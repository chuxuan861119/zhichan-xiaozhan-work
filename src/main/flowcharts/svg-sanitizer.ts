import type { Element as XmlElement, NamedNodeMap as XmlNamedNodeMap } from "@xmldom/xmldom";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { DEFAULT_PATENT_FIGURE_WIDTH_MM } from "../../shared/patent/model.js";

const MAX_SVG_BYTES = 20 * 1024 * 1024;
const MAX_SVG_NODES = 50_000;
const FORBIDDEN_SOURCE = /<!DOCTYPE|<!ENTITY/iu;
const EXTERNAL_URI = /(?:https?|ftp|ftps|file|ws|wss):\/\//iu;
const SVG_NAMESPACES = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/XML/1998/namespace",
]);
const VISIBLE_ELEMENTS = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "image",
  "use",
]);
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "clippath",
  "marker",
  "title",
  "desc",
  ...VISIBLE_ELEMENTS,
]);
const ALLOWED_ATTRIBUTES = new Set([
  "id",
  "class",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "clip-path",
  "marker-start",
  "marker-mid",
  "marker-end",
  "preserveAspectRatio",
  "href",
  "xlink:href",
  "xmlns",
  "xmlns:xlink",
  "version",
  "data-cell-id",
  "pointer-events",
  "style",
]);

export type SvgSanitizerErrorCode =
  | "INVALID_BORDER"
  | "INVALID_SVG"
  | "UNSAFE_SVG"
  | "EXTERNAL_RESOURCE"
  | "EMPTY_SVG"
  | "SVG_TOO_LARGE"
  | "SVG_TOO_COMPLEX";

export class SvgSanitizerError extends Error {
  constructor(
    readonly code: SvgSanitizerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type ElementLike = XmlElement & { attributes: XmlNamedNodeMap };

function fail(code: SvgSanitizerErrorCode, message: string): never {
  throw new SvgSanitizerError(code, message);
}

function elementName(element: XmlElement): string {
  return (element.localName || element.nodeName).toLowerCase();
}

function mapPaint(name: string, value: string, element: XmlElement): string {
  if (value.trim().toLowerCase() === "none") return "none";
  if (name === "stroke") return "#000000";
  const tag = elementName(element);
  return tag === "text" || tag === "tspan" ? "#000000" : "#FFFFFF";
}

function sanitizeStyle(style: string, element: XmlElement): string {
  const safe: string[] = [];
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const name = declaration.slice(0, separator).trim().toLowerCase();
    let value = declaration.slice(separator + 1).trim();
    if (!name || !value || name === "filter" || name.includes("shadow")) continue;
    if (name === "fill" || name === "stroke") value = mapPaint(name, value, element);
    if (name === "stroke-width") {
      const numeric = Number.parseFloat(value);
      if (Number.isFinite(numeric) && numeric < 0.2) value = "0.2";
    }
    if (EXTERNAL_URI.test(value)) fail("EXTERNAL_RESOURCE", "SVG 样式引用了外部资源。");
    safe.push(`${name}:${value}`);
  }
  return safe.join(";");
}

function allElements(root: XmlElement): XmlElement[] {
  const elements: XmlElement[] = [root];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (!element) continue;
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) elements.push(child as XmlElement);
    }
  }
  return elements;
}

function applyBorder(
  svg: XmlElement,
  borderMm: number,
  outputWidthMm: number,
  rotationDeg = 0,
): void {
  if (borderMm === 0) return;
  const raw = svg.getAttribute("viewBox");
  if (!raw) return;
  const values = raw
    .trim()
    .split(/[\s,]+/u)
    .map((value) => Number(value));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return;
  const [x = 0, y = 0, width = 0, height = 0] = values;
  if (width <= 0 || outputWidthMm <= borderMm * 2)
    fail("INVALID_BORDER", "附图宽度不足以容纳所选留白。");
  // The SVG is finally laid out at outputWidthMm. Expand its viewBox so the
  // resulting physical margin is exactly borderMm rather than a 96-DPI guess.
  const border =
    (borderMm * (rotationDeg === 90 || rotationDeg === 270 ? height : width)) /
    (outputWidthMm - borderMm * 2);
  svg.setAttribute(
    "viewBox",
    `${x - border} ${y - border} ${width + border * 2} ${height + border * 2}`,
  );
}

