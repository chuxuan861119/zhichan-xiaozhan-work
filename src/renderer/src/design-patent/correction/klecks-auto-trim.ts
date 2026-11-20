import {
  type AutoTrimOptions,
  AutoTrimOptionsSchema,
} from "../../../../shared/settings/design-auto-trim";
import type { WhitespaceBounds } from "./klecks-whitespace";
export async function scanTrimEdges(
  source: { width: number; height: number; data: Uint8ClampedArray },
  options: AutoTrimOptions,
  signal?: AbortSignal,
): Promise<WhitespaceBounds | null> {
  const { width, height, data } = source,
    settings = AutoTrimOptionsSchema.parse(options);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 10000 ||
    height > 10000 ||
    width * height > 40000000 ||
    data.length !== width * height * 4
  )
    throw Error("裁剪图像参数无效。");
  let left = width,
    top = height,
    right = -1,
    bottom = -1,
    clock = performance.now();
  for (let y = 0; y < height; y++) {
    if (signal?.aborted) throw new DOMException("已取消", "AbortError");
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (data[p + 3] === 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = y;
    }
    if (performance.now() - clock >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      clock = performance.now();
    }
  }
  if (right < 0) return null;
  const transparentBounds = {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
  if (settings.mode === "transparent") return transparentBounds;
  // Sample the content's corners, not a fixed user-selected color. Testing all
  // distinct candidates avoids treating an isolated corner mark as the backdrop.
  const colors: number[][] = [];
  for (const [x, y] of [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ]) {
    const p = (y! * width + x!) * 4;
    if (data[p + 3] === 0) continue;
    const rgb = [data[p]!, data[p + 1]!, data[p + 2]!];
    if (!colors.some((c) => c.every((v, i) => v === rgb[i]))) colors.push(rgb);
  }
  if (!colors.length) return transparentBounds;
  const boxes = colors.map(() => ({
    left: width,
    top: height,
    right: -1,
    bottom: -1,
  }));
  for (let y = top; y <= bottom; y++) {
    if (signal?.aborted) throw new DOMException("已取消", "AbortError");
    for (let x = left; x <= right; x++) {
      const p = (y * width + x) * 4;
      if (data[p + 3] === 0) continue;
      colors.forEach((rgb, index) => {
        if (rgb.every((v, c) => Math.abs(data[p + c]! - v) <= settings.tolerance)) return;
        const box = boxes[index]!;
        box.left = Math.min(box.left, x);
        box.right = Math.max(box.right, x);
        box.top = Math.min(box.top, y);
        box.bottom = y;
      });
    }
    if (performance.now() - clock >= 8) {
      await new Promise<void>((r) => setTimeout(r, 0));
      clock = performance.now();
    }
  }
  const content = boxes
    .filter((b) => b.right >= 0)
    .map((b) => ({
      left: b.left,
      top: b.top,
      width: b.right - b.left + 1,
      height: b.bottom - b.top + 1,
    }));
  if (!content.length) return null;
  return content.reduce(
    (best, b) => (b.width * b.height < best.width * best.height ? b : best),
    transparentBounds,
  );
}
