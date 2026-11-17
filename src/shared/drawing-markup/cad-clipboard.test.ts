// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pasteCadMetadata } from "./cad-clipboard.js";
import { createDetailView } from "./detail-view.js";
import type { DrawingProject } from "./model.js";

function fixture(): DrawingProject {
  return {
    projectId: "00000000-0000-4000-8000-000000000801",
    name: "图",
    sourceAssetId: "00000000-0000-4000-8000-000000000901",
    baseAssetId: "00000000-0000-4000-8000-000000000902",
    sourceKind: "dxf",
    pageNumber: 1,
    width: 100,
    height: 100,
    regions: [],
    warnings: [],
    revision: 0,
    annotations: [],
    cad: {
      version: 1,
      engine: "cadcraft",
      engineVersion: "0".repeat(40),
      assetId: "00000000-0000-4000-8000-000000000903",
      mapping: { originX: 0, originY: 100, scale: 1 },
      unified: 1,
      objects: [],
    },
  };
}
describe("frozen CAD clipboard metadata", () => {
  it("keeps text and leaders attached to world geometry when source and target display scales differ", () => {
    const source = fixture(),
      target = fixture();
    source.cad!.mapping.scale = 2;
    source.annotations = [
      {
        id: "a",
        text: "1",
        x: 30,
        y: 20,
        fontSize: 10,
        lineWidth: 2,
        points: [
          { x: 10, y: 10 },
          { x: 30, y: 20 },
        ],
      },
    ];
    source.cad!.objects = [{ id: "a", kind: "label", label: ["A", "B"] }];
    const next = pasteCadMetadata(
      target,
      source,
      ["A", "B"],
      ["C", "D"],
      [0, 0],
      [],
      ["C", "D"],
      () => "fresh",
    );
    expect(next.annotations[0]).toMatchObject({
      x: 15,
      y: 10,
      fontSize: 5,
      lineWidth: 1,
      points: [
        { x: 5, y: 5 },
        { x: 15, y: 10 },
      ],
    });
  });
  it("rebases pasted detail metadata into the target and resolves duplicate detail letters", () => {
    const source = fixture(),
      target = fixture();
    source.detailViews = [
      createDetailView(source, { x: 20, y: 20 }, 5, { x: 70, y: 70 }, "A", 2, 8, 1, "source"),
    ];
    source.cad!.objects = [
      { id: "source", kind: "detail", body: ["A"], frame: ["B"], source: ["C"] },
    ];
    target.detailViews = [
      createDetailView(target, { x: 10, y: 10 }, 5, { x: 40, y: 40 }, "B", 2, 8, 1, "target"),
    ];
    target.cad!.mapping = { originX: -10, originY: 110, scale: 1 };
    const immutable = JSON.stringify([source, target]);
    const result = pasteCadMetadata(
      target,
      source,
      ["A", "B", "C"],
      ["D", "E", "F"],
      [5, 0],
      ["1"],
      ["1", "D", "E", "F"],
      () => "fresh",
    );
    expect(result.detailViews![1]).toMatchObject({
      id: "fresh",
      label: "C",
      source: { x: 35, y: 30 },
      center: { x: 85, y: 80 },
    });
    expect(result.cad!.objects!.at(-1)).toMatchObject({
      id: "fresh",
      body: ["D"],
      frame: ["E"],
      source: ["F"],
    });
    expect(JSON.stringify([source, target])).toBe(immutable);
  });
  it("attaches only ordinary pasted geometry to an edited detail without mutating the source or target", () => {
    const source = fixture(),
      target = fixture();
    target.cad!.objects = [{ id: "inside", kind: "detail", body: ["1"], frame: ["2"] }];
    const immutable = JSON.stringify([source, target]);
    const result = pasteCadMetadata(
      target,
      source,
      ["A"],
      ["3"],
      [0, 0],
      ["1", "2"],
      ["1", "2", "3"],
      () => "fresh",
      "inside",
    );
    expect(result.cad!.objects![0]!.body).toEqual(["1", "3"]);
    expect(JSON.stringify([source, target])).toBe(immutable);
  });
});
