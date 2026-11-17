import { createHash, randomUUID } from "node:crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import sharp from "sharp";
import type { ImageRotation, PageSettings } from "../../shared/document/model.js";
import type {
  FlowchartFigureLink,
  FlowchartProjectDescriptor,
} from "../../shared/flowcharts/model.js";
import { FlowchartFigureLinkSchema } from "../../shared/flowcharts/model.js";
import {
  MAX_PATENT_FIGURE_WIDTH_MM,
  MIN_PATENT_FIGURE_WIDTH_MM,
} from "../../shared/patent/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { SvgSanitizer } from "./svg-sanitizer.js";

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_RENDER_DIMENSION = 100_000;
const MAX_RENDER_PIXELS = 100_000_000;
const CSS_PIXELS_PER_INCH = 96;
const FIGURE_DPI = 300;
const MILLIMETRES_PER_INCH = 25.4;

export type FlowchartFigureTarget =
  | { kind: "new"; insertIndex: number }
  | { kind: "replace"; figureId: string; assetId: string };

export type FlowchartRenderRequest = {
  patentId: string;
  project: FlowchartProjectDescriptor;
  pageId: string;
  exportScope: "page" | "selection";
  selectedCellIds: string[];
  borderMm: number;
  outputWidthMm?: number;
  drawingPage?: PageSettings;
  rotationDeg?: ImageRotation;
  svg: string;
  target: FlowchartFigureTarget;
};

export type FlowchartRenderPreview = {
  previewToken: string;
  sanitizedSvg: string;
  outputWidthMm: number;
  preview: Uint8Array;
  widthPx: number;
  heightPx: number;
  warnings: string[];
};

export type ClaimedFlowchartPreview = {
  patentId: string;
  asset: StoredAsset;
  link: FlowchartFigureLink;
  target: FlowchartFigureTarget;
  outputWidthMm: number;
};

export type FlowchartRenderErrorCode =
  | "RENDER_BUSY"
  | "EMPTY_RENDER"
  | "INVALID_PNG"
  | "PREVIEW_EXPIRED"
  | "STALE_SOURCE"
  | "STALE_TARGET";

