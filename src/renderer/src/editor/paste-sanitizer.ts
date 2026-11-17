import DOMPurify from "dompurify";
import { MathMLToLaTeX } from "mathml-to-latex";
import { defaultDocumentFontSizePt } from "../../../shared/document/font-policy";
import { MAX_KET_SOURCE_BYTES } from "../../../shared/document/model";
import {
  convertOmmlElement,
  expandSelfClosingMathElements,
  inferFormulaKind,
} from "../../../shared/document/omml-to-latex";
import { PATENT_FIRST_LINE_INDENT_MM } from "../../../shared/patent/formatting";
import { imageImportLimitError } from "./image/image-import-limits";
import { preserveTablePasteFormatting } from "./table/paste-table-formatting";

const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "sub",
  "sup",
  "ol",
  "ul",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "h1",
  "h2",
  "h3",
  "span",
];

/**
 * 将 CSS 长度值（text-indent / margin-left）换算为毫米（0~80mm，与 Tiptap
 * paragraphIndentMm 约束一致）。
 * - mm/cm/pt/px/in 精确换算；em 使用来源字号，缺省使用正文默认字号。
 * - 无法识别或负数返回 null；零缩进是有效的来源排版。
 */
function lengthToMillimeters(
  value: string,
  fontSizePt = defaultDocumentFontSizePt(),
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(-?(?:\d+\.?\d*|\.\d+))\s*(mm|cm|pt|px|in|em)?$/iu.exec(trimmed);
  if (!match) return null;
  const amount = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = (match[2] ?? "mm").toLocaleLowerCase("en-US");
  let millimeters: number;
  switch (unit) {
    case "cm":
      millimeters = amount * 10;
      break;
    case "pt":
      millimeters = amount * 0.3528;
      break;
    case "px":
      millimeters = amount * 0.2646;
      break;
    case "in":
      millimeters = amount * 25.4;
      break;
    case "em":
      millimeters = (amount * fontSizePt * 25.4) / 72;
      break;
    default:
      millimeters = amount;
  }
  if (!Number.isFinite(millimeters) || millimeters < 0) return null;
  return Math.round(millimeters * 100) / 100;
}

/**
 * 段落开头是否已经用空白字符自行表达首行缩进：一个制表符或全角空格相当于一个字符
 * 宽度以上，半角空格（含粘贴后展开的不换行空格）需两个才算一个缩进。
 * 这类段落不再叠加正文默认缩进，避免双重缩进。
 */
export function startsWithManualFirstLineIndent(text: string): boolean {
  const run = /^[\t \u00A0\u3000]+/u.exec(text)?.[0] ?? "";
  if (/^[\r\n]/u.test(text.slice(run.length))) return false;
  return /[\t\u3000]/u.test(run) || run.length >= 2;
}

/** 常见 CSS 颜色名 → 6 位十六进制（不含 #）。 */
const NAMED_COLOR_HEX: Record<string, string> = {
  black: "000000",
  silver: "c0c0c0",
  gray: "808080",
  grey: "808080",
  white: "ffffff",
  maroon: "800000",
  red: "ff0000",
  purple: "800080",
  fuchsia: "ff00ff",
  green: "008000",
  lime: "00ff00",
  olive: "808000",
  yellow: "ffff00",
  navy: "000080",
  blue: "0000ff",
  teal: "008080",
  aqua: "00ffff",
  orange: "ffa500",
  brown: "a52a2a",
};

/**
 * 将 CSS 颜色值规范化为 6 位十六进制（不含 #），供文档 ColorMark 使用。
 * 支持 #RGB/#RRGGBB/rgb()/无透明度 rgba()/常用命名色；hsl、变量及半透明颜色不保留。
 */
function cssColorToHex(value: string): string | null {
  const trimmed = value.trim().toLocaleLowerCase("en-US");
  if (!trimmed) return null;
  if (/^#[0-9a-f]{6}$/u.test(trimmed)) return trimmed.slice(1);
  if (/^#[0-9a-f]{3}$/u.test(trimmed)) {
    return [...trimmed.slice(1)].map((character) => character + character).join("");
  }

  const rgbMatch =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(1(?:\.0+)?))?\s*\)$/u.exec(
      trimmed,
    );
  if (rgbMatch) {
    const red = Number.parseInt(rgbMatch[1] ?? "", 10);
    const green = Number.parseInt(rgbMatch[2] ?? "", 10);
    const blue = Number.parseInt(rgbMatch[3] ?? "", 10);
    const alpha = rgbMatch[4];
    const isRgba = trimmed.startsWith("rgba(");
    if (
      Number.isInteger(red) &&
      Number.isInteger(green) &&
      Number.isInteger(blue) &&
      red >= 0 &&
      red <= 255 &&
      green >= 0 &&
      green <= 255 &&
      blue >= 0 &&
      blue <= 255 &&
      (isRgba ? alpha !== undefined : alpha === undefined)
    ) {
      return [red, green, blue].map((part) => part.toString(16).padStart(2, "0")).join("");
    }
  }
  return NAMED_COLOR_HEX[trimmed] ?? null;
}

type ClipboardImageMediaType = "image/png" | "image/jpeg" | "image/bmp" | "image/tiff";

const DATA_IMAGE_TYPES = new Map<ClipboardImageMediaType, "png" | "jpg" | "bmp" | "tif">([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/bmp", "bmp"],
  ["image/tiff", "tif"],
] as const);

export type ClipboardDataImage = {
  originalName: string;
  mediaType: string;
  bytes: Uint8Array<ArrayBuffer>;
  patentImage?: {
    layout: "block" | "inline";
    widthMm: number;
    alignment: "left" | "center" | "right";
    rotationDeg: 0 | 90 | 180 | 270;
  };
  chemicalStructure?: {
    ketSource: string;
    editorMode: "molecule" | "macromolecule";
    widthMm: number;
    alignment: "left" | "center" | "right";
  };
};

