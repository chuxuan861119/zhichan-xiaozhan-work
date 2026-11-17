import { afterEach, expect, test, vi } from "vitest";
import {
  CAD_HATCH_PREFERENCES_KEY,
  readHatchPreferences,
  rememberHatchPreferences,
} from "./cad-hatch-preferences";
import { DEFAULT_PATTERN_VALUES } from "./cad-pattern-command";

afterEach(() => {
  localStorage.removeItem(CAD_HATCH_PREFERENCES_KEY);
  vi.restoreAllMocks();
});

test("successful creation remembers automatic tolerance instead of the previous strict value", () => {
  localStorage.setItem(CAD_HATCH_PREFERENCES_KEY, JSON.stringify({ gapTolerance: "0" }));
  rememberHatchPreferences("hatch", {
    pattern: "ANSI38",
    scale: 3.125,
    angle: 25.123,
    style: "outer",
    points: [[4, 5]],
    handles: ["A"],
  });
  expect(JSON.parse(localStorage.getItem(CAD_HATCH_PREFERENCES_KEY) ?? "null")).toEqual({
    pattern: "ANSI38",
    scale: "3.125",
    hatchAngle: "25.123",
    islandStyle: "outer",
    gapTolerance: "",
  });
});

test("successful editing updates appearance while retaining the last creation-only tolerance", () => {
  localStorage.setItem(CAD_HATCH_PREFERENCES_KEY, JSON.stringify({ gapTolerance: "0.2" }));
  rememberHatchPreferences("hatchedit", {
    pattern: "ANSI33",
    scale: 2,
    angle: 45,
    style: "ignore",
    handles: ["H"],
  });
  expect(readHatchPreferences()).toMatchObject({
    pattern: "ANSI33",
    scale: "2",
    hatchAngle: "45",
    islandStyle: "ignore",
    gapTolerance: "0.2",
  });
});

test.each([
  "{",
  "null",
  "[]",
  JSON.stringify({ islandStyle: ["outer"] }),
  JSON.stringify({
    pattern: "",
    scale: "-2",
    hatchAngle: "Infinity",
    islandStyle: "invalid",
    gapTolerance: "5001",
    rows: "99",
    handles: ["A"],
  }),
])("invalid stored preferences recover safe defaults: %s", (stored) => {
  localStorage.setItem(CAD_HATCH_PREFERENCES_KEY, stored);
  expect(readHatchPreferences()).toEqual(DEFAULT_PATTERN_VALUES);
});

test("unavailable optional storage never makes a saved hatch fail", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceeded");
  });
  expect(() =>
    rememberHatchPreferences("hatch", {
      pattern: "ANSI31",
      scale: 1,
      angle: 0,
      style: "normal",
      gapTolerance: 0,
    }),
  ).not.toThrow();
  expect(warning).toHaveBeenCalledWith("填充已保存，但未能记住填充参数。", expect.any(Error));
});
