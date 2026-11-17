import { useEffect, useRef, useState } from "react";

/** A runtime is released only after its owning session has durably flushed. */
export function useExclusiveEditorRuntime(
  desired: string | null,
  openSessions: readonly string[],
  flush: (owner: string) => Promise<boolean>,
) {
  const [owner, setOwner] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  const live = useRef({ desired, openSessions, flush });
  live.current = { desired, openSessions, flush };
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit retry signal after a failed save.
  useEffect(() => {
    if (owner === desired) {
      setFailed(false);
      return;
    }
    let cancelled = false;
    setFailed(false);
    void (async () => {
      try {
        const saved =
          !owner || !live.current.openSessions.includes(owner) || (await live.current.flush(owner));
        if (cancelled) return;
        if (!saved) {
          setFailed(true);
          return;
        }
        setOwner(live.current.desired);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desired, owner, attempt]);
  return { owner, failed, pending: owner !== desired, retry: () => retry((value) => value + 1) };
}
