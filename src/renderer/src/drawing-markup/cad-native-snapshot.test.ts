import { expect, test } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { canAcceptNativeSnapshot } from "./cad-native-snapshot";
test("native geometry with unchanged patent objects does not need semantic recomposition", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: project.baseAssetId,
    unified: 1,
    mapping: { originX: 0, originY: 800, scale: 1 },
    objects: [],
  };
  expect(canAcceptNativeSnapshot(project, { ...project, revision: 2 })).toBe(true);
  expect(canAcceptNativeSnapshot(project, { ...project, annotations: [] })).toBe(false);
  expect(
    canAcceptNativeSnapshot(project, {
      ...project,
      cad: { ...project.cad, objects: [{ id: "d", kind: "detail", body: ["A"] }] },
    }),
  ).toBe(false);
});
