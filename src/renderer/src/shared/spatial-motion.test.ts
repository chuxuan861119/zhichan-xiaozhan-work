import { expect, test } from "vitest";
import { contentEditMotionTiming, SPATIAL_MOTION_TIMING } from "./spatial-motion";

test("shared motion restores the original fixed 400ms duration", () => {
  expect(SPATIAL_MOTION_TIMING).toEqual({ duration: 400, easing: "ease-in-out" });
});

test.each([
  ["win32", 650],
  ["Win32", 650],
  ["darwin", 400],
  ["MacIntel", 400],
  ["openharmony", 400],
  ["ohos", 400],
])("only Windows content edits slow down: %s", (platform, duration) => {
  expect(contentEditMotionTiming(platform)).toEqual({ duration, easing: "ease-in-out" });
  expect(SPATIAL_MOTION_TIMING.duration).toBe(400);
});

test("spatial travel keeps the same duration at every distance", async () => {
  const { spatialMotionTiming } = await import("./spatial-motion");
  expect(spatialMotionTiming(200).duration).toBe(400);
  expect(spatialMotionTiming(300).duration).toBe(400);
  expect(spatialMotionTiming(-300).duration).toBe(400);
  expect(spatialMotionTiming(6).duration).toBe(400);
  expect(spatialMotionTiming(900).duration).toBe(400);
});

test("resize timing includes travel of the farthest corner", async () => {
  const { surfaceMotionDistance } = await import("./spatial-motion");
  expect(
    surfaceMotionDistance(new DOMRect(0, 0, 100, 100), new DOMRect(0, 0, 200, 300)),
  ).toBeCloseTo(Math.hypot(100, 200));
});

test("keyframes use fixed timing without forcing a glyph layout read", async () => {
  const { keyframeMotionTiming } = await import("./spatial-motion");
  const element = document.createElement("span");
  const bounds = vi.spyOn(element, "getBoundingClientRect");
  expect(
    keyframeMotionTiming(element, [
      { transform: "translate(200px, 0px)" },
      { transform: "translate(0, 0)" },
    ]).duration,
  ).toBe(400);
  expect(bounds).not.toHaveBeenCalled();
  expect(keyframeMotionTiming(element, [{ opacity: 0 }, { opacity: 1 }]).duration).toBe(400);
});

test("uniform scaling keeps the original fixed duration", async () => {
  const { keyframeMotionTiming } = await import("./spatial-motion");
  const element = document.createElement("div");
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 1000));
  expect(
    keyframeMotionTiming(element, [{ transform: "scale(1)" }, { transform: "scale(0.5)" }])
      .duration,
  ).toBe(400);
});
