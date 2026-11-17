import { createBlankPatent } from "../patent/defaults.js";
import { createPatentPrintSnapshot } from "./patent-print-snapshot.js";

test("prints imported canonical drawings once while retaining standalone repeated images", () => {
  const patent = createBlankPatent({ patentType: "invention", name: "导入附图" });
  const figure = { figureId: crypto.randomUUID(), assetId: crypto.randomUUID(), widthMm: 80 };
  patent.figures = [figure];
  const book = patent.books.find((book) => book.kind === "description-drawings")!;
  book.document.content = [0, 1].map(() => ({
    id: crypto.randomUUID(),
    type: "figure",
    assetId: figure.assetId,
    widthMm: 80,
    alignment: "center",
  }));
  const snapshot = createPatentPrintSnapshot(patent, "description-drawings");
  expect(snapshot.current.content.filter((node) => node.type === "figure")).toHaveLength(2);
});

test("snapshots the five books, including the selected abstract figure, without changing the patent", () => {
  const patent = createBlankPatent({ patentType: "invention", name: "打印范围" });
  const figure = {
    figureId: crypto.randomUUID(),
    assetId: crypto.randomUUID(),
    widthMm: 100,
    rotationDeg: 90 as const,
  };
  const secondFigure = { ...figure, figureId: crypto.randomUUID() };
  patent.figures = [figure, secondFigure];
  patent.abstractDrawingFigureId = secondFigure.figureId;
  const original = structuredClone(patent);
  const snapshot = createPatentPrintSnapshot(patent, "abstract-drawing");
  expect(snapshot.documents.map((document) => document.title)).toEqual([
    "说明书摘要",
    "摘要附图",
    "权利要求书",
    "说明书",
    "说明书附图",
  ]);
  expect(snapshot.current.content.at(-1)).toMatchObject({
    type: "figure",
    id: patent.abstractDrawingFigureId,
    rotationDeg: 90,
  });
  expect(snapshot.figureLabels[patent.abstractDrawingFigureId]).toBe("图2");
  expect(snapshot.documents.at(-1)?.content.filter((node) => node.type === "figure")).toHaveLength(
    2,
  );
  expect(patent).toEqual(original);
});
