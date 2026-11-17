import { batchCadScreenPaths } from "./cad-screen-paths";
import { rebaseCadScreenRoot } from "./cad-svg-origin";

export type DrawingView = { x: number; y: number; width: number; height: number };
export type DrawingSize = { width: number; height: number };
export type SvgXmlAdapter = {
  parse(xml: string): Document;
  serialize(node: Node): string;
};

/** Keep one decoded CAD tile below a predictable memory ceiling. */
export const MAX_CAD_PREVIEW_PIXELS = 8_000_000;
export const EDITABLE_CAD_STROKE_WIDTH = 1;

export function cadRasterSize(
  region: DrawingView,
  displayScale: number,
  devicePixelRatio = 1,
  maxDimension = 4096,
  maxPixels = MAX_CAD_PREVIEW_PIXELS,
  minimumWidth = 0,
  minimumHeight = 0,
) {
  const scale = Math.max(0, displayScale) * Math.max(1, devicePixelRatio);
  let width = Math.min(maxDimension, Math.max(1, Math.ceil(region.width * scale)));
  let height = Math.min(maxDimension, Math.max(1, Math.ceil(region.height * scale)));
  const minimumScale = Math.max(
    region.width > 0 ? (minimumWidth * Math.max(1, devicePixelRatio)) / region.width : 0,
    region.height > 0 ? (minimumHeight * Math.max(1, devicePixelRatio)) / region.height : 0,
  );
  if (minimumScale > 0) {
    width = Math.min(maxDimension, Math.max(width, Math.ceil(region.width * minimumScale)));
    height = Math.min(maxDimension, Math.max(height, Math.ceil(region.height * minimumScale)));
  }
  const pixelBudget = Number.isFinite(maxPixels) && maxPixels > 0 ? maxPixels : Infinity;
  const pixels = width * height;
  if (pixels > pixelBudget) {
    const factor = Math.sqrt(pixelBudget / pixels);
    width = Math.max(1, Math.floor(width * factor));
    height = Math.max(1, Math.floor(height * factor));
    while (width * height > pixelBudget && (width > 1 || height > 1)) {
      if (width >= height) width -= 1;
      else height -= 1;
    }
  }
  return { width, height };
}

export function previewGeometry(
  project: DrawingSize,
  view: DrawingView,
  width: number,
  height: number,
  dpr: number,
) {
  const fit = Math.min(width / (project.width * 1.08), height / (project.height * 1.08));
  const cssScale = Math.min(width / view.width, height / view.height);
  const offsetX = (width - view.width * cssScale) / 2 - view.x * cssScale;
  const offsetY = (height - view.height * cssScale) / 2 - view.y * cssScale;
  return {
    zoom: cssScale / fit,
    scale: cssScale * dpr,
    width: Math.max(1, Math.round(width * dpr)),
    height: Math.max(1, Math.round(height * dpr)),
    offsetX: offsetX * dpr,
    offsetY: offsetY * dpr,
    visible: {
      x: -offsetX / cssScale,
      y: -offsetY / cssScale,
      width: width / cssScale,
      height: height / cssScale,
    },
  };
}
export type PreviewGeometry = ReturnType<typeof previewGeometry>;

/** Keep PDF hairlines at least one device pixel; only the display canvas is affected. */
export function fixedStrokeWidth(width: number, zoom: number, transformScale: number) {
  return Math.max(width / zoom, 1 / Math.max(transformScale, 1e-8));
}

/**
 * Detail views enlarge the decoded SVG as an image. Reduce its numeric stroke
 * widths before that raster is enlarged so the final detail keeps the base
 * drawing's line weight.
 */
export function scaleSvgStrokeWidths(bytes: Uint8Array, scale: number) {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return bytes;
  const pattern =
    /(stroke-width\s*[:=]\s*["']?)([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/giu;
  const source = new TextDecoder()
    .decode(bytes)
    .replace(
      /data-cad-stroke-unit="([\d.e+-]+)"/giu,
      (_match, value: string) => `data-cad-stroke-unit="${Number(value) / scale}"`,
    );
  return new TextEncoder().encode(
    source.replace(pattern, (_match, prefix: string, value: string, unit: string) => {
      return `${prefix}${Number(value) / scale}${unit}`;
    }),
  );
}
export function fixCanvasStrokes(ctx: CanvasRenderingContext2D, zoom: () => number) {
  const stroke = ctx.stroke;
  ctx.stroke = (path?: Path2D) => {
    const width = ctx.lineWidth,
      m = ctx.getTransform();
    ctx.lineWidth = fixedStrokeWidth(
      width,
      zoom(),
      Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d)),
    );
    try {
      if (path) stroke.call(ctx, path);
      else (stroke as () => void).call(ctx);
    } finally {
      ctx.lineWidth = width;
    }
  };
}

