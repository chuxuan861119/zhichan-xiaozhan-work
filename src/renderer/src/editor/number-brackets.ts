import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { EditorState } from "@tiptap/pm/state";
import { AllSelection, TextSelection } from "@tiptap/pm/state";

export function hasBracketTextSelection(state: EditorState): boolean {
  const { selection, doc } = state;
  return (
    !selection.empty &&
    (selection instanceof TextSelection || selection instanceof AllSelection) &&
    doc.textBetween(selection.from, selection.to, "", "").length > 0
  );
}

export function changeNumberBrackets(editor: Editor, add: boolean): boolean {
  if (!editor.isEditable || !hasBracketTextSelection(editor.state)) return false;
  const { doc, selection } = editor.state;
  const edits: { from: number; to: number; text: string }[] = [];
  doc.nodesBetween(selection.from, selection.to, (node, position) => {
    if (node.isAtom) return false;
    if (!node.isTextblock) return;
    // Keep document offsets intact across marks, while treating embedded objects as boundaries.
    let text = "";
    node.forEach((child) => {
      text += child.isText ? child.text : "\ufffc".repeat(child.nodeSize);
    });
    const start = Math.max(0, selection.from - position - 1);
    const end = Math.min(text.length, selection.to - position - 1);
    const selected = text.slice(start, end);
    const pattern = add ? /[0-9０-９]+/gu : /[()（）[\]［］【】{}｛｝〔〕〖〗]/gu;
    for (const match of selected.matchAll(pattern)) {
      const from = start + match.index;
      const to = from + match[0].length;
      if (add) {
        if (
          (text[from - 1] === "(" && text[to] === ")") ||
          (text[from - 1] === "（" && text[to] === "）")
        )
          continue;
        edits.push({ from: position + 1 + from, to: position + 1 + from, text: "(" });
        edits.push({ from: position + 1 + to, to: position + 1 + to, text: ")" });
      } else edits.push({ from: position + 1 + from, to: position + 1 + to, text: "" });
    }
    return false;
  });
  if (!edits.length) return false;
  const transaction = closeHistory(editor.state.tr);
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    if (edit.text) {
      const adjacent = doc.resolve(edit.from);
      const marks = edit.text === "(" ? adjacent.nodeAfter?.marks : adjacent.nodeBefore?.marks;
      transaction.insert(edit.from, editor.schema.text(edit.text, marks));
    } else transaction.delete(edit.from, edit.to);
  }
  transaction.setSelection(
    selection instanceof AllSelection
      ? new AllSelection(transaction.doc)
      : TextSelection.between(
          transaction.doc.resolve(transaction.mapping.map(selection.from, -1)),
          transaction.doc.resolve(transaction.mapping.map(selection.to, 1)),
        ),
  );
  editor.view.dispatch(transaction);
  editor.view.dispatch(closeHistory(editor.state.tr));
  editor.commands.focus();
  return true;
}
