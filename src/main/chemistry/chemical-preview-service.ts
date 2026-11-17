import { createHash, randomUUID } from "node:crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import sharp from "sharp";
import {
  MAX_CHEMICAL_PREVIEW_DIMENSION,
  MAX_CHEMICAL_PREVIEW_SVG_BYTES,
} from "../../shared/chemistry/chemical-preview.js";
import { CHEMICAL_PREVIEW_DENSITY } from "../../shared/chemistry/structure-size.js";
import type { ChemicalStructureSource } from "../../shared/chemistry/structure-source.js";
import type { ChemicalPreviewAssetDescriptor } from "../../shared/document/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { MAX_IMAGE_BYTES } from "../assets/image-importer.js";
import { embedChemicalStructureSource } from "./structure-source.js";

export {
  MAX_CHEMICAL_PREVIEW_DIMENSION,
  MAX_CHEMICAL_PREVIEW_SVG_BYTES,
} from "../../shared/chemistry/chemical-preview.js";

export type ChemicalPreviewErrorCode =
  | "SVG_TOO_LARGE"
  | "INVALID_SVG"
  | "UNSAFE_SVG"
  | "DIMENSIONS_TOO_LARGE"
  | "RENDER_FAILED"
  | "PNG_TOO_LARGE";
const CHEMICAL_PREVIEW_ERROR_CODES = new Set<ChemicalPreviewErrorCode>([
  "SVG_TOO_LARGE",
  "INVALID_SVG",
  "UNSAFE_SVG",
  "DIMENSIONS_TOO_LARGE",
  "RENDER_FAILED",
  "PNG_TOO_LARGE",
]);

export class ChemicalPreviewError extends Error {
  constructor(
    readonly code: ChemicalPreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChemicalPreviewError";
  }
}

export function isChemicalPreviewError(error: unknown): error is ChemicalPreviewError {
  return (
    error instanceof ChemicalPreviewError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      CHEMICAL_PREVIEW_ERROR_CODES.has(error.code as ChemicalPreviewErrorCode))
  );
}

export type ChemicalPreview = {
  svg: string;
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
};

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const ALLOWED_NAMESPACES = new Set([SVG_NAMESPACE, XLINK_NAMESPACE, XML_NAMESPACE]);
const ALLOWED_NAMESPACE_DECLARATIONS = new Set([...ALLOWED_NAMESPACES]);
const SAME_DOCUMENT_REFERENCE = /^#[^\s#]+$/u;
const CSS_URL = /url\s*\(\s*([^)]*?)\s*\)/giu;
const CSS_COMMENT = /\/\*[\s\S]*?\*\//gu;
const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(.))/giu;
const DISALLOWED_PROCESSING_INSTRUCTION = /<\?(?!xml(?:\s|version\b))[\s\S]*?\?>/iu;
const MAX_CHEMICAL_PREVIEW_ELEMENTS = 50_000;

function localNameOf(element: { localName: string | null; tagName: string }): string {
  return (element.localName || element.tagName.split(":").at(-1) || "").toLocaleLowerCase("en-US");
}

function unsafe(message: string): never {
  throw new ChemicalPreviewError("UNSAFE_SVG", message);
}

function validateReference(value: string): void {
  if (!SAME_DOCUMENT_REFERENCE.test(value.trim())) {
    unsafe("化学结构预览 SVG 包含不安全的外部引用。");
  }
}

function normalizeCss(value: string): string {
  const withoutComments = value.replace(CSS_COMMENT, "");
  if (withoutComments.includes("/*") || withoutComments.includes("*/")) {
    unsafe("化学结构预览 SVG 包含不安全的样式引用。");
  }
  const normalized = withoutComments.replace(
    CSS_ESCAPE,
    (_match, hex: string, character: string) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return character;
    },
  );
  if (normalized.includes("\\")) unsafe("化学结构预览 SVG 包含不安全的样式引用。");
  return normalized;
}

