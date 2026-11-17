import { assertCadPreviewFrame, cadPreviewFrameMatches } from "./cad-preview-frame";

const frame = {
  width: 2000,
  height: 1702.9175249370207,
  cad: {
    mapping: { originX: -166.5099212433999, originY: 691.6053787556522, scale: 2.3797611316223373 },
  },
};
const svg = (box: string, size = 'width="2000" height="1703"') =>
  new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" ${size}/>`);

test("detects the actual saved drawing mismatch without mistaking rounded raster size for a bad frame", () => {
  expect(cadPreviewFrameMatches(svg("0 0 840.420483 789.555675"), frame)).toBe(false);
  expect(
    cadPreviewFrameMatches(
      svg(`0 0 ${frame.width / frame.cad.mapping.scale} ${frame.height / frame.cad.mapping.scale}`),
      frame,
    ),
  ).toBe(true);
  expect(cadPreviewFrameMatches(svg("0 0 NaN 1"), frame)).toBe(false);
  expect(cadPreviewFrameMatches(svg("5 5 840.420483 715.583421"), frame)).toBe(false);
});

test("refuses to publish a prepared checkpoint with changed bounds, origin or scale", () => {
  expect(() => assertCadPreviewFrame(frame, structuredClone(frame))).not.toThrow();
  for (const prepared of [
    { ...frame, height: 1879 },
    { ...frame, width: 2100 },
    { ...frame, cad: { mapping: { ...frame.cad.mapping, originY: 765 } } },
    { ...frame, cad: { mapping: { ...frame.cad.mapping, originX: -200 } } },
    { ...frame, cad: { mapping: { ...frame.cad.mapping, scale: 2 } } },
  ])
    expect(() => assertCadPreviewFrame(frame, prepared)).toThrow("未发布错位底图");
});
