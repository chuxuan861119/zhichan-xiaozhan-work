import { expect, it } from "vitest";
import { nonWhiteBounds } from "./trim-white.js";

it("finds the tight bounds without losing faint lines or edge content", () => {
  const data = new Uint8ClampedArray(8 * 6 * 4).fill(255);
  data[(2 * 8 + 3) * 4] = 254;
  data[(4 * 8 + 7) * 4] = 0;
  expect(nonWhiteBounds(data, 8, 6)).toEqual({ x: 3, y: 2, width: 5, height: 3 });
});
it("ignores fully transparent pixels and returns null for a blank image", () => {
  expect(nonWhiteBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull();
  expect(nonWhiteBounds(new Uint8ClampedArray(16).fill(255), 2, 2)).toBeNull();
});
