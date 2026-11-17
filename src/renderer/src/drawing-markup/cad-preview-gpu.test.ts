import { expect, test } from "vitest";
import type { CadScene } from "./cadcraft-client";
import { previewMesh } from "./cad-preview-gpu";

const primitive = (
  points: [number, number][],
  kind = "polyline",
): CadScene["primitives"][number] => ({
  points,
  kind,
  handle: "A",
  color: [0, 0, 0],
  aci7: true,
  lineweight: 0.25,
});
test("GPU preview uses local coordinates, constant screen widths and immutable input", () => {
  const p = primitive([
    [1e9, 1e9],
    [1e9 + 10, 1e9],
    [1e9 + 10, 1e9 + 10],
  ]);
  const before = JSON.stringify(p);
  const mesh = previewMesh([p], () => 1.5);
  expect(mesh.origin).toEqual([1e9, 1e9]);
  expect(mesh.vertices.length).toBe(12 * 8);
  expect([...mesh.vertices.slice(0, 8)].map((n) => n || 0)).toEqual([0, 0, 0, 1, 0, -1, 1.5, 0]);
  expect(mesh.vertices[6 * 8 + 4]).toBe(10);
  expect(mesh.fallback).toEqual([]);
  expect(JSON.stringify(p)).toBe(before);
});
test("masks and degenerate strokes do not leak into the preview; triangle fills retain order", () => {
  const mesh = previewMesh(
    [
      primitive(
        [
          [0, 0],
          [10, 0],
        ],
        "mask",
      ),
      primitive([
        [0, 0],
        [0, 0],
      ]),
      primitive(
        [
          [0, 0],
          [10, 0],
          [0, 10],
        ],
        "triangles",
      ),
      primitive([
        [0, 0],
        [0, 0],
        [10, 0],
      ]),
    ],
    () => 2,
  );
  expect(mesh.vertices.length).toBe((3 + 6) * 8);
  expect(mesh.vertices[7]).toBe(1);
  expect(mesh.vertices[3 * 8 + 7]).toBe(0);
});
test("sharp bevel joins fall back independently without dropping the remaining drawing", () => {
  const sharp = primitive([
    [0, 0],
    [10, 0],
    [0, 0.1],
  ]);
  const mesh = previewMesh(
    [
      sharp,
      primitive([
        [20, 0],
        [30, 0],
      ]),
    ],
    () => 1.5,
  );
  expect(mesh.fallback).toEqual([sharp]);
  expect(mesh.vertices.length).toBe(6 * 8);
});
