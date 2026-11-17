import { expect, test } from "vitest";
import { compilePatternCommand, DEFAULT_PATTERN_VALUES } from "./cad-pattern-command";
test("path array requires a distinct path and bounded count", () => {
  const compile = (path?: string, count = "5") =>
    compilePatternCommand(
      "arraypath",
      { ...DEFAULT_PATTERN_VALUES, count },
      ["A"],
      null,
      false,
      path,
    );
  expect(() => compile()).toThrow("点选排列路径");
  expect(() => compile("A")).toThrow("不能同时");
  expect(() => compile("B", "1001")).toThrow();
  expect(compile("B")).toEqual({
    command: "arraypath",
    params: { handles: ["A"], path: "B", count: 5, align: true },
  });
});