function validateCssReferences(value: string): void {
  const normalized = normalizeCss(value);
  if (/@import\b/iu.test(normalized)) unsafe("化学结构预览 SVG 包含不安全的样式引用。");
  const remaining = normalized.replace(CSS_URL, (_match, raw: string) => {
    const reference = raw.trim().replace(/^(['"])(.*)\1$/u, "$2");
    validateReference(reference);
    return "";
  });
  if (/url\s*\(/iu.test(remaining)) {
    unsafe("化学结构预览 SVG 包含不安全的样式引用。");
  }
}

export function validateChemicalPreviewSvg(svg: string): string {
  if (/<!\s*(?:doctype|entity)\b/iu.test(svg)) {
    unsafe("化学结构预览 SVG 不允许文档类型或实体声明。");
  }
  if (DISALLOWED_PROCESSING_INSTRUCTION.test(svg)) {
    unsafe("化学结构预览 SVG 不允许处理指令。");
  }

  const parseErrors: string[] = [];
  let document: ReturnType<DOMParser["parseFromString"]>;
  try {
    document = new DOMParser({
      onError: (_level, message) => parseErrors.push(message),
    }).parseFromString(svg, "image/svg+xml");
  } catch {
    throw new ChemicalPreviewError("INVALID_SVG", "化学结构预览 SVG 无效。");
  }
  const root = document.documentElement;
  if (
    parseErrors.length > 0 ||
    !root ||
    localNameOf(root) !== "svg" ||
    root.namespaceURI !== SVG_NAMESPACE
  ) {
    throw new ChemicalPreviewError("INVALID_SVG", "化学结构预览 SVG 无效。");
  }

  const elements = [root, ...Array.from(root.getElementsByTagName("*"))];
  if (elements.length > MAX_CHEMICAL_PREVIEW_ELEMENTS) {
    unsafe("化学结构预览 SVG 包含过多元素。");
  }
  for (const element of elements) {
    if (!ALLOWED_NAMESPACES.has(element.namespaceURI ?? "")) {
      unsafe("化学结构预览 SVG 包含不受支持的命名空间。");
    }
    const localName = localNameOf(element);
    if (localName === "script" || localName === "foreignobject") {
      unsafe("化学结构预览 SVG 包含不允许的元素。");
    }
    if (localName === "style") validateCssReferences(element.textContent ?? "");

    for (const attribute of Array.from(element.attributes)) {
      const name = (attribute.localName || attribute.name).toLocaleLowerCase("en-US");
      if (name.startsWith("on")) unsafe("化学结构预览 SVG 包含不允许的事件属性。");
      if (attribute.namespaceURI === XMLNS_NAMESPACE) {
        if (!ALLOWED_NAMESPACE_DECLARATIONS.has(attribute.value)) {
          unsafe("化学结构预览 SVG 包含不受支持的命名空间。");
        }
        continue;
      }
      if (attribute.namespaceURI && !ALLOWED_NAMESPACES.has(attribute.namespaceURI)) {
        unsafe("化学结构预览 SVG 包含不受支持的命名空间。");
      }
      if (name === "href" || name === "src") {
        validateReference(attribute.value);
      }
      validateCssReferences(attribute.value);
    }
  }
  return new XMLSerializer().serializeToString(document);
}

function assertDimensions(
  width: number | undefined,
  height: number | undefined,
): {
  widthPx: number;
  heightPx: number;
} {
  if (!width || !height || width < 1 || height < 1) {
    throw new ChemicalPreviewError("INVALID_SVG", "化学结构预览 SVG 缺少有效尺寸。");
  }
  if (width > MAX_CHEMICAL_PREVIEW_DIMENSION || height > MAX_CHEMICAL_PREVIEW_DIMENSION) {
    throw new ChemicalPreviewError("DIMENSIONS_TOO_LARGE", "化学结构预览尺寸不能超过 4096 像素。");
  }
  return { widthPx: width, heightPx: height };
}

export async function rasterizeChemicalPreview(
  svg: string,
  outputWidthMm?: number,
): Promise<ChemicalPreview> {
  if (
    outputWidthMm !== undefined &&
    (!Number.isFinite(outputWidthMm) || outputWidthMm < 10 || outputWidthMm > 165)
  )
    throw new ChemicalPreviewError("INVALID_SVG", "附图宽度必须在 10–165 mm 之间。");
  if (!svg.trim()) throw new ChemicalPreviewError("INVALID_SVG", "化学结构预览 SVG 不能为空。");
  const bytes = Buffer.from(svg, "utf8");
  if (bytes.byteLength > MAX_CHEMICAL_PREVIEW_SVG_BYTES) {
    throw new ChemicalPreviewError("SVG_TOO_LARGE", "化学结构预览 SVG 不能超过 5 MiB。");
  }
  const sanitized = validateChemicalPreviewSvg(svg);

  try {
    const source = sharp(Buffer.from(sanitized, "utf8"), {
      limitInputPixels: MAX_CHEMICAL_PREVIEW_DIMENSION * MAX_CHEMICAL_PREVIEW_DIMENSION,
      sequentialRead: true,
    });
    const metadata = await source.metadata();
    const { widthPx: sourceWidth, heightPx: sourceHeight } = assertDimensions(
      metadata.width,
      metadata.height,
    );
    const scale = Math.min(
      outputWidthMm === undefined
        ? 4
        : (outputWidthMm * CHEMICAL_PREVIEW_DENSITY) / 25.4 / sourceWidth,
      MAX_CHEMICAL_PREVIEW_DIMENSION / Math.max(sourceWidth, sourceHeight),
    );
    // Render the vector at the target density; writing DPI metadata alone leaves a tiny bitmap.
    const rendered = await sharp(Buffer.from(sanitized, "utf8"), {
      density: Math.max(1, Math.floor(72 * scale)),
      limitInputPixels: MAX_CHEMICAL_PREVIEW_DIMENSION * MAX_CHEMICAL_PREVIEW_DIMENSION,
      sequentialRead: true,
    })
      .resize(
        Math.max(1, Math.round(sourceWidth * scale)),
        Math.max(1, Math.round(sourceHeight * scale)),
        {
          fit: "fill",
        },
      )
      .png()
      .withMetadata({ density: CHEMICAL_PREVIEW_DENSITY })
      .toBuffer({ resolveWithObject: true });
    const dimensions = assertDimensions(rendered.info.width, rendered.info.height);
    if (rendered.data.byteLength > MAX_IMAGE_BYTES) {
      throw new ChemicalPreviewError("PNG_TOO_LARGE", "化学结构预览 PNG 超过允许的大小。");
    }
    return {
      svg: sanitized,
      bytes: Uint8Array.from(rendered.data),
      ...dimensions,
    };
  } catch (error) {
    if (isChemicalPreviewError(error)) throw error;
    throw new ChemicalPreviewError("RENDER_FAILED", "化学结构预览生成失败。");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function chemicalPreviewDescriptor(input: {
  assetId: string;
  svg: string;
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
}): ChemicalPreviewAssetDescriptor {
  const original = Buffer.from(input.svg, "utf8");
  return {
    assetId: input.assetId,
    kind: "chemical-preview",
    originalName: "structure.svg",
    mediaType: "image/svg+xml",
    extension: "svg",
    byteLength: original.byteLength,
    sha256: sha256(original),
    widthPx: input.widthPx,
    heightPx: input.heightPx,
    previewByteLength: input.png.byteLength,
    previewSha256: sha256(input.png),
  };
}

/** Sanitizes, rasterizes and hashes a chemical structure SVG into a staged asset. */
export async function rasterizeChemicalStructureAsset(
  svg: string,
  source?: ChemicalStructureSource,
  outputWidthMm?: number,
): Promise<StoredAsset> {
  if (Buffer.byteLength(svg, "utf8") > MAX_CHEMICAL_PREVIEW_SVG_BYTES)
    throw new ChemicalPreviewError("SVG_TOO_LARGE", "化学结构预览 SVG 不能超过 5 MiB。");
  let validatedSvg = validateChemicalPreviewSvg(svg);
  if (outputWidthMm !== undefined || validatedSvg.includes("data-patent-output-width-mm")) {
    // AssetStore deduplicates by original SVG. Record the render variant in that
    // original so an existing natural-size preview cannot replace this raster.
    const document = new DOMParser().parseFromString(validatedSvg, "image/svg+xml");
    document.documentElement?.removeAttribute("data-patent-output-width-mm");
    if (outputWidthMm !== undefined)
      document.documentElement?.setAttribute("data-patent-output-width-mm", String(outputWidthMm));
    validatedSvg = new XMLSerializer().serializeToString(document);
  }
  const preview = await rasterizeChemicalPreview(
    source ? embedChemicalStructureSource(validatedSvg, source) : validatedSvg,
    outputWidthMm,
  );
  const descriptor = chemicalPreviewDescriptor({
    assetId: randomUUID(),
    svg: preview.svg,
    png: preview.bytes,
    widthPx: preview.widthPx,
    heightPx: preview.heightPx,
  });
  return {
    descriptor,
    original: Buffer.from(preview.svg, "utf8"),
    preview: preview.bytes,
  };
}
