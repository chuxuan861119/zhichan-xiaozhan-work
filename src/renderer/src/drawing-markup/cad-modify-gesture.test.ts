import { expect, test } from "vitest";
import {
  CadRotationGesture,
  cadTransform,
  mergeCadSelection,
  transformCadPoint,
} from "./cad-modify-gesture";

test("rotation gestures retain full turns, reverse continuously and ignore the center", () => {
  const g = new CadRotationGesture({ x: 0, y: 0 }, { x: 0, y: 1 });
  const at = (n: number) => ({
    x: -Math.sin((n * Math.PI) / 180),
    y: Math.cos((n * Math.PI) / 180),
  });
  for (const n of [90, 179, 181, 270, 359, 361, 450, 540])
    expect(g.update(at(n))).toBeCloseTo(n, 8);
  expect(g.update({ x: 0, y: 0 })).toBeCloseTo(540, 8);
  for (const n of [450, 360, 270, 180, 90, 0, -90, -179, -181, -270, -360])
    expect(g.update(at(n))).toBeCloseTo(n, 8);
});

test("rotation and reference scaling keep the picked base fixed", () => {
  const rotation = cadTransform("rotate", { x: 10, y: 20 }, null, { x: 10, y: 30 });
  expect(rotation).toEqual({ command: "rotate", base: [10, 20], angle: 90 });
  expect(transformCadPoint([20, 20], rotation!)).toEqual([10, 30]);
  const scale = cadTransform("scale", { x: 10, y: 20 }, { x: 20, y: 20 }, { x: 30, y: 20 });
  expect(scale).toEqual({ command: "scale", base: [10, 20], factor: 2 });
  expect(transformCadPoint([10, 20], scale!)).toEqual([10, 20]);
  expect(transformCadPoint([20, 20], scale!)).toEqual([30, 20]);
});

test("invalid scale references and zero target distances do not create a transform", () => {
  const base = { x: 0, y: 0 };
  expect(cadTransform("scale", base, base, { x: 10, y: 10 })).toBeNull();
  expect(cadTransform("scale", base, { x: 10, y: 0 }, base)).toBeNull();
  expect(cadTransform("rotate", base, null, base)).toBeNull();
});

test("normal selection accumulates and Shift only removes the hit members", () => {
  expect(mergeCadSelection(["A"], ["A", "B"], false)).toEqual(["A", "B"]);
  expect(mergeCadSelection(["A", "B"], ["B", "C"], true)).toEqual(["A"]);
  expect(mergeCadSelection(["A"], [], false)).toEqual(["A"]);
});
