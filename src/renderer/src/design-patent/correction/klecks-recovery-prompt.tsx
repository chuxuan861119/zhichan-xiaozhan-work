import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Choice = "recovery" | "cancel";
type Request = { label: string; signal: AbortSignal; discard(): Promise<void> };
type Entry = Request & {
  id: number;
  busy: boolean;
  attempted: boolean;
  error: string | null;
  resolve(choice: Choice): void;
  cleanup(): void;
};

export function useKlecksRecoveryPrompt() {
  const entries = useRef<Entry[]>([]),
    serial = useRef(0),
    alive = useRef(true);
  const [, setVersion] = useState(0);
  const refresh = useCallback(() => {
    if (alive.current) setVersion((value) => value + 1);
  }, []);
  const finish = useCallback(
    (entry: Entry, choice: Choice) => {
      if (!entries.current.includes(entry)) return;
      entries.current = entries.current.filter((item) => item !== entry);
      entry.cleanup();
      entry.resolve(choice);
      refresh();
    },
    [refresh],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const entry of entries.current) {
        entry.cleanup();
        entry.resolve("cancel");
      }
      entries.current = [];
    };
  }, []);
  const request = useCallback(
    (input: Request): Promise<Choice> => {
      if (!alive.current || input.signal.aborted) return Promise.resolve("cancel");
      return new Promise((resolve) => {
        const entry: Entry = {
          ...input,
          id: ++serial.current,
          busy: false,
          attempted: false,
          error: null,
          resolve,
          cleanup: () => input.signal.removeEventListener("abort", abort),
        };
        const abort = () => {
          if (!entry.busy) finish(entry, "cancel");
        };
        input.signal.addEventListener("abort", abort, { once: true });
        entries.current.push(entry);
        refresh();
      });
    },
    [finish, refresh],
  );
  const entry = entries.current[0];
  const choose = async (choice: "recovery" | "discard" | "cancel") => {
    if (!entry || entry.busy) return;
    if (choice !== "discard") {
      if (choice === "recovery" && entry.attempted) return;
      finish(entry, choice);
      return;
    }
    entry.busy = true;
    entry.attempted = true;
    entry.error = null;
    refresh();
    try {
      await entry.discard();
      finish(entry, "cancel");
    } catch (error) {
      entry.error =
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
          ? error.message
          : "舍弃未完成，请重试。";
    } finally {
      entry.busy = false;
      refresh();
    }
  };
  return {
    request,
    dialog: entry
      ? createPortal(<RecoveryDialog key={entry.id} entry={entry} choose={choose} />, document.body)
      : null,
  };
}

function RecoveryDialog({
  entry,
  choose,
}: {
  entry: Entry;
  choose(choice: "recovery" | "discard" | "cancel"): void;
}) {
  const backdrop = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    const background = [...document.body.children]
      .filter((element) => element !== backdrop.current)
      .map((element) => ({
        element,
        inert: element.hasAttribute("inert"),
        hidden: element.getAttribute("aria-hidden"),
      }));
    for (const { element } of background) {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    }
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target))
        panel.current?.focus();
    };
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("focusin", focus);
      for (const { element, inert, hidden } of background) {
        if (!inert) element.removeAttribute("inert");
        if (hidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", hidden);
      }
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div ref={backdrop} className="dialog-backdrop" role="presentation">
      <section
        ref={panel}
        className="close-dialog klecks-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="恢复图片编辑"
        aria-busy={entry.busy}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            choose("cancel");
          }
          if (event.key === "Tab") {
            const buttons = [
              ...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
                []),
            ];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            event.preventDefault();
            buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
          }
        }}
      >
        <h2>恢复图片编辑</h2>
        <p>“{entry.label}”有自动恢复的编辑记录，是否继续编辑？</p>
        <p>
          恢复记录不等于明确保存，也不会自动应用到视图。舍弃后返回上次保存版本；没有保存版本时返回原始初始化图片。
        </p>
        {entry.error && <p role="alert">{entry.error}</p>}
        {entry.busy && <p role="status">正在处理，请稍候…</p>}
        <div className="dialog-actions">
          <button ref={cancel} type="button" disabled={entry.busy} onClick={() => choose("cancel")}>
            取消
          </button>
          <button type="button" disabled={entry.busy} onClick={() => choose("discard")}>
            {entry.attempted ? "重试舍弃" : "舍弃恢复版本"}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={entry.busy || entry.attempted}
            onClick={() => choose("recovery")}
          >
            恢复编辑
          </button>
        </div>
      </section>
    </div>
  );
}
