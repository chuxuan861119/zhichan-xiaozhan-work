// @vitest-environment node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CadExportScene, compileCadExport } from "./cad-export.js";
import { createDetailView } from "./detail-view.js";
import type { DrawingProject } from "./model.js";

const rectangle = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const project = (): DrawingProject => ({
  projectId: "project",
  name: "CAD",
  sourceAssetId: "original",
  baseAssetId: "svg",
  sourceKind: "dxf",
  pageNumber: 1,
  width: 100,
  height: 100,
  annotations: [],
  regions: [],
  warnings: [],
  revision: 0,
  cad: {
    version: 1,
    engine: "cadcraft",
    engineVersion: "0".repeat(40),
    assetId: "cad",
    mapping: { originX: 0, originY: 100, scale: 1 },
  },
});
const lineScene: CadExportScene = {
  entities: [{ handle: "1" }],
  primitives: [
    {
      kind: "polyline",
      points: [
        [0, 50],
        [100, 50],
      ],
      color: [0, 0, 0],
      aci7: true,
      lineweight: 0.2,
    },
  ],
};
function primitives(plan: ReturnType<typeof compileCadExport>) {
  return plan.commands
    .filter((c) => c.command === "bridge.add_primitives")
    .flatMap((c) => c.params.primitives as { kind: string; points: number[][] }[]);
}
describe("CAD export composition", () => {
  it("retains the editable original CAD document when no crop is applied", () => {
    const plan = compileCadExport(project(), new Map([["cad", lineScene]]));
    expect(plan.sourceCadAssetId).toBe("cad");
    expect(plan.commands).toEqual([]);
  });
  it("clips holes before applying fragment translation", () => {
    const p = project();
    p.baseFragments = [
      {
        id: "piece",
        offset: { x: 10, y: 0 },
        clips: [rectangle(0, 0, 100, 100)],
        holes: [rectangle(40, 40, 20, 20)],
      },
    ];
    const plan = compileCadExport(p, new Map([["cad", lineScene]]));
    expect(plan.sourceCadAssetId).toBeNull();
    expect(
      primitives(plan)
        .filter((p) => p.kind === "polyline")
        .map((p) => p.points),
    ).toEqual([
      [
        [10, 50],
        [50, 50],
      ],
      [
        [70, 50],
        [110, 50],
      ],
    ]);
  });
  it("preserves fully unclipped entities through rotation and scaling", () => {
    const p = project();
    p.baseFragments = [
      {
        id: "whole",
        offset: { x: 10, y: 5 },
        scale: 2,
        rotation: 90,
        clips: [rectangle(0, 0, 100, 100)],
        holes: [],
      },
    ];
    const plan = compileCadExport(p, new Map([["cad", lineScene]]));
    expect(plan.sourceCadAssetId).toBe("cad");
    expect(plan.commands[0]?.command).toBe("bridge.transform_model");
  });
  it("clips filled triangle cells without dropping the fill", () => {
    const p = project();
    p.baseFragments = [
      { id: "half", offset: { x: 0, y: 0 }, clips: [rectangle(0, 0, 5, 10)], holes: [] },
    ];
    const scene: CadExportScene = {
      entities: [],
      primitives: [
        {
          kind: "triangles",
          points: [
            [0, 100],
            [10, 100],
            [0, 90],
          ],
          color: [0, 0, 0],
          aci7: true,
          lineweight: 0,
        },
      ],
    };
    const result = primitives(compileCadExport(p, new Map([["cad", scene]]))).filter(
      (p) => p.kind === "triangles",
    );
    const area = result
      .flatMap((p) => p.points)
      .reduce(
        (acc, _p, i, all) =>
          i % 3
            ? acc
            : acc +
              Math.abs(
                (all[i + 1]![0]! - all[i]![0]!) * (all[i + 2]![1]! - all[i]![1]!) -
                  (all[i + 1]![1]! - all[i]![1]!) * (all[i + 2]![0]! - all[i]![0]!),
              ) /
                2,
        0,
      );
    expect(area).toBeCloseTo(37.5);
  });
  it("exports every annotation as native text and a leader", () => {
    const p = project();
    p.annotations = [
      {
        id: "a",
        text: "12",
        x: 50,
        y: 30,
        fontSize: 10,
        lineWidth: 1,
        points: [
          { x: 0, y: 50 },
          { x: 50, y: 30 },
        ],
      },
    ];
    const plan = compileCadExport(p, new Map([["cad", lineScene]]));
    expect(plan.commands.find((c) => c.command === "text")?.params).toMatchObject({
      text: "12",
      at: [50, 70],
      height: 10,
      justify: "MC",
    });
    expect(primitives(plan).some((p) => p.kind === "polyline")).toBe(true);
  });
  it("uses the frozen source for nested details and emits masks, marker and ratio", () => {
    const p = project();
    const first = createDetailView(p, { x: 50, y: 50 }, 20, { x: 200, y: 200 }, "A", 2, 10, 1, "a");
    p.detailViews = [first];
    const nested = createDetailView(
      p,
      { x: 200, y: 200 },
      10,
      { x: 300, y: 300 },
      "B",
      3,
      10,
      1,
      "b",
    );
    p.detailViews = [nested];
    p.cad = { ...p.cad!, assetId: "new-cad" };
    const plan = compileCadExport(
      p,
      new Map([
        ["cad", lineScene],
        ["new-cad", { entities: [], primitives: [] }],
      ]),
    );
    const lines = primitives(plan).filter((p) => p.kind === "polyline");
    expect(lines.some((p) => p.points.some((q) => Math.abs(q[1]! + 200) < 1e-6))).toBe(true);
    expect(primitives(plan).some((p) => p.kind === "mask")).toBe(true);
    expect(plan.commands.filter((c) => c.command === "text").map((c) => c.params.text)).toEqual(
      expect.arrayContaining(["B", "3:1"]),
    );
    expect(() => compileCadExport(p, new Map([["new-cad", lineScene]]))).toThrow(/局部放大|冻结/);
  });
  it("fails explicitly instead of ignoring unsupported scene primitive types", () => {
    const p = project();
    p.baseFragments = [
      { id: "clipped", offset: { x: 0, y: 0 }, clips: [rectangle(0, 0, 50, 50)], holes: [] },
    ];
    expect(() =>
      compileCadExport(
        p,
        new Map([
          [
            "cad",
            { entities: [], primitives: [{ ...lineScene.primitives[0]!, kind: "unsupported" }] },
          ],
        ]),
      ),
    ).toThrow(/不支持/);
  });
  it("handles a concave crop and a filled hole without filling the removed area", () => {
    const p = project();
    p.baseFragments = [
      {
        id: "l",
        offset: { x: 0, y: 0 },
        clips: [
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 4 },
            { x: 4, y: 4 },
            { x: 4, y: 10 },
            { x: 0, y: 10 },
          ],
        ],
        holes: [rectangle(1, 1, 2, 2)],
      },
    ];
    const scene: CadExportScene = {
      entities: [],
      primitives: [
        {
          kind: "triangles",
          points: [
            [0, 100],
            [10, 100],
            [10, 90],
            [0, 100],
            [10, 90],
            [0, 90],
          ],
          color: [0, 0, 0],
          aci7: true,
          lineweight: 0,
        },
      ],
    };
    const cells = primitives(compileCadExport(p, new Map([["cad", scene]]))).filter(
      (p) => p.kind === "triangles",
    );
    const sum = cells.reduce((total, p) => {
      const [a, b, c] = p.points as [number[], number[], number[]];
      return (
        total + Math.abs((b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!)) / 2
      );
    }, 0);
    expect(sum).toBeCloseTo(60);
  });
  it.skipIf(
    process.platform !== "win32" ||
      !existsSync(new URL("../../../resources/cadcraft/cadcraft-codec.exe", import.meta.url)) ||
      !existsSync(new URL("../../../resources/cadcraft/wasm/cadcraft_bg.wasm", import.meta.url)),
  )(
    "executes a clipped Chinese/detail/annotation plan in real WASM and roundtrips real DWG",
    async () => {
      const generated = new URL("../../../resources/cadcraft/wasm/", import.meta.url);
      const { initSync, CadcraftSession } = await import(
        /* @vite-ignore */ new URL("cadcraft.js", generated).href
      );
      initSync({ module: readFileSync(new URL("cadcraft_bg.wasm", generated)) });
      const source = new CadcraftSession(),
        output = new CadcraftSession(),
        restored = new CadcraftSession();
      try {
        const font = fileURLToPath(
          new URL("../document/fonts/SourceHanSerifCN-Regular.otf", import.meta.url),
        );
        source.register_font("Source Han Serif CN", readFileSync(font));
        source.execute(
          "line",
          JSON.stringify({
            points: [
              [0, 50],
              [100, 50],
            ],
          }),
        );
        source.execute("text", JSON.stringify({ at: [30, 60], text: "专利", height: 8 }));
        source.execute("circle", JSON.stringify({ center: [25, 50], radius: 5 }));
        source.execute("layer.set", JSON.stringify({ name: "0", locked: true }));
        const p = project();
        p.baseFragments = [
          {
            id: "piece",
            offset: { x: 5, y: 0 },
            clips: [rectangle(0, 0, 80, 100)],
            holes: [rectangle(45, 45, 5, 10)],
          },
        ];
        p.annotations = [
          {
            id: "n",
            text: "12",
            x: 60,
            y: 20,
            fontSize: 8,
            lineWidth: 1,
            points: [
              { x: 40, y: 40 },
              { x: 60, y: 20 },
            ],
          },
        ];
        p.detailViews = [
          createDetailView(p, { x: 30, y: 45 }, 20, { x: 150, y: 100 }, "A", 2, 8, 1, "d"),
        ];
        const scene = JSON.parse(source.scene());
        const plan = compileCadExport(p, new Map([["cad", scene]]));
        if (plan.sourceCadAssetId) output.load_dxf(source.export_dxf());
        for (const command of plan.commands)
          output.execute(command.command, JSON.stringify(command.params));
        const types = JSON.parse(output.scene()).entities.map((e: { type: string }) => e.type);
        expect(types).toContain("2D Solid");
        expect(types).toContain("Text");
        expect(types).toContain("Wipeout");
        const codec = fileURLToPath(
          new URL("../../../resources/cadcraft/cadcraft-codec.exe", import.meta.url),
        );
        const dwg = execFileSync(codec, ["dxf-to-dwg", "--font", font], {
          input: output.export_dxf(),
          windowsHide: true,
          maxBuffer: 100 * 1024 * 1024,
        });
        expect(dwg.subarray(0, 6).toString()).toBe("AC1032");
        const dxf = execFileSync(codec, ["dwg-to-dxf", "--font", font], {
          input: dwg,
          windowsHide: true,
          maxBuffer: 100 * 1024 * 1024,
        });
        restored.load_dxf(dxf);
        expect(JSON.parse(restored.scene()).entityCount).toBe(
          JSON.parse(output.scene()).entityCount,
        );
        expect(new TextDecoder().decode(restored.export_dxf())).toContain("12");
      } finally {
        source.free();
        output.free();
        restored.free();
      }
    },
  );
});
