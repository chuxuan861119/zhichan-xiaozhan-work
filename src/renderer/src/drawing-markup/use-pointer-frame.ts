import { useCallback, useEffect, useRef } from "react";

/** Coalesce preview work only; release flushes the final sample synchronously. */
export function usePointerFrame<T>(apply: (sample: T) => void) {
  const latest = useRef(apply);
  latest.current = apply;
  const pending = useRef<{ value: T } | null>(null);
  const frame = useRef<number | null>(null);
  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = null;
  }, []);
  const flush = useCallback(
    (sample?: T) => {
      const value = sample === undefined ? pending.current : { value: sample };
      cancel();
      if (value) latest.current(value.value);
    },
    [cancel],
  );
  const schedule = useCallback(
    (value: T) => {
      pending.current = { value };
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => flush());
    },
    [flush],
  );
  useEffect(() => cancel, [cancel]);
  return { schedule, flush, cancel };
}