export type PastedContentCapabilities = {
  headings: boolean;
  lists: boolean;
  tables: boolean;
  formulas: boolean;
};

/** 粘贴公式占位 token 的前缀/后缀（私有区字符，专利正文不会出现）。 */
const FORMULA_TOKEN_PREFIX = "\uE000PWF";
const FORMULA_TOKEN_SUFFIX = "\uE001";
export const FORMULA_TOKEN_PATTERN = /\uE000PWF(\d+)\uE001/gu;

export type PasteFormula = {
  latex: string;
  kind: "math" | "chemistry";
  block: boolean;
  alignment?: "left" | "center" | "right";
  fontSizePt?: number;
  color?: string;
};

/** 粘贴图片占位 token（私有区字符，专利正文不会出现）。 */
const PASTE_IMAGE_MARKER_PREFIX = "\uE010PIMG";
const PASTE_IMAGE_MARKER_SUFFIX = "\uE011";
export const PASTE_IMAGE_MARKER_PATTERN = /\uE010PIMG(\d+)\uE011/g;

export type SanitizedPaste = {
  html: string;
  formulas: PasteFormula[];
  pasteImageCount: number;
  internalProseMirrorSlice: boolean;
  paragraphMode: PasteParagraphMode;
  simplifications: string[];
};

export type PasteParagraphMode = "source" | "body";

/** Read only paragraph properties from simple Office CSS rules; never attach clipboard stylesheets. */
function resolveOfficeParagraphStyles(parsed: Document): void {
  const properties = [
    "font-size",
    "font-weight",
    "font-style",
    "color",
    "text-decoration",
    "text-indent",
    "text-align",
    "margin-left",
    "margin-right",
    "margin-top",
    "margin-bottom",
    "line-height",
    "width",
    "height",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "vertical-align",
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
  ];
  const rules: {
    selector: string;
    style: CSSStyleDeclaration;
    specificity: number;
    order: number;
  }[] = [];
  for (const sheet of parsed.querySelectorAll("style")) {
    for (const match of (sheet.textContent ?? "").matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      for (const rawSelector of (match[1] ?? "").split(",")) {
        const selector = rawSelector.trim();
        if (
          !/^(?:(?:p|div|span|h[1-3]|table|td|th|tr|col)(?:\.[\w-]+)?|\.[\w-]+)(?:\s+(?:p|span|td|th))?$/iu.test(
            selector,
          )
        )
          continue;
        const style = parsed.createElement("span").style;
        style.cssText = match[2] ?? "";
        rules.push({
          selector,
          style,
          specificity: (selector.includes(".") ? 10 : 0) + (/^[a-z]/iu.test(selector) ? 1 : 0),
          order: rules.length,
        });
      }
    }
  }
  rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  for (const paragraph of parsed.body.querySelectorAll<HTMLElement>(
    "p, div, span, h1, h2, h3, table, td, th, tr, col",
  )) {
    const inlineStyle = paragraph.getAttribute("style") ?? "";
    const resolved = parsed.createElement("span").style;
    for (const rule of rules) {
      if (!paragraph.matches(rule.selector)) continue;
      for (const property of properties) {
        const value = rule.style.getPropertyValue(property);
        if (value) resolved.setProperty(property, value);
      }
    }
    paragraph.setAttribute("style", `${resolved.cssText};${inlineStyle}`);
  }
}

/** Resolve supported inherited styles before removing layout containers and source typography. */
function resolveInheritedPasteStyles(body: HTMLElement): Map<HTMLElement, number> {
  const sizes = new Map<HTMLElement, number>();
  for (const element of [body, ...body.querySelectorAll<HTMLElement>("*")]) {
    if (!(element instanceof HTMLElement)) continue;
    if (element.tagName === "FONT" && !element.style.color) {
      const color = cssColorToHex(element.getAttribute("color") ?? "");
      if (color !== null) element.style.color = `#${color}`;
    }
    const parent = element.parentElement;
    const base = (parent && sizes.get(parent)) ?? defaultDocumentFontSizePt();
    const raw = element.style.fontSize;
    const size = raw.endsWith("%")
      ? (Number.parseFloat(raw) * base) / 100
      : raw.endsWith("pt")
        ? Number.parseFloat(raw)
        : raw
          ? ((lengthToMillimeters(raw, base) ?? 0) * 72) / 25.4
          : base;
    sizes.set(element, Number.isFinite(size) && size > 0 ? size : base);
    if (element.style.textIndent.endsWith("em")) {
      const indent = lengthToMillimeters(element.style.textIndent, sizes.get(element));
      if (indent !== null) element.style.textIndent = `${indent}mm`;
    }
    // Semantic tags have their own emphasis; an inherited normal style must not erase it.
    if (element.matches("strong,b") && !element.style.fontWeight) element.style.fontWeight = "bold";
    if (element.matches("em,i") && !element.style.fontStyle) element.style.fontStyle = "italic";
    if (element.matches("u") && !element.style.textDecoration)
      element.style.textDecoration = "underline";
    for (const property of [
      "text-align",
      "text-indent",
      "font-weight",
      "font-style",
      "color",
      "text-decoration",
      "line-height",
    ]) {
      const own =
        element.style.getPropertyValue(property) ||
        (property === "text-align" ? element.getAttribute("align") : "");
      if ((!own || own === "inherit") && parent) {
        const inherited =
          parent.style?.getPropertyValue(property) ||
          (property === "text-align" ? parent.getAttribute("align") : "");
        if (inherited) element.style.setProperty(property, inherited);
      }
    }
    // TextStyle reads spans, not block styles. Materialize inherited color on
    // text leaves before unsupported layout wrappers are removed.
    if (element.tagName !== "SPAN" && element.style.color) {
      const color = cssColorToHex(element.style.color);
      if (color !== null) {
        for (const child of [...element.childNodes]) {
          if (child.nodeType !== Node.TEXT_NODE || !child.textContent) continue;
          const span = body.ownerDocument.createElement("span");
          span.style.color = `#${color}`;
          child.replaceWith(span);
          span.append(child);
        }
      }
    }
  }
  return sizes;
}

