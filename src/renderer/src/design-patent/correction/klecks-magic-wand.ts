import type { SelectionOutline } from "../../../../shared/patent/design-selection-coverage";
export type MagicWandOptions = {
  tolerance: number;
  contiguous: boolean;
  antiAlias: boolean;
  sampleSize: 1 | 3 | 5 | 11;
  sampleAllLayers: boolean;
};
export async function magicWandSelection(
  image: { width: number; height: number; data: Uint8ClampedArray },
  x: number,
  y: number,
  options: MagicWandOptions,
  job: { signal?: AbortSignal; budgetMs?: number; yieldControl?: () => Promise<void> } = {},
): Promise<SelectionOutline> {
  const { width, height, data } = image,
    n = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 10000 ||
    height > 10000 ||
    n > 40000000 ||
    data.length !== n * 4 ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= width ||
    y >= height ||
    !Number.isInteger(options.tolerance) ||
    options.tolerance < 0 ||
    options.tolerance > 255 ||
    ![1, 3, 5, 11].includes(options.sampleSize) ||
    [options.contiguous, options.antiAlias, options.sampleAllLayers].some(
      (v) => typeof v !== "boolean",
    )
  )
    throw Error("魔棒参数或取样位置无效，请在图片范围内点击。");
  let clock = performance.now();
  const checkpoint = async () => {
    if (job.signal?.aborted) throw new DOMException("已取消魔棒选区", "AbortError");
    if (performance.now() - clock >= (job.budgetMs ?? 8)) {
      await (job.yieldControl?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0)));
      clock = performance.now();
      if (job.signal?.aborted) throw new DOMException("已取消魔棒选区", "AbortError");
    }
  };
  await checkpoint();
  x = Math.floor(x);
  y = Math.floor(y);
  const radius = (options.sampleSize - 1) / 2,
    sample = [0, 0, 0, 0];
  let count = 0;
  for (let sy = Math.max(0, y - radius); sy <= Math.min(height - 1, y + radius); sy++)
    for (let sx = Math.max(0, x - radius); sx <= Math.min(width - 1, x + radius); sx++) {
      const i = (sy * width + sx) * 4,
        a = data[i + 3]!;
      for (let k = 0; k < 3; k++) sample[k]! += data[i + k]! * a;
      sample[3]! += a;
      count++;
    }
  for (let k = 0; k < 3; k++) sample[k] = sample[3] ? sample[k]! / sample[3]! : 0;
  sample[3] = sample[3]! / count;
  const match = (index: number) => {
    const i = index * 4,
      a = data[i + 3]!;
    if (sample[3] === 0) return a === 0;
    if (a === 0 || Math.abs(a - sample[3]!) > options.tolerance) return false;
    return (
      Math.max(
        Math.abs(data[i]! - sample[0]!),
        Math.abs(data[i + 1]! - sample[1]!),
        Math.abs(data[i + 2]! - sample[2]!),
      ) <= options.tolerance
    );
  };
  const state = new Uint8Array(n);
  if (options.contiguous) {
    const queue = new Uint32Array(n);
    let head = 0,
      tail = 0;
    const visit = (index: number) => {
      if (state[index]) return;
      state[index] = match(index) ? 2 : 1;
      if (state[index] === 2) queue[tail++] = index;
    };
    visit(y * width + x);
    while (head < tail) {
      const index = queue[head++]!,
        column = index % width;
      if (column > 0) visit(index - 1);
      if (column + 1 < width) visit(index + 1);
      if (index >= width) visit(index - width);
      if (index + width < n) visit(index + width);
      if ((head & 4095) === 0) await checkpoint();
    }
  } else {
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const i = row * width + col;
        state[i] = match(i) ? 2 : 1;
      }
      await checkpoint();
    }
  }
  return traceSelectedPixels(state, width, height, options.antiAlias, checkpoint);
}
export async function traceSelectedPixels(
  state: Uint8Array,
  width: number,
  height: number,
  antiAlias: boolean,
  checkpoint: () => Promise<void>,
): Promise<SelectionOutline> {
  const steps = traceSelectedPixelSteps(state, width, height, antiAlias);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    await checkpoint();
  }
}
export function traceSelectedPixelsSync(
  state: Uint8Array,
  width: number,
  height: number,
): SelectionOutline {
  const steps = traceSelectedPixelSteps(state, width, height, false);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
function* traceSelectedPixelSteps(
  state: Uint8Array,
  width: number,
  height: number,
  antiAlias: boolean,
): Generator<void, SelectionOutline> {
  // Directed pixel boundaries retain holes and separate diagonal islands. Collinear
  // edges are simplified during tracing, not by lossy downsampling of the image.
  const stride = width + 1,
    edges = new Map<number, number>();
  let edgeCount = 0;
  const complex = () =>
    Error("本次选区边缘过于复杂，未改变原选区。请开启连续区域或调整容差后重试。");
  const edge = (px: number, py: number, d: number) => {
    if (++edgeCount > 200000) throw complex();
    const key = py * stride + px;
    edges.set(key, (edges.get(key) ?? 0) | (1 << d));
  };
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      if (state[i] !== 2) continue;
      if (row === 0 || state[i - width] !== 2) edge(col, row, 0);
      if (col === width - 1 || state[i + 1] !== 2) edge(col + 1, row, 1);
      if (row === height - 1 || state[i + width] !== 2) edge(col + 1, row + 1, 2);
      if (col === 0 || state[i - 1] !== 2) edge(col, row + 1, 3);
    }
    yield;
  }
  type Ring = SelectionOutline[number][number];
  const rings: Array<{ ring: Ring; area: number }> = [];
  let totalPoints = 0,
    steps = 0;
  const delta = [1, stride, -1, -stride];
  while (edges.size) {
    const start = edges.keys().next().value!;
    let node = start,
      previous = -1;
    const ring: Ring = [[node % stride, Math.floor(node / stride)]];
    do {
      const bits = edges.get(node) ?? 0;
      const order =
        previous < 0
          ? [0, 1, 2, 3]
          : [(previous + 1) % 4, previous, (previous + 3) % 4, (previous + 2) % 4];
      const direction = order.find((d) => bits & (1 << d));
      if (direction === undefined) throw complex();
      const remaining = bits & ~(1 << direction);
      if (remaining) edges.set(node, remaining);
      else edges.delete(node);
      node += delta[direction]!;
      const point: [number, number] = [node % stride, Math.floor(node / stride)];
      if (direction === previous && ring.length > 1) ring[ring.length - 1] = point;
      else ring.push(point);
      previous = direction;
      if ((++steps & 4095) === 0) yield;
    } while (node !== start);
    // The arbitrary starting edge can split one straight edge across the closure.
    if (ring.length > 4) {
      const a = ring.at(-2)!,
        b = ring[0]!,
        c = ring[1]!;
      if ((b[0] - a[0]) * (c[1] - b[1]) === (b[1] - a[1]) * (c[0] - b[0])) {
        ring.shift();
        ring[ring.length - 1] = [...ring[0]!] as [number, number];
      }
    }
    const area =
      ring.slice(1).reduce((sum, p, i) => sum + ring[i]![0] * p[1] - p[0] * ring[i]![1], 0) / 2;
    totalPoints += antiAlias ? (ring.length - 1) * 2 + 1 : ring.length;
    if (totalPoints > 50000 || rings.length >= 1000) throw complex();
    rings.push({ ring, area });
  }
  const outers = rings.filter((r) => r.area > 0),
    result: SelectionOutline = outers.map((r) => [r.ring]);
  const contains = (ring: Ring, p: readonly number[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
      const a = ring[i]!,
        b = ring[j]!;
      if (
        a[1] > p[1]! !== b[1] > p[1]! &&
        p[0]! < ((b[0] - a[0]) * (p[1]! - a[1])) / (b[1] - a[1]) + a[0]
      )
        inside = !inside;
    }
    return inside;
  };
  for (const hole of rings.filter((r) => r.area < 0)) {
    let parent = -1,
      smallest = Infinity;
    for (let i = 0; i < outers.length; i++)
      if (outers[i]!.area < smallest && contains(outers[i]!.ring, hole.ring[0]!)) {
        parent = i;
        smallest = outers[i]!.area;
      }
    if (parent < 0) throw complex();
    result[parent]!.push(hole.ring);
    yield;
  }
  if (antiAlias)
    for (const polygon of result)
      for (let k = 0; k < polygon.length; k++) {
        const ring = polygon[k]!,
          smooth: Ring = [];
        for (let i = 0; i < ring.length - 1; i++) {
          const p = ring[i]!,
            a = ring[(i + ring.length - 2) % (ring.length - 1)]!,
            b = ring[(i + 1) % (ring.length - 1)]!;
          if (p[0] === 0 || p[0] === width || p[1] === 0 || p[1] === height) {
            smooth.push([...p] as [number, number]);
            continue;
          }
          const before = Math.hypot(a[0] - p[0], a[1] - p[1]),
            after = Math.hypot(b[0] - p[0], b[1] - p[1]);
          smooth.push(
            [p[0] + ((a[0] - p[0]) * 0.2) / before, p[1] + ((a[1] - p[1]) * 0.2) / before],
            [p[0] + ((b[0] - p[0]) * 0.2) / after, p[1] + ((b[1] - p[1]) * 0.2) / after],
          );
        }
        smooth.push([...smooth[0]!] as [number, number]);
        polygon[k] = smooth;
      }
  yield;
  return result;
}
