import { type SetStateAction, useCallback, useEffect, useRef, useState } from "react";

/** Setters retain their originating session even when an asynchronous operation completes later. */
export function useSessionState<T>(
  sessionId: string | null | undefined,
  initial: T,
  openSessionIds: readonly string[],
) {
  const [entries, setEntries] = useState<Record<string, T>>({});
  const openIds = useRef(openSessionIds);
  openIds.current = openSessionIds;
  const setForSession = useCallback(
    (owner: string, action: SetStateAction<T>) => {
      setEntries((current) => {
        if (!openIds.current.includes(owner)) return current;
        const previous = current[owner] ?? initial;
        const next = typeof action === "function" ? (action as (value: T) => T)(previous) : action;
        return Object.is(previous, next) ? current : { ...current, [owner]: next };
      });
    },
    [initial],
  );
  const set = useCallback(
    (action: SetStateAction<T>) => {
      if (sessionId) setForSession(sessionId, action);
    },
    [sessionId, setForSession],
  );
  useEffect(() => {
    setEntries((current) => {
      const keys = Object.keys(current);
      if (keys.every((key) => openSessionIds.includes(key))) return current;
      return Object.fromEntries(
        Object.entries(current).filter(([key]) => openSessionIds.includes(key)),
      );
    });
  }, [openSessionIds]);
  return [
    sessionId ? (entries[sessionId] ?? initial) : initial,
    set,
    entries,
    setForSession,
  ] as const;
}
