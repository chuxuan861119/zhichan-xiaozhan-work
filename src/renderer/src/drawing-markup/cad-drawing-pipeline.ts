type Options<Input, Output> = {
  execute(input: Input, sequence: number): Promise<Output>;
  save(output: Output, sequence: number): Promise<void>;
  byteLength?(output: Output): number;
  onPending(pending: boolean): void;
  onError(error: Error): void;
};

/** Geometry and immutable checkpoint writes have separate, ordered queues. */
export class CadDrawingPipeline<Input, Output> {
  private inputs: { input: Input; sequence: number }[] = [];
  private checkpoints: { output: Output; sequence: number; bytes: number }[] = [];
  private bufferedBytes = 0;
  private computing: Promise<void> | null = null;
  private saving: Promise<void> | null = null;
  private sequence = 0;
  error: Error | null = null;

  constructor(private options: Options<Input, Output>) {}

  get pending() {
    return this.inputs.length > 0 || this.checkpoints.length > 0;
  }

  get geometryPending() {
    return this.inputs.length > 0 || this.computing !== null;
  }

  isLatest(sequence: number) {
    return sequence === this.sequence;
  }

  enqueue(input: Input) {
    if (this.error) return false;
    this.inputs.push({ input, sequence: ++this.sequence });
    this.options.onPending(true);
    this.compute();
    return true;
  }

  private fail(error: unknown) {
    this.error = error instanceof Error ? error : new Error(String(error));
    this.options.onError(this.error);
    this.options.onPending(this.pending);
  }

  private compute() {
    if (this.computing || this.error || !this.inputs.length || !this.hasCapacity()) return;
    this.computing = Promise.resolve()
      .then(async () => {
        for (
          let item = this.inputs[0];
          item && !this.error && this.hasCapacity();
          item = this.inputs[0]
        ) {
          const output = await this.options.execute(item.input, item.sequence);
          this.inputs.shift();
          const bytes = this.options.byteLength?.(output) ?? 0;
          this.bufferedBytes += bytes;
          this.checkpoints.push({ output, sequence: item.sequence, bytes });
          this.save();
        }
      })
      .catch((error) => this.fail(error))
      .finally(() => {
        this.computing = null;
        this.options.onPending(this.pending);
        this.save();
      });
  }

  private hasCapacity() {
    // A single supported large checkpoint may exceed the budget; do not start
    // another until it is durable. Remaining input consists only of commands.
    return this.checkpoints.length < 8 && this.bufferedBytes < 32 * 1024 * 1024;
  }

  private save() {
    if (this.saving || this.error || !this.checkpoints.length) return;
    this.saving = Promise.resolve()
      .then(async () => {
        for (let item = this.checkpoints[0]; item && !this.error; item = this.checkpoints[0]) {
          await this.options.save(item.output, item.sequence);
          this.checkpoints.shift();
          this.bufferedBytes -= item.bytes;
          this.compute();
        }
      })
      .catch((error) => this.fail(error))
      .finally(() => {
        this.saving = null;
        this.options.onPending(this.pending);
        this.save();
        this.compute();
      });
  }

  /** Retry retained work and do not allow close/export to pass an unsaved stroke. */
  async flush() {
    this.error = null;
    this.compute();
    this.save();
    while (this.computing || this.saving) {
      await Promise.all([this.computing, this.saving]);
      if (this.error) return false;
      this.compute();
      this.save();
    }
    return !this.pending;
  }
}
