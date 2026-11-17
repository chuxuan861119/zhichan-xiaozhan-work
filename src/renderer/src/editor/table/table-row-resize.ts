import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { lineSpacingToCssLineHeight } from "../../../../shared/document/line-spacing";
import {
  TABLE_ROW_HEIGHT_MAX_MM,
  TABLE_ROW_HEIGHT_MIN_MM,
} from "../../../../shared/document/model";
import { isBlankTableCell, setTableRowHeightByIndexes } from "./table-commands";
import { inspectTableSelection } from "./table-selection";

const PIXELS_PER_MILLIMETRE = 96 / 25.4;

function clampHeight(heightMm: number): number {
  return (
    Math.round(
      Math.min(TABLE_ROW_HEIGHT_MAX_MM, Math.max(TABLE_ROW_HEIGHT_MIN_MM, heightMm)) * 10,
    ) / 10
  );
}

function createResizeHandle(row: number, cellPosition: number, tableFrom: number): HTMLElement {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "table-row-resize-handle";
  handle.setAttribute("aria-label", `调整第 ${row + 1} 行行高`);
  handle.setAttribute("title", "拖动调整行高，内容较多时自动撑高");
  handle.dataset.tableRowResize = String(row);
  handle.dataset.tableSelectionCell = String(cellPosition);
  handle.dataset.tableFrom = String(tableFrom);
  return handle;
}

function rowResizeDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, tableFrom) => {
    if (node.type.spec.tableRole !== "table") return;
    const map = TableMap.get(node);
    const tableStart = tableFrom + 1;
    for (let row = 0; row < map.height; row += 1) {
      const offsets = new Set(map.map.slice(row * map.width, (row + 1) * map.width));
      for (const offset of offsets) {
        // A rowspan has no horizontal edge inside it; expose only its actual bottom edge.
        if (map.findCell(offset).bottom !== row + 1) continue;
        const cellPosition = tableStart + offset;
        decorations.push(
          Decoration.widget(
            cellPosition + 1,
            () => createResizeHandle(row, cellPosition, tableFrom),
            {
              side: 1,
              ignoreSelection: true,
            },
          ),
        );
      }
    }
  });
  return DecorationSet.create(doc, decorations);
}

function rowHeightFromElement(row: HTMLTableRowElement, scale: number): number {
  const persisted = Number(row.getAttribute("data-row-height-mm"));
  const measured = row.getBoundingClientRect().height / scale / PIXELS_PER_MILLIMETRE;
  // A minimum is not the current height: content may have expanded the row.
  if (measured > 0 && Number.isFinite(measured)) return clampHeight(measured);
  if (Number.isFinite(persisted) && persisted >= TABLE_ROW_HEIGHT_MIN_MM) return persisted;
  return clampHeight(measured || TABLE_ROW_HEIGHT_MIN_MM);
}

