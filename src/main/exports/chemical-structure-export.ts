import sharp from "sharp";
import type { ChemicalStructureNode } from "../../shared/document/model.js";
import type { ExportIssue } from "../../shared/exports/report.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { validateChemicalPreviewSvg } from "../chemistry/chemical-preview-service.js";

const MAX_EMBEDDED_SVG_BYTES = 2 * 1024 * 1024;

export type PreparedChemicalStructureExport = {
  /** Sanitized SVG source for vector-aware rendering, or null when unavailable. */
  svg: string | null;
  /** Preview PNG bytes used to create the 300 DPI submission JPEG and as a fallback. */
  png: Uint8Array;
  pngWidthPx: number;
  pngHeightPx: number;
  /** Output width in millimetres, clamped to the content area. */
  widthMm: number;
  /** Output height in millimetres, proportional to the preview aspect ratio. */
  heightMm: number;
};

export type PreparedChemicalStructureJpeg = {
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
};

const OFFICIAL_IMAGE_DENSITY_DPI = 300;

export async function prepareChemicalStructureJpeg(
  media: Pick<PreparedChemicalStructureExport, "svg" | "png" | "widthMm" | "heightMm">,
): Promise<PreparedChemicalStructureJpeg> {
  const widthPx = Math.max(1, Math.round((media.widthMm * OFFICIAL_IMAGE_DENSITY_DPI) / 25.4));
  const heightPx = Math.max(1, Math.round((media.heightMm * OFFICIAL_IMAGE_DENSITY_DPI) / 25.4));
  if (!Number.isFinite(widthPx * heightPx) || widthPx * heightPx > 4096 * 4096) {
    throw new Error("结构式输出尺寸过大，请缩小后重试。");
  }
  const source = media.svg === null ? media.png : Buffer.from(media.svg, "utf8");
  // Rasterize the SVG close to the final pixel size, not at a fixed scale of its
  // intrinsic dimensions. Keep the input safety limit even for large drawings.
  let density = 72;
  if (media.svg !== null) {
    const metadata = await sharp(source, { limitInputPixels: 4096 * 4096 }).metadata();
    if (!metadata.width || !metadata.height) throw new Error("结构式尺寸无效。");
    const scale = Math.max(widthPx / metadata.width, heightPx / metadata.height);
    const safeScale = Math.sqrt((4096 * 4096) / (metadata.width * metadata.height));
    density = Math.max(1, Math.min(100000, Math.floor(72 * Math.min(scale, safeScale))));
  }
  const rendered = await sharp(source, {
    density,
    limitInputPixels: 4096 * 4096,
    sequentialRead: true,
  })
    .resize(widthPx, heightPx, { fit: "fill" })
    .flatten({ background: "#fff" })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .withMetadata({ density: OFFICIAL_IMAGE_DENSITY_DPI })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: Uint8Array.from(rendered.data),
    widthPx: rendered.info.width,
    heightPx: rendered.info.height,
  };
}

export type ChemicalStructureExportConstraints = {
  contentWidthMm: number;
  contentHeightMm?: number;
};

export function sanitizeExportSvg(svg: string): boolean {
  if (!svg.trim()) return false;
  if (new TextEncoder().encode(svg).byteLength > MAX_EMBEDDED_SVG_BYTES) return false;
  try {
    validateChemicalPreviewSvg(svg);
    return true;
  } catch {
    return false;
  }
}

function missingAssetIssue(node: ChemicalStructureNode, message: string): ExportIssue {
  return {
    severity: "error",
    code: "MISSING_ASSET",
    nodeId: node.id,
    message,
  };
}

/**
 * Single preparation entry point shared by DOCX, PDF and print export. Validates the
 * preview resource, picks the sanitized SVG when available, and computes the output
 * size from the node width clamped to the content area.
 */
export async function prepareChemicalStructureExport(
  node: ChemicalStructureNode,
  stored: StoredAsset | undefined,
  constraints: ChemicalStructureExportConstraints,
): Promise<
  { ok: true; media: PreparedChemicalStructureExport } | { ok: false; issue: ExportIssue }
> {
  if (!stored) {
    return {
      ok: false,
      issue: missingAssetIssue(node, `化学结构预览资源不存在：${node.previewAssetId}`),
    };
  }
  let pngWidthPx: number;
  let pngHeightPx: number;
  try {
    const metadata = await sharp(stored.preview, {
      limitInputPixels: 4096 * 4096,
      sequentialRead: true,
    }).metadata();
    if (metadata.format !== "png" || !metadata.width || !metadata.height) {
      throw new Error("化学结构预览不是有效 PNG。");
    }
    pngWidthPx = metadata.width;
    pngHeightPx = metadata.height;
  } catch {
    return {
      ok: false,
      issue: missingAssetIssue(node, `化学结构预览已损坏：${node.previewAssetId}`),
    };
  }

  const contentWidthMm = Math.max(10, constraints.contentWidthMm);
  let widthMm = Math.min(Math.max(10, node.widthMm), contentWidthMm);
  let heightMm = (widthMm * pngHeightPx) / pngWidthPx;
  if (constraints.contentHeightMm !== undefined && heightMm > constraints.contentHeightMm) {
    const scale = constraints.contentHeightMm / heightMm;
    widthMm *= scale;
    heightMm *= scale;
  }

  let svg: string | null = null;
  if (stored.descriptor.kind === "chemical-preview" && stored.descriptor.extension === "svg") {
    const candidate = Buffer.from(stored.original).toString("utf8");
    if (sanitizeExportSvg(candidate)) {
      try {
        const metadata = await sharp(Buffer.from(candidate, "utf8"), {
          limitInputPixels: 4096 * 4096,
        }).metadata();
        if (metadata.width && metadata.height && metadata.width * metadata.height <= 4096 * 4096) {
          svg = candidate;
        }
      } catch {
        // A valid preview can still export when its archived vector original is damaged.
      }
    }
  }

  return {
    ok: true,
    media: {
      svg,
      png: stored.preview,
      pngWidthPx,
      pngHeightPx,
      widthMm,
      heightMm,
    },
  };
}

/**
 * Collects a degradation warning when a chemical preview owns an SVG original that
 * cannot be embedded. Legacy PNG-only previews are a normal compatibility fallback
 * and must not be reported as issues.
 */
export function chemicalStructureDegradationIssue(
  node: ChemicalStructureNode,
  stored: StoredAsset,
  media: PreparedChemicalStructureExport,
): ExportIssue | null {
  if (
    media.svg === null &&
    stored.descriptor.kind === "chemical-preview" &&
    stored.descriptor.extension === "svg"
  ) {
    return {
      severity: "warning",
      code: "CHEMISTRY_RENDERED_AS_IMAGE",
      nodeId: node.id,
      message: "化学结构 SVG 无法安全导出，已降级为 JPEG 图片。",
    };
  }
  return null;
}
