// These thresholds only enable cost evaluation; size alone never delays a ruler.
export function isComplexRulerDocument(document: { content: readonly unknown[] }): boolean {
  if (document.content.length > 800) return true;
  let nodes = 0;
  let characters = 0;
  const pending: unknown[] = [...document.content];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    nodes += 1;
    if (nodes > 5_000) return true;
    const record = node as Record<string, unknown>;
    const text = record.type === "text" ? record.text : record.source;
    if (typeof text === "string") {
      for (const character of text) {
        if (!/\p{White_Space}/u.test(character)) characters += 1;
        if (characters > 30_000) return true;
      }
    }
    for (const key of ["content", "items", "rows", "cells"]) {
      const children = record[key];
      if (Array.isArray(children)) {
        for (const child of children) pending.push(child);
      }
    }
  }
  return false;
}

export class AdaptiveRulerScheduler<Input, Output> {
  private samples: number[] = [];
  private fastSamples = 0;
  private deferred = false;
  private lastStarted = Number.NEGATIVE_INFINITY;
  private pending: { input: Input; complex: boolean } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly calculate: (input: Input) => Output,
    private readonly publish: (output: Output) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  update(input: Input, complex: boolean): void {
    this.pending = { input, complex };
    if (!complex) {
      this.samples = [];
      this.fastSamples = 0;
      this.deferred = false;
    }
    const delay = this.deferred ? Math.max(0, 100 - (this.now() - this.lastStarted)) : 0;
    if (delay === 0) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.run();
    } else if (this.timer === null) {
      // Keep the first deadline and replace only pending input. Debouncing every
      // keystroke would starve the ruler during uninterrupted typing.
      this.timer = setTimeout(() => {
        this.timer = null;
        this.run();
      }, delay);
    }
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private run(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.lastStarted = this.now();
    const output = this.calculate(pending.input);
    const duration = this.now() - this.lastStarted;
    if (pending.complex) {
      this.samples = [...this.samples.slice(-4), duration];
      this.fastSamples = duration < 8 ? this.fastSamples + 1 : 0;
      if (this.fastSamples >= 5) this.deferred = false;
      else if (this.samples.filter((sample) => sample > 16).length >= 3) this.deferred = true;
    }
    this.publish(output);
  }
}
