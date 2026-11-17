import type { FlowchartFigureLink } from "../../../shared/flowcharts/model";
import type { PatentFigure } from "../../../shared/patent/model";
import type { FlowchartExportTarget } from "./flowchart-export-dialog";

export function planFlowchartFigureCommit(
  current: readonly PatentFigure[],
  input: {
    target: FlowchartExportTarget;
    newFigureId: string;
    newAssetId: string;
    newWidthMm: number;
    link: FlowchartFigureLink;
  },
): PatentFigure[] {
  const target = input.target;
  if (target.kind === "new") {
    if (target.insertIndex < 0 || target.insertIndex > current.length) {
      throw new Error("附图插入位置已发生变化。");
    }
    const next = current.map((figure) => structuredClone(figure));
    next.splice(target.insertIndex, 0, {
      figureId: input.newFigureId,
      assetId: input.newAssetId,
      widthMm: input.newWidthMm,
      flowchartLink: structuredClone(input.link),
    });
    return next;
  }
  const index = current.findIndex((figure) => figure.figureId === target.figureId);
  const existing = current[index];
  if (!existing || existing.assetId !== target.assetId) {
    throw new Error("目标附图已发生变化，请重新选择。");
  }
  return current.map((figure, figureIndex) =>
    figureIndex === index
      ? {
          ...structuredClone(figure),
          assetId: input.newAssetId,
          widthMm: input.newWidthMm,
          flowchartLink: structuredClone(input.link),
        }
      : structuredClone(figure),
  );
}
