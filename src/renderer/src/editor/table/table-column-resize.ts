import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { columnResizingPluginKey, TableMap } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { TABLE_COMMAND_COLUMN_WIDTH_META } from "./table-column-width-sync";
import { editorContentWidthMm } from "./table-layout-width";
import { resizeConstrainedWidths, tableWidthConstraints } from "./table-width-constraints";

/** Keep resize previews out of the document and convert screen movement back to layout pixels. */
export function beginTableColumnResize(
  view: EditorView,
  event: MouseEvent,
  minimum: number,
  editor: Editor,
): boolean {
  const resize = columnResizingPluginKey.getState(view.state);
  if (!view.editable || !resize || resize.activeHandle < 0 || resize.dragging) return false;
  if (event.button !== 0) return true;
  const $cell = view.state.doc.resolve(resize.activeHandle);
  const node = $cell.node(-1);
  const start = $cell.start(-1);
  const map = TableMap.get(node);
  const activeCell = $cell.nodeAfter;
  if (!activeCell) return false;
  const column = map.colCount($cell.pos - start) + activeCell.attrs.colspan - 1;
  const root = view.nodeDOM(start - 1);
  const table =
    root instanceof HTMLTableElement
      ? root
      : root instanceof HTMLElement
        ? root.querySelector("table")
        : null;
  if (!table) return false;
  const columns = [...table.querySelectorAll<HTMLTableColElement>(":scope > colgroup > col")];
  const weights: number[] = Array.isArray(node.attrs.columnWidthsMm)
    ? [...node.attrs.columnWidthsMm]
    : Array.from({ length: map.width }, () => 113);
  if (!Array.isArray(node.attrs.columnWidthsMm)) {
    for (const offset of new Set(map.map)) {
      const cell = node.nodeAt(offset);
      if (!cell) return false;
      const rect = map.findCell(offset);
      for (let index = 0; index < cell.attrs.colspan; index++) {
        const width = cell.attrs.colwidth?.[index];
        if (width > 0) weights[rect.left + index] = width;
      }
    }
  }
  const total = weights.reduce((sum, width) => sum + width, 0);
  let widths = weights.map(
    (weight, index) => columns[index]?.offsetWidth || (table.offsetWidth * weight) / total,
  );
  if (widths.some((width) => !(width > 0))) return false;
  const originalWidths = [...widths];
  const constraints = tableWidthConstraints(node, minimum);
  const scale = table.getBoundingClientRect().width / table.offsetWidth || 1;
  const renderedColumnTotal = columns.reduce(
    (sum, columnElement) => sum + columnElement.getBoundingClientRect().width / scale,
    0,
  );
  const collapsedBorderWidth = Math.max(0, table.offsetWidth - renderedColumnTotal);
  const maxTotal = Math.max(
    0,
    ((editorContentWidthMm(editor) ?? 165) * 96) / 25.4 - collapsedBorderWidth,
  );
  const startDoc = view.state.doc;
  const startSelection = view.state.selection;
  const startWidth = widths[column];
  if (startWidth === undefined) return false;
  const originalTableStyle = table.style.cssText;
  const originalColumnStyles = columns.map((col) => col.style.cssText);
  const win = view.dom.ownerDocument.defaultView ?? window;
  event.preventDefault();
  view.dispatch(
    view.state.tr.setMeta(columnResizingPluginKey, {
      setDragging: { startX: event.clientX, startWidth },
    }),
  );
  const valid = () =>
    !view.isDestroyed &&
    view.editable &&
    view.state.doc === startDoc &&
    view.state.selection.eq(startSelection);
  const cleanup = () => {
    win.removeEventListener("mousemove", move);
    win.removeEventListener("mouseup", finish);
    win.removeEventListener("blur", cancel);
    editor.off("destroy", cancel);
    view.dom.ownerDocument.removeEventListener("keydown", keydown);
    if (!view.isDestroyed && view.state.doc === startDoc) {
      table.style.cssText = originalTableStyle;
      columns.forEach((col, index) => {
        col.style.cssText = originalColumnStyles[index] ?? "";
      });
    }
    if (!view.isDestroyed)
      view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: null }));
  };
  const cancel = () => cleanup();
  const keydown = (key: KeyboardEvent) => {
    if (key.key === "Escape") {
      key.preventDefault();
      cancel();
    }
  };
  const widthsAt = (x: number) =>
    resizeConstrainedWidths(
      originalWidths,
      column,
      (x - event.clientX) / scale,
      maxTotal,
      constraints,
    );
  const move = (next: MouseEvent) => {
    if (!valid()) {
      cancel();
      return;
    }
    widths = widthsAt(next.clientX);
    columns.forEach((col, index) => {
      col.style.width = `${widths[index]}px`;
    });
    table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    table.style.minWidth = "";
  };
  const finish = (next: MouseEvent) => {
    const commit = valid() && next.clientX !== event.clientX;
    cleanup();
    if (!commit) return;
    widths = widthsAt(next.clientX);
    if (widths.every((width, index) => Math.abs(width - (originalWidths[index] ?? 0)) < 0.001))
      return;
    let tr = closeHistory(view.state.tr).setNodeMarkup(start - 1, undefined, {
      ...node.attrs,
      layoutMode: "fixed",
      columnWidthsMm: widths.map((width) => Math.round(((width * 25.4) / 96) * 1000) / 1000),
    });
    for (const offset of new Set(map.map)) {
      const cell = node.nodeAt(offset);
      if (!cell) throw new Error("调整列宽时单元格不存在");
      const rect = map.findCell(offset);
      tr = tr.setNodeMarkup(start + offset, undefined, {
        ...cell.attrs,
        colwidth: widths.slice(rect.left, rect.right).map(Math.round),
      });
    }
    view.dispatch(tr.setMeta(TABLE_COMMAND_COLUMN_WIDTH_META, true));
    view.dispatch(closeHistory(view.state.tr));
  };
  win.addEventListener("mousemove", move);
  win.addEventListener("mouseup", finish);
  win.addEventListener("blur", cancel);
  editor.on("destroy", cancel);
  view.dom.ownerDocument.addEventListener("keydown", keydown);
  return true;
}
