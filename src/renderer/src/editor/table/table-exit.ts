import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { type Node as ProseMirrorNode, type ResolvedPos, Slice } from "@tiptap/pm/model";
import {
  Plugin,
  Selection,
  type SelectionBookmark,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import type { Mappable } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

const selectionType = "patent-table-end";
type BodyAttributes = Record<string, unknown>;

function isTableEnd(selection: Selection): selection is TableEndSelection {
  // JSON identity also accepts a selection restored by an earlier HMR module.
  return selection.toJSON().type === selectionType;
}

function lastCellEnd(doc: ProseMirrorNode, tablePosition: number): number {
  const table = doc.nodeAt(tablePosition);
  if (table?.type.spec.tableRole !== "table") throw new RangeError("Expected table boundary");
  const offset = TableMap.get(table).map.at(-1);
  if (offset === undefined) throw new RangeError("Expected a final table cell");
  const cellPosition = tablePosition + 1 + offset;
  const cell = doc.nodeAt(cellPosition);
  if (!cell) throw new RangeError("Expected a final table cell");
  return TextSelection.near(doc.resolve(cellPosition + cell.nodeSize - 1), -1).from;
}

function resolveEnd(doc: ProseMirrorNode, pos: number, attrs: BodyAttributes): Selection {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  return $pos.nodeBefore?.type.spec.tableRole === "table"
    ? new TableEndSelection($pos, attrs)
    : Selection.near($pos);
}

class TableEndBookmark implements SelectionBookmark {
  constructor(
    readonly pos: number,
    readonly attrs: BodyAttributes,
  ) {}
  map(mapping: Mappable) {
    return new TableEndBookmark(mapping.map(this.pos, -1), this.attrs);
  }
  resolve(doc: ProseMirrorNode) {
    return resolveEnd(doc, this.pos, this.attrs);
  }
}

/** A document boundary, not an empty paragraph or an in-cell text selection. */
export class TableEndSelection extends Selection {
  override readonly visible = false;
  constructor(
    $pos: ResolvedPos,
    readonly paragraphAttributes: BodyAttributes = {},
  ) {
    super($pos, $pos);
  }
  eq(other: Selection): boolean {
    return isTableEnd(other) && other.from === this.from;
  }
  map(doc: ProseMirrorNode, mapping: Mappable) {
    return resolveEnd(doc, mapping.map(this.from, -1), this.paragraphAttributes);
  }
  toJSON() {
    return { type: selectionType, pos: this.from, paragraphAttributes: this.paragraphAttributes };
  }
  static override fromJSON(
    doc: ProseMirrorNode,
    json: { pos: number; paragraphAttributes?: BodyAttributes },
  ) {
    return resolveEnd(doc, json.pos, json.paragraphAttributes ?? {});
  }
  override getBookmark() {
    return new TableEndBookmark(this.from, this.paragraphAttributes);
  }
  enterBody(tr: Transaction) {
    const position = this.from;
    const paragraph = tr.doc.type.schema.nodes.paragraph;
    if (!paragraph) throw new RangeError("Table-end input requires a paragraph node");
    const following = tr.doc.nodeAt(position);
    if (following && following.type === paragraph && following.content.size === 0) {
      tr.setNodeMarkup(position, undefined, { ...following.attrs, ...this.paragraphAttributes });
    } else {
      tr.insert(position, paragraph.create(this.paragraphAttributes));
    }
    tr.setSelection(TextSelection.create(tr.doc, position + 1)).setStoredMarks(null);
    closeHistory(tr);
    return tr;
  }
  override replace(tr: Transaction, content = Slice.empty) {
    if (!content.size) return;
    this.enterBody(tr);
    tr.selection.replace(tr, content);
  }
  override replaceWith(tr: Transaction, node: ProseMirrorNode) {
    this.enterBody(tr);
    tr.selection.replaceWith(tr, node);
  }
}

try {
  Selection.jsonID(selectionType, TableEndSelection);
} catch (error) {
  // ProseMirror's registry outlives renderer HMR; the registered deserializer
  // remains compatible with the identical JSON format.
  if (
    !(error instanceof RangeError) ||
    !error.message.includes("Duplicate use of selection JSON ID")
  )
    throw error;
}

function selectEnd(view: EditorView, pos: number, attrs: BodyAttributes) {
  view.dispatch(
    view.state.tr
      .setSelection(new TableEndSelection(view.state.doc.resolve(pos), attrs))
      .setStoredMarks(null),
  );
}

function endCaretView(view: EditorView, attrs: BodyAttributes) {
  const caret = document.createElement("span");
  caret.className = "table-end-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.hidden = true;
  document.body.append(caret);
  let observedTable: Element | null = null;
  const render = () => {
    const selection = view.state.selection;
    const active = isTableEnd(selection) && view.editable && view.hasFocus();
    view.dom.toggleAttribute("data-table-end-active", active);
    caret.hidden = true;
    if (!active) return;
    const tableNode = selection.$from.nodeBefore;
    if (tableNode?.type.spec.tableRole !== "table") return;
    const tablePos = selection.from - tableNode.nodeSize;
    const wrapper = view.nodeDOM(tablePos);
    if (!(wrapper instanceof HTMLElement)) return;
    const table = wrapper.querySelector("table");
    if (!table) return;
    if (table !== observedTable) {
      if (observedTable) observer?.unobserve(observedTable);
      observer?.observe(table);
      observedTable = table;
    }
    try {
      const rect = table.getBoundingClientRect();
      const line = view.coordsAtPos(lastCellEnd(view.state.doc, tablePos), -1);
      const left = rect.right + 3;
      const height = Math.max(12, line.bottom - line.top);
      // The portal is outside CSS zoom and scrolling ancestors. Clip it explicitly.
      let topLimit = 0;
      let bottomLimit = window.innerHeight;
      let leftLimit = 0;
      let rightLimit = window.innerWidth;
      for (let parent = view.dom.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          topLimit = Math.max(topLimit, bounds.top);
          bottomLimit = Math.min(bottomLimit, bounds.bottom);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          leftLimit = Math.max(leftLimit, bounds.left);
          rightLimit = Math.min(rightLimit, bounds.right);
        }
      }
      if (
        line.top < topLimit ||
        line.top + height > bottomLimit ||
        left < leftLimit ||
        left >= rightLimit
      )
        return;
      caret.style.left = `${left}px`;
      caret.style.top = `${line.top}px`;
      caret.style.height = `${height}px`;
      caret.style.backgroundColor =
        getComputedStyle(view.dom).getPropertyValue("--editor-caret-color") ||
        getComputedStyle(view.dom).color;
      caret.hidden = false;
    } catch {
      // Detached editors and DOM-less tests have no measurable text line.
    }
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(render);
  observer?.observe(view.dom);
  const click = (event: Event) => {
    if (
      !(event instanceof MouseEvent) ||
      event.button !== 0 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !view.editable
    )
      return;
    const target = event.target;
    // Retained React editors are mounted after their plugin views are created.
    // Resolve the current paper for each click instead of binding to a detached host.
    const host =
      view.dom.closest(".patent-page-with-rail") ??
      view.dom.closest(".patent-page-zoom-frame, .editor-paper") ??
      view.dom.closest(".patent-book-rich-text") ??
      view.dom.parentElement ??
      view.dom;
    if (!(target instanceof Node) || !host.contains(target)) return;
    if (
      !(target instanceof Element) ||
      target.closest(
        "button, input, textarea, select, a, [role='button'], .patent-global-function-rail-slot, .patent-global-function-rail, .table-annotation, .table-selection-controls, .table-insertion-controls",
      )
    )
      return;
    if (target.closest("td, th, table")) return;
    const targetPaper = target.closest(".patent-book-rich-text, .editor-paper");
    if (targetPaper && !targetPaper.contains(view.dom)) return;
    let position: number | null = null;
    view.state.doc.forEach((node, pos) => {
      if (node.type.spec.tableRole !== "table") return;
      const wrapper = view.nodeDOM(pos);
      if (!(wrapper instanceof HTMLElement)) return;
      const table = wrapper.querySelector("table");
      if (!table) return;
      const rect = table.getBoundingClientRect();
      const exterior = wrapper.getBoundingClientRect();
      if (
        event.clientY >= exterior.top &&
        event.clientY <= exterior.bottom &&
        event.clientX > rect.right + 1
      )
        position = pos + node.nodeSize;
    });
    if (position === null) return;
    event.preventDefault();
    event.stopPropagation();
    selectEnd(view, position, attrs);
    view.focus();
    render();
  };
  document.addEventListener("mousedown", click, true);
  window.addEventListener("scroll", render, true);
  window.addEventListener("resize", render);
  view.dom.addEventListener("focus", render);
  view.dom.addEventListener("blur", render);
  render();
  return {
    update: render,
    destroy() {
      observer?.disconnect();
      caret.remove();
      view.dom.removeAttribute("data-table-end-active");
      document.removeEventListener("mousedown", click, true);
      window.removeEventListener("scroll", render, true);
      window.removeEventListener("resize", render);
      view.dom.removeEventListener("focus", render);
      view.dom.removeEventListener("blur", render);
    },
  };
}

export const TableExit = Extension.create<{ paragraphAttributes: BodyAttributes }>({
  name: "tableExit",
  priority: 110,
  addOptions() {
    return { paragraphAttributes: {} };
  },
  addKeyboardShortcuts() {
    const editor = this.editor;
    const attrs = this.options.paragraphAttributes;
    const returnToCell = () => {
      const selection = editor.state.selection;
      if (!isTableEnd(selection)) return false;
      const table = selection.$from.nodeBefore;
      if (table?.type.spec.tableRole !== "table") return false;
      editor.view.dispatch(
        editor.state.tr
          .setSelection(
            TextSelection.create(
              editor.state.doc,
              lastCellEnd(editor.state.doc, selection.from - table.nodeSize),
            ),
          )
          .setStoredMarks(null)
          .scrollIntoView(),
      );
      return true;
    };
    return {
      ArrowRight: () => {
        const { selection, doc } = editor.state;
        if (!(selection instanceof TextSelection) || !selection.empty) return false;
        const { $from } = selection;
        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type.spec.tableRole !== "table") continue;
          const pos = $from.before(depth);
          if (selection.from !== lastCellEnd(doc, pos)) return false;
          selectEnd(editor.view, pos + $from.node(depth).nodeSize, attrs);
          return true;
        }
        return false;
      },
      ArrowLeft: returnToCell,
      Backspace: () => {
        if (returnToCell()) return true;
        const { selection } = editor.state;
        const { $from } = selection;
        if (
          !selection.empty ||
          $from.depth !== 1 ||
          $from.parent.type.name !== "paragraph" ||
          $from.parentOffset !== 0
        )
          return false;
        const pos = $from.before();
        if (editor.state.doc.resolve(pos).nodeBefore?.type.spec.tableRole !== "table") return false;
        if ($from.parent.attrs.paragraphIndentMm > 0) {
          const tr = closeHistory(
            editor.state.tr.setNodeMarkup(pos, undefined, {
              ...$from.parent.attrs,
              paragraphIndentMm: 0,
            }),
          );
          editor.view.dispatch(tr);
          return true;
        }
        const tr = editor.state.tr;
        if ($from.parent.content.size === 0) closeHistory(tr.delete(pos, $from.after()));
        tr.setSelection(new TableEndSelection(tr.doc.resolve(pos), attrs)).setStoredMarks(null);
        editor.view.dispatch(tr);
        return true;
      },
      Enter: () => {
        const selection = editor.state.selection;
        if (!isTableEnd(selection)) return false;
        editor.view.dispatch(selection.enterBody(editor.state.tr).scrollIntoView());
        return true;
      },
      Delete: () => {
        if (!isTableEnd(editor.state.selection)) return false;
        // Never let a forward delete at the boundary remove the entire table.
        const next = Selection.findFrom(editor.state.selection.$from, 1, true);
        if (next) editor.view.dispatch(editor.state.tr.setSelection(next).setStoredMarks(null));
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const attrs = this.options.paragraphAttributes;
    let composition: {
      selection: TableEndSelection;
      following: ProseMirrorNode | null;
      preparedDoc: ProseMirrorNode;
    } | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    const prepareComposition = (view: EditorView) => {
      if (view.editable && isTableEnd(view.state.selection)) {
        const selection = view.state.selection;
        const following = selection.$from.nodeAfter;
        view.dispatch(selection.enterBody(view.state.tr));
        composition = { selection, following, preparedDoc: view.state.doc };
      }
      return false;
    };
    return [
      new Plugin({
        props: {
          handleTextInput: (view, _from, _to, text) => {
            if (!view.editable || !isTableEnd(view.state.selection)) return false;
            view.dispatch(view.state.tr.insertText(text).scrollIntoView());
            return true;
          },
          handleDOMEvents: {
            compositionstart: prepareComposition,
            compositionend: (view) => {
              const pending = composition;
              composition = null;
              if (!pending) return false;
              cleanupTimer = setTimeout(() => {
                cleanupTimer = null;
                // Only undo our empty preparation; never revert text or intervening edits.
                if (view.isDestroyed || view.composing || !view.state.doc.eq(pending.preparedDoc))
                  return;
                const pos = pending.selection.from;
                const body = view.state.doc.nodeAt(pos);
                if (body?.type.name !== "paragraph" || body.content.size !== 0) return;
                const tr = view.state.tr;
                if (
                  pending.following?.type.name === "paragraph" &&
                  pending.following.content.size === 0
                )
                  tr.replaceWith(pos, pos + body.nodeSize, pending.following);
                else tr.delete(pos, pos + body.nodeSize);
                tr.setSelection(new TableEndSelection(tr.doc.resolve(pos), attrs)).setStoredMarks(
                  null,
                );
                view.dispatch(tr);
              }, 0);
              return false;
            },
            beforeinput: (view, event) => {
              if (event.inputType === "insertCompositionText") return prepareComposition(view);
              if (
                view.editable &&
                isTableEnd(view.state.selection) &&
                event.inputType === "insertText" &&
                event.data
              ) {
                event.preventDefault();
                view.dispatch(view.state.tr.insertText(event.data).scrollIntoView());
                return true;
              }
              return false;
            },
          },
        },
        view: (view) => {
          const caret = endCaretView(view, attrs);
          return {
            update: caret.update,
            destroy() {
              if (cleanupTimer !== null) clearTimeout(cleanupTimer);
              composition = null;
              caret.destroy();
            },
          };
        },
      }),
    ];
  },
});
