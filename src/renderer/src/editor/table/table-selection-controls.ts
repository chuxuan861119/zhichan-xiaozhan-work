import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

type TableContext = {
  map: TableMap;
  tableStart: number;
};

const activePointerSelections = new WeakMap<EditorView, () => void>();

function finishPointerSelection(view: EditorView): void {
  activePointerSelections.get(view)?.();
}

function beginPointerSelection(view: EditorView, event: MouseEvent): void {
  if (event.button !== 0) return;
  if (
    event.target instanceof Element &&
    event.target.closest<HTMLElement>("[data-table-row-resize]")
  )
    return;

  finishPointerSelection(view);
  const root = view.root;
  const win = view.dom.ownerDocument.defaultView ?? window;
  const finish = () => {
    root.removeEventListener("mouseup", finish);
    root.removeEventListener("dragstart", finish);
    win.removeEventListener("blur", finish);
    delete view.dom.dataset.tableSelectionDragging;
    activePointerSelections.delete(view);
  };
  view.dom.dataset.tableSelectionDragging = "true";
  root.addEventListener("mouseup", finish);
  root.addEventListener("dragstart", finish);
  win.addEventListener("blur", finish);
  activePointerSelections.set(view, finish);
}

function tableContextAt(editor: Editor, cellPosition: number): TableContext | null {
  const $cell = editor.state.doc.resolve(cellPosition);
  for (let depth = $cell.depth; depth > 0; depth -= 1) {
    if ($cell.node(depth).type.spec.tableRole !== "table") continue;
    return { map: TableMap.get($cell.node(depth)), tableStart: $cell.start(depth) };
  }
  return null;
}

function selectOffsets(
  editor: Editor,
  context: TableContext,
  anchor: number,
  head: number,
): boolean {
  return editor
    .chain()
    .setCellSelection({
      anchorCell: context.tableStart + anchor,
      headCell: context.tableStart + head,
    })
    .focus()
    .run();
}

function firstOffsetAt(context: TableContext, row: number, column: number): number | null {
  if (row < 0 || row >= context.map.height || column < 0 || column >= context.map.width)
    return null;
  return context.map.map[row * context.map.width + column] ?? null;
}

export function selectTableRow(editor: Editor, cellPosition: number, row: number): boolean {
  const context = tableContextAt(editor, cellPosition);
  if (!context) return false;
  const anchor = firstOffsetAt(context, row, 0);
  const head = firstOffsetAt(context, row, context.map.width - 1);
  return anchor !== null && head !== null && selectOffsets(editor, context, anchor, head);
}

export function selectTableColumn(editor: Editor, cellPosition: number, column: number): boolean {
  const context = tableContextAt(editor, cellPosition);
  if (!context) return false;
  const anchor = firstOffsetAt(context, 0, column);
  const head = firstOffsetAt(context, context.map.height - 1, column);
  return anchor !== null && head !== null && selectOffsets(editor, context, anchor, head);
}

export function selectWholeTable(editor: Editor, cellPosition: number): boolean {
  const context = tableContextAt(editor, cellPosition);
  if (!context) return false;
  const anchor = firstOffsetAt(context, 0, 0);
  const head = firstOffsetAt(context, context.map.height - 1, context.map.width - 1);
  return anchor !== null && head !== null && selectOffsets(editor, context, anchor, head);
}

function createHandle(label: string, attributes: Record<string, string>): HTMLElement {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "table-selection-handle";
  handle.setAttribute("aria-label", label);
  handle.setAttribute("title", label);
  for (const [name, value] of Object.entries(attributes)) handle.setAttribute(name, value);

  const revealKind =
    attributes["data-table-selection-row"] !== undefined
      ? "row"
      : attributes["data-table-selection-column"] !== undefined
        ? "column"
        : attributes["data-table-selection-table"] !== undefined
          ? "table"
          : null;
  if (!revealKind) return handle;

  const reveal = document.createElement("span");
  reveal.className = "table-selection-handle-reveal";
  reveal.dataset.tableSelectionReveal = revealKind;
  reveal.append(handle);
  return reveal;
}

function tableSelectionDecorations(doc: Editor["state"]["doc"]): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, tableFrom) => {
    if (node.type.spec.tableRole !== "table") return;
    const map = TableMap.get(node);
    const tableStart = tableFrom + 1;
    const seen = new Set<number>();
    for (let row = 0; row < map.height; row += 1) {
      for (let column = 0; column < map.width; column += 1) {
        const offset = map.map[row * map.width + column];
        if (offset === undefined || seen.has(offset)) continue;
        seen.add(offset);
        const cellPosition = tableStart + offset;
        const widgetPosition = cellPosition + 1;
        decorations.push(
          Decoration.widget(
            widgetPosition,
            () => createHandle("选择单元格", { "data-table-selection-cell": String(cellPosition) }),
            { side: -1, ignoreSelection: true },
          ),
        );
        if (column === 0) {
          decorations.push(
            Decoration.widget(
              widgetPosition,
              () =>
                createHandle("选择本行", {
                  "data-table-selection-row": String(row),
                  "data-table-selection-cell": String(cellPosition),
                }),
              { side: -1, ignoreSelection: true },
            ),
          );
        }
        if (row === 0) {
          decorations.push(
            Decoration.widget(
              widgetPosition,
              () =>
                createHandle("选择本列", {
                  "data-table-selection-column": String(column),
                  "data-table-selection-cell": String(cellPosition),
                }),
              { side: -1, ignoreSelection: true },
            ),
          );
        }
        if (row === 0 && column === 0) {
          decorations.push(
            Decoration.widget(
              widgetPosition,
              () =>
                createHandle("选择整张表格", {
                  "data-table-selection-table": String(cellPosition),
                  "data-table-selection-cell": String(cellPosition),
                }),
              { side: -1, ignoreSelection: true },
            ),
          );
        }
      }
    }
  });
  return DecorationSet.create(doc, decorations);
}

