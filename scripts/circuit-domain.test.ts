import { describe, expect, it } from "vitest";

import { loadDrawioRuntimeFiles } from "./helpers/drawio-runtime-test-harness";

type Rect = { x: number; y: number; width: number; height: number };
type CircuitDomain = {
  CIRCUIT_MARKER: string;
  readStyle(style: string): Record<string, string>;
  isCircuitStyle(style: string): boolean;
  terminalKey(cellId: string, portId: string): string;
  classifyRole(input: { style: string; value: string; incoming: number; outgoing: number }): string;
  stableCompareId(left: string, right: string): number;
  normalizeRect(rect: Rect): Rect;
  inflateRect(rect: Rect, amount: number): Rect;
  rectsOverlap(left: Rect, right: Rect): boolean;
  pointKey(point: { x: number; y: number }): string;
  directionForPort(port: { id: string; x: number; y: number }): string;
};

async function loadDomain(): Promise<CircuitDomain> {
  const runtime = await loadDrawioRuntimeFiles(["circuit-domain.js"]);
  return runtime.PatentCircuitDomain as CircuitDomain;
}

describe("circuit domain", () => {
  it("identifies only electrical or explicitly marked circuit cells", async () => {
    const domain = await loadDomain();

    expect(domain.CIRCUIT_MARKER).toBe("patentCircuit");
    expect(domain.isCircuitStyle("shape=mxgraph.electrical.logic_gates.and;")).toBe(true);
    expect(domain.isCircuitStyle("rounded=0;patentCircuit=1;")).toBe(true);
    expect(domain.isCircuitStyle("shape=rectangle;")).toBe(false);
    expect(domain.isCircuitStyle("")).toBe(false);
  });

  it("creates stable terminal and point keys", async () => {
    const domain = await loadDomain();

    expect(domain.terminalKey("cell-2", "native-1")).toBe("cell-2::native-1");
    expect(domain.pointKey({ x: 12.5, y: -3 })).toBe("12.5,-3");
    expect(["cell-10", "cell-2", "cell-1"].sort(domain.stableCompareId)).toEqual([
      "cell-1",
      "cell-2",
      "cell-10",
    ]);
  });

  it.each([
    ["shape=mxgraph.electrical.miscellaneous.power;", "", 1, 1, "power"],
    ["shape=mxgraph.electrical.signal_sources.ground;", "", 1, 1, "ground"],
    ["shape=mxgraph.electrical.logic_gates.input;", "", 0, 2, "input"],
    ["shape=mxgraph.electrical.miscellaneous.lamp;", "", 2, 0, "output"],
    ["shape=mxgraph.electrical.resistors.resistor_1;", "", 1, 1, "passive"],
    ["shape=mxgraph.electrical.logic_gates.and;", "", 2, 1, "generic"],
    ["shape=mxgraph.electrical.miscellaneous.component;", "信号源", 0, 1, "input"],
  ])("classifies %s deterministically", async (style, value, incoming, outgoing, role) => {
    const domain = await loadDomain();

    expect(domain.classifyRole({ style, value, incoming, outgoing })).toBe(role);
  });

  it("normalizes, inflates and intersects valid rectangles", async () => {
    const domain = await loadDomain();

    expect(domain.normalizeRect({ x: "2" as never, y: 3, width: 10, height: 5 })).toEqual({
      x: 2,
      y: 3,
      width: 10,
      height: 5,
    });
    expect(domain.inflateRect({ x: 2, y: 3, width: 10, height: 5 }, 2)).toEqual({
      x: 0,
      y: 1,
      width: 14,
      height: 9,
    });
    expect(
      domain.rectsOverlap(
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 9, y: 9, width: 4, height: 4 },
      ),
    ).toBe(true);
    expect(
      domain.rectsOverlap(
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 10, y: 0, width: 4, height: 4 },
      ),
    ).toBe(false);
  });

  it.each([
    [{ x: Number.NaN, y: 0, width: 1, height: 1 }],
    [{ x: 0, y: 0, width: -1, height: 1 }],
    [{ x: 0, y: 0, width: 1, height: Number.POSITIVE_INFINITY }],
  ])("fails closed for invalid geometry %#", async (rect) => {
    const domain = await loadDomain();

    expect(() => domain.normalizeRect(rect)).toThrowError("INVALID_CIRCUIT_GEOMETRY");
  });

  it.each([
    [{ id: "left", x: 0.5, y: 0.5 }, "left"],
    [{ id: "native", x: 1, y: 0.4 }, "right"],
    [{ id: "native", x: 0.4, y: 0 }, "top"],
    [{ id: "native", x: 0.4, y: 1 }, "bottom"],
    [{ id: "native", x: 0.4, y: 0.4 }, "auto"],
  ])("resolves port direction %#", async (port, expected) => {
    const domain = await loadDomain();

    expect(domain.directionForPort(port)).toBe(expected);
  });

  it("uses the last style value to match draw.io style resolution", async () => {
    const domain = await loadDomain();

    expect(
      domain.readStyle("shape=rectangle;shape=mxgraph.electrical.resistors.resistor_1;"),
    ).toEqual({ shape: "mxgraph.electrical.resistors.resistor_1" });
  });
});
