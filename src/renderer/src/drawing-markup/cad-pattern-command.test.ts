import { expect, test } from "vitest";
import { compilePatternCommand, DEFAULT_PATTERN_VALUES as defaults } from "./cad-pattern-command";

test("new hatches default to scale one", () => {
  expect(defaults.scale).toBe("1");
});

test("arrays preserve sources, accept negative spacing and retain polar orientation choice", () => {
  expect(
    compilePatternCommand(
      "arrayrect",
      { ...defaults, rows: "2", colSpacing: "-15", axisAngle: "30" },
      ["A"],
      null,
    ),
  ).toEqual({
    command: "arrayrect",
    params: {
      handles: ["A"],
      rows: 2,
      cols: 3,
      rowSpacing: 10,
      colSpacing: -15,
      axisAngle: 30,
      associative: false,
    },
  });
  expect(
    compilePatternCommand("arraypolar", { ...defaults, angle: "-180", rotate: false }, ["A"], {
      x: 10,
      y: 20,
    }).params,
  ).toMatchObject({ center: [10, 20], angle: -180, rotate: false, associative: false, count: 6 });
});
test("invalid and excessive arrays are rejected before reaching the worker", () => {
  for (const values of [
    { rows: "" },
    { rows: "1.2" },
    { cols: "0" },
    { cols: "1001" },
    { rows: "50", cols: "50" },
    { colSpacing: "0" },
    { axisAngle: "Infinity" },
  ])
    expect(() =>
      compilePatternCommand("arrayrect", { ...defaults, ...values }, ["A"], null),
    ).toThrow();
  expect(() => compilePatternCommand("arraypolar", defaults, ["A"], null)).toThrow(/圆心/);
  expect(() =>
    compilePatternCommand(
      "arraypolar",
      { ...defaults, count: "1000" },
      Array.from({ length: 11 }, (_, i) => String(i)),
      { x: 0, y: 0 },
    ),
  ).toThrow(/10000/);
});
test("hatch creation by inside point and editing use distinct non-destructive commands", () => {
  expect(compilePatternCommand("hatch", defaults, [], { x: 2, y: 3 })).toMatchObject({
    command: "hatch",
    params: { points: [[2, 3]], pattern: "ANSI31" },
  });
  expect(
    compilePatternCommand(
      "hatch",
      { ...defaults, hatchAngle: "45", scale: "2" },
      ["H"],
      null,
      true,
    ),
  ).toEqual({
    command: "hatchedit",
    params: { handles: ["H"], pattern: "ANSI31", scale: 2, angle: 45, style: "normal" },
  });
  expect(() => compilePatternCommand("hatch", defaults, [], null)).toThrow();
});

test("hatches accept multiple regions, island settings and small positive scales", () => {
  expect(
    compilePatternCommand(
      "hatch",
      { ...defaults, scale: "0.01", islandStyle: "outer" },
      [],
      [
        { x: 2, y: 3 },
        { x: 5, y: 6 },
      ],
    ),
  ).toMatchObject({
    params: {
      points: [
        [2, 3],
        [5, 6],
      ],
      scale: 0.01,
      style: "outer",
      separate: true,
    },
  });
  expect(
    compilePatternCommand("hatch", { ...defaults, pattern: "SOLID", scale: "" }, [], {
      x: 2,
      y: 3,
    }),
  ).toMatchObject({ params: { pattern: "SOLID" } });
});

test("gap tolerance is explicit, finite and bounded, including strict zero for imported drawings", () => {
  const point = { x: 5, y: 5 };
  expect(defaults.gapTolerance).toBe("");
  expect(compilePatternCommand("hatch", defaults, [], point).params).not.toHaveProperty(
    "gapTolerance",
  );
  expect(
    compilePatternCommand("hatch", { ...defaults, gapTolerance: "0" }, [], point).params,
  ).toHaveProperty("gapTolerance", 0);
  expect(
    compilePatternCommand("hatch", { ...defaults, gapTolerance: "0.005" }, [], point).params,
  ).toHaveProperty("gapTolerance", 0.005);
  for (const gapTolerance of ["-1", "5001", "Infinity"])
    expect(() =>
      compilePatternCommand("hatch", { ...defaults, gapTolerance }, [], point),
    ).toThrow();
});
