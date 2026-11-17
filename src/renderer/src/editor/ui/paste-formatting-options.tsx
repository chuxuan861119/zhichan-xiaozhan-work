import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMotionPresenceClosing } from "../../app/motion-presence";
import type { PasteFormattingSession } from "../paste-paragraph-formatting";
import type { PasteParagraphMode } from "../paste-sanitizer";
import "./paste-formatting-options.css";

export function PasteFormattingOptions({
  session,
  editorElement,
  onSelect,
  onClose,
}: {
  session: PasteFormattingSession;
  editorElement?: HTMLElement;
  onSelect(mode: PasteParagraphMode): void;
  onClose(): void;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  const closing = useMotionPresenceClosing();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const differs = session.targets.some(({ source, body }) =>
    Object.keys({ ...source, ...body }).some((key) => source[key] !== body[key]),
  );
  const missing = session.simplifications.some(
    (issue) => issue.includes("补充") || issue.includes("不支持公式"),
  );
  useEffect(() => {
    if (!editorElement || closing) return;
    const layout = editorElement.closest(".patent-page-with-rail");
    const scope = editorElement.closest("[data-function-rail-scope]") ?? layout;
    if (!scope) return;
    const update = () => {
      if (!editorElement.isConnected || editorElement.closest('[hidden], [data-active="false"]')) {
        close.current();
        return;
      }
      const book = editorElement.closest("[data-book-kind]")?.getAttribute("data-book-kind");
      // Overlay rails are portaled to the same scope's edge; never use another pane's rail.
      const local = layout?.querySelector<HTMLElement>(".patent-global-function-rail__body");
      const rail = Array.from(
        scope.querySelectorAll<HTMLElement>(".patent-global-function-rail"),
      ).find((item) => book && item.dataset.bookKind === book);
      setHost(
        local ?? rail?.querySelector<HTMLElement>(".patent-global-function-rail__body") ?? null,
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(scope, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "data-active"],
    });
    for (let parent = scope.parentElement; parent; parent = parent.parentElement) {
      observer.observe(parent, { attributes: true, attributeFilter: ["hidden", "data-active"] });
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    const paste = () => close.current();
    window.addEventListener("keydown", handleEscape);
    editorElement.addEventListener("paste", paste, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("keydown", handleEscape);
      editorElement.removeEventListener("paste", paste, true);
    };
  }, [editorElement, closing]);
  const notices =
    session.simplifications.length > 0 ? (
      <details className="spatial-disclosure" open={missing}>
        <summary>
          {missing ? "已粘贴可保留的内容，部分内容缺失，请核对原文。" : "部分来源格式已简化"}
        </summary>
        <ul>
          {session.simplifications.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      </details>
    ) : null;
  return (
    <>
      {host && (differs || (!missing && notices))
        ? createPortal(
            <section
              className="paste-formatting-options paste-formatting-options--rail"
              data-motion={closing ? "exit" : "enter"}
              inert={closing || undefined}
              aria-hidden={closing || undefined}
              aria-label="粘贴排版"
            >
              <header>
                <strong>粘贴排版</strong>
                <button type="button" aria-label="关闭粘贴排版" onClick={onClose}>
                  ×
                </button>
              </header>
              {differs && (
                <div className="paste-formatting-choices" title="调整新粘贴段落的缩进和对齐">
                  <button
                    type="button"
                    aria-pressed={session.mode === "source"}
                    onClick={() => onSelect("source")}
                  >
                    保留原段落格式
                  </button>
                  <button
                    type="button"
                    aria-pressed={session.mode === "body"}
                    onClick={() => onSelect("body")}
                  >
                    使用正文段落格式
                  </button>
                </div>
              )}
              {!missing && notices}
            </section>,
            host,
          )
        : null}
      {missing
        ? createPortal(
            <section
              className="paste-formatting-options"
              data-motion={closing ? "exit" : "enter"}
              inert={closing || undefined}
              aria-hidden={closing || undefined}
              role="alert"
              aria-label="粘贴内容提示"
            >
              <header>
                <strong>粘贴内容提示</strong>
                <button type="button" aria-label="关闭粘贴提示" onClick={onClose}>
                  ×
                </button>
              </header>
              {notices}
            </section>,
            document.body,
          )
        : null}
    </>
  );
}
