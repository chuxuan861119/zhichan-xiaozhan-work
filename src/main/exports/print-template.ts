import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import katex from "katex";
import { displayDocumentFont } from "../../shared/document/font-policy.js";
import {
  BLOCK_FORMULA_MATH_STYLE,
  BLOCK_FORMULA_STYLE,
} from "../../shared/document/formula-layout.js";
import {
  effectiveParagraphFontSizePt,
  lineSpacingToCssLineHeight,
} from "../../shared/document/line-spacing.js";
import {
  TABLE_ANNOTATION_FONT_SIZE_PT,
  tableNameNumbers,
  visibleTableAnnotations,
} from "../../shared/document/table-annotations.js";
import { resolveTableColumnWidthsMm } from "../../shared/document/table-column-widths.js";
import { pageBodyWidthMm, tableExceedsPage } from "../../shared/document/table-page-fit.js";
import "katex/contrib/mhchem";
import {
  type BlockNode,
  type CanonicalDocument,
  CanonicalDocumentSchema,
  type InlineNode,
  type ParagraphAttributes,
  type ParagraphNode,
  type PatentBookDocument,
  PatentBookDocumentSchema,
  type TableCell,
  type TextMark,
} from "../../shared/document/model.js";
import type { ExportIssue } from "../../shared/exports/report.js";
import {
  createDefaultPrintSettings,
  type PrintLayoutSettings,
  PrintLayoutSettingsSchema,
  type PrintMargins,
} from "../../shared/printing/model.js";
import { getPaperSizeMillimetres } from "../../shared/printing/paper-sizes.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { isVectorSvgSafeForExport } from "../assets/vector-image-safety.js";
import { prepareChemicalStructureExport, sanitizeExportSvg } from "./chemical-structure-export.js";
import { type FormulaFallbackImage, renderFormulaFallback } from "./formula-fallback.js";

const require = createRequire(import.meta.url);
const katexCssPath = require.resolve("katex/dist/katex.min.css");
const KATEX_CSS = readFileSync(katexCssPath, "utf8");
const KATEX_DATA_FONT_CSS = [...KATEX_CSS.matchAll(/@font-face\{[^}]*\}/gu)]
  .map(([rule]) => {
    const filename = /url\(fonts\/([^)]+\.woff2)\)/u.exec(rule)?.[1];
    if (!filename) throw new Error("KaTeX 字体声明无效。");
    const encoded = readFileSync(join(dirname(katexCssPath), "fonts", filename)).toString("base64");
    return rule.replace(/src:[^}]+/u, `src:url(data:font/woff2;base64,${encoded}) format("woff2")`);
  })
  .join("");

type PrintTemplateDependencies = {
  includeDocumentHeader: boolean;
  patentBookLayout: boolean;
  renderFallback(
    source: string,
    outputWidthMm?: number,
    color?: string,
  ): Promise<FormulaFallbackImage>;
  onIssue(issue: ExportIssue): void;
  figureLabel(nodeId: string): string | null;
};

const defaultDependencies: PrintTemplateDependencies = {
  includeDocumentHeader: true,
  patentBookLayout: false,
  renderFallback: renderFormulaFallback,
  onIssue: () => undefined,
  figureLabel: () => null,
};

type RenderContext = {
  tableNameNumbers: ReadonlyMap<string, number>;
  assets: ReadonlyMap<string, StoredAsset>;
  dependencies: PrintTemplateDependencies;
  fallbackCache: Map<string, Promise<FormulaFallbackImage>>;
  fallbackTail: Promise<void>;
  contentWidthMm: number;
};