function beginRowResize(editor: Editor, handle: HTMLElement, event: MouseEvent): boolean {
  if (!editor.isEditable) return true;
  if (event.button !== 0) return true;
  const rowIndex = Number(handle.dataset.tableRowResize);
  const cellPosition = Number(handle.dataset.tableSelectionCell);
  const tableFrom = Number(handle.dataset.tableFrom);
  if (
    !Number.isSafeInteger(rowIndex) ||
    !Number.isSafeInteger(cellPosition) ||
    !Number.isSafeInteger(tableFrom)
  )
    return false;

  const currentSelection = inspectTableSelection(editor);
  const selectedRows =
    editor.state.selection instanceof CellSelection &&
    currentSelection.tableFrom === Number(handle.dataset.tableFrom) &&
    currentSelection.selectedRowIndexes.includes(rowIndex)
      ? currentSelection.selectedRowIndexes
      : [rowIndex];
  const tableDom = editor.view.nodeDOM(tableFrom);
  const table =
    tableDom instanceof HTMLTableElement
      ? tableDom
      : tableDom instanceof HTMLElement
        ? tableDom.querySelector("table")
        : null;
  const row = table?.rows[rowIndex];
  if (!row) return false;
  event.preventDefault();
  const startY = event.clientY;
  const measuredScale =
    row.offsetHeight > 0 ? row.getBoundingClientRect().height / row.offsetHeight : 1;
  const scale = measuredScale > 0 && Number.isFinite(measuredScale) ? measuredScale : 1;
  const startHeightMm = rowHeightFromElement(row, scale);
  const rule = "at-least";
  editor.commands.focus(undefined, { scrollIntoView: false });
  const startDocument = editor.state.doc;
  const startSelection = editor.state.selection;
  const previewRows = selectedRows.flatMap((index) => {
    const element = table?.rows[index];
    return element
      ? [{ element, height: element.style.getPropertyValue("--patent-row-height") }]
      : [];
  });
  const blankCells: HTMLElement[] = [];
  const tableNode = startDocument.nodeAt(tableFrom);
  tableNode?.forEach((node, rowOffset, index) => {
    if (!selectedRows.includes(index)) return;
    node.forEach((cell, cellOffset) => {
      if (!isBlankTableCell(cell)) return;
      const element = editor.view.nodeDOM(tableFrom + 2 + rowOffset + cellOffset);
      if (element instanceof HTMLElement) blankCells.push(element);
    });
  });
  let currentHeightMm = startHeightMm;
  let moved = false;

  const cleanup = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("blur", cleanup);
    editor.off("destroy", cleanup);
    for (const { element, height } of previewRows) {
      if (height) element.style.setProperty("--patent-row-height", height);
      else element.style.removeProperty("--patent-row-height");
      delete element.dataset.tableRowResizePreview;
    }
    for (const cell of blankCells) {
      delete cell.dataset.tableRowResizeCompact;
      cell.style.removeProperty("--table-resize-line-height");
    }
    delete handle.dataset.tableRowResizeValue;
  };
  const onMove = (moveEvent: MouseEvent) => {
    moved = moveEvent.clientY !== startY;
    currentHeightMm = clampHeight(
      startHeightMm + (moveEvent.clientY - startY) / scale / PIXELS_PER_MILLIMETRE,
    );
    for (const { element } of previewRows) {
      element.style.setProperty("--patent-row-height", `${currentHeightMm}mm`);
      element.dataset.tableRowResizePreview = "true";
    }
    for (const cell of blankCells) {
      if (currentHeightMm < startHeightMm) {
        cell.dataset.tableRowResizeCompact = "true";
        cell.style.setProperty("--table-resize-line-height", String(lineSpacingToCssLineHeight(1)));
      } else {
        delete cell.dataset.tableRowResizeCompact;
        cell.style.removeProperty("--table-resize-line-height");
      }
    }
    handle.dataset.tableRowResizeValue = `${currentHeightMm} mm`;
  };
  const onUp = () => {
    cleanup();
    if (
      !moved ||
      editor.isDestroyed ||
      !editor.isEditable ||
      editor.state.doc !== startDocument ||
      !editor.state.selection.eq(startSelection)
    )
      return;
    setTableRowHeightByIndexes(
      editor,
      tableFrom,
      { heightMm: currentHeightMm, rule },
      selectedRows,
      { compactBlankCells: currentHeightMm < startHeightMm },
    );
  };
  const onKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape") return;
    cleanup();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp, { once: true });
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("blur", cleanup, { once: true });
  editor.on("destroy", cleanup);
  return true;
}

export const TableRowResize = Extension.create({
  name: "tableRowResize",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        // Decorations only exist at a cell's actual bottom edge, including rowspans.
        // CSS anchors the handle there. Measuring animated cell rectangles against
        // untransformed rows would move handles outside the table and create overflow.
        state: {
          init: (_, state) => rowResizeDecorations(state.doc),
          apply: (transaction, decorations) =>
            transaction.docChanged ? rowResizeDecorations(transaction.doc) : decorations,
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleDOMEvents: {
            mousedown: (_view, event) => {
              if (!(event.target instanceof Element)) return false;
              const handle = event.target.closest<HTMLElement>("[data-table-row-resize]");
              return handle ? beginRowResize(this.editor, handle, event) : false;
            },
          },
        },
      }),
    ];
  },
});
