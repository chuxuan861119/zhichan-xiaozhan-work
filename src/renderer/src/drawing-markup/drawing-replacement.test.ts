import type { PatentFigure } from "../../../shared/patent/model";
import { planDrawingReplacement } from "./drawing-replacement";

const target: PatentFigure = {
  figureId: "11111111-1111-4111-8111-111111111111",
  assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  widthMm: 90,
  rotationDeg: 90,
};
const other: PatentFigure = {
  figureId: "22222222-2222-4222-8222-222222222222",
  assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  widthMm: 80,
};

test("replaces only the chosen image, preserving its identity, width and position", () => {
  const figures = [other, target];
  const next = planDrawingReplacement(figures, target, "new-image");
  expect(next).toEqual([other, { ...target, assetId: "new-image", rotationDeg: 0 }]);
  expect(figures).toEqual([other, target]);
});

test("a CAD replacement removes the old flowchart editing link", () => {
  const linked = { ...target, flowchartLink: { projectId: "old-flowchart" } } as PatentFigure;
  expect(planDrawingReplacement([linked], linked, "new-image")[0]?.flowchartLink).toBeUndefined();
});

test.each(["deleted", "asset", "width", "rotation"])(
  "rejects a replacement target changed since preview (%s)",
  (change) => {
    const changed = { ...target };
    const figures = change === "deleted" ? [] : [changed];
    if (change === "asset") changed.assetId = "changed";
    if (change === "width") changed.widthMm = 120;
    if (change === "rotation") changed.rotationDeg = 180;
    expect(() => planDrawingReplacement(figures, target, "new-image")).toThrow(
      "目标附图已发生变化，请重新选择。",
    );
  },
);
