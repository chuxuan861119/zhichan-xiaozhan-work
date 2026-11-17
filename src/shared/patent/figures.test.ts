import { createBlankPatent } from "./defaults.js";
import {
  numberFigures,
  reorderFigures,
  resolveFigureLabel,
  selectAbstractDrawingFigure,
} from "./figures.js";
import type { PatentFigure } from "./model.js";

function figure(index: number): PatentFigure {
  return {
    figureId: `00000000-0000-4000-8000-${(600 + index).toString().padStart(12, "0")}`,
    assetId: `00000000-0000-4000-8000-${(700 + index).toString().padStart(12, "0")}`,
    widthMm: 100,
  };
}

describe("structured patent figures", () => {
  test("derives figure labels from order after vertical reorder", () => {
    const first = figure(1);
    const second = figure(2);
    const third = figure(3);

    const reordered = reorderFigures([first, second, third], third.figureId, 0);

    expect(numberFigures(reordered).map((numbered) => numbered.label)).toEqual([
      "图1",
      "图2",
      "图3",
    ]);
    expect(resolveFigureLabel(reordered, second.figureId)).toBe("图3");
  });

  test("selects an abstract drawing by reference without duplicating assets", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const selected = selectAbstractDrawingFigure(
      { ...patent, figures: [figure(1)], assets: [] },
      "00000000-0000-4000-8000-000000000601",
    );

    expect(selected.abstractDrawingFigureId).toBe("00000000-0000-4000-8000-000000000601");
    expect(selected.assets).toEqual([]);
  });
});
