import { ChevronDown, X } from "lucide-react";
import { useEffect, useRef } from "react";
import "./klecks-temporary-images.css";

export function KlecksDocumentTabs({
  documents,
  activeId,
  loadingId,
  dirty,
  disabled,
  onActivate,
  onClose,
}: {
  documents: {
    viewId: string;
    name: string;
    label: string;
    temporary?: boolean;
    dirty?: boolean;
  }[];
  activeId: string | null;
  loadingId?: string | null | undefined;
  dirty: boolean;
  disabled: boolean;
  onActivate(viewId: string): void;
  onClose?: ((viewId: string) => void) | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const activeIndex = documents.findIndex((document) => document.viewId === activeId);
  const itemCount = documents.length;
  useEffect(() => {
    if (!activeId || itemCount === 0) return;
    const list = root.current,
      selected = list?.children.item(activeIndex);
    if (!list || !selected) return;
    const outer = list.getBoundingClientRect(),
      inner = selected.getBoundingClientRect();
    if (inner.left < outer.left) list.scrollLeft -= outer.left - inner.left;
    else if (inner.right > outer.right) list.scrollLeft += inner.right - outer.right;
  }, [activeId, activeIndex, itemCount]);
  useEffect(() => {
    const list = root.current;
    if (!list) return;
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
        list.scrollWidth <= list.clientWidth
      )
        return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    };
    list.addEventListener("wheel", wheel, { passive: false });
    return () => list.removeEventListener("wheel", wheel);
  }, []);
  return (
    <>
      <div ref={root} className="klecks-panels__tabs" role="tablist" aria-label="已导入图片">
        {documents.map((document) => (
          <div
            key={document.viewId}
            role="presentation"
            className="klecks-document-tab"
            data-active={document.viewId === activeId}
          >
            <button
              type="button"
              role="tab"
              aria-selected={document.viewId === activeId}
              disabled={disabled}
              onClick={() => onActivate(document.viewId)}
              title={document.temporary ? document.name : document.label}
            >
              <span>{document.temporary ? document.name : document.label}</span>
              {document.temporary ? <small className="klecks-temporary-badge">临时</small> : null}
              {loadingId === document.viewId ? <small>加载中…</small> : null}
              {(document.temporary ? document.dirty : document.viewId === activeId && dirty) ? (
                <i role="img" aria-label={document.temporary ? "未导出修改" : "未保存"} />
              ) : null}
            </button>
            {document.temporary && onClose ? (
              <button
                type="button"
                className="klecks-temporary-close"
                disabled={disabled}
                aria-label={`关闭临时图片 ${document.name}`}
                onClick={() => onClose(document.viewId)}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {documents.length > 1 ? (
        <label className="klecks-panels__all-images" title="全部图片">
          <ChevronDown size={14} aria-hidden="true" />
          <select
            aria-label="全部图片"
            disabled={disabled}
            value={activeId ?? ""}
            onChange={(event) => onActivate(event.currentTarget.value)}
          >
            <option value="" disabled>
              选择图片
            </option>
            {documents.map((document) => (
              <option key={document.viewId} value={document.viewId}>
                {document.temporary ? `${document.name} · 临时` : document.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );
}
