import type { Editor } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { randomUuid } from "../../../../shared/id";

const sharedFigureAttributes = (attributes: Record<string, unknown>) => ({
  nodeId: attributes.nodeId,
  assetId: attributes.assetId,
  widthMm: attributes.widthMm,
  alignment: attributes.alignment,
  rotationDeg: attributes.rotationDeg ?? 0,
  sourceAspectRatio: attributes.sourceAspectRatio ?? 1,
});

export function convertBlockFigureToInline(editor: Editor): boolean {
  const { selection, schema } = editor.state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "figure") return false;
  const inlineType = schema.nodes.inlineFigure;
  const paragraphType = schema.nodes.paragraph;
  if (!inlineType || !paragraphType) return false;
  const inline = inlineType.create(sharedFigureAttributes(selection.node.attrs));
  const paragraph = paragraphType.create({ nodeId: randomUuid() }, inline);
  const transaction = editor.state.tr.replaceSelectionWith(paragraph);
  transaction.setSelection(NodeSelection.create(transaction.doc, selection.from + 1));
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

export function canConvertInlineFigureToBlock(editor: Editor): boolean {
  const { selection, schema } = editor.state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "inlineFigure")
    return false;
  const figureType = schema.nodes.figure;
  if (!figureType || !selection.$from.parent.isTextblock) return false;
  const depth = selection.$from.depth - 1;
  const index = selection.$from.index(depth);
  return selection.$from.node(depth).canReplaceWith(index, index + 1, figureType);
}

export function convertInlineFigureToBlock(editor: Editor): boolean {
  if (!canConvertInlineFigureToBlock(editor)) return false;
  const { selection, schema } = editor.state;
  if (!(selection instanceof NodeSelection)) return false;
  const figureType = schema.nodes.figure;
  if (!figureType) return false;

  const parent = selection.$from.parent;
  const parentStart = selection.$from.before();
  const offset = selection.$from.parentOffset;
  const before = parent.content.cut(0, offset);
  const after = parent.content.cut(offset + selection.node.nodeSize);
  const figure = figureType.create({
    ...sharedFigureAttributes(selection.node.attrs),
    semanticRole: null,
  });
  const replacement = [];
  if (before.size > 0) replacement.push(parent.copy(before));
  const figurePosition = parentStart + (before.size > 0 ? (replacement[0]?.nodeSize ?? 0) : 0);
  replacement.push(figure);
  if (after.size > 0) {
    replacement.push(
      parent.type.create({ ...parent.attrs, nodeId: randomUuid() }, Fragment.from(after)),
    );
  }
  const transaction = editor.state.tr.replaceWith(
    parentStart,
    parentStart + parent.nodeSize,
    replacement,
  );
  transaction.setSelection(NodeSelection.create(transaction.doc, figurePosition));
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}