export class FlowchartRenderError extends Error {
  constructor(
    readonly code: FlowchartRenderErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type FrozenPreview = ClaimedFlowchartPreview & {
  projectRevision: number;
  sourceSha256: string;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
};

function svgDimensions(svg: string): { width: number; height: number } {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const values = (document.documentElement?.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/u)
    .map((value) => Number(value));
  const width = values[2] ?? 0;
  const height = values[3] ?? 0;
  if (
    values.length !== 4 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new FlowchartRenderError("EMPTY_RENDER", "流程图没有可生成附图的可见区域。");
  return { width, height };
}

function withViewBox(svg: string): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (!root || root.hasAttribute("viewBox")) return svg;
  const pixels = (value: string | null, fallback: number): number => {
    if (!value) return fallback;
    const match = /^\s*(\d+(?:\.\d+)?)\s*(px|pt|mm|cm|in)?\s*$/u.exec(value);
    if (!match) throw new FlowchartRenderError("EMPTY_RENDER", "流程图尺寸无效。");
    const factors: Record<string, number> = {
      px: 1,
      pt: 96 / 72,
      mm: 96 / 25.4,
      cm: 96 / 2.54,
      in: 96,
    };
    return Number(match[1]) * (factors[match[2] ?? "px"] ?? 1);
  };
  root.setAttribute(
    "viewBox",
    `0 0 ${pixels(root.getAttribute("width"), 300)} ${pixels(root.getAttribute("height"), 150)}`,
  );
  return new XMLSerializer().serializeToString(document);
}

function fittedFigureWidthMm(svg: string, request: FlowchartRenderRequest): number {
  const content = svgDimensions(svg);
  const quarterTurn = request.rotationDeg === 90 || request.rotationDeg === 270;
  const naturalWidth =
    ((quarterTurn ? content.height : content.width) * MILLIMETRES_PER_INCH) / CSS_PIXELS_PER_INCH;
  const naturalHeight =
    ((quarterTurn ? content.width : content.height) * MILLIMETRES_PER_INCH) / CSS_PIXELS_PER_INCH;
  const page = request.drawingPage;
  const maxWidth = Math.min(
    MAX_PATENT_FIGURE_WIDTH_MM,
    page ? page.widthMm - page.marginLeftMm - page.marginRightMm : MAX_PATENT_FIGURE_WIDTH_MM,
  );
  const maxHeight = Math.min(
    200,
    page ? page.heightMm - page.marginTopMm - page.marginBottomMm - 25 : 200,
  );
  const padding = request.borderMm * 2;
  if (maxWidth <= padding || maxHeight <= padding)
    throw new FlowchartRenderError("INVALID_PNG", "页面可用区域不足以容纳所选留白。");
  const requested =
    request.outputWidthMm ?? Math.max(MIN_PATENT_FIGURE_WIDTH_MM, naturalWidth + padding);
  const scale = Math.min(
    (requested - padding) / naturalWidth,
    (maxWidth - padding) / naturalWidth,
    (maxHeight - padding) / naturalHeight,
  );
  const width = naturalWidth * scale + padding;
  if (!Number.isFinite(width) || width < MIN_PATENT_FIGURE_WIDTH_MM)
    throw new FlowchartRenderError("INVALID_PNG", "生成的附图宽度无效或过小。");
  return Math.round(width * 100) / 100;
}

function physicalSvg(
  svg: string,
  widthMm: number,
  rotationDeg: ImageRotation = 0,
  raster = false,
): string {
  const size = svgDimensions(svg);
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (!root) throw new FlowchartRenderError("EMPTY_RENDER", "流程图没有可生成附图的可见区域。");
  const quarterTurn = rotationDeg === 90 || rotationDeg === 270;
  // Sharp scales unitless SVG dimensions from 72 points per inch. Physical
  // units are resolved at the input density first, which would scale twice.
  const unit = raster ? "" : "mm";
  const scale = raster ? 72 / MILLIMETRES_PER_INCH : 1;
  root.setAttribute(
    "width",
    `${(quarterTurn ? (widthMm * size.width) / size.height : widthMm) * scale}${unit}`,
  );
  root.setAttribute(
    "height",
    `${(quarterTurn ? widthMm : (widthMm * size.height) / size.width) * scale}${unit}`,
  );
  return new XMLSerializer().serializeToString(document);
}

async function convertEmbeddedRasters(svg: string): Promise<string> {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const images = Array.from(document.getElementsByTagName("image"));
  for (const image of images) {
    const attribute = image.hasAttribute("href") ? "href" : "xlink:href";
    const href = image.getAttribute(attribute) ?? "";
    const match = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/u.exec(href);
    if (!match?.[1])
      throw new FlowchartRenderError("INVALID_PNG", "流程图内嵌位图无效，无法生成黑白附图。");
    try {
      const monochrome = await sharp(Buffer.from(match[1], "base64"), {
        failOn: "error",
        limitInputPixels: MAX_RENDER_PIXELS,
      })
        .grayscale()
        .threshold(128)
        .png({ compressionLevel: 9 })
        .toBuffer();
      image.setAttribute(attribute, `data:image/png;base64,${monochrome.toString("base64")}`);
    } catch {
      throw new FlowchartRenderError("INVALID_PNG", "流程图内嵌位图无效，无法生成黑白附图。");
    }
  }
  return new XMLSerializer().serializeToString(document);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function sameTarget(left: FlowchartFigureTarget, right: FlowchartFigureTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "new" && right.kind === "new") return left.insertIndex === right.insertIndex;
  return (
    left.kind === "replace" &&
    right.kind === "replace" &&
    left.figureId === right.figureId &&
    left.assetId === right.assetId
  );
}

function cloneTarget(target: FlowchartFigureTarget): FlowchartFigureTarget {
  return { ...target };
}

export class FlowchartRenderService {
  readonly #sanitizer = new SvgSanitizer();
  readonly #previews = new Map<string, FrozenPreview>();
  readonly #randomUUID: () => string;
  readonly #now: () => number;
  readonly #maxPreviews: number;
  readonly #maxPreviewBytes: number;
  readonly #maxConcurrentRenders: number;
  #activeRenders = 0;
  #retainedBytes = 0;

  constructor(
    options: {
      randomUUID?: () => string;
      now?: () => number;
      maxPreviews?: number;
      maxPreviewBytes?: number;
      maxConcurrentRenders?: number;
    } = {},
  ) {
    this.#randomUUID = options.randomUUID ?? (() => randomUUID());
    this.#now = options.now ?? (() => Date.now());
    this.#maxPreviews = Math.max(1, options.maxPreviews ?? 8);
    this.#maxPreviewBytes = Math.max(1, options.maxPreviewBytes ?? 128 * 1024 * 1024);
    this.#maxConcurrentRenders = Math.max(1, options.maxConcurrentRenders ?? 2);
  }

  async render(request: FlowchartRenderRequest): Promise<FlowchartRenderPreview> {
    if (this.#activeRenders >= this.#maxConcurrentRenders)
      throw new FlowchartRenderError("RENDER_BUSY", "流程图预览正在生成，请稍后重试。");
    this.#activeRenders++;
    try {
      return await this.#render(request);
    } finally {
      this.#activeRenders--;
    }
  }

  async #render(request: FlowchartRenderRequest): Promise<FlowchartRenderPreview> {
    this.#pruneExpired();
    const content = this.#sanitizer.sanitize(request.svg, { borderMm: 0 });
    content.svg = withViewBox(content.svg);
    const outputWidthMm = fittedFigureWidthMm(content.svg, request);
    const sanitized =
      request.borderMm === 0
        ? content
        : this.#sanitizer.sanitize(content.svg, {
            borderMm: request.borderMm,
            outputWidthMm,
            ...(request.rotationDeg === undefined ? {} : { rotationDeg: request.rotationDeg }),
          });
    sanitized.svg = await convertEmbeddedRasters(sanitized.svg);
    let svgBytes = Uint8Array.from(Buffer.from(sanitized.svg, "utf8"));
    let png: Buffer;
    try {
      // Validate source dimensions before normalization without allocating its bitmap.
      const input = await sharp(svgBytes, {
        density: CSS_PIXELS_PER_INCH,
        limitInputPixels: MAX_RENDER_PIXELS,
      }).metadata();
      const width = input.width ?? 0,
        height = input.height ?? 0;
      if (
        width > MAX_RENDER_DIMENSION ||
        height > MAX_RENDER_DIMENSION ||
        width * height > MAX_RENDER_PIXELS
      )
        throw new FlowchartRenderError("INVALID_PNG", "生成的预览尺寸无效或过大。");
      sanitized.svg = physicalSvg(sanitized.svg, outputWidthMm, request.rotationDeg);
      svgBytes = Uint8Array.from(Buffer.from(sanitized.svg, "utf8"));
      const rasterSvg = Buffer.from(
        physicalSvg(sanitized.svg, outputWidthMm, request.rotationDeg, true),
        "utf8",
      );
      png = await sharp(rasterSvg, { density: FIGURE_DPI, limitInputPixels: MAX_RENDER_PIXELS })
        .png({ compressionLevel: 9 })
        .toBuffer();
    } catch (error) {
      if (error instanceof FlowchartRenderError) throw error;
      if (error instanceof Error && /pixel limit/iu.test(error.message))
        throw new FlowchartRenderError("INVALID_PNG", "生成的预览尺寸无效或过大。");
      throw new FlowchartRenderError("EMPTY_RENDER", "流程图没有可生成附图的可见区域。");
    }
    const metadata = await sharp(png, { failOn: "error" }).metadata();
    const widthPx = metadata.width ?? 0;
    const heightPx = metadata.height ?? 0;
    if (
      metadata.format !== "png" ||
      widthPx <= 0 ||
      heightPx <= 0 ||
      widthPx > MAX_RENDER_DIMENSION ||
      heightPx > MAX_RENDER_DIMENSION ||
      widthPx * heightPx > MAX_RENDER_PIXELS
    ) {
      throw new FlowchartRenderError("INVALID_PNG", "生成的预览尺寸无效或过大。");
    }
    const assetId = this.#randomUUID();
    const previewToken = this.#randomUUID();
    const link = FlowchartFigureLinkSchema.parse({
      projectId: request.project.projectId,
      pageId: request.pageId,
      exportScope: request.exportScope,
      selectedCellIds: [...request.selectedCellIds],
      borderMm: request.borderMm,
      exportedProjectRevision: request.project.revision,
      exportedSourceSha256: request.project.sourceSha256,
      renderProfileVersion: 1,
    });
    const previewBytes = Uint8Array.from(png);
    const asset: StoredAsset = {
      descriptor: {
        assetId,
        kind: "flowchart-preview",
        originalName: `${request.project.name}.svg`,
        mediaType: "image/svg+xml",
        extension: "svg",
        byteLength: svgBytes.byteLength,
        sha256: sha256(svgBytes),
        widthPx,
        heightPx,
        previewByteLength: previewBytes.byteLength,
        previewSha256: sha256(previewBytes),
      },
      original: svgBytes,
      preview: previewBytes,
    };
    const retainedBytes = svgBytes.byteLength + previewBytes.byteLength;
    if (retainedBytes > this.#maxPreviewBytes)
      throw new FlowchartRenderError("INVALID_PNG", "流程图预览过大，请缩小导出范围。");
    while (
      this.#previews.size >= this.#maxPreviews ||
      this.#retainedBytes + retainedBytes > this.#maxPreviewBytes
    ) {
      const oldest = this.#previews.keys().next().value;
      if (!oldest) break;
      this.discard(oldest);
    }
    this.#retainedBytes += retainedBytes;
    const expiresAt = this.#now() + PREVIEW_TTL_MS;
    const expiryTimer = setTimeout(() => this.discard(previewToken), PREVIEW_TTL_MS);
    expiryTimer.unref?.();
    this.#previews.set(previewToken, {
      patentId: request.patentId,
      asset,
      link,
      target: cloneTarget(request.target),
      outputWidthMm,
      projectRevision: request.project.revision,
      sourceSha256: request.project.sourceSha256,
      expiresAt,
      expiryTimer,
    });
    return {
      previewToken,
      sanitizedSvg: sanitized.svg,
      outputWidthMm,
      preview: previewBytes,
      widthPx,
      heightPx,
      warnings: sanitized.warnings,
    };
  }

  claim(
    previewToken: string,
    current: { project: FlowchartProjectDescriptor; target?: FlowchartFigureTarget },
  ): ClaimedFlowchartPreview {
    const frozen = this.#previews.get(previewToken);
    if (!frozen || frozen.expiresAt <= this.#now()) {
      this.discard(previewToken);
      throw new FlowchartRenderError("PREVIEW_EXPIRED", "预览已过期，请重新生成。");
    }
    if (
      current.project.projectId !== frozen.link.projectId ||
      current.project.revision !== frozen.projectRevision ||
      current.project.sourceSha256 !== frozen.sourceSha256
    ) {
      throw new FlowchartRenderError("STALE_SOURCE", "源工程已发生变化，请重新生成预览。");
    }
    if (current.target && !sameTarget(current.target, frozen.target)) {
      throw new FlowchartRenderError("STALE_TARGET", "目标附图已发生变化，请重新选择。");
    }
    this.discard(previewToken);
    return {
      patentId: frozen.patentId,
      asset: {
        descriptor: structuredClone(frozen.asset.descriptor),
        original: Uint8Array.from(frozen.asset.original),
        preview: Uint8Array.from(frozen.asset.preview),
      },
      link: structuredClone(frozen.link),
      target: cloneTarget(frozen.target),
      outputWidthMm: frozen.outputWidthMm,
    };
  }

  discard(previewToken: string): void {
    const preview = this.#previews.get(previewToken);
    if (preview) {
      clearTimeout(preview.expiryTimer);
      this.#retainedBytes -= preview.asset.original.byteLength + preview.asset.preview.byteLength;
    }
    this.#previews.delete(previewToken);
  }

  #pruneExpired(): void {
    for (const [token, preview] of this.#previews) {
      if (preview.expiresAt <= this.#now()) this.discard(token);
    }
  }
}
