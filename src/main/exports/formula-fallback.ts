import { DOMParser, type Element, XMLSerializer } from "@xmldom/xmldom";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import "mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import sharp from "sharp";

const MAX_RASTER_DIMENSION = 4096;
const OUTPUT_DENSITY = 300;
const SVG_BASE_DENSITY = 72;
const MIN_RASTER_DENSITY = 12;
const DISABLED_TEX_PACKAGES = new Set([
  "autoload",
  "configmacros",
  "html",
  "newcommand",
  "noerrors",
  "noundefined",
  "require",
  "url",
]);

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const ENABLED_TEX_PACKAGES = [...new Set([...AllPackages, "mhchem"])].filter(
  (name) => !DISABLED_TEX_PACKAGES.has(name),
);
const tex = new TeX({
  packages: ENABLED_TEX_PACKAGES,
  maxBuffer: 100_000,
  maxMacros: 1_000,
});
const svg = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

export type FormulaFallbackImage = {
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
  altText: string;
};

export class FormulaSyntaxError extends Error {
  constructor(detail: string) {
    super(`公式语法错误：${detail.slice(0, 200)}`);
    this.name = "FormulaSyntaxError";
  }
}

function assertSelfContainedSvg(svgMarkup: string): void {
  if (
    /<(?:foreignObject|iframe|image|script)\b/iu.test(svgMarkup) ||
    /(?:href|src)\s*=\s*["']\s*(?!#)/iu.test(svgMarkup) ||
    /url\(\s*["']?(?!#)/iu.test(svgMarkup)
  ) {
    throw new Error("公式图形包含外部资源。");
  }
}

function flattenSvgGroups(svgMarkup: string): string {
  const document = new DOMParser({
    onError: (_level, message) => {
      throw new Error(`公式 SVG 无法解析：${message}`);
    },
  }).parseFromString(svgMarkup, "image/svg+xml");
  const root = document.documentElement;
  if (!root) throw new Error("公式 SVG 缺少根节点。");
  const inheritedAttributes = ["fill", "stroke", "stroke-width"];

  const flatten = (element: Element): void => {
    const childElements = Array.from({ length: element.childNodes.length }, (_, index) =>
      element.childNodes.item(index),
    ).filter((child): child is Element => child?.nodeType === 1);
    for (const child of childElements) flatten(child);
    if (element.localName !== "g" || !element.parentNode) return;

    const parent = element.parentNode;
    const groupTransform = element.getAttribute("transform");
    const children = Array.from({ length: element.childNodes.length }, (_, index) =>
      element.childNodes.item(index),
    );
    for (const child of children) {
      if (!child) continue;
      if (child.nodeType === 1) {
        const childElement = child as Element;
        const childTransform = childElement.getAttribute("transform");
        if (groupTransform) {
          childElement.setAttribute(
            "transform",
            childTransform ? `${groupTransform} ${childTransform}` : groupTransform,
          );
        }
        for (const attribute of inheritedAttributes) {
          const inherited = element.getAttribute(attribute);
          if (inherited && !childElement.hasAttribute(attribute)) {
            childElement.setAttribute(attribute, inherited);
          }
        }
      }
      parent.insertBefore(child, element);
    }
    parent.removeChild(element);
  };

  flatten(root);
  return new XMLSerializer().serializeToString(root, { requireWellFormed: true });
}

async function rasterizeSvg(
  svgMarkup: string,
  outputWidthMm?: number,
): Promise<{
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
}> {
  const bytes = Buffer.from(svgMarkup, "utf8");
  const baseMetadata = await sharp(bytes).metadata();
  if (!baseMetadata.width || !baseMetadata.height) {
    throw new Error("公式图形尺寸无效。");
  }

  if (
    outputWidthMm !== undefined &&
    (!Number.isFinite(outputWidthMm) || outputWidthMm < 10 || outputWidthMm > 165)
  )
    throw new Error("附图宽度必须在 10–165 mm 之间。");
  const requestedDensity =
    outputWidthMm === undefined
      ? OUTPUT_DENSITY
      : ((outputWidthMm * OUTPUT_DENSITY) / 25.4 / baseMetadata.width) * SVG_BASE_DENSITY;
  const expectedWidth = (baseMetadata.width * requestedDensity) / SVG_BASE_DENSITY;
  const expectedHeight = (baseMetadata.height * requestedDensity) / SVG_BASE_DENSITY;
  const density = Math.max(
    MIN_RASTER_DENSITY,
    Math.min(
      requestedDensity,
      Math.floor(
        requestedDensity *
          Math.min(1, MAX_RASTER_DIMENSION / expectedWidth, MAX_RASTER_DIMENSION / expectedHeight),
      ),
    ),
  );

  const png = await sharp(bytes, {
    density,
    limitInputPixels: MAX_RASTER_DIMENSION * MAX_RASTER_DIMENSION,
  })
    .resize({
      width: MAX_RASTER_DIMENSION,
      height: MAX_RASTER_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .withMetadata({ density: OUTPUT_DENSITY })
    .toBuffer();
  const metadata = await sharp(png).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("公式 PNG 尺寸无效。");
  }
  if (metadata.width > MAX_RASTER_DIMENSION || metadata.height > MAX_RASTER_DIMENSION) {
    throw new Error("公式 PNG 超出尺寸限制。");
  }
  return { png: Uint8Array.from(png), widthPx: metadata.width, heightPx: metadata.height };
}

export async function renderFormulaFallback(
  source: string,
  outputWidthMm?: number,
  color?: string,
): Promise<FormulaFallbackImage> {
  if (color !== undefined && !/^#[0-9A-F]{6}$/u.test(color)) throw new Error("公式颜色无效。");
  const container = mathDocument.convert(source, {
    display: true,
    em: 16,
    ex: 8,
    containerWidth: 80 * 8,
  });
  const svgElement = adaptor.tags(container, "svg")[0];
  if (!svgElement) throw new Error("公式未生成 SVG。");
  if (color) adaptor.setAttribute(svgElement, "color", color);
  const error = adaptor
    .tags(svgElement, "g")
    .find((node) => adaptor.getAttribute(node, "data-mml-node") === "merror");
  if (error) {
    const detail = adaptor.getAttribute(error, "data-mjx-error") ?? "无法解析公式";
    throw new FormulaSyntaxError(detail);
  }
  const svgMarkup = flattenSvgGroups(adaptor.outerHTML(svgElement));
  assertSelfContainedSvg(svgMarkup);
  const image = await rasterizeSvg(svgMarkup, outputWidthMm);
  return {
    ...image,
    altText: `复杂公式（LaTeX）：${source}`,
  };
}
