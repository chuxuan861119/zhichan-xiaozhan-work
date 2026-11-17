import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SpatialPresence } from "../../shared/spatial-presence";
import { toolbarDropdownPosition } from "../ui/toolbar-dropdown-position";
import type { TableInsertRequest } from "./table-commands";

export type InsertTablePopoverProps = {
  open: boolean;
  anchor?: HTMLElement | null;
  onClose(): void;
  onConfirm(request: TableInsertRequest): void;
};

function validDimensions(rows: number, columns: number): boolean {
  return (
    Number.isInteger(rows) &&
    Number.isInteger(columns) &&
    rows >= 1 &&
    rows <= 100 &&
    columns >= 1 &&
    columns <= 30
  );
}

export function InsertTablePopover({ open, anchor, onClose, onConfirm }: InsertTablePopoverProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState({ rows: 3, columns: 3 });
  const [rows, setRows] = useState("3");
  const [columns, setColumns] = useState("3");
  const [headerRow, setHeaderRow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const position = () => {
      const panel = panelRef.current;
      const toolbarPosition = anchor
        ? toolbarDropdownPosition(anchor, anchor, panel?.offsetWidth ?? 0)
        : null;
      if (panel && toolbarPosition) {
        panel.style.left = `${toolbarPosition.left}px`;
        panel.style.top = `${toolbarPosition.top}px`;
        frame = requestAnimationFrame(position);
        return;
      }
      const page = [
        ...document.querySelectorAll<HTMLElement>(
          ".patent-page-zoom-frame, .editor-session.is-active .editor-paper",
        ),
      ].find(
        (element) =>
          !element.closest('[hidden], [aria-hidden="true"], [data-active="false"]') &&
          !element.closest('[data-book-target]:not([data-active="true"])') &&
          element.getBoundingClientRect().width > 0,
      );
      if (panel && page) {
        const bounds = page.getBoundingClientRect();
        const workspace = page.closest(".editor-workspace")?.getBoundingClientRect();
        const left = Math.max(
          8,
          Math.min(bounds.right + 8, window.innerWidth - panel.offsetWidth - 8),
        );
        const top = Math.max(
          8,
          Math.min(
            Math.max(bounds.top, workspace?.top ?? 8),
            window.innerHeight - panel.offsetHeight - 8,
          ),
        );
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
      }
      // The page can move during zoom and pane transitions without changing its layout size.
      frame = requestAnimationFrame(position);
    };
    position();
    return () => cancelAnimationFrame(frame);
  }, [anchor, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  const submit = (requestedRows: number, requestedColumns: number) => {
    if (!validDimensions(requestedRows, requestedColumns)) {
      setError("行数应为 1–100，列数应为 1–30。");
      return;
    }
    setError(null);
    onConfirm({
      rows: requestedRows,
      columns: requestedColumns,
      headerRowCount: headerRow ? 1 : 0,
      layoutMode: "fit-page",
    });
  };

  return createPortal(
    <SpatialPresence>
      {open ? (
        <section className="insert-table-popover" aria-label="插入表格设置" ref={panelRef}>
          <p className="insert-table-popover__preview">
            {hovered.rows} 行 × {hovered.columns} 列
          </p>
          <fieldset className="insert-table-popover__grid" aria-label="快速选择表格大小">
            {Array.from({ length: 100 }, (_, index) => {
              const gridRows = Math.floor(index / 10) + 1;
              const gridColumns = (index % 10) + 1;
              const active = gridRows <= hovered.rows && gridColumns <= hovered.columns;
              return (
                <button
                  type="button"
                  className={active ? "is-active" : undefined}
                  aria-label={`插入 ${gridRows} 行 ${gridColumns} 列表格`}
                  key={`${gridRows}-${gridColumns}`}
                  onMouseEnter={() => setHovered({ rows: gridRows, columns: gridColumns })}
                  onFocus={() => setHovered({ rows: gridRows, columns: gridColumns })}
                  onClick={() => submit(gridRows, gridColumns)}
                />
              );
            })}
          </fieldset>
          <div className="insert-table-popover__custom">
            <label>
              行数
              <input
                type="number"
                min="1"
                max="100"
                value={rows}
                onChange={(event) => setRows(event.target.value)}
              />
            </label>
            <label>
              列数
              <input
                type="number"
                min="1"
                max="30"
                value={columns}
                onChange={(event) => setColumns(event.target.value)}
              />
            </label>
          </div>
          <label className="insert-table-popover__header-row">
            <input
              type="checkbox"
              checked={headerRow}
              onChange={(event) => setHeaderRow(event.target.checked)}
            />
            将首行设为标题行
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <button
            type="button"
            className="primary-button"
            onClick={() => submit(Number(rows), Number(columns))}
          >
            插入自定义表格
          </button>
        </section>
      ) : null}
    </SpatialPresence>,
    document.body,
  );
}
