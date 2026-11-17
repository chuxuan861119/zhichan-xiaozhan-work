import type { PatentFigure } from "../../../shared/patent/model";
import { planFlowchartFigureCommit } from "./flowchart-figure-plan";

const figures: PatentFigure[] = [
  {
    figureId: "11111111-1111-4111-8111-111111111111",
    assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    widthMm: 120,
  },
  {
    figureId: "22222222-2222-4222-8222-222222222222",
    assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    widthMm: 90,
  },
];
const secondFigure =
  figures[1] ??
  (() => {
    throw new Error("missing fixture");
  })();
const link = {
  projectId: "33333333-3333-4333-8333-333333333333",
  pageId: "page-1",
  exportScope: "page" as const,
  selectedCellIds: [],
  borderMm: 2,
  exportedProjectRevision: 3,
  exportedSourceSha256: "A".repeat(64),
  renderProfileVersion: 1 as const,
};

test("inserts a new linked figure at the selected position", () => {
  const next = planFlowchartFigureCommit(figures, {
    target: { kind: "new", insertIndex: 1 },
    newFigureId: "44444444-4444-4444-8444-444444444444",
    newAssetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    newWidthMm: 36,
    link,
  });
  expect(next.map((figure) => figure.figureId)).toEqual([
    figures[0]?.figureId,
    "44444444-4444-4444-8444-444444444444",
    figures[1]?.figureId,
  ]);
  expect(next[1]?.widthMm).toBe(36);
});

test("replacement preserves identity and order while applying the newly fitted width", () => {
  const next = planFlowchartFigureCommit(figures, {
    target: { kind: "replace", figureId: secondFigure.figureId, assetId: secondFigure.assetId },
    newFigureId: "unused",
    newAssetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    newWidthMm: 120,
    link,
  });
  expect(next[1]).toEqual({
    ...figures[1],
    assetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    widthMm: 120,
    flowchartLink: link,
  });
});

test("rejects a deleted or changed replacement target", () => {
  expect(() =>
    planFlowchartFigureCommit(figures, {
      target: { kind: "replace", figureId: secondFigure.figureId, assetId: "changed" },
      newFigureId: "unused",
      newAssetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      newWidthMm: 120,
      link,
    }),
  ).toThrowError("目标附图已发生变化");
});
