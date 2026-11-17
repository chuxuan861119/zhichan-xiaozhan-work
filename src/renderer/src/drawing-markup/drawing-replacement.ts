import type { PatentFigure } from "../../../shared/patent/model";

export function planDrawingReplacement(
  figures: readonly PatentFigure[],
  target: PatentFigure,
  assetId: string,
): PatentFigure[] {
  const existing = figures.find((figure) => figure.figureId === target.figureId);
  if (!existing || JSON.stringify(existing) !== JSON.stringify(target))
    throw new Error("目标附图已发生变化，请重新选择。");
  return figures.map((figure) => {
    if (figure.figureId !== target.figureId) return figure;
    // Rendered output is already oriented; the previous image's rotation/link must not carry over.
    const { flowchartLink: _oldLink, ...rest } = figure;
    return { ...rest, assetId, rotationDeg: 0 };
  });
}
