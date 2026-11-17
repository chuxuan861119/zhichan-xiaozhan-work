import { z } from "zod";

export const DRAWING_TILES_MEDIA_TYPE = "application/vnd.zxw.cad-tiles+zip";
export const DRAWING_TILE_MAX_BYTES = 8 * 1024 * 1024;
export const DRAWING_CONTAINER_MAX_BYTES = 256 * 1024 * 1024;
export const DRAWING_TILE_RASTER_MAX_DIMENSION = 4096;
export const DRAWING_TILE_RASTER_MAX_PIXELS = 4_000_000;
// The legacy tier field remains readable; it no longer chooses an import strategy.
const Rect = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();
export const DrawingTileSchema = z
  .object({
    id: z.string().regex(/^tile-[0-9]{1,4}$/u),
    core: Rect,
    render: Rect,
    byteLength: z.number().int().positive().max(DRAWING_TILE_MAX_BYTES),
    sha256: z.string().regex(/^[0-9A-F]{64}$/u),
  })
  .strict();
export const DrawingTileIndexSchema = z
  .object({
    version: z.literal(1),
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000),
    tier: z.enum(["large", "huge"]),
    primitives: z.number().int().nonnegative(),
    tiles: z.array(DrawingTileSchema).min(1).max(4094),
  })
  .strict()
  .superRefine((index, context) => {
    const ids = new Set<string>();
    for (const tile of index.tiles) {
      const c = tile.core,
        r = tile.render;
      if (
        ids.has(tile.id) ||
        c.x + c.width > index.width + 0.001 ||
        c.y + c.height > index.height + 0.001 ||
        r.x > c.x ||
        r.y > c.y ||
        r.x + r.width > index.width + 0.001 ||
        r.y + r.height > index.height + 0.001 ||
        r.x + r.width + 0.001 < c.x + c.width ||
        r.y + r.height + 0.001 < c.y + c.height
      )
        context.addIssue({ code: "custom", message: "图纸分块索引无效。" });
      ids.add(tile.id);
    }
  });
export type DrawingTileIndex = z.infer<typeof DrawingTileIndexSchema>;
export type DrawingTile = z.infer<typeof DrawingTileSchema>;
export const DrawingTileRasterSchema = z
  .object({
    region: Rect,
    width: z.number().int().min(1).max(DRAWING_TILE_RASTER_MAX_DIMENSION),
    height: z.number().int().min(1).max(DRAWING_TILE_RASTER_MAX_DIMENSION),
    strokeScale: z.number().finite().min(1e-9).max(1e9),
    minimumPixels: z.number().finite().min(0.01).max(10),
  })
  .strict()
  .refine((r) => r.width * r.height <= DRAWING_TILE_RASTER_MAX_PIXELS);
export type DrawingTileRaster = z.infer<typeof DrawingTileRasterSchema>;

/** Preview allocation can be smaller than its displayed size; keep strokes in display pixels. */
export function tilePreviewStrokes(
  rasterDensity: number,
  displayDensity: number,
  referenceDensity: number,
  devicePixelRatio: number,
) {
  return {
    strokeScale: displayDensity / referenceDensity,
    minimumPixels: Math.max(
      0.01,
      0.65 * devicePixelRatio * Math.min(1, rasterDensity / displayDensity),
    ),
  };
}

/** Pure preprocessing; painting is performed by the bounded native rasterizer. */
export function prepareTileRasterSvg(
  bytes: Uint8Array,
  index: Pick<DrawingTileIndex, "width" | "height">,
  raster: DrawingTileRaster,
) {
  const units = 1_000_000 / Math.max(index.width, index.height),
    r = raster.region;
  const minimum = (raster.minimumPixels * r.width * units) / raster.width;
  let markup = new TextDecoder().decode(bytes);
  const head = markup.match(/<svg\b[^>]*>/u)?.[0];
  if (!head) throw new Error("图纸矢量底图无效。");
  let next = head;
  for (const [name, value] of Object.entries({
    viewBox: `${r.x * units} ${r.y * units} ${r.width * units} ${r.height * units}`,
    width: String(raster.width),
    height: String(raster.height),
    preserveAspectRatio: "none",
  })) {
    const pattern = new RegExp(`\\b${name}\\s*=\\s*["'][^"']*["']`, "u");
    next = pattern.test(next)
      ? next.replace(pattern, `${name}="${value}"`)
      : next.replace(/>$/u, ` ${name}="${value}">`);
  }
  markup = markup
    .replace(head, next)
    .replace(
      /(stroke-width\s*[:=]\s*["']?)([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/giu,
      (match, prefix: string, value: string, unit: string) => {
        const width = Number(value);
        return width > 0 && !unit
          ? `${prefix}${Math.max(width / raster.strokeScale, minimum)}`
          : match;
      },
    );
  return new TextEncoder().encode(markup);
}
export function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
