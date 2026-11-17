import { Download, FileText, GitBranch, PenTool } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type FolderFormat,
  folderExportItems,
  type PatentFolderEntry,
  patentFolderEntries,
} from "../../../shared/patent/folder";
import type { CanonicalPatent } from "../../../shared/patent/model";
import { MotionPresence } from "../app/motion-presence";
import { StandardDialog } from "../shared/standard-dialog";
import "./patent-folder-dialog.css";

export function PatentFolderDialog({
  patent,
  busy,
  onOpen,
  onExport,
  onCancel,
  exportNotice,
}: {
  patent: CanonicalPatent;
  busy: boolean;
  onOpen(entry: PatentFolderEntry): void;
  onExport(items: { key: string; format: FolderFormat }[]): void;
  onCancel(): void;
  exportNotice?: string | null;
}) {
  const entries = useMemo(() => patentFolderEntries(patent), [patent]);
  const [selected, setSelected] = useState<string[]>([]);
  const [format, setFormat] = useState<FolderFormat | undefined>();
  const anchor = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);
  const [rowExport, setRowExport] = useState<{
    entry: PatentFolderEntry;
    format: FolderFormat;
  } | null>(null);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    before: string[];
    base: string[];
    active: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [rectangle, setRectangle] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    const selectAll = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "a" ||
        event.isComposing ||
        !dialogRef.current?.contains(event.target as Node)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!busy) {
        setSelected(entries.map((entry) => entry.key));
        setFormat(undefined);
      }
    };
    document.addEventListener("keydown", selectAll, true);
    return () => document.removeEventListener("keydown", selectAll, true);
  }, [busy, entries]);
  const updateRectangle = (clientX: number, clientY: number) => {
    const gesture = drag.current;
    const list = filesRef.current;
    if (!gesture || !list) return;
    if (!gesture.active && Math.hypot(clientX - gesture.clientX, clientY - gesture.clientY) < 4)
      return;
    gesture.active = true;
    suppressClick.current = true;
    const frame = list.getBoundingClientRect();
    const x = clientX - frame.left + list.scrollLeft;
    const y = clientY - frame.top + list.scrollTop;
    const box = {
      left: Math.min(x, gesture.x),
      top: Math.min(y, gesture.y),
      width: Math.abs(x - gesture.x),
      height: Math.abs(y - gesture.y),
    };
    const hits = [...list.querySelectorAll<HTMLElement>('[role="option"]')].flatMap(
      (row, index) => {
        const rect = row.getBoundingClientRect();
        const left = rect.left - frame.left + list.scrollLeft;
        const top = rect.top - frame.top + list.scrollTop;
        return left < box.left + box.width &&
          left + rect.width > box.left &&
          top < box.top + box.height &&
          top + rect.height > box.top
          ? [entries[index]!.key]
          : [];
      },
    );
    setRectangle(box);
    setFormat(undefined);
    setSelected([...new Set([...gesture.base, ...hits])]);
  };
  const finishRectangle = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (cancelled && gesture.active) setSelected(gesture.before);
    drag.current = null;
    setRectangle(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const single = selected.length === 1 ? entries.find((e) => e.key === selected[0]) : undefined;
  const all = entries.length > 0 && entries.every((e) => selected.includes(e.key));
  const select = (index: number, additive: boolean, range: boolean) => {
    const key = entries[index]!.key;
    setFormat(undefined);
    setSelected((current) =>
      range
        ? Array.from(
            new Set([
              ...(additive ? current : []),
              ...entries
                .slice(Math.min(anchor.current, index), Math.max(anchor.current, index) + 1)
                .map((e) => e.key),
            ]),
          )
        : additive
          ? current.includes(key)
            ? current.filter((k) => k !== key)
            : [...current, key]
          : [key],
    );
    if (!range) anchor.current = index;
  };
  return (
    <>
      <StandardDialog
        open
        title={patent.name ?? "未命名专利"}
        closeLabel="关闭文件夹"
        size="xl"
        onCancel={onCancel}
        onEscape={() => undefined}
        dialogRef={dialogRef}
        closeDisabled={busy}
        className="patent-folder"
        bodyClassName="patent-folder__body"
        footer={
          <>
            <span
              className={`patent-folder__status${exportNotice && !busy ? " is-success" : ""}`}
              role="status"
            >
              {busy
                ? "正在导出，请稍候…"
                : (exportNotice ?? `${entries.length} 个文件 · 已选 ${selected.length} 个`)}
            </span>
            {single ? (
              <label className="patent-folder__format">
                导出格式{" "}
                <select
                  aria-label="导出格式"
                  value={format ?? single.formats[0]}
                  disabled={busy}
                  onChange={(e) => setFormat(e.target.value as FolderFormat)}
                >
                  {single.formats.map((f) => (
                    <option key={f} value={f}>
                      {f.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="patent-folder__hint">多选以默认格式导出 ZIP</span>
            )}
            <button type="button" onClick={onCancel} disabled={busy}>
              关闭
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={
                busy ||
                !selected.length ||
                selected.some((key) => !entries.find((e) => e.key === key)?.formats.length)
              }
              onClick={() => onExport(folderExportItems(entries, selected, format))}
            >
              <Download size={16} aria-hidden="true" />
              导出所选
            </button>
          </>
        }
      >
        <div className="patent-folder__toolbar">
          <label>
            <input
              type="checkbox"
              aria-label="全选文件"
              checked={all}
              disabled={busy}
              onChange={() => {
                setSelected(all ? [] : entries.map((e) => e.key));
                setFormat(undefined);
              }}
            />
            全选
          </label>
        </div>
        <div className="patent-folder__columns" aria-hidden="true">
          <span>名称</span>
          <span>类型</span>
          <span>操作</span>
        </div>
        <div
          role="listbox"
          aria-label="专利文件"
          aria-multiselectable="true"
          className="patent-folder__files"
          ref={filesRef}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && e.key === "ArrowDown") {
              e.preventDefault();
              if (!busy && entries.length) {
                select(0, false, e.shiftKey);
                filesRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
              }
            }
          }}
          onClickCapture={(e) => {
            if (suppressClick.current) {
              e.preventDefault();
              e.stopPropagation();
              suppressClick.current = false;
            }
          }}
          onClick={(e) => {
            if (!busy && e.target === e.currentTarget) {
              setSelected([]);
              setFormat(undefined);
            }
          }}
          onPointerDown={(e) => {
            suppressClick.current = false;
            if (
              busy ||
              e.button !== 0 ||
              e.pointerType === "touch" ||
              ((e.target as HTMLElement).closest("button") &&
                !(e.target as HTMLElement).closest('[role="option"]'))
            )
              return;
            const list = e.currentTarget;
            const rect = list.getBoundingClientRect();
            drag.current = {
              pointerId: e.pointerId,
              x: e.clientX - rect.left + list.scrollLeft,
              y: e.clientY - rect.top + list.scrollTop,
              clientX: e.clientX,
              clientY: e.clientY,
              before: selected,
              base: e.ctrlKey || e.metaKey || e.shiftKey ? selected : [],
              active: false,
            };
            if (!(e.target as HTMLElement).closest('[role="option"]'))
              list.focus({ preventScroll: true });
          }}
          onPointerMove={(e) => {
            if (!drag.current || drag.current.pointerId !== e.pointerId) return;
            updateRectangle(e.clientX, e.clientY);
            if (drag.current?.active) {
              e.preventDefault();
              e.currentTarget.setPointerCapture?.(e.pointerId);
            }
          }}
          onPointerUp={(e) => finishRectangle(e)}
          onPointerCancel={(e) => finishRectangle(e, true)}
          onLostPointerCapture={(e) => finishRectangle(e, true)}
        >
          {entries.map((entry, index) => {
            const Icon =
              entry.kind === "flowchart"
                ? GitBranch
                : entry.kind === "drawing"
                  ? PenTool
                  : FileText;
            return (
              <div
                role="presentation"
                className="patent-folder__row"
                data-selected={selected.includes(entry.key)}
                key={entry.key}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={selected.includes(entry.key)}
                  className={`patent-folder__file patent-folder__file--${entry.kind}`}
                  disabled={busy}
                  onClick={(e) => select(index, e.ctrlKey || e.metaKey, e.shiftKey)}
                  onDoubleClick={() => onOpen(entry)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onOpen(entry);
                    }
                    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
                      e.preventDefault();
                      const next = Math.max(
                        0,
                        Math.min(
                          entries.length - 1,
                          index + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1),
                        ),
                      );
                      select(next, e.ctrlKey || e.metaKey, e.shiftKey);
                      filesRef.current
                        ?.querySelectorAll<HTMLElement>('[role="option"]')
                        [next]?.focus();
                    }
                  }}
                >
                  <span className="patent-folder__icon">
                    <Icon size={21} strokeWidth={1.65} aria-hidden="true" />
                  </span>
                  <span className="patent-folder__name" title={entry.name}>
                    {entry.name}
                  </span>
                  <small>{entry.label}</small>
                </button>
                <button
                  type="button"
                  className="patent-folder__row-export"
                  aria-label={`导出${entry.name}`}
                  disabled={busy || !entry.formats.length}
                  onClick={() =>
                    setRowExport({
                      entry,
                      format:
                        single?.key === entry.key
                          ? (format ?? entry.formats[0]!)
                          : entry.formats[0]!,
                    })
                  }
                >
                  <Download size={14} aria-hidden="true" />
                  导出
                </button>
              </div>
            );
          })}
          {rectangle ? (
            <div
              data-testid="folder-selection-rectangle"
              className="patent-folder__selection-rectangle"
              style={rectangle}
            />
          ) : null}
        </div>
      </StandardDialog>
      <MotionPresence>
        {rowExport ? (
          <StandardDialog
            open
            title="导出文件"
            subtitle={rowExport.entry.name}
            size="s"
            onEscape={() => undefined}
            onCancel={() => setRowExport(null)}
            footer={
              <>
                <button type="button" onClick={() => setRowExport(null)}>
                  关闭
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    const item = rowExport;
                    setRowExport(null);
                    onExport(folderExportItems(entries, [item.entry.key], item.format));
                  }}
                >
                  导出
                </button>
              </>
            }
          >
            <label className="patent-folder__format">
              文件格式{" "}
              <select
                aria-label="文件格式"
                value={rowExport.format}
                onChange={(e) =>
                  setRowExport({ ...rowExport, format: e.target.value as FolderFormat })
                }
              >
                {rowExport.entry.formats.map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </StandardDialog>
        ) : null}
      </MotionPresence>
    </>
  );
}