function tableSelectionBoundaryDecorations(
  doc: Editor["state"]["doc"],
  selection: Editor["state"]["selection"],
): DecorationSet {
  if (!(selection instanceof CellSelection)) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  doc.descendants((node, tableFrom) => {
    if (node.type.spec.tableRole !== "table") return;
    const tableStart = tableFrom + 1;
    const tableEnd = tableFrom + node.nodeSize;
    const anchorCell = selection.$anchorCell.pos;
    const headCell = selection.$headCell.pos;
    if (
      anchorCell < tableStart ||
      anchorCell >= tableEnd ||
      headCell < tableStart ||
      headCell >= tableEnd
    )
      return;

    const map = TableMap.get(node);
    const anchor = map.findCell(anchorCell - tableStart);
    const head = map.findCell(headCell - tableStart);
    const bounds = {
      left: Math.min(anchor.left, head.left),
      top: Math.min(anchor.top, head.top),
      right: Math.max(anchor.right, head.right),
      bottom: Math.max(anchor.bottom, head.bottom),
    };
    const selectedOffsets = new Set<number>();
    for (let row = bounds.top; row < bounds.bottom; row += 1) {
      for (let column = bounds.left; column < bounds.right; column += 1) {
        const offset = map.map[row * map.width + column];
        if (offset !== undefined) selectedOffsets.add(offset);
      }
    }

    for (const offset of selectedOffsets) {
      const cellPosition = tableStart + offset;
      const cell = doc.nodeAt(cellPosition);
      if (!cell) continue;
      const rectangle = map.findCell(offset);
      const classes: string[] = [];
      if (rectangle.top === bounds.top) classes.push("table-selection-boundary-top");
      if (rectangle.right === bounds.right) classes.push("table-selection-boundary-right");
      if (rectangle.bottom === bounds.bottom) classes.push("table-selection-boundary-bottom");
      if (rectangle.left === bounds.left) classes.push("table-selection-boundary-left");
      if (classes.length === 0) continue;
      decorations.push(
        Decoration.node(cellPosition, cellPosition + cell.nodeSize, {
          class: classes.join(" "),
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export function collapseTableSelection(editor: Editor): boolean {
  const { selection } = editor.state;
  if (!(selection instanceof CellSelection)) return false;
  return editor
    .chain()
    .setTextSelection(selection.$anchorCell.pos + 2)
    .focus()
    .run();
}

export const TableSelectionControls = Extension.create({
  name: "tableSelectionControls",

  addKeyboardShortcuts() {
    return { Escape: () => collapseTableSelection(this.editor) };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        view: (view) => ({ destroy: () => finishPointerSelection(view) }),
        state: {
          init: (_, state) => tableSelectionDecorations(state.doc),
          apply: (transaction, decorations) =>
            transaction.docChanged ? tableSelectionDecorations(transaction.doc) : decorations,
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleDOMEvents: {
            mousemove: (view, event) => {
              if (event.buttons === 0) finishPointerSelection(view);
              return false;
            },
            mousedown: (view, event) => {
              beginPointerSelection(view, event);
              if (!(event.target instanceof Element)) return false;
              const handle = event.target.closest<HTMLElement>(".table-selection-handle");
              if (!handle) return false;
              const cellPosition = Number(handle.dataset.tableSelectionCell);
              if (!Number.isSafeInteger(cellPosition)) return false;
              event.preventDefault();
              if (handle.dataset.tableSelectionRow !== undefined)
                return selectTableRow(
                  this.editor,
                  cellPosition,
                  Number(handle.dataset.tableSelectionRow),
                );
              if (handle.dataset.tableSelectionColumn !== undefined)
                return selectTableColumn(
                  this.editor,
                  cellPosition,
                  Number(handle.dataset.tableSelectionColumn),
                );
              if (handle.dataset.tableSelectionTable !== undefined)
                return selectWholeTable(this.editor, cellPosition);
              return this.editor
                .chain()
                .setCellSelection({ anchorCell: cellPosition, headCell: cellPosition })
                .focus()
                .run();
            },
          },
        },
      }),
      new Plugin<DecorationSet>({
        state: {
          init: (_, state) => tableSelectionBoundaryDecorations(state.doc, state.selection),
          apply: (transaction, decorations) =>
            transaction.docChanged || transaction.selectionSet
              ? tableSelectionBoundaryDecorations(transaction.doc, transaction.selection)
              : decorations,
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
