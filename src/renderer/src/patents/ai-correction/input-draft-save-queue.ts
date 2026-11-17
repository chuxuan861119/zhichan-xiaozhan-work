type Write = () => Promise<boolean>;
type Entry = {
  pending?: Write | undefined;
  running?: Promise<boolean> | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
  failed: boolean;
};

/** Keep UI input immediate; serialize writes per draft and retain failed input. */
export class InputDraftSaveQueue {
  private readonly entries = new Map<string, Entry>();
  enqueue(key: string, write: Write) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { failed: false };
      this.entries.set(key, entry);
    }
    entry.pending = write;
    entry.failed = false;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry) void this.run(entry);
    }, 200);
  }
  private run(entry: Entry): Promise<boolean> {
    clearTimeout(entry.timer);
    if (entry.running) return entry.running;
    entry.running = (async () => {
      while (entry.pending) {
        const write = entry.pending;
        entry.pending = undefined;
        let ok = false;
        try {
          ok = await write();
        } catch {
          /* Retain input for retry. */
        }
        if (!ok) {
          // A failure for superseded input must not strand the newer draft.
          if (entry.pending) continue;
          entry.pending ??= write;
          entry.failed = true;
          return false;
        }
      }
      return true;
    })().finally(() => {
      entry.running = undefined;
    });
    return entry.running;
  }
  async flush(matches: (key: string) => boolean = () => true): Promise<boolean> {
    for (const [key, entry] of this.entries) if (matches(key)) entry.failed = false;
    while (true) {
      const results = await Promise.all(
        [...this.entries]
          .filter(([key]) => matches(key))
          .map(([, entry]) => (entry.failed ? Promise.resolve(false) : this.run(entry))),
      );
      if (results.some((ok) => !ok)) return false;
      for (const [key, entry] of this.entries) {
        if (matches(key) && !entry.pending && !entry.running) this.entries.delete(key);
      }
      if (![...this.entries.keys()].some(matches)) return true;
    }
  }
}
