/** OS launch arguments and pre-ready file events may describe the same request. */
export function createStartupFileOpenGuard(lateBurstMs = 0, now = () => Date.now()) {
  const opened = new Map<string, number>();
  let startup = true;
  return {
    accept(path: string | null): boolean {
      if (!path) return true;
      const timestamp = now();
      const previous = opened.get(path);
      // Harmony can deliver the cold-start Want again after whenReady completes.
      // Keep a short burst guard across that boundary; later explicit opens work.
      if (previous !== undefined && (startup || timestamp - previous < lateBurstMs)) return false;
      for (const [key, time] of opened) {
        if (!startup && timestamp - time >= lateBurstMs) opened.delete(key);
      }
      opened.set(path, timestamp);
      return true;
    },
    finish() {
      startup = false;
    },
  };
}
