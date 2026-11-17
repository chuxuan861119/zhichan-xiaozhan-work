import { expect, test } from "vitest";
import {
  nativeCadLabelHandles,
  nativeCadLabelIds,
  selectedNativeCadLabelIds,
} from "./cad-native-label.js";
import { cadSemanticKey } from "./cad-semantic-key.js";
import type { DrawingProject } from "./model.js";

const project = (): DrawingProject => {
  const p: DrawingProject = {
    projectId: "p",
    name: "图",
    sourceAssetId: "source",
    baseAssetId: "base",
    sourceKind: "dxf" as const,
    pageNumber: 1,
    width: 100,
    height: 100,
    regions: [],
    warnings: [],
    revision: 1,
    annotations: [
      {
        id: "label",
        text: "1",
        x: 20,
        y: 20,
        fontSize: 8,
        lineWidth: 1,
        points: [
          { x: 5, y: 5 },
          { x: 20, y: 20 },
        ],
      },
    ],
    cad: {
      version: 1 as const,
      engine: "cadcraft" as const,
      engineVersion: "0".repeat(40),
      assetId: "cad",
      mapping: { originX: 0, originY: 100, scale: 1 },
      unified: 1 as const,
      objects: [{ id: "label", kind: "label" as const, label: ["A", "B"] }],
    },
  };
  p.cad!.semanticKey = cadSemanticKey(p);
  return p;
};

test("uses native label only when its CAD binding matches the semantic revision", () => {
  const p = project();
  expect(nativeCadLabelHandles(p, "label")).toEqual(["A", "B"]);
  expect([...nativeCadLabelIds(p)]).toEqual(["label"]);
  expect([...selectedNativeCadLabelIds(p, ["A"])]).toEqual([]);
  expect([...selectedNativeCadLabelIds(p, ["A", "B"])]).toEqual(["label"]);
  expect(
    nativeCadLabelHandles({ ...p, annotations: [{ ...p.annotations[0]!, text: "2" }] }, "label"),
  ).toEqual([]);
  expect(nativeCadLabelHandles({ ...p, cad: { ...p.cad!, objects: [] } }, "label")).toEqual([]);
  expect(nativeCadLabelHandles({ ...p, cad: { ...p.cad!, unified: undefined } }, "label")).toEqual(
    [],
  );
});