/** The rewritten SVG is loaded as an image, never inserted into the application DOM. */
export function prepareSvgPreview(
  bytes: Uint8Array,
  project: DrawingSize,
  xml: SvgXmlAdapter = {
    parse: (source) => new DOMParser().parseFromString(source, "image/svg+xml"),
    serialize: (node) => new XMLSerializer().serializeToString(node),
  },
) {
  const doc = xml.parse(new TextDecoder().decode(bytes));
  const root = doc.documentElement;
  if (!root) throw new Error("图纸矢量底图无效。");
  const cadStrokeUnit = Number(root.getAttribute("data-cad-stroke-unit"));
  if (root.localName !== "svg" || doc.getElementsByTagName("parsererror").length)
    throw new Error("图纸矢量底图无效。");
  const box = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (
    !box ||
    box.length !== 4 ||
    box.some((n) => !Number.isFinite(n)) ||
    box[2]! <= 0 ||
    box[3]! <= 0
  )
    throw new Error("图纸矢量范围无效。");
  const originalBody = Array.from(root.childNodes)
    .map((n) => xml.serialize(n))
    .join("");
  const screenRoot = root.cloneNode(true) as Element;
  batchCadScreenPaths(screenRoot);
  for (const element of Array.from(screenRoot.getElementsByTagName("*"))) {
    // SVG images do not consistently apply an inherited CSS vector-effect when
    // the source is cropped and then enlarged. Put it on each drawable element
    // so high zoom cannot scale the CAD stroke with the image bitmap.
    if (element.localName !== "style" && element.localName !== "defs")
      element.setAttribute("vector-effect", "non-scaling-stroke");
  }
  const screenBody = Array.from(screenRoot.childNodes)
    .map((n) => xml.serialize(n))
    .join("");
  const originalRoot = root.cloneNode(false) as Element;
  const strokePattern =
    /(stroke-width\s*[:=]\s*["']?)([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/giu;
  let lastZoom = Number.NaN,
    lastPixelScale = Number.NaN,
    lastScreenStrokeWidth: number | undefined,
    lastScreenStrokes = false,
    body = "";
  const draw = (
    g: PreviewGeometry,
    screenStrokes = false,
    screenPixelScale = 1,
    screenStrokeWidth?: number,
  ) => {
    const head = originalRoot.cloneNode(false) as Element;
    const rx = box[2]! / project.width,
      ry = box[3]! / project.height;
    const strokeZoom = screenStrokes ? Math.sqrt(rx * ry) / g.scale : g.zoom;
    head.setAttribute("width", String(g.width));
    head.setAttribute("height", String(g.height));
    head.setAttribute(
      "viewBox",
      `${box[0]! + g.visible.x * rx} ${box[1]! + g.visible.y * ry} ${g.visible.width * rx} ${g.visible.height * ry}`,
    );
    head.setAttribute("preserveAspectRatio", "none");
    const rewriteStroke = (_match: string, prefix: string, value: string, unit: string) => {
      const numeric = Number(value) / strokeZoom;
      const width =
        screenStrokes && numeric !== 0 && !unit
          ? (cadStrokeUnit > 0
              ? Math.max(0.5, Number(value) / cadStrokeUnit)
              : (screenStrokeWidth ?? Math.max(numeric, 0.65))) * screenPixelScale
          : numeric;
      return `${prefix}${width}${unit}`;
    };
    if (
      lastZoom !== strokeZoom ||
      lastScreenStrokes !== screenStrokes ||
      lastScreenStrokeWidth !== screenStrokeWidth ||
      lastPixelScale !== screenPixelScale
    ) {
      body = (screenStrokes ? screenBody : originalBody).replace(strokePattern, rewriteStroke);
      lastZoom = strokeZoom;
      lastScreenStrokes = screenStrokes;
      lastPixelScale = screenPixelScale;
      lastScreenStrokeWidth = screenStrokeWidth;
    }
    let displayedBody = body;
    const originX = box[0]! + g.visible.x * rx;
    const originY = box[1]! + g.visible.y * ry;
    if (
      screenStrokes &&
      Math.max(
        (Math.abs(originX) * g.width) / (g.visible.width * rx),
        (Math.abs(originY) * g.height) / (g.visible.height * ry),
      ) >
        2 ** 20
    ) {
      const local = rebaseCadScreenRoot(screenRoot, originX, originY);
      if (local) {
        head.setAttribute("viewBox", `0 0 ${g.visible.width * rx} ${g.visible.height * ry}`);
        displayedBody = Array.from(local.childNodes)
          .map((node) => xml.serialize(node))
          .join("")
          .replace(strokePattern, rewriteStroke);
      }
    }
    const start = xml
      .serialize(head)
      .replace(strokePattern, rewriteStroke)
      .replace(/\s*\/>$/u, ">");
    return `${start}${displayedBody}${screenStrokes ? "<style>*{vector-effect:non-scaling-stroke!important}</style>" : ""}</svg>`;
  };
  // Converter output uses flattened geometry. Keep the existing renderer for
  // transformed SVGs; its zoom-scaled fallback handles transforms that cannot
  // safely use non-scaling-stroke.
  return Object.assign(draw, {
    supportsScreenStrokes: !Array.from(root.getElementsByTagName("*")).some((element) =>
      element.hasAttribute("transform"),
    ),
  });
}

/** Share the expensive SVG parse and serialization among base, fragment and detail views. */
const sharedSvgPreviews = new WeakMap<
  Uint8Array,
  Map<string, ReturnType<typeof prepareSvgPreview>>
>();

export function sharedSvgPreview(bytes: Uint8Array, project: DrawingSize) {
  let variants = sharedSvgPreviews.get(bytes);
  if (!variants) {
    variants = new Map();
    sharedSvgPreviews.set(bytes, variants);
  }
  const key = `${project.width}:${project.height}`;
  const existing = variants.get(key);
  if (existing) return existing;
  const prepared = prepareSvgPreview(bytes, project);
  // A drawing can have several detail scales, but should not retain unbounded
  // serialized copies of a large source while its asset remains open.
  if (variants.size >= 8) variants.delete(variants.keys().next().value!);
  variants.set(key, prepared);
  return prepared;
}