function preserveParagraphSpacing(body: HTMLElement, sizes: Map<HTMLElement, number>): string[] {
  const issues = new Set<string>();
  for (const paragraph of body.querySelectorAll<HTMLElement>("p, h1, h2, h3")) {
    if (paragraph.closest("td, th")) continue;
    const raw = paragraph.style.lineHeight;
    const ratio =
      raw === "normal"
        ? 1
        : raw.endsWith("%")
          ? Number.parseFloat(raw) / 100
          : /^\d+(?:\.\d+)?$/u.test(raw)
            ? Number(raw)
            : NaN;
    if (ratio >= 1 && ratio <= 3) paragraph.dataset.lineHeight = String(ratio);
    else if (raw) issues.add("固定行距或不支持的行距已采用默认值");
    for (const [edge, name] of [
      ["top", "before"],
      ["bottom", "after"],
    ] as const) {
      const raw = paragraph.style.getPropertyValue(`margin-${edge}`);
      if (!raw) continue;
      const mm = lengthToMillimeters(raw, sizes.get(paragraph));
      const points = raw.endsWith("pt")
        ? Number.parseFloat(raw)
        : mm === null
          ? NaN
          : (mm * 72) / 25.4;
      if (Number.isFinite(points) && points >= 0 && points <= 200)
        paragraph.setAttribute(`data-space-${name}-pt`, String(Math.round(points * 100) / 100));
      else issues.add("不支持的段前或段后间距已采用默认值");
    }
  }
  return [...issues];
}

function paragraphSimplifications(body: HTMLElement): string[] {
  const issues = new Set<string>();
  for (const paragraph of body.querySelectorAll<HTMLElement>("p, h1, h2, h3")) {
    const style = paragraph.style;
    if (style.textIndent) {
      const indent = lengthToMillimeters(style.textIndent);
      if (Number.parseFloat(style.textIndent) < 0) issues.add("悬挂缩进");
      else if (indent === null || indent > 80) issues.add("不支持的首行缩进值");
    }
    if (
      [style.marginLeft, style.marginRight, style.paddingLeft, style.paddingRight].some(
        (value) => value && Number.parseFloat(value) !== 0,
      )
    )
      issues.add("段落左右缩进");
  }
  if (body.querySelector("li ul, li ol")) issues.add("多级列表已转为平级列表");
  if (body.querySelector("object, embed, iframe, video, audio, svg, canvas"))
    issues.add("嵌入对象无法直接粘贴，请通过对应的插入或导入功能补充");
  if (
    [...body.querySelectorAll("img")].some(
      (image) => !/^data:image\//iu.test(image.getAttribute("src") ?? ""),
    )
  )
    issues.add("非内嵌图片无法直接粘贴，请通过插入图片补充");
  return [...issues];
}

export function extractClipboardDataImages(input: string): ClipboardDataImage[] {
  const parsed = new DOMParser().parseFromString(input, "text/html");
  const images: ClipboardDataImage[] = [];
  const candidates = [...parsed.body.querySelectorAll<HTMLImageElement>("img")].flatMap(
    (element) => {
      const source = element.getAttribute("src")?.trim() ?? "";
      const match = /^data:([^;,]+);base64,([\s\S]+)$/iu.exec(source);
      if (!match) return [];
      const mediaType = match[1]?.toLocaleLowerCase("en-US") ?? "";
      const extension = DATA_IMAGE_TYPES.get(mediaType as ClipboardImageMediaType);
      const encoded = match[2]?.replace(/\s+/gu, "") ?? "";
      if (!extension || !encoded) return [];
      const paddingBytes = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
      const estimatedBytes = Math.floor((encoded.length * 3) / 4) - paddingBytes;
      return [{ element, mediaType, extension, encoded, estimatedBytes }];
    },
  );
  const limitError = imageImportLimitError(
    candidates.map(({ estimatedBytes }) => ({ size: estimatedBytes })),
  );
  if (limitError) throw new Error(limitError);
  for (const { element, mediaType, extension, encoded } of candidates) {
    try {
      const binary = globalThis.atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      let chemicalStructure: ClipboardDataImage["chemicalStructure"];
      const ketBase64 = element.dataset.patentChemicalKetBase64 ?? "";
      const ketPaddingBytes = ketBase64.endsWith("==") ? 2 : ketBase64.endsWith("=") ? 1 : 0;
      const estimatedKetBytes = Math.floor((ketBase64.length * 3) / 4) - ketPaddingBytes;
      if (ketBase64 && estimatedKetBytes <= MAX_KET_SOURCE_BYTES) {
        try {
          const ketBinary = globalThis.atob(ketBase64);
          const ketBytes = Uint8Array.from(ketBinary, (character) => character.charCodeAt(0));
          const ketSource = new TextDecoder("utf-8", { fatal: true }).decode(ketBytes);
          if (ketSource.trim()) {
            chemicalStructure = {
              ketSource,
              editorMode:
                element.dataset.patentChemicalEditorMode === "macromolecule"
                  ? "macromolecule"
                  : "molecule",
              widthMm: Math.min(
                165,
                Math.max(10, Number(element.dataset.patentChemicalWidthMm) || 80),
              ),
              alignment:
                element.dataset.patentChemicalAlignment === "left" ||
                element.dataset.patentChemicalAlignment === "right"
                  ? element.dataset.patentChemicalAlignment
                  : "center",
            };
          }
        } catch {
          chemicalStructure = undefined;
        }
      }
      images.push({
        originalName: `clipboard-image-${images.length + 1}.${extension}`,
        mediaType,
        bytes,
        ...(element.dataset.patentImageLayout === "block" ||
        element.dataset.patentImageLayout === "inline"
          ? {
              patentImage: {
                layout: element.dataset.patentImageLayout,
                widthMm: Math.min(
                  165,
                  Math.max(10, Number(element.dataset.patentImageWidthMm) || 80),
                ),
                alignment:
                  element.dataset.patentImageAlignment === "left" ||
                  element.dataset.patentImageAlignment === "right"
                    ? element.dataset.patentImageAlignment
                    : "center",
                rotationDeg:
                  element.dataset.patentImageRotationDeg === "90"
                    ? 90
                    : element.dataset.patentImageRotationDeg === "180"
                      ? 180
                      : element.dataset.patentImageRotationDeg === "270"
                        ? 270
                        : 0,
              },
            }
          : {}),
        ...(chemicalStructure ? { chemicalStructure } : {}),
      });
    } catch {
      // Invalid data URLs are omitted from the document just like unsupported remote images.
    }
  }
  return images;
}

