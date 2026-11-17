// @vitest-environment node
import { DrawingConversionCache } from "./drawing-conversion-cache.js";

const drawing = (size = 4) => ({
  svg: Buffer.alloc(size, 1),
  preview: Buffer.alloc(size, 2),
  width: 2000,
  height: 1000,
  warnings: ["核对特殊对象"],
});

test("keeps validated tiled results under the same byte budget without sharing mutable buffers", () => {
  const cache = new DrawingConversionCache(32, 2);
  const result = {
    tiles: Buffer.alloc(8, 3),
    preview: Buffer.alloc(8, 4),
    width: 2000,
    height: 1000,
    warnings: [],
  };
  cache.set("tiles", result);
  result.tiles.fill(9);
  expect(cache.get("tiles")?.tiles).toEqual(Buffer.alloc(8, 3));
  cache.get("tiles")!.tiles!.fill(7);
  expect(cache.get("tiles")?.tiles).toEqual(Buffer.alloc(8, 3));
  cache.set("too-large", { ...result, tiles: Buffer.alloc(25) });
  expect(cache.get("too-large")).toBeUndefined();
});

test("reuses geometry but isolates returned bytes and warnings from later imports", () => {
  const cache = new DrawingConversionCache(32, 2);
  const original = drawing();
  cache.set("file-and-runtime", original);
  original.svg.fill(9);
  original.warnings.length = 0;
  const first = cache.get("file-and-runtime")!;
  expect(first.svg).toEqual(Buffer.alloc(4, 1));
  expect(first.warnings).toEqual(["核对特殊对象"]);
  first.preview.fill(7);
  first.warnings.length = 0;
  expect(cache.get("file-and-runtime")).toEqual(drawing());
  expect(cache.get("changed-file-or-runtime")).toBeUndefined();
});

test("evicts the least recently used result at the byte or entry limit", () => {
  const cache = new DrawingConversionCache(16, 2);
  cache.set("a", drawing());
  cache.set("b", drawing());
  cache.get("a");
  cache.set("c", drawing());
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBeDefined();
  expect(cache.get("c")).toBeDefined();
  cache.set("large", drawing(9));
  expect(cache.get("large")).toBeUndefined();
  expect(cache.get("a")).toBeDefined();
  const entries = new DrawingConversionCache(100, 1);
  entries.set("a", drawing());
  entries.set("b", drawing());
  expect(entries.get("a")).toBeUndefined();
});
