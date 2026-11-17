import { closeHistory } from "@tiptap/pm/history";
import type { Attrs, Node } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { PasteParagraphMode } from "./paste-sanitizer";

export type PasteFormattingSession = {
  document: Node;
  mode: PasteParagraphMode;
  targets: { position: number; source: Attrs; body: Attrs }[];
  simplifications: string[];
};

/** Only whole newly pasted paragraphs may change: merged destination paragraphs stay untouched. */
export function capturePasteFormatting(
  transaction: Transaction,
  alternate: Node,
  document: Node,
  mode: PasteParagraphMode,
  simplifications: string[],
): PasteFormattingSession {
  const targets: PasteFormattingSession["targets"] = [];
  transaction.mapping.maps.at(-1)?.forEach((_oldFrom, _oldTo, from, to) => {
    document.nodesBetween(from, Math.min(to, document.content.size), (node, position) => {
      if (node.type.name !== "paragraph" || position < from || position + node.nodeSize > to)
        return;
      const other = alternate.nodeAt(position);
      if (!other || other.type !== node.type || !other.content.eq(node.content)) return;
      const attributes = (value: Node): Attrs => ({
        paragraphIndentMm: value.attrs.paragraphIndentMm,
        textAlign: value.attrs.textAlign,
        lineHeight: value.attrs.lineHeight,
        spaceBeforePt: value.attrs.spaceBeforePt,
        spaceAfterPt: value.attrs.spaceAfterPt,
      });
      targets.push({
        position,
        [mode]: attributes(node),
        [mode === "source" ? "body" : "source"]: attributes(other),
      } as PasteFormattingSession["targets"][number]);
    });
  });
  return { document, mode, targets, simplifications };
}

export function switchPasteFormatting(
  view: EditorView,
  session: PasteFormattingSession,
  mode: PasteParagraphMode,
): PasteFormattingSession | null {
  // Any subsequent edit/undo invalidates these positions. Never format unrelated content.
  if (view.state.doc !== session.document) return null;
  const transaction = view.state.tr;
  for (const target of session.targets) {
    const node = transaction.doc.nodeAt(target.position);
    if (node && Object.entries(target[mode]).some(([key, value]) => node.attrs[key] !== value))
      transaction.setNodeMarkup(target.position, undefined, { ...node.attrs, ...target[mode] });
  }
  if (transaction.docChanged) {
    view.dispatch(closeHistory(transaction));
    view.dispatch(closeHistory(view.state.tr));
  }
  return { ...session, document: view.state.doc, mode };
}
