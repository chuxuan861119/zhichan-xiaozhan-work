import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { displayDocumentFont } from "../../../../shared/document/font-policy";

export function selectContextTarget(editor: Editor, position: number, nodePosition?: number): void {
  const { selection, doc } = editor.state;
  // A selected cell range or text range wins over the individual clicked node.
  if (!selection.empty && position >= selection.from && position < selection.to) return;
  const node = nodePosition === undefined ? null : doc.nodeAt(nodePosition);
  const next =
    node && NodeSelection.isSelectable(node)
      ? NodeSelection.create(doc, nodePosition as number)
      : TextSelection.near(doc.resolve(Math.max(0, Math.min(position, doc.content.size))));
  editor.view.dispatch(editor.state.tr.setSelection(next));
}

export function menuFormatValue(
  editor: Editor,
  attribute: string,
  fallback: string | number,
): string {
  const { from, to, empty, $from } = editor.state.selection;
  const blockAttribute =
    attribute === "fontFamily"
      ? "defaultFontFamily"
      : attribute === "fontSizePt"
        ? "defaultFontSizePt"
        : attribute;
  const values = new Set<string>();
  const displayValue = (value: unknown) =>
    attribute === "fontFamily" ? displayDocumentFont(String(value)) : String(value);
  if (empty)
    return displayValue(
      editor.getAttributes("textStyle")[attribute] ??
        $from.parent.attrs[blockAttribute] ??
        fallback,
    );
  editor.state.doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (!node.isText) return;
    const attrs = node.marks.find((mark) => mark.type.name === "textStyle")?.attrs;
    values.add(displayValue(attrs?.[attribute] ?? parent?.attrs[blockAttribute] ?? fallback));
  });
  return values.size > 1
    ? "mixed"
    : ([...values][0] ?? displayValue($from.parent.attrs[blockAttribute] ?? fallback));
}

export function runMenuClipboard(
  editor: Editor,
  command: "copy" | "cut" | "paste",
  native = (value: string) => document.execCommand(value),
): boolean {
  if (editor.isDestroyed || (!editor.isEditable && command !== "copy")) return false;
  editor.view.focus();
  if (command !== "paste" && editor.state.selection.empty) return false;
  // Copy first: a rejected clipboard write must never erase the source.
  const doc = editor.state.doc;
  const selection = editor.state.selection;
  let rejected = false;
  // A cancelled copy with no supplied data (e.g. an image-count limit) can
  // still make execCommand return true. Observe the handled event as well.
  const copiedEvent = (event: ClipboardEvent) => {
    if (event.defaultPrevented && !event.clipboardData?.types.length) rejected = true;
  };
  document.addEventListener("copy", copiedEvent);
  let copied: boolean;
  try {
    copied = native(command === "cut" ? "copy" : command);
  } finally {
    document.removeEventListener("copy", copiedEvent);
  }
  if (
    !copied ||
    rejected ||
    editor.isDestroyed ||
    editor.state.doc !== doc ||
    !editor.state.selection.eq(selection)
  )
    return false;
  return command === "cut" ? editor.commands.deleteSelection() : true;
}

export function pasteIntoMenuEditor(
  editor: Editor,
  request: () => Promise<{ ok: boolean }>,
): Promise<boolean> {
  if (editor.isDestroyed || !editor.isEditable) return Promise.resolve(false);
  const doc = editor.state.doc;
  const selection = editor.state.selection;
  editor.view.focus();
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      document.removeEventListener("paste", receive, true);
      resolve(ok);
    };
    const receive = (event: ClipboardEvent) => {
      const valid =
        !editor.isDestroyed &&
        editor.isEditable &&
        editor.state.doc === doc &&
        editor.state.selection.eq(selection) &&
        event.target instanceof Node &&
        editor.view.dom.contains(event.target);
      if (!valid) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      finish(valid);
    };
    const timer = setTimeout(() => finish(false), 2000);
    document.addEventListener("paste", receive, true);
    void request().then(
      (result) => {
        if (!result.ok) finish(false);
      },
      () => finish(false),
    );
  });
}