export class ChemicalStructurePreviewAssetError extends Error {
  constructor(
    readonly nodeId: string,
    readonly assetId: string,
  ) {
    super(`化学结构预览资源不存在或已损坏：${assetId}`);
    this.name = "ChemicalStructurePreviewAssetError";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cssString(value: string): string {
  return `"${[...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined ? "" : `\\${codePoint.toString(16)} `;
    })
    .join("")}"`;
}

function styleAttribute(styles: Readonly<Record<string, string | number>>): string {
  const value = Object.entries(styles)
    .map(([property, styleValue]) => `${property}:${styleValue}`)
    .join(";");
  return value ? ` style="${escapeHtml(value)}"` : "";
}

function markStyles(marks: readonly TextMark[]): Record<string, string | number> {
  const styles: Record<string, string | number> = {};
  for (const mark of marks) {
    if (mark.type === "font-family")
      styles["font-family"] = cssString(displayDocumentFont(mark.value, process.platform));
    if (mark.type === "font-size") styles["font-size"] = `${mark.valuePt}pt`;
    if (mark.type === "color") styles.color = mark.value;
    if (mark.type === "background-color") styles["background-color"] = mark.value;
  }
  return styles;
}

function renderText(node: Extract<InlineNode, { type: "text" }>): string {
  let content = escapeHtml(node.text);
  const styles = markStyles(node.marks);
  if (Object.keys(styles).length > 0) content = `<span${styleAttribute(styles)}>${content}</span>`;
  for (const mark of node.marks) {
    if (mark.type === "bold") content = `<strong>${content}</strong>`;
    if (mark.type === "italic") content = `<em>${content}</em>`;
    if (mark.type === "underline") content = `<u>${content}</u>`;
    if (mark.type === "superscript") content = `<sup>${content}</sup>`;
    if (mark.type === "subscript") content = `<sub>${content}</sub>`;
  }
  return content;
}

async function renderFormula(
  source: string,
  displayMode: boolean,
  context: RenderContext,
  color?: string,
): Promise<string> {
  try {
    return katex.renderToString(source, {
      displayMode,
      output: "htmlAndMathml",
      throwOnError: true,
      strict: "error",
      trust: false,
      maxSize: 20,
      maxExpand: 1_000,
    });
  } catch {
    try {
      const cacheKey = `${source}\u0000${color ?? ""}`;
      let pending = context.fallbackCache.get(cacheKey);
      if (!pending) {
        pending = context.fallbackTail.then(() =>
          color
            ? context.dependencies.renderFallback(source, undefined, color)
            : context.dependencies.renderFallback(source),
        );
        context.fallbackCache.set(cacheKey, pending);
        context.fallbackTail = pending.then(
          () => undefined,
          () => undefined,
        );
      }
      const image = await pending;
      const encoded = Buffer.from(image.png).toString("base64");
      const width = (image.widthPx * 96) / 300 / 16;
      const height = (image.heightPx * 96) / 300 / 16;
      return `<img class="formula-fallback" src="data:image/png;base64,${encoded}" alt="${escapeHtml(
        image.altText,
      )}"${styleAttribute({ width: `${width}em`, height: `${height}em` })}>`;
    } catch {
      return `<code class="formula-source">${escapeHtml(source)}</code>`;
    }
  }
}

async function renderInline(node: InlineNode, context: RenderContext): Promise<string> {
  if (node.type === "text") return renderText(node);
  if (node.type === "hard-break") return "<br>";
  if (node.type === "inline-formula")
    return `<span class="inline-formula"${styleAttribute({
      ...(node.fontSizePt != null ? { "font-size": `${node.fontSizePt}pt` } : {}),
      ...(node.color ? { color: node.color } : {}),
    })}>${await renderFormula(node.source, false, context, node.color)}</span>`;
  const asset = context.assets.get(node.assetId);
  if (!asset) throw new Error(`图片资源不存在：${node.assetId}`);
  const useOriginal =
    asset.descriptor.mediaType === "image/png" || asset.descriptor.mediaType === "image/jpeg";
  const bytes = useOriginal ? asset.original : asset.preview;
  const mediaType = useOriginal ? asset.descriptor.mediaType : "image/png";
  const originalAspectRatio = asset.descriptor.widthPx / asset.descriptor.heightPx;
  const quarterTurned = node.rotationDeg === 90 || node.rotationDeg === 270;
  const displayedAspectRatio = quarterTurned ? 1 / originalAspectRatio : originalAspectRatio;
  return `<span class="inline-figure"${styleAttribute({
    display: "inline-block",
    position: "relative",
    width: `${node.widthMm}mm`,
    "aspect-ratio": displayedAspectRatio,
    "vertical-align": "baseline",
  })}><img src="data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}" alt="${escapeHtml(asset.descriptor.originalName)}"${styleAttribute(
    {
      position: "absolute",
      top: "50%",
      left: "50%",
      width: quarterTurned ? `${originalAspectRatio * 100}%` : "100%",
      height: quarterTurned ? `${100 / originalAspectRatio}%` : "100%",
      "object-fit": "contain",
      transform: `translate(-50%, -50%) rotate(${node.rotationDeg ?? 0}deg)`,
    },
  )}></span>`;
}

function paragraphStyles(
  attrs: ParagraphAttributes,
  content: readonly InlineNode[] = [],
): Record<string, string | number> {
  return {
    "font-family": `${cssString(displayDocumentFont(attrs.defaultFontFamily, process.platform))}, SimSun, serif`,
    "font-size": `${effectiveParagraphFontSizePt(
      attrs.defaultFontSizePt,
      content
        .filter((node) => node.type === "text")
        .map(
          (node) =>
            node.marks.find((mark) => mark.type === "font-size")?.valuePt ??
            attrs.defaultFontSizePt,
        ),
    )}pt`,
    "line-height": lineSpacingToCssLineHeight(attrs.lineSpacing),
    ...(attrs.spaceBeforePt !== undefined ? { "margin-top": `${attrs.spaceBeforePt}pt` } : {}),
    ...(attrs.spaceAfterPt !== undefined ? { "margin-bottom": `${attrs.spaceAfterPt}pt` } : {}),
    "text-align": attrs.alignment,
    "text-indent": `${attrs.paragraphIndentMm}mm`,
  };
}

async function renderParagraph(
  node: ParagraphNode,
  context: RenderContext,
  tag = "p",
): Promise<string> {
  const content = await Promise.all(node.content.map((child) => renderInline(child, context)));
  return `<${tag}${styleAttribute(paragraphStyles(node.attrs, node.content))}>${content.join("") || "<br>"}</${tag}>`;
}

function tableBorderStyle(style: TableCell["borderStyle"]): string {
  if (style === "none") return "none";
  if (style === "double") return "3px double #000";
  return "1px solid #000";
}

async function renderTableCell(
  cell: TableCell,
  context: RenderContext,
  tag: "td" | "th",
  exactHeightMm?: number,
): Promise<string> {
  const content = await Promise.all(
    cell.content.map((paragraph) => renderParagraph(paragraph, context)),
  );
  const edges = cell.borderEdges ?? {
    top: cell.borderStyle,
    right: cell.borderStyle,
    bottom: cell.borderStyle,
    left: cell.borderStyle,
  };
  return `<${tag} rowspan="${cell.rowSpan}" colspan="${cell.colSpan}"${styleAttribute({
    "border-top": tableBorderStyle(edges.top),
    "border-right": tableBorderStyle(edges.right),
    "border-bottom": tableBorderStyle(edges.bottom),
    "border-left": tableBorderStyle(edges.left),
    "text-align": cell.horizontalAlignment,
    "vertical-align": cell.verticalAlignment,
    ...(cell.paddingMm
      ? {
          padding: `${cell.paddingMm.top}mm ${cell.paddingMm.right}mm ${cell.paddingMm.bottom}mm ${cell.paddingMm.left}mm`,
        }
      : {}),
  })}><div class="print-table-cell-content"${styleAttribute({
    ...(exactHeightMm !== undefined
      ? {
          "max-height": `max(0px, calc(${formatMillimetres(exactHeightMm)} - ${cell.paddingMm ? cell.paddingMm.top + cell.paddingMm.bottom : 3}mm - 1px))`,
          overflow: "hidden",
        }
      : {}),
  })}>${content.join("")}</div></${tag}>`;
}

async function renderBlock(node: BlockNode, context: RenderContext): Promise<string> {
  switch (node.type) {
    case "paragraph":
      return renderParagraph(node, context);
    case "heading": {
      const content = await Promise.all(node.content.map((child) => renderInline(child, context)));
      return `<h${node.level}${styleAttribute(paragraphStyles(node.attrs))}>${content.join("") || "<br>"}</h${node.level}>`;
    }
    case "bullet-list":
    case "ordered-list": {
      const tag = node.type === "bullet-list" ? "ul" : "ol";
      const start = node.type === "ordered-list" ? ` start="${node.start}"` : "";
      const items = await Promise.all(
        node.items.map(async (item) => {
          const content = await Promise.all(
            item.content.map((paragraph) => renderParagraph(paragraph, context)),
          );
          return `<li>${content.join("")}</li>`;
        }),
      );
      return `<${tag}${start}>${items.join("")}</${tag}>`;
    }
    case "page-break":
      return '<div class="page-break" aria-hidden="true"></div>';
    case "figure": {
      const asset = context.assets.get(node.assetId);
      if (!asset) throw new Error(`附图资源不存在：${node.assetId}`);
      const label = context.dependencies.figureLabel(node.id);
      const labelHtml = label ? `<figcaption>${escapeHtml(label)}</figcaption>` : "";
      const originalAspectRatio = asset.descriptor.widthPx / asset.descriptor.heightPx;
      const quarterTurned = node.rotationDeg === 90 || node.rotationDeg === 270;
      const displayedAspectRatio = quarterTurned ? 1 / originalAspectRatio : originalAspectRatio;
      const figureStyle = styleAttribute({
        width: `${node.widthMm}mm`,
      });
      const imageFrameStyle = styleAttribute({
        display: "block",
        position: "relative",
        width: "100%",
        "aspect-ratio": displayedAspectRatio,
      });
      const imageStyle = styleAttribute({
        position: "absolute",
        top: "50%",
        left: "50%",
        width: quarterTurned ? `${originalAspectRatio * 100}%` : "100%",
        height: quarterTurned ? `${100 / originalAspectRatio}%` : "100%",
        "object-fit": "contain",
        transform: `translate(-50%, -50%) rotate(${node.rotationDeg ?? 0}deg)`,
      });
      if (
        asset.descriptor.kind === "vector-image" ||
        asset.descriptor.kind === "flowchart-preview"
      ) {
        const svg = Buffer.from(asset.original).toString("utf8");
        const validSvg =
          asset.descriptor.kind === "vector-image"
            ? isVectorSvgSafeForExport(svg)
            : Boolean(sanitizeExportSvg(svg));
        const source = validSvg
          ? `data:image/svg+xml,${encodeURIComponent(svg)}`
          : `data:image/png;base64,${Buffer.from(asset.preview).toString("base64")}`;
        if (!validSvg && asset.descriptor.kind === "flowchart-preview") {
          context.dependencies.onIssue({
            severity: "warning",
            code: "FLOWCHART_RENDERED_AS_IMAGE",
            nodeId: node.id,
            message: "流程图 SVG 无法安全导出，已降级为 PNG 图片。",
          });
        }
        return `<figure class="figure figure-${node.alignment}"${figureStyle}><span class="figure-image-frame"${imageFrameStyle}><img src="${source}" alt="${escapeHtml(asset.descriptor.originalName)}"${imageStyle}></span>${labelHtml}</figure>`;
      }
      const useOriginal =
        asset.descriptor.mediaType === "image/png" || asset.descriptor.mediaType === "image/jpeg";
      const bytes = useOriginal ? asset.original : asset.preview;
      const mediaType = useOriginal ? asset.descriptor.mediaType : "image/png";
      const encoded = Buffer.from(bytes).toString("base64");
      return `<figure class="figure figure-${node.alignment}"${figureStyle}><span class="figure-image-frame"${imageFrameStyle}><img src="data:${mediaType};base64,${encoded}" alt="${escapeHtml(
        asset.descriptor.originalName,
      )}"${imageStyle}></span>${labelHtml}</figure>`;
    }
    case "table": {
      const headerRowCount = node.headerRowCount ?? 0;
      const rows = await Promise.all(
        node.rows.map(async (row, rowIndex) => {
          const tag = rowIndex < headerRowCount ? "th" : "td";
          const cells = await Promise.all(
            row.cells.map((cell) => {
              const spannedRows = node.rows.slice(rowIndex, rowIndex + cell.rowSpan);
              const exactHeightMm =
                spannedRows.length === cell.rowSpan &&
                spannedRows.every(
                  (item) => item.rowHeightRule === "exact" && item.rowHeightMm !== undefined,
                )
                  ? spannedRows.reduce((height, item) => height + (item.rowHeightMm ?? 0), 0)
                  : undefined;
              return renderTableCell(cell, context, tag, exactHeightMm);
            }),
          );
          const rowHeight =
            row.rowHeightMm !== undefined && row.rowHeightRule !== undefined
              ? ` data-patent-row-height-rule="${row.rowHeightRule}"${styleAttribute({
                  "--patent-row-height": formatMillimetres(row.rowHeightMm),
                })}`
              : "";
          return `<tr${rowHeight}>${cells.join("")}</tr>`;
        }),
      );
      const resolvedWidths = resolveTableColumnWidthsMm(node, context.contentWidthMm);
      const columns = resolvedWidths
        .map((width) => `<col${styleAttribute({ width: `${width}mm` })}>`)
        .join("");
      const head =
        headerRowCount > 0 ? `<thead>${rows.slice(0, headerRowCount).join("")}</thead>` : "";
      const annotations = visibleTableAnnotations(node, context.tableNameNumbers.get(node.id));
      const width = formatMillimetres(resolvedWidths.reduce((sum, width) => sum + width, 0));
      const margins = {
        "margin-left":
          node.tableAlignment === "center" || node.tableAlignment === "right" ? "auto" : "0",
        "margin-right": node.tableAlignment === "center" ? "auto" : "0",
      };
      const font = node.rows[0]?.cells[0]?.content[0]?.attrs;
      const annotationStyles = {
        width,
        ...margins,
        "font-size": `${TABLE_ANNOTATION_FONT_SIZE_PT}pt`,
        "font-family": cssString(displayDocumentFont(font?.defaultFontFamily, process.platform)),
        "line-height": "1.5",
        "white-space": "pre-wrap",
        "overflow-wrap": "anywhere",
        "text-indent": "0",
      };
      const name = annotations.name
        ? `<div class="table-name"${styleAttribute({ ...annotationStyles, "text-align": "center", "font-weight": "600", "margin-bottom": "2mm", "break-after": "avoid" })}>${escapeHtml(annotations.name)}</div>`
        : "";
      const note = annotations.note
        ? `<div class="table-note"${styleAttribute({ ...annotationStyles, "text-align": "left", "margin-top": "2mm", "break-before": "avoid" })}>${escapeHtml(annotations.note).replaceAll("\n", "<br>")}</div>`
        : "";
      return `${name}<table${styleAttribute({ width, "table-layout": "fixed", ...margins })}><colgroup>${columns}</colgroup>${head}<tbody>${rows.slice(headerRowCount).join("")}</tbody></table>${note}`;
    }
    case "block-formula":
      return `<div class="block-formula" style="text-align: ${node.alignment ?? "center"}${node.fontSizePt != null ? `; font-size: ${node.fontSizePt}pt` : ""}${node.color ? `; color: ${node.color}` : ""}">${await renderFormula(node.source, true, context, node.color)}</div>`;
    case "chemical-structure": {
      const prepared = await prepareChemicalStructureExport(
        node,
        context.assets.get(node.previewAssetId),
        { contentWidthMm: context.contentWidthMm },
      );
      if (!prepared.ok) throw new ChemicalStructurePreviewAssetError(node.id, node.previewAssetId);
      const { svg, png, widthMm } = prepared.media;
      const source =
        svg !== null
          ? `data:image/svg+xml,${encodeURIComponent(svg)}`
          : `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
      return `<figure class="chemical-structure chemical-structure-${node.alignment}"${styleAttribute(
        {
          width: `${widthMm}mm`,
        },
      )}><img src="${source}" alt="化学结构预览"></figure>`;
    }
  }
}

function isLayoutCandidate(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ("orientation" in value ||
      "paperSize" in value ||
      "scalePercent" in value ||
      "margins" in value)
  );
}

function formatMillimetres(value: number): string {
  return `${Number(value.toFixed(2))}mm`;
}

function resolveMargins(document: PrintableDocument, margins: PrintMargins): string {
  if (margins.mode === "none") return "0mm 0mm 0mm 0mm";
  if (margins.mode === "custom") {
    return [margins.topMm, margins.rightMm, margins.bottomMm, margins.leftMm]
      .map(formatMillimetres)
      .join(" ");
  }
  const page = document.page;
  return [page.marginTopMm, page.marginRightMm, page.marginBottomMm, page.marginLeftMm]
    .map(formatMillimetres)
    .join(" ");
}

type PrintableDocument = CanonicalDocument | PatentBookDocument;

function fixedStyles(
  document: PrintableDocument,
  layout: PrintLayoutSettings | null,
  patentBookLayout: boolean,
): string {
  const page = layout
    ? getPaperSizeMillimetres(layout.paperSize, layout.orientation)
    : document.page;
  const isA4Portrait = page.widthMm === 210 && page.heightMm === 297;
  const pageSize = layout
    ? `${layout.paperSize} ${layout.orientation}`
    : isA4Portrait
      ? "A4 portrait"
      : `${page.widthMm}mm ${page.heightMm}mm`;
  const margin = layout
    ? resolveMargins(document, layout.margins)
    : `${document.page.marginTopMm}mm ${document.page.marginRightMm}mm ${document.page.marginBottomMm}mm ${document.page.marginLeftMm}mm`;
  const topMarginMm =
    layout?.margins.mode === "none"
      ? 0
      : layout?.margins.mode === "custom"
        ? layout.margins.topMm
        : document.page.marginTopMm;
  return `
@page { size: ${pageSize}; margin: ${margin}; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { width: auto; font-family: SimSun, serif; font-size: 14pt; }
h1, h2, h3, p { margin: 0; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; line-break: strict; text-justify: inter-character; text-align-last: auto; }
u { text-decoration-thickness: 0.75px; text-underline-offset: 0.08em; }
.document-print-header { margin-bottom: 28px; padding-bottom: 12px; border-bottom: 1px solid #d9dde4; font-family: SimSun, serif; font-size: 18px; text-align: center; }
${
  patentBookLayout
    ? `@page {
  @top-center {
    content: ${cssString(document.title)};
    font-family: SimSun, serif;
    font-size: 18px;
    line-height: normal;
    vertical-align: top;
    text-align: center;
    margin-top: ${formatMillimetres(Math.max(1, topMarginMm - 12))};
    margin-bottom: calc(12mm - 1lh - 13px);
    padding-bottom: 12px;
    border-bottom: 1px solid #d9dde4;
  }
}
.document-print-header { display: none; }
.patent-book-print-body { margin: 0; }`
    : ""
}
h1 { font-size: 18pt; } h2 { font-size: 16pt; } h3 { font-size: 14pt; }
ul, ol { margin: 0 0 0.75em; padding-inline-start: 3em; list-style-position: outside; }
li > p { text-indent: 0 !important; margin-bottom: 0.25em; }
.page-break { display: block; height: 0; break-after: page; page-break-after: always; }
.figure { display: block; max-width: 100%; margin-top: 0.75em; margin-bottom: 0.75em; break-inside: avoid; page-break-inside: avoid; }
.figure-left { margin-left: 0; margin-right: auto; }
.figure-center { margin-left: auto; margin-right: auto; }
.figure-right { margin-left: auto; margin-right: 0; }
.figure img { display: block; width: auto; max-width: 100%; max-height: 245mm; height: auto; object-fit: contain; }
figcaption { display: block; padding-top: 0.35em; text-align: center; }
table { width: auto; max-width: 100%; margin: 0 0 0.75em; border-collapse: collapse; break-inside: auto; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
tr[data-patent-row-height-rule="at-least"] { height: var(--patent-row-height); }
tr[data-patent-row-height-rule="exact"] { height: var(--patent-row-height); overflow: hidden; }
tr[data-patent-row-height-rule="exact"] > td, tr[data-patent-row-height-rule="exact"] > th { overflow: hidden; }
td, th { padding: 1.5mm; font-weight: inherit; }
th { font-weight: bold; }
td > p:last-child, th > p:last-child { margin-bottom: 0; }
.print-table-cell-content { overflow-wrap: anywhere; }
.print-table-cell-content > p:last-child { margin-bottom: 0; }
.block-formula { ${BLOCK_FORMULA_STYLE} }
.block-formula .katex-display { ${BLOCK_FORMULA_MATH_STYLE} }
.block-formula .katex-display > .katex { text-align: inherit; }
.inline-formula > .katex, .block-formula .katex-display > .katex { font-size: 1em; }
.formula-fallback { max-width: 100%; object-fit: contain; vertical-align: middle; }
.formula-source { display: inline-block; max-width: 100%; overflow-wrap: anywhere; white-space: pre-wrap; }
.chemical-structure { display: block; max-width: 100%; margin-top: 0.75em; margin-bottom: 0.75em; break-inside: avoid; page-break-inside: avoid; }
.chemical-structure-left { margin-left: 0; margin-right: auto; }
.chemical-structure-center { margin-left: auto; margin-right: auto; }
.chemical-structure-right { margin-left: auto; margin-right: 0; }
.chemical-structure img { display: block; width: auto; max-width: 100%; max-height: 245mm; height: auto; object-fit: contain; }
`;
}

export async function renderPrintHtml(
  inputDocument: PrintableDocument,
  assets: readonly StoredAsset[],
  layoutOrOverrides: PrintLayoutSettings | Partial<PrintTemplateDependencies> = {},
  overrides: Partial<PrintTemplateDependencies> = {},
): Promise<string> {
  const document = (
    CanonicalDocumentSchema.safeParse(inputDocument).success
      ? CanonicalDocumentSchema.parse(inputDocument)
      : PatentBookDocumentSchema.parse(inputDocument)
  ) as PrintableDocument;
  if (
    document.content.some(
      (node) => node.type === "table" && tableExceedsPage(node, pageBodyWidthMm(document.page)),
    )
  ) {
    throw new Error("表格超出正文宽度，请在编辑器中适配正文宽度或减少列数后再导出、打印。");
  }
  const layout = isLayoutCandidate(layoutOrOverrides)
    ? PrintLayoutSettingsSchema.parse(layoutOrOverrides)
    : CanonicalDocumentSchema.safeParse(document).success
      ? createDefaultPrintSettings(document.page).layout
      : null;
  const dependenciesOverrides = isLayoutCandidate(layoutOrOverrides)
    ? overrides
    : layoutOrOverrides;
  const assetMap = new Map(assets.map((asset) => [asset.descriptor.assetId, asset]));
  const context: RenderContext = {
    tableNameNumbers: tableNameNumbers(document.content),
    assets: assetMap,
    dependencies: { ...defaultDependencies, ...dependenciesOverrides },
    fallbackCache: new Map(),
    fallbackTail: Promise.resolve(),
    contentWidthMm: Math.max(
      1,
      document.page.widthMm - document.page.marginLeftMm - document.page.marginRightMm,
    ),
  };
  const content = await Promise.all(document.content.map((node) => renderBlock(node, context)));
  const header = context.dependencies.includeDocumentHeader
    ? `<header class="document-print-header">${escapeHtml(document.title)}</header>`
    : "";
  const body = context.dependencies.patentBookLayout
    ? `<main class="patent-book-print-body">${content.join("")}</main>`
    : content.join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(
    document.title,
  )}</title><style>${KATEX_CSS}\n${KATEX_DATA_FONT_CSS}\n${fixedStyles(document, layout, context.dependencies.patentBookLayout)}</style></head><body>${header}${body}</body></html>`;
}

export async function renderPrintDocumentsHtml(
  documents: readonly CanonicalDocument[],
  assets: readonly StoredAsset[],
  layout: PrintLayoutSettings,
  figureLabels: Readonly<Record<string, string>> = {},
  onIssue: (issue: ExportIssue) => void = () => {},
): Promise<string> {
  const styles: string[] = [];
  const sections: string[] = [];
  for (const [index, document] of documents.entries()) {
    const html = await renderPrintHtml(document, assets, layout, {
      patentBookLayout: true,
      figureLabel: (id) => figureLabels[id] ?? null,
      onIssue,
    });
    const name = `print-book-${index}`;
    const css = /<style>([\s\S]*)<\/style>/u.exec(html)?.[1] ?? "";
    styles.push(
      css
        .replace(KATEX_CSS, "")
        .replace(KATEX_DATA_FONT_CSS, "")
        .replaceAll("@page {", `@page ${name} {`),
    );
    const body = /<body>([\s\S]*)<\/body>/u.exec(html)?.[1] ?? "";
    sections.push(
      `<section style="page:${name};min-height:1px;${index ? "break-before:page" : ""}">${body}</section>`,
    );
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><style>${KATEX_CSS}\n${KATEX_DATA_FONT_CSS}\n${styles.join("\n")}</style></head><body>${sections.join("")}</body></html>`;
}
