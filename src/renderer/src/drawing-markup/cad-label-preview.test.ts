// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import init, { CadcraftSession } from "../../../../resources/cadcraft/wasm/cadcraft.js";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { cadLabelFreeSvg } from "./cad-label-preview";
import { cadObjectGroup } from "../../../shared/drawing-markup/cad-objects";

await init({
  module_or_path: readFileSync(
    new URL("../../../../resources/cadcraft/wasm/cadcraft_bg.wasm", import.meta.url),
  ),
});

test.each(["frame", "source"] as const)("selected detail %s renders independently of its other parts", role => {
  const source = new CadcraftSession(), actual = new CadcraftSession(), expected = new CadcraftSession();
  try {
    const chosen = JSON.parse(source.execute("circle", JSON.stringify({ center: [30,30], radius: 10 }))).handle;
    const other = JSON.parse(source.execute("line", JSON.stringify({ points: [[70,70],[90,90]] }))).handles[0];
    const name = cadObjectGroup({ id: "detail", kind: "detail", role });
    source.execute("group", JSON.stringify({ name, handles: [chosen], selectable: false }));
    const bytes = source.export_dxf();
    const project = { width: 100, height: 100, cad: { mapping: { originX: 0, originY: 100, scale: 1 } } } as DrawingProject;
    const svg = cadLabelFreeSvg(actual, project, bytes, [], [chosen]);
    source.execute("ungroup", JSON.stringify({ name }));
    const visible = cadLabelFreeSvg(expected, project, source.export_dxf(), [], [chosen]);
    expect(svg).toBe(visible);
    expect(JSON.parse(actual.scene()).entities.map((e: {handle:string}) => e.handle)).toEqual([chosen]);
    expect(JSON.parse(source.scene()).entities.map((e: {handle:string}) => e.handle)).toContain(other);
  } finally { source.free(); actual.free(); expected.free(); }
});

test("removes only bound CAD labels from a framed preview without mutating the source", () => {
  const source = new CadcraftSession();
  try {
    const geometry = JSON.parse(
      source.execute(
        "line",
        JSON.stringify({
          points: [
            [10, 20],
            [30, 40],
          ],
        }),
      ),
    ).handles[0] as string;
    const label = JSON.parse(
      source.execute("text", JSON.stringify({ at: [20, 30], text: "1", height: 3 })),
    ).handle as string;
    const bytes = source.export_dxf();
    const project = {
      projectId: "p",
      name: "图",
      sourceAssetId: "s",
      baseAssetId: "b",
      sourceKind: "dxf",
      pageNumber: 1,
      width: 100,
      height: 100,
      regions: [],
      warnings: [],
      revision: 1,
      annotations: [{ id: "a", text: "1", x: 20, y: 70, fontSize: 3, lineWidth: 1, points: [] }],
      cad: {
        version: 1,
        engine: "cadcraft",
        engineVersion: "0".repeat(40),
        assetId: "c",
        mapping: { originX: 0, originY: 100, scale: 1 },
        unified: 1,
        objects: [{ id: "a", kind: "label", label: [label] }],
      },
    } as DrawingProject;
    const isolated = new CadcraftSession();
    try {
      const svg = cadLabelFreeSvg(isolated, project, bytes, [label]);
      expect(svg).toMatch(/viewBox="[-.\d]+ [-.\d]+ 100 100"/u);
      expect(svg).toContain("polyline");
      expect(svg).not.toContain(">1</text>");
      expect(
        JSON.parse(source.scene()).entities.map((e: { handle: string }) => e.handle),
      ).toContain(label);
      expect(
        JSON.parse(isolated.scene()).entities.map((e: { handle: string }) => e.handle),
      ).toContain(geometry);
      expect(
        JSON.parse(isolated.scene()).entities.map((e: { handle: string }) => e.handle),
      ).not.toContain(label);
    } finally {
      isolated.free();
    }
  } finally {
    source.free();
  }
});

test("selected CAD preview keeps only chosen geometry and repaints its bound label", () => {
  const source = new CadcraftSession();
  try {
    const chosen = JSON.parse(source.execute("line", JSON.stringify({ points: [[10, 20], [30, 40]] }))).handles[0] as string;
    const excluded = JSON.parse(source.execute("line", JSON.stringify({ points: [[70, 20], [90, 40]] }))).handles[0] as string;
    const label = JSON.parse(source.execute("text", JSON.stringify({ at: [20, 30], text: "1", height: 3 }))).handle as string;
    const bytes = source.export_dxf();
    const project = {
      width: 100, height: 100,
      cad: { mapping: { originX: 0, originY: 100, scale: 1 } },
    } as DrawingProject;
    const isolated = new CadcraftSession();
    try {
      const svg = cadLabelFreeSvg(isolated, project, bytes, [label], [chosen, label]);
      const handles = JSON.parse(isolated.scene()).entities.map((entity: { handle: string }) => entity.handle);
      expect(handles).toContain(chosen);
      expect(handles).not.toContain(excluded);
      expect(handles).not.toContain(label);
      expect(svg).toContain("polyline");
      expect(svg).not.toContain(">1</text>");
      expect(JSON.parse(source.scene()).entities).toHaveLength(3);
    } finally { isolated.free(); }
  } finally { source.free(); }
});
