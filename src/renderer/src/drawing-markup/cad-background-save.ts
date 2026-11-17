export class CadBackgroundSave {
  private jobs: {save: () => Promise<void>; replaceable: boolean; key?: unknown}[] = [];
  private running: Promise<void> | null = null;
  private error: Error | null = null;
  constructor(
    private changed: (pending: boolean) => void,
    private failed: (error: Error) => void,
  ) {}
  get pending() {
    return this.jobs.length > 0;
  }
  enqueue(save: () => Promise<void>) {
    this.jobs.push({save, replaceable: false});
    this.changed(true);
    this.start();
  }
  /** Only for complete document snapshots, never independent asset operations. */
  enqueueLatest(save: () => Promise<void>, key?: unknown) {
    const tail = this.jobs.at(-1);
    const job = {save, replaceable: true, key};
    if (this.jobs.length > 1 && tail?.replaceable && tail.key === key) this.jobs[this.jobs.length - 1] = job;
    else this.jobs.push(job);
    this.changed(true);
    this.start();
  }
  private start() {
    if (this.running || this.error || !this.pending) return;
    this.running = Promise.resolve()
      .then(async () => {
        while (this.jobs.length) {
          await this.jobs[0]!.save();
          this.jobs.shift();
        }
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.failed(this.error);
      })
      .finally(() => {
        this.running = null;
        this.changed(this.pending);
        this.start();
      });
  }
  async flush() {
    this.error = null;
    this.start();
    while (this.running) {
      await this.running;
      if (this.error) return false;
      this.start();
    }
    return !this.pending;
  }
}