/**
 * 清理元素行内样式，仅保留以下白名单排版信息，其余（字号/字体/背景色等）
 * 一律丢弃，粘贴内容统一由文档全局样式接管（避免 Word 行内字号造成的
 * "超尺寸文字"）：
 * - 段落/标题首行缩进：text-indent → data-paragraph-indent-mm（毫米）；
 * - Word 编号项（mso-list）左缩进：margin-left → data-paragraph-indent-mm；
 * - 文字颜色 color、背景色 background-color → #RRGGBB（文档 ColorMark 约束）；
 * - 段落 text-align（left 为默认不写，center/right/justify 保留）。
 * 隐藏元素（display:none / visibility:hidden / hidden）整体移除。
 */
function removeUnsupportedColorDeclarations(input: string): string {
  return input.replace(
    /\bstyle=(["'])([\s\S]*?)\1/giu,
    (_attribute, quote: string, style: string) => {
      const safeStyle = style.replace(
        /(^|;)\s*(background-color|color)\s*:\s*([^;]+)/giu,
        (declaration: string, prefix: string, _property: string, value: string) =>
          cssColorToHex(value) === null ? prefix : declaration,
      );
      return `style=${quote}${safeStyle}${quote}`;
    },
  );
}

function rawStylePropertyValue(
  style: string,
  property: "color" | "background-color",
): string | null {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "iu").exec(style);
  return match?.[1]?.trim() ?? null;
}

function cleanStyle(
  element: HTMLElement,
  sourceParagraphs = false,
  internal = false,
  fontSizePt?: number,
): void {
  const style = element.style;
  const rawStyle = element.getAttribute("style") ?? "";
  if (style.display === "none" || style.visibility === "hidden" || element.hidden) {
    element.remove();
    return;
  }
  if (element.matches("p, h1, h2, h3")) {
    // Word 自动编号段以 mso-list 标志 + 悬挂缩进（margin-left 正 / text-indent 负）
    // 表达，其 margin-left 值随 Word 模板和层级变化，不是专利标准的两字符缩进；
    // 正文整理模式用专利标准缩进；来源模式保留支持的值并提示不支持的悬挂缩进。
    const isWordNumberedItem = /\bmso-list\s*:/iu.test(element.getAttribute("style") ?? "");
    if (isWordNumberedItem && !sourceParagraphs) {
      element.setAttribute("data-paragraph-indent-mm", String(PATENT_FIRST_LINE_INDENT_MM));
    } else {
      const indentMm = lengthToMillimeters(style.textIndent, fontSizePt);
      if (indentMm !== null && indentMm <= 80) {
        element.setAttribute("data-paragraph-indent-mm", String(indentMm));
      } else if (sourceParagraphs && !element.hasAttribute("data-paragraph-indent-mm")) {
        element.setAttribute("data-paragraph-indent-mm", "0");
      }
    }
  }
  const preservedStyle: string[] = [];
  if (internal) {
    for (const attribute of ["data-document-font-family", "data-default-font-family"]) {
      const font = element.getAttribute(attribute);
      if (
        font !== null &&
        (!font.trim() ||
          font.length > 100 ||
          [...font].some((character) => character.charCodeAt(0) < 32))
      )
        element.removeAttribute(attribute);
    }
    const size = Number(element.getAttribute("data-font-size-pt"));
    if (Number.isFinite(size) && size > 0 && size <= 200)
      preservedStyle.push(`font-size: ${size}pt`);
  }
  if (/^(?:normal|bold|bolder|[1-9]00)$/u.test(style.fontWeight))
    preservedStyle.push(`font-weight: ${style.fontWeight === "normal" ? "400" : style.fontWeight}`);
  if (/^(?:normal|italic|oblique)$/u.test(style.fontStyle))
    preservedStyle.push(
      `font-style: ${style.fontStyle === "oblique" ? "italic" : style.fontStyle}`,
    );
  if (/\bunderline\b/u.test(style.textDecorationLine || style.textDecoration))
    preservedStyle.push("text-decoration: underline");
  const colorHex = cssColorToHex(rawStylePropertyValue(rawStyle, "color") ?? "");
  if (colorHex !== null) preservedStyle.push(`color: #${colorHex}`);
  const backgroundColorHex = cssColorToHex(
    rawStylePropertyValue(rawStyle, "background-color") ?? "",
  );
  if (backgroundColorHex !== null) preservedStyle.push(`background-color: #${backgroundColorHex}`);
  // Word 常用 align 属性（非 inline style）表达段落对齐，
  // element.style.textAlign 读不到，需额外检查。
  const alignment = style.textAlign || element.getAttribute("align");
  if (
    alignment === "left" ||
    alignment === "center" ||
    alignment === "right" ||
    alignment === "justify"
  ) {
    preservedStyle.push(`text-align: ${alignment}`);
  }
  if (preservedStyle.length > 0) {
    element.setAttribute("style", preservedStyle.join(";"));
  } else {
    element.removeAttribute("style");
  }
}

/** 会被当作段落子内容承载的块级元素；含这些子元素的 `<div>` 是布局容器，不能降级为段落。 */
const PARAGRAPH_DIV_BLOCK_CHILDREN =
  "p, div, ul, ol, li, dl, table, h1, h2, h3, blockquote, pre, section, article, figure, form";

/**
 * 部分来源（网页、PDF 阅读器）用 `<div>` 而不是 `<p>` 分隔段落，而 `<div>` 不在
 * ALLOWED_TAGS 中：DOMPurify 会剥掉标签，把相邻段落的文字粘成一段。粘贴清洗前把
 * 「只装行内内容」的 `<div>` 降级为 `<p>`，保留段落边界，也让它们能拿到正文首行缩进。
 * 含块级子元素的 `<div>` 保持原样，交给 DOMPurify 展开，避免产生嵌套段落。
 */
function promoteParagraphDivs(body: HTMLElement): void {
  for (const element of [...body.querySelectorAll("div")]) {
    // 应用自有节点（如块级公式）带 data-type，改写标签会破坏后续解析。
    if (element.hasAttribute("data-type")) continue;
    if (element.querySelector(PARAGRAPH_DIV_BLOCK_CHILDREN)) continue;
    const paragraph = element.ownerDocument.createElement("p");
    for (const attribute of [...element.attributes]) {
      paragraph.setAttribute(attribute.name, attribute.value);
    }
    while (element.firstChild) paragraph.append(element.firstChild);
    element.replaceWith(paragraph);
  }
}

/**
 * 外部粘贴的正文段落统一补上专利标准首行缩进（9.88mm，约两个字符）。
 * 来源没有 text-indent、也不是 Word 编号段时 cleanStyle 不会写缩进属性，段落会顶格；
 * 这里补默认值。以下情况保持原样：已带显式缩进的段落、标题（h1~h3）、
 * 列表项与表格单元格内的段落（结构化内容），以及开头已有手工缩进空白的段落。
 * 居中对齐的段落通常是标题行，也不参与。
 */
function applyDefaultParagraphIndent(body: HTMLElement): void {
  for (const paragraph of body.querySelectorAll<HTMLElement>("p")) {
    if (paragraph.hasAttribute("data-paragraph-indent-mm")) continue;
    if (paragraph.closest("li, td, th")) continue;
    if (paragraph.style.textAlign === "center" || paragraph.style.textAlign === "right") continue;
    if (startsWithManualFirstLineIndent(paragraph.textContent ?? "")) continue;
    paragraph.setAttribute("data-paragraph-indent-mm", String(PATENT_FIRST_LINE_INDENT_MM));
  }
}

/**
 * Word 自动编号转为静态字符后，编号与正文之间常有多余空白（制表位或 &nbsp;），
 * 压缩为单个普通空格：`1.  文字` → `1. 文字`、`（1） 文字` → `（1） 文字`。
 * 仅当段落开头存在编号模式时处理；编号可能位于嵌套 span 中，需跨文本节点定位。
 */
const NUMBERED_ITEM_PREFIX_PATTERN = /^((?:\d{1,3}[.、)）])|(?:[（(]\d{1,3}[)）]))\s+/u;

