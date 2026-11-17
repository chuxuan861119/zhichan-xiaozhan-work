import { ArrowRight, ChevronDown, Ellipsis } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { richDraftClipboardFormats } from "../../../shared/patent/claims-rich-text";
import {
  CLAIMS_DESCRIPTION_LABELS,
  type ClaimsDescriptionResult,
  type ClaimsDescriptionTarget,
} from "../../../shared/patent/claims-to-description";
import { MotionPresence } from "../app/motion-presence";
import type { OperationFeedback } from "../shared/operation-feedback";
import { SpatialPresence } from "../shared/spatial-presence";
import { StandardDialog } from "../shared/standard-dialog";
import { reportGuidanceProgress } from "../writing-guidance/progress";
import "./claims-description-preview.css";
import "./claims-description-menu.css";

export function ClaimsToDescriptionPanel({
  onPrepare,
  onCopied,
  onFeedback,
  onOpenSettings,
}: {
  onPrepare(target: ClaimsDescriptionTarget): ClaimsDescriptionResult;
  onCopied(target: ClaimsDescriptionTarget, nodeId: string | null): void;
  onFeedback(feedback: OperationFeedback): void;
  onOpenSettings?(): void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    target: ClaimsDescriptionTarget;
    prepared: Extract<ClaimsDescriptionResult, { ok: true }>;
  } | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const root = useRef<HTMLElement>(null);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, width: 180 });
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      if (!toggleRef.current || !menuRef.current) return;
      const anchor = toggleRef.current.getBoundingClientRect();
      const width = Math.min(Math.max(anchor.width, 180), window.innerWidth - 16);
      menuRef.current.style.width = `${width}px`;
      const height = menuRef.current.getBoundingClientRect().height;
      setMenuPosition({
        width,
        left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
        top: Math.max(
          8,
          anchor.bottom + 4 + height <= window.innerHeight - 8
            ? anchor.bottom + 4
            : Math.min(anchor.top - height - 4, window.innerHeight - height - 8),
        ),
      });
    };
    updatePosition();
    const onMove = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      const toggle = toggleRef.current;
      if (!toggle) return;
      const anchor = toggle.getBoundingClientRect();
      let left = 0;
      let top = 0;
      let right = window.innerWidth;
      let bottom = window.innerHeight;
      for (let parent = toggle.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, rect.left);
          right = Math.min(right, rect.right);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
      }
      if (
        anchor.bottom <= top ||
        anchor.top >= bottom ||
        anchor.right <= left ||
        anchor.left >= right
      ) {
        setOpen(false);
        return;
      }
      updatePosition();
    };
    window.addEventListener("resize", onMove);
    document.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      document.removeEventListener("scroll", onMove, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const help =
        event.target instanceof Element ? event.target.closest(".clear-format-help") : null;
      // Chapter help is a separate portal, but still belongs to its menu button.
      if (
        help?.id &&
        [...(menuRef.current?.querySelectorAll("[aria-describedby]") ?? [])].some((button) =>
          button.getAttribute("aria-describedby")?.split(/\s+/).includes(help.id),
        )
      )
        return;
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !menuRef.current?.contains(event.target)
      )
        setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape in a help panel dismisses that panel before its parent menu.
      if (event.target instanceof Element && event.target.closest(".clear-format-help")) return;
      event.stopPropagation();
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [open]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const preparePreview = (target: ClaimsDescriptionTarget) => {
    try {
      const prepared = onPrepare(target);
      if (!prepared.ok) throw new Error(prepared.message);
      setOpen(false);
      setPreview({ target, prepared });
    } catch (error) {
      onFeedback({
        tone: "error",
        title: "未能生成预览",
        message: error instanceof Error ? error.message : "请检查权利要求书后重试。",
      });
    }
  };
  const copy = async () => {
    if (!preview) return;
    if (pending.current) return;
    const { target, prepared } = preview;
    pending.current = true;
    setBusy(true);
    try {
      const copied = await window.patentApi.clipboard.writeText({
        paragraphs: prepared.paragraphs,
        style: "formatted-draft",
      });
      if (!mounted.current) return;
      if (!copied.ok) throw new Error(copied.error.message);
      if (root.current?.closest('[hidden], [inert], [aria-hidden="true"]')) return;
      setOpen(false);
      setPreview(null);
      reportGuidanceProgress(root.current, "copied", CLAIMS_DESCRIPTION_LABELS[target]);
      onCopied(target, prepared.targetNodeId);
      onFeedback({
        tone: "success",
        title: `已复制，请在“${CLAIMS_DESCRIPTION_LABELS[target]}”的合适位置粘贴`,
        ...(prepared.targetNodeId
          ? {}
          : {
              message: `说明书里没有唯一的“${CLAIMS_DESCRIPTION_LABELS[target]}”标题，已跳过跳转。`,
            }),
      });
    } catch (error) {
      if (mounted.current)
        onFeedback({
          tone: "error",
          title: "未能复制",
          message: error instanceof Error ? error.message : "无法写入剪贴板，请重试。",
        });
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section ref={root} className="claims-description-tool">
      <button
        ref={toggleRef}
        type="button"
        className="claims-description-tool__toggle"
        aria-expanded={open}
        data-menu-open={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <ArrowRight aria-hidden="true" />
        说明书
        <ChevronDown aria-hidden="true" className="claims-description-tool__chevron" />
      </button>
      {createPortal(
        <SpatialPresence>
          {open ? (
            <section
              ref={menuRef}
              id={panelId}
              className="claims-description-tool__panel claims-description-menu"
              data-function-rail-owner={
                root.current
                  ?.closest("[data-function-rail-scope]")
                  ?.getAttribute("data-function-rail-scope") ?? undefined
              }
              style={menuPosition}
              aria-label="转为说明书"
              aria-busy={busy}
            >
              <div className="claims-description-tool__actions">
                <div className="claims-description-tool__invention">
                  <button
                    className="claims-description-tool__invention-action"
                    type="button"
                    disabled={busy}
                    onClick={() => preparePreview("invention-content")}
                  >
                    发明内容
                  </button>
                  {onOpenSettings ? (
                    <button
                      type="button"
                      className="claims-description-tool__settings"
                      aria-label="发明内容设置"
                      title="发明内容设置"
                      disabled={busy}
                      onClick={() => {
                        setOpen(false);
                        onOpenSettings();
                      }}
                    >
                      <Ellipsis aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <button
                  className="claims-description-tool__embodiments-action"
                  type="button"
                  disabled={busy}
                  onClick={() => preparePreview("detailed-embodiments")}
                >
                  具体实施方式
                </button>
              </div>
              {busy ? <p role="status">正在复制…</p> : null}
            </section>
          ) : null}
        </SpatialPresence>,
        document.body,
      )}
      {createPortal(
        <MotionPresence>
          {preview ? (
            <StandardDialog
              open
              title={`${CLAIMS_DESCRIPTION_LABELS[preview.target]}预览`}
              size="l"
              className="claims-description-preview"
              onCancel={() => {
                if (!pending.current) setPreview(null);
              }}
              closeDisabled={busy}
              footer={
                <>
                  <button type="button" disabled={busy} onClick={() => setPreview(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void copy()}
                  >
                    {busy ? "正在复制…" : "复制并跳转"}
                  </button>
                </>
              }
            >
              <section
                className="claims-description-preview__text"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the preview.
                tabIndex={0}
                aria-label="处理后的文字"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: validated canonical styles and escaped text from shared serializer, never arbitrary HTML.
                dangerouslySetInnerHTML={{
                  __html: richDraftClipboardFormats(preview.prepared.paragraphs).html,
                }}
              />
            </StandardDialog>
          ) : null}
        </MotionPresence>,
        document.body,
      )}
    </section>
  );
}
