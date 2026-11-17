import type { CanonicalPatent, PatentFigure } from "./model.js";

export type NumberedFigure = PatentFigure & {
  number: number;
  label: string;
};

export function numberFigures(figures: readonly PatentFigure[]): NumberedFigure[] {
  return figures.map((figure, index) => ({
    ...figure,
    number: index + 1,
    label: `图${index + 1}`,
  }));
}

export function resolveFigureLabel(
  figures: readonly PatentFigure[],
  figureId: string,
): string | null {
  return numberFigures(figures).find((figure) => figure.figureId === figureId)?.label ?? null;
}

export function reorderFigures(
  figures: readonly PatentFigure[],
  figureId: string,
  targetIndex: number,
): PatentFigure[] {
  const sourceIndex = figures.findIndex((figure) => figure.figureId === figureId);
  if (sourceIndex === -1) return [...figures];

  const nextFigures = [...figures];
  const [figure] = nextFigures.splice(sourceIndex, 1);
  if (!figure) return [...figures];
  nextFigures.splice(Math.max(0, Math.min(targetIndex, nextFigures.length)), 0, figure);
  return nextFigures;
}

export function selectAbstractDrawingFigure(
  patent: CanonicalPatent,
  figureId: string,
): CanonicalPatent {
  if (!patent.figures.some((figure) => figure.figureId === figureId)) {
    throw new Error("摘要附图引用的说明书附图不存在。");
  }

  return { ...patent, abstractDrawingFigureId: figureId };
}
