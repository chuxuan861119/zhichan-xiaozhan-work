import { expect, it } from "vitest";
import { DrawingRegionSchema } from "./model.js";
import {
  annotationOutputStyle,
  DRAWING_LEADER_WIDTH_MM,
  defaultDrawingOutput,
  drawingAnnotationScale,
  drawingLeaderWidth,
  drawingOutput,
  storedAnnotationLineWidth,
  wholeDrawingAnnotationScale,
} from "./output-settings.js";

const points = [
  { x: 0, y: 0 },
  { x: 400, y: 0 },
  { x: 400, y: 300 },
  { x: 0, y: 300 },
];
const region = {
  id: "r",
  name: "图1",
  kind: "rectangle" as const,
  points,
};
const annotation = { fontSize: 24, lineWidth: 1.5 };
const styleFor = (
  source: { fontSize: number; lineWidth: number },
  output: ReturnType<typeof defaultDrawingOutput>,
  cropPoints = points,
) => annotationOutputStyle(source, drawingAnnotationScale(cropPoints, output));

it("keeps the chosen label size but derives the leader width from the crop", () => {
  const style = styleFor({ fontSize: 36, lineWidth: 0.5 }, defaultDrawingOutput());
  expect(style.fontSize).toBe(36);
  // 400 图形单位印成 120 mm：0.3 mm 引出线折合 1 个图形单位，用户填的 0.5 不再生效。
  expect(style.lineWidth).toBeCloseTo(DRAWING_LEADER_WIDTH_MM * (400 / 120));
});

it("ignores the stored per-crop leader width so the output weight never drifts", () => {
  const style = styleFor(annotation, { ...defaultDrawingOutput(), leaderWidthMm: 0.6 });
  expect(style.lineWidth).toBeCloseTo(1);
});

it("keeps a transient collapsed crop editable instead of throwing during a corner drag", () => {
  expect(
    styleFor(annotation, { ...defaultDrawingOutput(), mode: "uniform" }, [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 0, y: 200 },
    ]),
  ).toEqual(annotation);
});

it("keeps physical label and leader sizes identical across crop sizes", () => {
  for (const cropWidth of [200, 800]) {
    const style = styleFor(annotation, { ...defaultDrawingOutput(), mode: "uniform" }, [
      { x: 0, y: 0 },
      { x: cropWidth, y: 0 },
      { x: cropWidth, y: 100 },
    ]);
    expect((style.fontSize / cropWidth) * 120).toBeCloseTo(3.5);
    expect((style.lineWidth / cropWidth) * 120).toBeCloseTo(DRAWING_LEADER_WIDTH_MM);
  }
});

it("uses the whole drawing as the leader scale before any crop is selected", () => {
  const style = annotationOutputStyle(
    { fontSize: 12, lineWidth: 9 },
    wholeDrawingAnnotationScale(1000, defaultDrawingOutput()),
  );
  expect(style.fontSize).toBe(12);
  expect(style.lineWidth).toBeCloseTo(DRAWING_LEADER_WIDTH_MM * (1000 / 120));
});

it("keeps the stored leader width inside the model range for extreme drawing sizes", () => {
  expect(
    storedAnnotationLineWidth(wholeDrawingAnnotationScale(1000, defaultDrawingOutput())),
  ).toBeCloseTo(2.5);
  // 超大图纸换算值远超模型上限，夹住上限，免得整份工作稿因为一个已不再生效的字段存不下来。
  expect(
    storedAnnotationLineWidth(wholeDrawingAnnotationScale(1_000_000, defaultDrawingOutput())),
  ).toBe(100);
  // 极小图纸同理，夹住下限。
  expect(storedAnnotationLineWidth(wholeDrawingAnnotationScale(1, defaultDrawingOutput()))).toBe(
    0.1,
  );
  expect(storedAnnotationLineWidth(null)).toBe(DRAWING_LEADER_WIDTH_MM);
});

it("preserves old drawing-relative styles and validates per-region output settings", () => {
  expect(annotationOutputStyle(annotation, drawingAnnotationScale(points, undefined))).toEqual(
    annotation,
  );
  expect(drawingOutput(region).mode).toBe("drawing");
  const saved = DrawingRegionSchema.parse({
    ...region,
    output: { ...defaultDrawingOutput(), widthMm: 90, dpi: 600 },
  });
  expect(saved.output?.widthMm).toBe(90);
  expect(saved.output?.dpi).toBe(600);
  expect(
    DrawingRegionSchema.safeParse({
      ...region,
      output: { ...defaultDrawingOutput(), labelHeightMm: 0 },
    }).success,
  ).toBe(false);
});
it("retains a stable body-image link alongside a drawing-book link", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  expect(
    DrawingRegionSchema.parse({ ...region, figureId: id, bodyNodeId: id, bodyAssetId: id }),
  ).toMatchObject({ figureId: id, bodyNodeId: id, bodyAssetId: id });
});

it("keeps leader strokes physically constant at all viewport scales and export DPIs", () => {
  for (const unit of [0.0001, 0.1, 1, 100]) {
    for (const dpi of [96, 150, 300, 600]) {
      expect((drawingLeaderWidth(unit, dpi) / unit / dpi) * 25.4).toBeCloseTo(0.3);
    }
  }
});
