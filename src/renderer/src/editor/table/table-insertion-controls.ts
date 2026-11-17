import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { runTableCommand } from "./table-commands";
import { isTableInsertionAnimating } from "./table-insertion-animation";
import {
  selectedInsertionPreview,
  TABLE_INSERTION_PREVIEW,
  type TableInsertionCommand,
} from "./table-insertion-feedback";

type InsertionTarget = {
  cell: HTMLTableCellElement;
  axis: "row" | "column";
  side: "before" | "after";
  boundary: number;
  table: DOMRect;
};

// Viewport-space controls stay outside the table's scroll/clipping containers.
export const TableInsertionControls = Extension.create({
  name: "tableInsertionControls",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        view(view) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "table-insert-handle";
          button.textContent = "+";
          button.hidden = true;
          const guide = document.createElement("div");
          guide.className = "table-insert-guide";
          guide.setAttribute("aria-hidden", "true");
          guide.hidden = true;
          document.body.append(button, guide);
          let target: InsertionTarget | null = null;
          let railPreview = false;
          let retainingRowHandle = false;
          const hide = () => {
            railPreview = false;
            retainingRowHandle = false;
            target = null;
            button.hidden = true;
            guide.hidden = true;
          };
          const showGuide = (next: {
            axis: "row" | "column";
            boundary: number;
            table: DOMRect;
          }) => {
            const row = next.axis === "row";
            guide.dataset.axis = next.axis;
            guide.style.left = `${row ? next.table.left : next.boundary - 1}px`;
            guide.style.top = `${row ? next.boundary - 1 : next.table.top}px`;
            guide.style.width = `${row ? next.table.width : 2}px`;
            guide.style.height = `${row ? 2 : next.table.height}px`;
            guide.hidden = false;
          };
          const show = (next: InsertionTarget) => {
            target = next;
            const row = next.axis === "row";
            const label = row ? "插入行" : "插入列";
            button.setAttribute("aria-label", label);
            button.title = label;
            button.style.left = `${row ? next.table.left - 8 : next.boundary}px`;
            button.style.top = `${row ? next.boundary : next.table.top - 8}px`;
            showGuide(next);
            button.hidden = false;
            guide.hidden = false;
          };
          const move = (event: MouseEvent) => {
            if (!editor.isEditable || event.buttons) return hide();
            if (railPreview) return;
            if (event.target === button) return;
            if (isTableInsertionAnimating(editor)) return hide();
            const surface =
              view.dom.closest(".patent-book-rich-text, .editor-paper") ?? view.dom.parentElement;
            if (!(event.target instanceof Node) || !surface?.contains(event.target)) return hide();
            for (const table of view.dom.querySelectorAll("table")) {
              const bounds = table.getBoundingClientRect();
              const row = event.clientX >= bounds.left - 32 && event.clientX <= bounds.left - 2;
              const column = event.clientY >= bounds.top - 32 && event.clientY <= bounds.top - 2;
              if (!row && !column) continue;
              let nearest: InsertionTarget | null = null;
              let distance = 9;
              for (const tr of table.rows)
                for (const cell of tr.cells) {
                  const rect = cell.getBoundingClientRect();
                  for (const axis of ["row", "column"] as const) {
                    if (
                      axis === "row"
                        ? !row || Math.abs(rect.left - bounds.left) > 2
                        : !column || Math.abs(rect.top - bounds.top) > 2
                    )
                      continue;
                    for (const side of ["before", "after"] as const) {
                      const boundary =
                        axis === "row"
                          ? side === "before"
                            ? rect.top
                            : rect.bottom
                          : side === "before"
                            ? rect.left
                            : rect.right;
                      // An interior edge is represented by the following cell only.
                      if (
                        side === "after" &&
                        Math.abs(boundary - (axis === "row" ? bounds.bottom : bounds.right)) > 2
                      )
                        continue;
                      // Preserve the existing rule that a header remains the first row.
                      if (
                        axis === "row" &&
                        side === "before" &&
                        tr.rowIndex === 0 &&
                        cell.tagName === "TH"
                      )
                        continue;
                      const delta = Math.abs(
                        (axis === "row" ? event.clientY : event.clientX) - boundary,
                      );
                      if (delta < distance) {
                        distance = delta;
                        nearest = { cell, axis, side, boundary, table: bounds };
                      }
                    }
                  }
                }
              if (nearest) return show(nearest);
            }
            hide();
          };
          button.onmousedown = (event) => event.preventDefault();
          button.onclick = () => {
            const current = target;
            if (!current || !editor.isEditable) return;
            const position = view.posAtDOM(current.cell, 0);
            const resolved = view.state.doc.resolve(position);
            let cellPosition: number | null = null;
            let tableFrom: number | null = null;
            for (let depth = resolved.depth; depth > 0; depth -= 1) {
              const role = resolved.node(depth).type.spec.tableRole;
              if (role === "cell" || role === "header_cell") {
                cellPosition = resolved.before(depth);
              } else if (role === "table") {
                tableFrom = resolved.before(depth);
                break;
              }
            }
            if (cellPosition === null) return;
            let insertionIndex: number | null = null;
            if (current.axis === "row" && tableFrom !== null) {
              const tableNode = view.state.doc.nodeAt(tableFrom);
              if (tableNode) {
                const rect = TableMap.get(tableNode).findCell(cellPosition - tableFrom - 1);
                insertionIndex = current.side === "before" ? rect.top : rect.bottom;
                retainingRowHandle = true;
              }
            } else {
              hide();
            }
            view.dispatch(
              closeHistory(
                view.state.tr.setSelection(CellSelection.create(view.state.doc, cellPosition)),
              ),
            );
            const inserted = runTableCommand(editor, `add-${current.axis}-${current.side}`);
            if (
              !inserted ||
              current.axis !== "row" ||
              tableFrom === null ||
              insertionIndex === null
            ) {
              hide();
              return;
            }
            const tableNode = view.state.doc.nodeAt(tableFrom);
            if (!tableNode) {
              hide();
              return;
            }
            const map = TableMap.get(tableNode);
            const offset = map.map[insertionIndex * map.width];
            const cell = offset === undefined ? null : view.nodeDOM(tableFrom + 1 + offset);
            if (!(cell instanceof HTMLTableCellElement)) {
              hide();
              return;
            }
            target = { ...current, cell, side: "before" };
            retainingRowHandle = false;
          };
          const keydown = (event: KeyboardEvent) => {
            if (event.key === "Escape") hide();
          };
          const preview = (event: Event) => {
            hide();
            const command = (event as CustomEvent<TableInsertionCommand | null>).detail;
            if (!command || isTableInsertionAnimating(editor)) return;
            const next = selectedInsertionPreview(editor, command);
            if (next) {
              railPreview = true;
              showGuide(next);
            }
          };
          view.dom.addEventListener(TABLE_INSERTION_PREVIEW, preview);
          document.addEventListener("mousemove", move);
          document.addEventListener("keydown", keydown);
          document.addEventListener("scroll", hide, true);
          window.addEventListener("resize", hide);
          window.addEventListener("blur", hide);
          return {
            update(_view, previous) {
              if (retainingRowHandle) return;
              if (
                previous.doc !== view.state.doc ||
                !previous.selection.eq(view.state.selection) ||
                !editor.isEditable
              )
                hide();
            },
            destroy() {
              view.dom.removeEventListener(TABLE_INSERTION_PREVIEW, preview);
              document.removeEventListener("mousemove", move);
              document.removeEventListener("keydown", keydown);
              document.removeEventListener("scroll", hide, true);
              window.removeEventListener("resize", hide);
              window.removeEventListener("blur", hide);
              button.remove();
              guide.remove();
            },
          };
        },
      }),
    ];
  },
});
