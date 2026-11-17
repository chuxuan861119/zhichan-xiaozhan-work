import { describe, expect, it, vi } from "vitest";

import { loadDrawioRuntimeFiles } from "./helpers/drawio-runtime-test-harness";

type Bounds = { width: number; height: number };
type Policy = {
  scaleTemplateSize(width: number, height: number, minimum?: number): Bounds;
  transformTemplate(input: { style: string; width: number; height: number; source: string }): {
    style: string;
    width: number;
    height: number;
  };
  constrainCellBounds(original: Bounds, proposed: Bounds): Bounds;
  constrainSelectionBounds(original: Bounds, proposed: Bounds, containsCircuit: boolean): Bounds;
  isCornerSizerIndex(index: number): boolean;
  install(options: Record<string, unknown>): {
    setEditorMode(mode: string): void;
    dispose(): void;
  };
};

async function loadPolicy(extraGlobal: Record<string, unknown> = {}): Promise<Policy> {
  const sourceGlobal = await loadDrawioRuntimeFiles(
    ["circuit-domain.js", "circuit-component-policy.js"],
    extraGlobal,
  );
  return sourceGlobal.PatentCircuitComponentPolicy as Policy;
}

describe("circuit component sizing policy", () => {
  it("scales a new circuit template to 60 percent once", async () => {
    const policy = await loadPolicy();

    expect(
      policy.transformTemplate({
        style: "shape=mxgraph.electrical.resistors.resistor_1;",
        width: 100,
        height: 40,
        source: "sidebar-template",
      }),
    ).toEqual(
      expect.objectContaining({
        style: expect.stringMatching(/patentCircuit=1;.*patentCircuitScale=60/),
        width: 60,
        height: 24,
      }),
    );
  });

  it("keeps thin circuit symbols at exactly 60 percent without enlarging the short side", async () => {
    const policy = await loadPolicy();

    expect(policy.scaleTemplateSize(20, 100)).toEqual({ width: 12, height: 60 });
    expect(policy.scaleTemplateSize(100, 20)).toEqual({ width: 60, height: 12 });
  });

  it.each(["copy", "paste", "duplicate", "import"])(
    "does not rescale a circuit component from %s",
    async (source) => {
      const policy = await loadPolicy();

      expect(
        policy.transformTemplate({
          style: "shape=mxgraph.electrical.resistors.resistor_1;patentCircuit=1;",
          width: 80,
          height: 32,
          source,
        }),
      ).toMatchObject({ width: 80, height: 32 });
    },
  );

  it("leaves ordinary flowchart templates unchanged", async () => {
    const policy = await loadPolicy();

    expect(
      policy.transformTemplate({
        style: "shape=rectangle;",
        width: 100,
        height: 40,
        source: "sidebar-template",
      }),
    ).toEqual({ style: "shape=rectangle;", width: 100, height: 40 });
  });

  it("keeps the current ratio for old imported circuit cells", async () => {
    const policy = await loadPolicy();

    expect(
      policy.constrainCellBounds({ width: 120, height: 30 }, { width: 240, height: 90 }),
    ).toEqual({ width: 240, height: 60 });
  });

  it("locks a mixed selection while leaving an ordinary selection free", async () => {
    const policy = await loadPolicy();

    expect(
      policy.constrainSelectionBounds(
        { width: 200, height: 100 },
        { width: 320, height: 100 },
        true,
      ),
    ).toEqual({ width: 320, height: 160 });
    expect(
      policy.constrainSelectionBounds(
        { width: 200, height: 100 },
        { width: 320, height: 100 },
        false,
      ),
    ).toEqual({ width: 320, height: 100 });
  });

  it("allows only corner resize handles for circuit components", async () => {
    const policy = await loadPolicy();

    expect([0, 2, 5, 7].filter((index) => policy.isCornerSizerIndex(index))).toEqual([0, 2, 5, 7]);
    expect([1, 3, 4, 6].some((index) => policy.isCornerSizerIndex(index))).toBe(false);
  });

  it("wraps graph resizing permanently and restores it on dispose", async () => {
    const graph = {
      getModel: () => ({ getStyle: (cell: { style: string }) => cell.style }),
      resizeCells: vi.fn((_cells: unknown[], bounds: Bounds[]) => bounds),
      getCellStyle: vi.fn(() => ({ shape: "mxgraph.electrical.resistors.resistor_1" })),
    };
    const originalResize = graph.resizeCells;
    const originalGetCellStyle = graph.getCellStyle;
    const policy = await loadPolicy();
    const controller = policy.install({ editorUi: { editor: { graph } } });
    const cell = {
      id: "old",
      style: "shape=mxgraph.electrical.resistors.resistor_1;",
      geometry: { width: 120, height: 30 },
    };

    controller.setEditorMode("flowchart");
    graph.resizeCells([cell], [{ width: 240, height: 90 }]);
    expect(originalResize).toHaveBeenCalledWith([cell], [{ width: 240, height: 60 }]);
    expect(graph.getCellStyle(cell)).toMatchObject({ aspect: "fixed" });

    controller.dispose();
    expect(graph.resizeCells).toBe(originalResize);
    expect(graph.getCellStyle).toBe(originalGetCellStyle);
  });

  it("does not mark the model dirty merely by installing or changing mode", async () => {
    const model = { setStyle: vi.fn(), getStyle: () => "shape=rectangle;" };
    const graph = {
      getModel: () => model,
      resizeCells: vi.fn(),
      getCellStyle: vi.fn(() => ({ shape: "rectangle" })),
    };
    const controller = (await loadPolicy()).install({ editorUi: { editor: { graph } } });

    controller.setEditorMode("flowchart");
    controller.setEditorMode("circuit");

    expect(model.setStyle).not.toHaveBeenCalled();
    controller.dispose();
  });
});
