import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";

export type FigureAlignment = "left" | "center" | "right";

export type FigureSelectionSnapshot =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "figure";
      nodeType: "figure" | "inlineFigure";
      position: number;
      assetId: string;
      widthMm: number;
      alignment: FigureAlignment;
      rotationDeg: 0 | 90 | 180 | 270;
    }>;

export const EMPTY_FIGURE_SELECTION: FigureSelectionSnapshot = Object.freeze({ kind: "none" });

export function inspectFigureSelection(editor: Editor): FigureSelectionSnapshot {
  const { selection } = editor.state;
  if (
    !(selection instanceof NodeSelection) ||
    (selection.node.type.name !== "figure" && selection.node.type.name !== "inlineFigure")
  ) {
    return EMPTY_FIGURE_SELECTION;
  }
  return {
    kind: "figure",
    nodeType: selection.node.type.name,
    position: selection.from,
    assetId: String(selection.node.attrs.assetId),
    widthMm: Number(selection.node.attrs.widthMm),
    alignment: selection.node.attrs.alignment as FigureAlignment,
    rotationDeg: selection.node.attrs.rotationDeg as 0 | 90 | 180 | 270,
  };
}
