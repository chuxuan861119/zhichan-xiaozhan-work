const paths: Record<
  string,
  { path: string; x: number; y: number; pointer?: boolean; size?: number; strokeWidth?: number }
> = {
  rectangle: { path: "M48.5 1V95M1 48.5H95", x: 48, y: 48, size: 96, strokeWidth: 0.75 },
  clone: { path: "M12 5a4 4 0 0 1 8 0v6l3 4H9l3-4V5Zm-5 13h18v4H7Z", x: 16, y: 16 },
  blur: { path: "M16 3c-3 5-8 10-8 15a8 8 0 0 0 16 0c0-5-5-10-8-15Z", x: 16, y: 16 },
  bucket: {
    path: "m18 19 7-7 9 9-10 10-9-9 3-3m-1 4h15m1 4c-3 4-3 6 0 6s3-2 0-6",
    x: 2,
    y: 2,
    pointer: true,
  },
  magicWand: {
    path: "m18 29 10-10m-8 8 3 3m0-13 1-3m5 3 3-1m-4 7 3 2m-13-5-3-1",
    x: 2,
    y: 2,
    pointer: true,
  },
  move: {
    path: "M18 24h12m-6-6v12m-6-6 3-3m-3 3 3 3m9-3-3-3m3 3-3 3m-3-9-3 3m3-3 3 3m-3 9-3-3m3 3 3-3",
    x: 2,
    y: 2,
    pointer: true,
  },
  lasso: {
    path: "M20 18c-5 2-4 8 2 8s10-6 5-8c-4-3-9 0-7 3s7 3 5 7c-1 2-5 3-5 0",
    x: 2,
    y: 2,
    pointer: true,
  },
  polygon: {
    path: "M18 17 30 20 27 29 18 27 18 17m0 10 5 3",
    x: 2,
    y: 2,
    pointer: true,
  },
  eyedropper: {
    path: "m4 20 2-6L17 3l4 4-11 11-6 2Zm9-13 6 6M3 21l2-2m10-14 4 4",
    x: 3,
    y: 21,
  },
  crop: { path: "M7 2v15h15M2 7h15v15M4 4l17 17", x: 7, y: 7 },
  rotate: { path: "M5 13a8 8 0 1 1 7 8M2 9l3 5 5-4", x: 5, y: 13 },
};
const cache = new Map<string, string>();
/** Original monochrome drawings with a white keyline for contrast on any image. */
export function klecksToolShape(tool: string, precise = false): string {
  if (precise && tool !== "rectangle") return "crosshair";
  const shape = paths[tool];
  if (!shape) return "crosshair";
  let cursor = cache.get(tool);
  if (!cursor) {
    const size = shape.size ?? (shape.pointer ? 32 : 26);
    const arrow = shape.pointer
      ? '<path fill="#111" stroke="white" stroke-width="2" stroke-linejoin="round" d="M2 2v17l4.5-4.5L10 22l3-1.5L9.5 13H17Z"/>'
      : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${arrow}<g fill="none" stroke-linejoin="round" stroke-linecap="round"><path stroke="white" stroke-width="${shape.strokeWidth ? 2 : 3.5}" d="${shape.path}"/><path stroke="#111" stroke-width="${shape.strokeWidth ?? 1.3}" d="${shape.path}"/></g></svg>`;
    cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${shape.x} ${shape.y}, crosshair`;
    cache.set(tool, cursor);
  }
  return cursor;
}
