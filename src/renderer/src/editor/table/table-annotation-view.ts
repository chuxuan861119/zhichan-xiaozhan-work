import { redo, undo } from "@tiptap/pm/history";
import type { EditorView } from "@tiptap/pm/view";
import { TABLE_ANNOTATION_FONT_SIZE_PT } from "../../../../shared/document/table-annotations";

/** Annotation editors stay outside tbody so table maps and cell selection remain unchanged. */
export function attachTableAnnotationEditors(
  dom: HTMLElement,
  table: HTMLTableElement,
  view: EditorView,
) {
  const parts = (["name", "note"] as const).map((kind) => {
    const root = document.createElement("div");
    root.className = `table-annotation table-annotation--${kind}`;
    root.contentEditable = "false";
    root.dataset.annotationKind = kind;
    const label = document.createElement("div");
    label.className = "table-annotation__text";
    const input = document.createElement("textarea");
    input.className = "table-annotation__input";
    input.setAttribute("aria-label", kind === "name" ? "编辑表名" : "编辑补充说明");
    input.placeholder = kind === "name" ? "填写表名" : "填写补充说明";
    input.maxLength = kind === "name" ? 2000 : 10000;
    input.rows = 1;
    root.append(label, input);
    if (kind === "name") dom.insertBefore(root, table);
    else dom.append(root);
    const resize = () => {
      // Hidden textareas have no useful geometry. Reading them still forces a
      // document-wide layout after style writes, even when annotations are off.
      if (root.hidden || !root.classList.contains("is-editing")) return;
      input.style.height = "auto";
      input.style.height = `${Math.max(input.scrollHeight, 24)}px`;
    };
    label.addEventListener("click", () => {
      root.classList.add("is-editing");
      input.focus();
      resize();
    });
    input.addEventListener("blur", () => root.classList.remove("is-editing"));
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        (event.shiftKey ? redo : undo)(view.state, view.dispatch);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo(view.state, view.dispatch);
      }
    });
    input.addEventListener("input", () => {
      if (!view.editable) return;
      let position: number | null = null;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === "table" && view.nodeDOM(pos) === dom) position = pos;
      });
      if (position === null) return;
      const node = view.state.doc.nodeAt(position);
      if (!node) return;
      view.dispatch(
        view.state.tr.setNodeMarkup(position, undefined, {
          ...node.attrs,
          [kind === "name" ? "tableName" : "tableNote"]: input.value,
        }),
      );
      resize();
    });
    return { kind, root, label, input, resize };
  });
  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => syncGeometry());
  function syncGeometry() {
    for (const part of parts) {
      part.root.style.width = table.style.width || "100%";
      part.root.style.maxWidth = "100%";
      part.root.style.marginLeft = table.style.marginLeft;
      part.root.style.marginRight = table.style.marginRight;
      part.resize();
    }
  }
  resizeObserver?.observe(table);
  return {
    sync(attrs: Record<string, unknown>, number: number) {
      const paragraph = table.querySelector<HTMLElement>("td p, th p");
      for (const { kind, root, label, input } of parts) {
        const enabled = attrs[kind === "name" ? "tableNameEnabled" : "tableNoteEnabled"] === true;
        const value = String(attrs[kind === "name" ? "tableName" : "tableNote"] ?? "");
        root.hidden = !enabled;
        if (!enabled) root.classList.remove("is-editing");
        root.style.fontSize = `${TABLE_ANNOTATION_FONT_SIZE_PT}pt`;
        root.style.fontFamily = paragraph?.style.fontFamily || "SimSun, serif";
        if (input.value !== value) input.value = value;
        input.readOnly = !view.editable;
        const text = value.trim();
        const labelText = text
          ? kind === "name"
            ? `表${number} ${text}`
            : text
          : input.placeholder;
        if (label.textContent !== labelText) label.textContent = labelText;
        root.classList.toggle("is-empty", !text);
      }
      syncGeometry();
    },
    destroy() {
      resizeObserver?.disconnect();
    },
  };
}