function cleanNumberedItemSpacing(
  root: HTMLElement,
  wordNumberedParagraphs: ReadonlySet<HTMLElement>,
): void {
  for (const paragraph of root.querySelectorAll("p, li")) {
    if (!wordNumberedParagraphs.has(paragraph as HTMLElement)) continue;
    const nodes: Text[] = [];
    const queue: Node[] = [...paragraph.childNodes];
    while (queue.length > 0 && nodes.length < 4) {
      const node = queue.shift();
      if (node === undefined || node === null) continue;
      if (node.nodeType === Node.TEXT_NODE) nodes.push(node as Text);
      else queue.unshift(...node.childNodes);
    }
    if (nodes.length === 0) continue;
    let combined = "";
    for (const node of nodes) combined += node.nodeValue ?? "";
    const match = NUMBERED_ITEM_PREFIX_PATTERN.exec(combined);
    if (!match) continue;
    const numberText = match[1] ?? "";
    const blankCount = match[0].length - numberText.length;
    let consumed = 0;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node === undefined) break;
      const value = node.nodeValue ?? "";
      const nodeEnd = consumed + value.length;
      if (numberText.length <= nodeEnd) {
        const local = numberText.length - consumed;
        node.nodeValue = `${value.slice(0, local)} ${value.slice(local + blankCount)}`;
        for (let next = index + 1; next < nodes.length; next += 1) {
          const nextNode = nodes[next];
          if (nextNode === undefined) continue;
          const nextValue = nextNode.nodeValue ?? "";
          if (/^\s/u.test(nextValue)) {
            nextNode.nodeValue = nextValue.replace(/^\s+/u, "");
          }
        }
        break;
      }
      consumed = nodeEnd;
    }
  }
}

/**
 * 把外部 HTML 中含实际内容文本节点的连续空格/制表符转成不换行空格（U+00A0），
 * 避免 Tiptap/ProseMirror 解析时按 HTML 空白折叠规则吞掉多空格排版
 * （Word/网页复制来的段内空格、中文对齐空格等）。
 * 应用内部的 ProseMirror 剪贴板内容由粘贴解析器通过 preserveWhitespace 保留空格，
 * 不应在这里改变字符类型，否则两端对齐时 U+00A0 会产生不同的视觉宽度。
 * 段首手工缩进可能跨多个纯空白 span，先整体识别再保留；带换行的 HTML 源码
 * 缩进不处理。夹在两个可见行内节点之间的制表符也按四个可见空格保留。
 */
