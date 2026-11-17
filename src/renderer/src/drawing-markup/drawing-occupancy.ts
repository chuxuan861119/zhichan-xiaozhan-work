import type { LabelArrangementBounds } from "../../../shared/drawing-markup/annotation-alignment";
import { baseFragments, fragmentWorldPoint } from "../../../shared/drawing-markup/base-fragments";
import { type CadMapping, cadToPage } from "../../../shared/drawing-markup/cad-state";
import type { DrawingProject } from "../../../shared/drawing-markup/model";

type OccupancyScene = {
  partial?: boolean;
  entities: readonly { handle: string; visible?: boolean }[];
  primitives: readonly { handle: string; kind: string; points: readonly (readonly number[])[] }[];
};

export function cadFigureBounds(
  scene: OccupancyScene,
  mapping: CadMapping,
  excludedHandles: ReadonlySet<string>,
): LabelArrangementBounds | null {
  if (scene.partial) return null;
  const hidden = new Set(
    scene.entities.filter((entity) => entity.visible === false).map((entity) => entity.handle),
  );
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const primitive of scene.primitives) {
    if (excludedHandles.has(primitive.handle) || hidden.has(primitive.handle)) continue;
    // Their two stored points are origin and direction, not visible endpoints.
    if (primitive.kind === "ray" || primitive.kind === "infinite") return null;
    for (const [x, y] of primitive.points) {
      if (x === undefined || y === undefined) return null;
      const point = cadToPage({ x, y }, mapping);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : null;
}

export function rasterInkBounds(
  rgba: Uint8ClampedArray,
  pixelWidth: number,
  pixelHeight: number,
  pageWidth: number,
  pageHeight: number,
): LabelArrangementBounds | null {
  if (pixelWidth < 1 || pixelHeight < 1 || rgba.length !== pixelWidth * pixelHeight * 4)
    return null;
  const corners = [0, pixelWidth - 1, (pixelHeight - 1) * pixelWidth, pixelHeight * pixelWidth - 1];
  const background = [0, 1, 2].map((channel) => {
    const samples = corners.map((index) => rgba[index * 4 + channel] ?? 255).sort((a, b) => a - b);
    return ((samples[1] ?? 255) + (samples[2] ?? 255)) / 2;
  });
  let left = pixelWidth,
    top = pixelHeight,
    right = -1,
    bottom = -1;
  for (let y = 0; y < pixelHeight; y++)
    for (let x = 0; x < pixelWidth; x++) {
      const index = (y * pixelWidth + x) * 4;
      const alpha = (rgba[index + 3] ?? 0) / 255;
      const difference = Math.max(
        ...background.map((value, channel) =>
          Math.abs(value - (alpha * (rgba[index + channel] ?? 255) + (1 - alpha) * 255)),
        ),
      );
      if (difference < 30) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  if (right < left) return null;
  return {
    left: (left / pixelWidth) * pageWidth,
    top: (top / pixelHeight) * pageHeight,
    right: ((right + 1) / pixelWidth) * pageWidth,
    bottom: ((bottom + 1) / pixelHeight) * pageHeight,
  };
}

/** Locate visible raster ink after crop, move, scale and rotation, not the full image sheet. */
export function rasterFigureBounds(
  project: Pick<DrawingProject, "width" | "height" | "baseFragments" | "detailViews">,
  ink: LabelArrangementBounds | null,
): LabelArrangementBounds | null {
  if (!ink) return null;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const include = (x: number, y: number) => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  };
  for (const fragment of baseFragments(project)) {
    const clip = fragment.clips.reduce<LabelArrangementBounds>(
      (area, polygon) => ({
        left: Math.max(area.left, Math.min(...polygon.map((point) => point.x))),
        top: Math.max(area.top, Math.min(...polygon.map((point) => point.y))),
        right: Math.min(area.right, Math.max(...polygon.map((point) => point.x))),
        bottom: Math.min(area.bottom, Math.max(...polygon.map((point) => point.y))),
      }),
      ink,
    );
    if (clip.left >= clip.right || clip.top >= clip.bottom) continue;
    // A partial cutout can only make this bound larger, never hide visible figure ink.
    for (const x of [clip.left, clip.right])
      for (const y of [clip.top, clip.bottom]) {
        const point = fragmentWorldPoint(fragment, { x, y });
        include(point.x, point.y);
      }
  }
  for (const detail of project.detailViews ?? []) {
    const radius = detail.radius * detail.ratio;
    include(detail.center.x - radius, detail.center.y - radius);
    include(detail.center.x + radius, detail.center.y + radius);
    if (!detail.markerHidden) {
      include(detail.source.x - detail.radius, detail.source.y - detail.radius);
      include(detail.source.x + detail.radius, detail.source.y + detail.radius);
    }
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : null;
}

/** Sample only a small offscreen preview; never read or scan the full-resolution source on click. */
export async function loadRasterInkBounds(
  url: string,
  pageWidth: number,
  pageHeight: number,
): Promise<LabelArrangementBounds | null> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const scale = Math.min(1, 768 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.ceil(image.naturalWidth * scale));
  const height = Math.max(1, Math.ceil(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return rasterInkBounds(
    context.getImageData(0, 0, width, height).data,
    width,
    height,
    pageWidth,
    pageHeight,
  );
}
