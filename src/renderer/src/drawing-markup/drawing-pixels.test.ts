import { afterEach, expect, test, vi } from "vitest";
import { nonWhiteBounds } from "../../../shared/drawing-markup/trim-white";
import { DrawingPixelScanner } from "./drawing-pixels";

afterEach(() => vi.unstubAllGlobals());
test("cooperative scan matches the original pixel predicate at stripe boundaries and hairlines", async () => {
  vi.stubGlobal("Worker", undefined);
  const width = 50,
    height = 300,
    data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x, y] of [
    [4, 0],
    [49, 128],
    [30, 299],
  ])
    data[(y! * width + x!) * 4] = 254;
  const ctx = {
    getImageData: vi.fn((_x: number, y: number, w: number, h: number) => ({
      data: data.slice(y * w * 4, (y + h) * w * 4),
    })),
  };
  const scanner = new DrawingPixelScanner();
  expect(await scanner.scan(ctx as never, width, height)).toEqual(
    nonWhiteBounds(data, width, height),
  );
  expect(ctx.getImageData).toHaveBeenCalledTimes(1);
  data.fill(255);
  expect(await scanner.scan(ctx as never, width, height)).toBeNull();
  scanner.dispose();
});

test("worker failure falls back without losing pixels and does not retry the broken worker", async () => {
  const terminate = vi.fn(),
    post = vi.fn();
  vi.stubGlobal(
    "Worker",
    class {
      onerror: (() => void) | null = null;
      postMessage() {
        post();
        queueMicrotask(() => this.onerror?.());
      }
      terminate() {
        terminate();
      }
    },
  );
  const data = new Uint8ClampedArray(4 * 10 * 10).fill(255);
  data[(7 * 10 + 3) * 4] = 254;
  const context = { canvas: {}, getImageData: vi.fn(() => ({ data })) };
  const scanner = new DrawingPixelScanner();
  expect(await scanner.scan(context as never, 10, 10)).toEqual({ x: 3, y: 7, width: 1, height: 1 });
  expect(await scanner.scan(context as never, 10, 10)).toEqual({ x: 3, y: 7, width: 1, height: 1 });
  expect(post).toHaveBeenCalledTimes(1);
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(context.getImageData).toHaveBeenCalledTimes(2);
  scanner.dispose();
});
