import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
export type DraftTextHandle = { flush(): void };
export function DraftText({
  ref,
  id,
  value,
  label,
  onCommit,
  onFinish,
  autoFocus = false,
}: {
  ref?: Ref<DraftTextHandle>;
  id?: string;
  value: string;
  label: string;
  onCommit: ((value: string) => boolean) | ((value: string) => void);
  onFinish?: () => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (autoFocus) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }
  }, [autoFocus]);
  function finish() {
    if (cancelled.current) return;
    cancelled.current = true;
    const next = draft.trim();
    if (next && next !== value) {
      if (onCommit(next) === false) setDraft(value);
    } else setDraft(value);
    onFinish?.();
  }
  useImperativeHandle(ref, () => ({ flush: finish }));
  return (
    <input
      id={id}
      ref={input}
      aria-label={label}
      value={draft}
      maxLength={100}
      onChange={(e) => {
        cancelled.current = false;
        setDraft(e.target.value);
      }}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          setDraft(value);
          onFinish?.();
          input.current?.blur();
        }
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          input.current?.blur();
        }
      }}
    />
  );
}