function preserveSignificantSpaces(root: HTMLElement): void {
  for (const paragraph of root.querySelectorAll("p, h1, h2, h3")) {
    const walker = paragraph.ownerDocument.createTreeWalker(
      paragraph,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    const leading: { node: Text; length: number }[] = [];
    let prefix = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node instanceof Element) {
        if (node.matches("br, img, [data-type]")) break;
        continue;
      }
      const text = node.nodeValue ?? "";
      const whitespace = /^[\t \u00a0\u3000]*/u.exec(text)?.[0] ?? "";
      if (/^[\r\n]/u.test(text.slice(whitespace.length))) {
        prefix = "";
        break;
      }
      prefix += whitespace;
      leading.push({ node: node as Text, length: whitespace.length });
      if (whitespace.length !== text.length) break;
    }
    if (!startsWithManualFirstLineIndent(prefix)) continue;
    for (const { node, length } of leading) {
      const text = node.data;
      node.data =
        text.slice(0, length).replaceAll("\t", "\u00a0".repeat(4)).replaceAll(" ", "\u00a0") +
        text.slice(length);
    }
  }
  const stack: Node[] = [...root.childNodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || node === null) continue;
    if (node.nodeType === Node.TEXT_NODE) {
      const original = node.nodeValue ?? "";
      const isInlineTabGap =
        /\t/u.test(original) &&
        !/[\r\n]/u.test(original) &&
        /\S/u.test(node.previousSibling?.textContent ?? "") &&
        /\S/u.test(node.nextSibling?.textContent ?? "");
      let isInlineSpaceGap = false;
      const paragraph = node.parentElement?.closest("p,h1,h2,h3");
      if (paragraph && /^[ \t]+$/u.test(original)) {
        const before = root.ownerDocument.createRange();
        before.selectNodeContents(paragraph);
        before.setEndBefore(node);
        const after = root.ownerDocument.createRange();
        after.selectNodeContents(paragraph);
        after.setStartAfter(node);
        const left = /\S([ \t\u00a0]*)$/u.exec(before.toString());
        const right = /^([ \t\u00a0]*)\S/u.exec(after.toString());
        isInlineSpaceGap = Boolean(
          left &&
            right &&
            (original.includes("\t") ||
              original.length + (left[1]?.length ?? 0) + (right[1]?.length ?? 0) > 1),
        );
      }
      if (
        isInlineSpaceGap ||
        ((/\S/u.test(original) || isInlineTabGap) && / {2,}|\t/u.test(original))
      ) {
        if (isInlineSpaceGap) {
          node.nodeValue = original.replaceAll("\t", "\u00a0".repeat(4)).replaceAll(" ", "\u00a0");
          continue;
        }
        const replaced = original.replace(/ {2,}|\t+/gu, (whitespace) =>
          whitespace.startsWith("\t")
            ? "\u00A0".repeat(whitespace.length * 4)
            : "\u00A0".repeat(whitespace.length),
        );
        if (replaced !== original) node.nodeValue = replaced;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      stack.push(...node.childNodes);
    }
  }
}

/** 是否是 OMML/MathML 公式元素。 */
function isFormulaElement(element: Element): boolean {
  const tag = element.nodeName.toLowerCase();
  return tag === "m:omath" || tag === "m:omathpara" || tag === "math";
}

function formulaToken(index: number): string {
  return `${FORMULA_TOKEN_PREFIX}${index}${FORMULA_TOKEN_SUFFIX}`;
}

/**
 * 清洗粘贴 HTML：
 * 1. 外部来源用 `<div>` 分隔的段落降级为 `<p>`，保住段落边界；
 * 2. OMML / MathML 公式 → LaTeX，替换为占位 token（formulas 记录转换结果）；
 * 3. 丢弃行内字号/字体等样式，保留段落首行缩进、Word 编号项左缩进、
 *    文字颜色与段落对齐（text-indent → data-paragraph-indent-mm，
 *    color → #RRGGBB，text-align 白名单）；
 * 4. 没有自带缩进的正文段落补上专利标准首行缩进（9.88mm）；
 * 5. 压缩 Word 编号与正文之间的多余空白；连续空格转不换行空格；
 * 6. 移除脚本/危险元素/远程图片等噪声。
 */