export class SvgSanitizer {
  sanitize(
    source: string,
    options: { borderMm: number; outputWidthMm?: number; rotationDeg?: number },
  ): { svg: string; warnings: string[] } {
    if (!Number.isFinite(options.borderMm) || options.borderMm < 0 || options.borderMm > 20) {
      fail("INVALID_BORDER", "附图留白必须在 0 到 20 mm 之间。");
    }
    if (Buffer.byteLength(source, "utf8") > MAX_SVG_BYTES) {
      fail("SVG_TOO_LARGE", "SVG 超过 20 MiB 限制。");
    }
    if (FORBIDDEN_SOURCE.test(source)) fail("UNSAFE_SVG", "SVG 包含 DTD 或外部实体。");
    const parseErrors: string[] = [];
    const document = new DOMParser({
      onError: (level, message) => {
        if (level !== "warning") parseErrors.push(message);
      },
    }).parseFromString(source, "image/svg+xml");
    const root = document.documentElement;
    if (parseErrors.length > 0 || !root || elementName(root) !== "svg") {
      fail("INVALID_SVG", "SVG 结构无效。");
    }
    const warnings: string[] = [];
    let visibleCount = 0;
    const elements = allElements(root);
    if (elements.length > MAX_SVG_NODES) {
      fail("SVG_TOO_COMPLEX", "SVG 图形对象过多，无法安全生成专利附图。");
    }
    const gradientElements = new Set(["lineargradient", "radialgradient", "stop"]);
    for (const element of elements) {
      const name = elementName(element);
      if (gradientElements.has(name)) {
        element.parentNode?.removeChild(element);
        continue;
      }
      if (name === "filter") {
        element.parentNode?.removeChild(element);
        continue;
      }
      if (!ALLOWED_ELEMENTS.has(name)) fail("UNSAFE_SVG", `SVG 包含不允许的元素：${name}。`);
      if (VISIBLE_ELEMENTS.has(name)) visibleCount += 1;
      if (name === "image") {
        warnings.push("位图已按专利附图规则转换为高对比度效果，请检查细节。");
      }
      const attributes = Array.from((element as ElementLike).attributes);
      for (const attribute of attributes) {
        const attributeName = attribute.name;
        const normalizedName = attributeName.toLowerCase();
        if (normalizedName.startsWith("on")) fail("UNSAFE_SVG", "SVG 包含事件处理器。");
        if (normalizedName === "filter") {
          element.removeAttribute(attributeName);
          continue;
        }
        if (!ALLOWED_ATTRIBUTES.has(attributeName) && !ALLOWED_ATTRIBUTES.has(normalizedName)) {
          fail("UNSAFE_SVG", `SVG 包含不允许的属性：${attributeName}。`);
        }
        if (EXTERNAL_URI.test(attribute.value) && !SVG_NAMESPACES.has(attribute.value))
          fail("EXTERNAL_RESOURCE", "SVG 引用了外部资源。");
        if (normalizedName === "fill" || normalizedName === "stroke") {
          element.setAttribute(attributeName, mapPaint(normalizedName, attribute.value, element));
        } else if (normalizedName === "stroke-width") {
          const numeric = Number.parseFloat(attribute.value);
          if (Number.isFinite(numeric) && numeric < 0.2) element.setAttribute(attributeName, "0.2");
        } else if (normalizedName === "style") {
          const style = sanitizeStyle(attribute.value, element);
          if (style) element.setAttribute(attributeName, style);
          else element.removeAttribute(attributeName);
        }
      }
      // draw.io puts label paint on a parent group. Shape groups become white,
      // so labels need their own black paint to remain visible in the preview.
      if (
        (name === "text" || name === "tspan") &&
        !element.hasAttribute("fill") &&
        !/(?:^|;)\s*fill\s*:/iu.test(element.getAttribute("style") ?? "")
      ) {
        let inheritedNone = false;
        for (let parent = element.parentNode; parent?.nodeType === 1; parent = parent.parentNode) {
          const ancestor = parent as XmlElement;
          const fill =
            /(?:^|;)\s*fill\s*:\s*([^;]+)/iu
              .exec(ancestor.getAttribute("style") ?? "")?.[1]
              ?.trim() ?? ancestor.getAttribute("fill");
          if (fill) {
            inheritedNone = fill.toLowerCase() === "none";
            break;
          }
        }
        if (!inheritedNone) element.setAttribute("fill", "#000000");
      }
    }
    if (visibleCount === 0) fail("EMPTY_SVG", "SVG 没有可见图形。");
    applyBorder(
      root,
      options.borderMm,
      options.outputWidthMm ?? DEFAULT_PATENT_FIGURE_WIDTH_MM,
      options.rotationDeg,
    );
    return {
      svg: new XMLSerializer().serializeToString(document),
      warnings: [...new Set(warnings)],
    };
  }
}
