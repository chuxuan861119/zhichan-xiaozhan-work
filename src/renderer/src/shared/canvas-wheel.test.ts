import { canvasWheelPans, canvasZoomFactor, wheelPixels } from "./canvas-wheel";

test("pinch gain matches flowchart fine zoom, preserves direction and stays proportional", () => {
  expect(canvasZoomFactor(2.5, 0, 800, true)).toBeCloseTo(1.025);
  expect(canvasZoomFactor(0.1, 0, 800, true)).toBeCloseTo(1.001);
  expect(canvasZoomFactor(2.5, 0, 800, true)).toBeGreaterThan(canvasZoomFactor(2.5, 0, 800));
  expect(canvasZoomFactor(-2.5, 0, 800, true) * canvasZoomFactor(2.5, 0, 800, true)).toBeCloseTo(1);
  expect(canvasZoomFactor(0, 0, 800, true)).toBe(1);
});

test("normalizes line/page input and retains ordinary mouse zoom gain", () => {
  expect(wheelPixels(1, 1, 800)).toBe(40);
  expect(wheelPixels(1, 2, 800)).toBe(800);
  expect(canvasZoomFactor(100, 0, 800)).toBeCloseTo(Math.exp(0.14));
});

test.each(["openharmony", "ohos", "darwin"])(
  "%s scroll pans; explicit zoom modifiers never pan",
  (platform) => {
    const plain = { ctrlKey: false, metaKey: false, altKey: false };
    expect(canvasWheelPans(plain, platform)).toBe(true);
    for (const key of ["ctrlKey", "metaKey", "altKey"])
      expect(canvasWheelPans({ ...plain, [key]: true }, platform)).toBe(false);
    expect(canvasWheelPans(plain, "win32")).toBe(false);
  },
);
