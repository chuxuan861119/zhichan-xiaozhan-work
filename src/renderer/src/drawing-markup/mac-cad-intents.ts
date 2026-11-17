/** Mac input arriving while geometry is updating. Never stores edit commands. */
export class MacCadIntents<T> {
  private items: T[] = [];
  private generation = 0;
  private running = false;

  get pending() {
    return this.running || this.items.length > 0;
  }
  get draining() {
    return this.running;
  }

  push(item: T) {
    // Bound retained input when a worker is slow or unavailable.
    if (this.items.length >= 32) return false;
    this.items.push(item);
    return true;
  }

  clear() {
    this.generation++;
    this.items = [];
  }

  async drain(ready: () => boolean, apply: (item: T) => Promise<void>) {
    if (this.running) return;
    const generation = this.generation;
    this.running = true;
    try {
      while (generation === this.generation && this.items.length && ready()) {
        await apply(this.items.shift()!);
      }
    } finally {
      this.running = false;
    }
  }
}