export function sanitizePastedHtmlWithFormulas(
  input: string,
  capabilities?: PastedContentCapabilities,
  requestedMode?: PasteParagraphMode,
): SanitizedPaste {
  const normalizedInput = removeUnsupportedColorDeclarations(expandSelfClosingMathElements(input));
  const parsed = new DOMParser().parseFromString(normalizedInput, "text/html");
  const internalProseMirrorSlice = parsed.body.querySelector("[data-pm-slice]") !== null;
  const officeSource =
    /xmlns:w\s*=|class\s*=\s*["']?Mso|name\s*=\s*["']?Generator[^>]*content\s*=\s*["'][^"']*(?:Microsoft|WPS)/iu.test(
      input,
    ) ||
    [...parsed.querySelectorAll('meta[name="generator" i]')].some((meta) =>
      /Microsoft|WPS/iu.test(meta.getAttribute("content") ?? ""),
    );
  if (!internalProseMirrorSlice && officeSource) resolveOfficeParagraphStyles(parsed);
  const wordNumberedParagraphs = new Set<HTMLElement>();
  if (!internalProseMirrorSlice) {
    // 先补出 `<div>` 段落，Word 编号段的识别才能覆盖这些段落。
    promoteParagraphDivs(parsed.body);
    for (const paragraph of parsed.body.querySelectorAll<HTMLElement>("p, li")) {
      const candidates = [paragraph, ...paragraph.querySelectorAll<HTMLElement>("*")];
      if (
        candidates.some((element) =>
          /(?:^|;)\s*mso-(?:list|tab-count)\s*:/iu.test(element.getAttribute("style") ?? ""),
        )
      ) {
        wordNumberedParagraphs.add(paragraph);
      }
    }
  }
  const sourceSizes = internalProseMirrorSlice
    ? new Map<HTMLElement, number>()
    : resolveInheritedPasteStyles(parsed.body);
  const hasExplicitParagraphFormat = [
    ...parsed.body.querySelectorAll<HTMLElement>("p, div, h1, h2, h3"),
  ].some(
    (paragraph) =>
      lengthToMillimeters(paragraph.style.textIndent) !== null ||
      [paragraph.style.lineHeight, paragraph.style.marginTop, paragraph.style.marginBottom].some(
        Boolean,
      ),
  );
  const paragraphMode =
    requestedMode ?? (officeSource || hasExplicitParagraphFormat ? "source" : "body");
  const simplifications = internalProseMirrorSlice ? [] : paragraphSimplifications(parsed.body);
  if (!internalProseMirrorSlice && paragraphMode === "source")
    simplifications.push(...preserveParagraphSpacing(parsed.body, sourceSizes));
  simplifications.push(
    ...preserveTablePasteFormatting(parsed.body, {
      internal: internalProseMirrorSlice,
      sourceParagraphs: paragraphMode === "source",
      millimetres: lengthToMillimeters,
    }),
  );
  if (parsed.body.querySelector("table table"))
    simplifications.push("嵌套表格已转为文字，请核对行列关系");
  if (capabilities && !capabilities.tables && parsed.body.querySelector("table"))
    simplifications.push("当前文档不支持表格，已转为文字，请核对行列关系");
  if (capabilities && !capabilities.lists && parsed.body.querySelector("ol, ul"))
    simplifications.push("当前文档不支持列表，已转为普通段落");
  const formulas: PasteFormula[] = [];
  // 只处理最外层公式元素（oMathPara 内含 oMath / math 时由外层递归覆盖）。
  for (const element of [...parsed.body.querySelectorAll("*")]) {
    // Tiptap 自家公式 HTML（应用内复制粘贴）——在 DOMPurify 剥离 data-* 属性前提取 latex/alignment。
    const dataType = element.getAttribute("data-type");
    if (dataType === "block-math" || dataType === "inline-math") {
      const latex = element.getAttribute("data-latex");
      if (!latex) continue;
      if (capabilities && !capabilities.formulas) {
        simplifications.push("当前文档不支持公式，请核对转换后的文字");
        element.replaceWith(parsed.createTextNode(element.textContent ?? ""));
        continue;
      }
      const block = dataType === "block-math";
      const kind =
        (element.getAttribute("data-formula-kind") as PasteFormula["kind"]) ??
        inferFormulaKind(latex);
      const alignmentRaw = element.getAttribute("data-formula-alignment");
      const alignment =
        alignmentRaw === "left" || alignmentRaw === "right" ? alignmentRaw : undefined;
      const index = formulas.length;
      const fontSizePt = Number(element.getAttribute("data-font-size-pt"));
      const color = element.getAttribute("data-formula-color");
      formulas.push({
        latex,
        kind,
        block,
        ...(alignment ? { alignment } : {}),
        ...(Number.isFinite(fontSizePt) && fontSizePt >= 8 && fontSizePt <= 72
          ? { fontSizePt }
          : {}),
        ...(color && /^#[0-9a-f]{6}$/iu.test(color) ? { color: color.toUpperCase() } : {}),
      });
      const token = parsed.createElement(
        block && !element.parentElement?.closest("p,h1,h2,h3,h4,h5,h6") ? "p" : "span",
      );
      token.textContent = formulaToken(index);
      element.replaceWith(token);
      continue;
    }
    if (!isFormulaElement(element)) continue;
    if (element.parentElement && isFormulaElement(element.parentElement)) continue;
    const tag = element.nodeName.toLowerCase();
    let latex: string | null = null;
    if (tag === "math") {
      try {
        const mathMl = element.outerHTML;
        latex = MathMLToLaTeX.convert(
          mathMl.includes("xmlns")
            ? mathMl
            : mathMl.replace(/^<math/, '<math xmlns="http://www.w3.org/1998/Math/MathML"'),
        );
      } catch {
        latex = null;
      }
    } else {
      try {
        latex = convertOmmlElement(element).replace(/\s+/gu, " ").trim();
      } catch {
        latex = null;
      }
    }
    if (capabilities && !capabilities.formulas) {
      simplifications.push("当前文档不支持公式，请核对转换后的文字");
      // 编辑器不支持公式：降级为公式内部纯文本，避免内容丢失。
      element.replaceWith(parsed.createTextNode(element.textContent ?? ""));
      continue;
    }
    if (!latex) {
      simplifications.push("部分公式未能转换，请通过公式功能补充");
      // 转换失败：保留内部文本，不丢内容。
      element.replaceWith(parsed.createTextNode(element.textContent ?? ""));
      continue;
    }
    const block = tag === "m:omathpara" || element.getAttribute("display") === "block";
    const index = formulas.length;
    formulas.push({ latex, kind: inferFormulaKind(latex), block });
    const token = parsed.createElement(
      block && !element.parentElement?.closest("p,h1,h2,h3,h4,h5,h6") ? "p" : "span",
    );
    token.textContent = formulaToken(index);
    element.replaceWith(token);
  }

  const nestedTables = [...parsed.body.querySelectorAll("table table")].reverse();
  for (const table of nestedTables) {
    const text = [...table.querySelectorAll("th, td")]
      .filter((cell) => !cell.querySelector("th, td"))
      .map((cell) => cell.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    const flattened = parsed.createElement("span");
    flattened.textContent = text;
    table.replaceWith(flattened);
  }
  if (capabilities && !capabilities.headings) {
    for (const heading of parsed.body.querySelectorAll("h1, h2, h3")) {
      const paragraph = parsed.createElement("p");
      paragraph.innerHTML = heading.innerHTML;
      heading.replaceWith(paragraph);
    }
  }
  if (capabilities && !capabilities.lists) {
    for (const list of parsed.body.querySelectorAll("ol, ul")) {
      const paragraphs = [...list.querySelectorAll(":scope > li")].map((item) => {
        const paragraph = parsed.createElement("p");
        paragraph.innerHTML = item.innerHTML;
        return paragraph;
      });
      list.replaceWith(...paragraphs);
    }
  }
  if (capabilities && !capabilities.tables) {
    for (const table of parsed.body.querySelectorAll("table")) {
      const paragraphs = [...table.querySelectorAll("th, td")].map((cell) => {
        const paragraph = parsed.createElement("p");
        paragraph.innerHTML = cell.innerHTML;
        return paragraph;
      });
      table.replaceWith(...paragraphs);
    }
  }
  for (const element of [...parsed.body.querySelectorAll<HTMLElement>("*")]) {
    if (element.matches("script,style,iframe,object,embed,svg")) {
      element.remove();
      continue;
    }
    if (element.nodeName.toLocaleLowerCase("en-US") === "font") {
      const colorHex = cssColorToHex(element.style.color || element.getAttribute("color") || "");
      const span = parsed.createElement("span");
      if (colorHex !== null) span.style.color = `#${colorHex}`;
      while (element.firstChild) span.append(element.firstChild);
      element.replaceWith(span);
      cleanStyle(span);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLocaleLowerCase("en-US").startsWith("on")) {
        element.removeAttribute(attribute.name);
      }
    }
    cleanStyle(
      element,
      !internalProseMirrorSlice && paragraphMode === "source",
      internalProseMirrorSlice,
      sourceSizes.get(element),
    );
  }
  // cleanStyle 已定下显式缩进与对齐，此时再为其余正文段落补默认首行缩进。
  if (!internalProseMirrorSlice) {
    if (requestedMode === "body") {
      for (const paragraph of parsed.body.querySelectorAll<HTMLElement>("p")) {
        if (
          paragraph.closest("li, td, th") ||
          ["center", "right"].includes(paragraph.style.textAlign) ||
          startsWithManualFirstLineIndent(paragraph.textContent ?? "")
        )
          continue;
        paragraph.removeAttribute("data-paragraph-indent-mm");
      }
    }
    if (paragraphMode === "body") applyDefaultParagraphIndent(parsed.body);
  }
  // The persisted model supports flat lists. Hoist nested items without dropping
  // text after a sublist or rejecting the complete paste operation.
  function flattenList(list: Element): void {
    for (const item of [...list.children]) {
      if (item.tagName !== "LI") continue;
      if (![...item.children].some((child) => child.matches("ul, ol"))) continue;
      const parts: Element[] = [];
      let current = item.cloneNode(false) as Element;
      const flush = () => {
        if (current.children.length || current.textContent?.trim()) parts.push(current);
        current = item.cloneNode(false) as Element;
      };
      for (const child of [...item.childNodes]) {
        if (child instanceof Element && child.matches("ul, ol")) {
          flush();
          flattenList(child);
          parts.push(...child.children);
        } else current.append(child);
      }
      flush();
      item.replaceWith(...parts);
    }
  }
  for (const list of parsed.body.querySelectorAll("ul, ol")) {
    if (list.matches("ol[start]")) {
      const start = Number(list.getAttribute("start"));
      if (!Number.isInteger(start) || start < 1 || start > 1_000_000) list.removeAttribute("start");
    }
    if (!list.parentElement?.closest("ul, ol")) flattenList(list);
  }
  cleanNumberedItemSpacing(parsed.body, wordNumberedParagraphs);
  if (!internalProseMirrorSlice) {
    preserveSignificantSpaces(parsed.body);
  }
  let pasteImageCount = 0;
  for (const element of [...parsed.body.querySelectorAll<HTMLImageElement>("img")]) {
    // 仅为已验证的内嵌图片保留异步导入标记。远程、无效或不支持图片会直接移除，
    // 不能伪装成可插入内容、阻断文本回退，也不能扰乱图片标记与字节数组的下标对应。
    if (extractClipboardDataImages(element.outerHTML).length === 0) {
      element.remove();
      continue;
    }
    const marker = parsed.createElement("span");
    marker.textContent = `${PASTE_IMAGE_MARKER_PREFIX}${pasteImageCount}${PASTE_IMAGE_MARKER_SUFFIX}`;
    element.replaceWith(marker);
    pasteImageCount += 1;
  }
  const html = DOMPurify.sanitize(parsed.body.innerHTML, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: [
      ...(internalProseMirrorSlice
        ? [
            "data-font-size-pt",
            "data-default-font-size-pt",
            "data-document-font-family",
            "data-default-font-family",
          ]
        : []),
      "colspan",
      "rowspan",
      "colwidth",
      "start",
      "data-paragraph-indent-mm",
      "style",
      "data-column-widths-mm",
      "data-layout-mode",
      "data-table-alignment",
      "data-table-name-enabled",
      "data-table-name",
      "data-table-note-enabled",
      "data-table-note",
      "data-header-row-count",
      "data-row-height-mm",
      "data-row-height-rule",
      "data-padding-top-mm",
      "data-padding-right-mm",
      "data-padding-bottom-mm",
      "data-padding-left-mm",
      "data-horizontal-alignment",
      "data-vertical-alignment",
      "data-border-style",
      "data-border-top",
      "data-border-right",
      "data-border-bottom",
      "data-border-left",
      "data-line-height",
      "data-space-before-pt",
      "data-space-after-pt",
    ],
    ALLOW_DATA_ATTR: false,
  });
  return {
    html,
    formulas,
    pasteImageCount,
    internalProseMirrorSlice,
    paragraphMode,
    simplifications: [...new Set(simplifications)],
  };
}

/**
 * 兼容入口：仅返回清洗后的 HTML（不保留公式转换结果）。
 * 新代码请使用 {@link sanitizePastedHtmlWithFormulas}。
 */
export function sanitizePastedHtml(
  input: string,
  capabilities?: PastedContentCapabilities,
): string {
  return sanitizePastedHtmlWithFormulas(input, capabilities).html;
}
