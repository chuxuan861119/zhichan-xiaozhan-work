import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  AlignmentType,
  BorderStyle,
  createTransformation,
  Document,
  Drawing,
  type FileChild,
  HeadingLevel,
  HeightRule,
  hashedId,
  type IContext,
  type IImageOptions,
  type IMediaData,
  type INumberingOptions,
  LevelFormat,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  type ParagraphChild,
  RunProperties,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TabStopType,
  TextRun,
  UnderlineType,
  VerticalAlignTable,
  VerticalMergeType,
  WidthType,
  XmlComponent,
} from "docx";
import yauzl, { type ZipFile } from "yauzl";
import { referencedDocumentAssetIds } from "../../shared/document/asset-references.js";
import { DOCX_HEADING_STYLES } from "../../shared/document/docx-heading-style.js";
import {
  DOCX_LIST_PARAGRAPH_STYLES,
  LIST_CONTINUATION_STYLE_ID,
} from "../../shared/document/docx-list-style.js";
import { docxDocumentFont } from "../../shared/document/font-policy.js";
import { effectiveParagraphFontSizePt } from "../../shared/document/line-spacing.js";
import type {
  BlockFormulaNode,
  BlockNode,
  CanonicalDocument,
  TableCell as CanonicalTableCell,
  ChemicalStructureNode,
  FigureNode,
  HeadingNode,
  InlineFigureNode,
  InlineNode,
  ParagraphAttributes,
  ParagraphNode,
  TableNode,
  TextMark,
} from "../../shared/document/model.js";
import {
  TABLE_ANNOTATION_FONT_SIZE_PT,
  tableNameNumbers,
  visibleTableAnnotations,
} from "../../shared/document/table-annotations.js";
import {
  normalizeTableColumnWidths,
  resolveTableColumnWidthsMm,
} from "../../shared/document/table-column-widths.js";
import { pageBodyWidthMm, tableExceedsPage } from "../../shared/document/table-page-fit.js";
import type { ExportIssue, ExportReport } from "../../shared/exports/report.js";
import type { AssetStore, StoredAsset } from "../assets/asset-store.js";
import { writeExportFile } from "../platform/atomic-export-write.js";
import {
  chemicalStructureDegradationIssue,
  prepareChemicalStructureExport,
  prepareChemicalStructureJpeg,
} from "./chemical-structure-export.js";
import { prepareDocxImageData } from "./docx-image-data.js";
import { exportFormula, type FormulaExport } from "./formula-exporter.js";

// Match the editor's 14pt list container: two characters before the marker,
// one more to the text start. Explicit tabs avoid Word's wider default stops.
const LIST_TEXT_INDENT_TWIPS = 14 * 3 * 20;
const LIST_HANGING_TWIPS = 14 * 20;
const DEFAULT_FONT = "SimSun";
const DEFAULT_FONT_SIZE_PT = 12;
// Supported editor fonts map to Windows names without embedding system font files.

export type DocxPackageRequest = {
  sessionId: string;
  document: CanonicalDocument;
};

export type DocxPackage = {
  buffer: Buffer;
  issues: ExportIssue[];
};

export type MappingContext = {
  tableNameNumbers?: ReadonlyMap<string, number>;
  sessionId: string;
  assetStore: AssetStore;
  assetCache: Map<string, ExportImageAsset | null>;
  preparedAssetMediaCache: Map<string, PreparedAssetMedia>;
  preparedFormulaMediaCache: WeakMap<RasterFormulaImage, PreparedAssetMedia>;
  formulaExports: ReadonlyMap<FormulaNode, FormulaExport>;
  chemicalStructureAssets: ReadonlyMap<ChemicalStructureNode, ExportImageAsset>;
  nextDrawingId: number;
  contentWidthMm: number;
  contentHeightMm: number;
  issues: ExportIssue[];
  embeddedMediaTypes: Set<StoredAsset["descriptor"]["mediaType"]>;
  orderedListReferences: ReadonlyMap<string, string>;
};

type ExportImageAsset = {
  original: Uint8Array;
  mediaType: StoredAsset["descriptor"]["mediaType"];
  originalName: string;
  widthPx: number;
  heightPx: number;
};

type PreparedAssetMedia = {
  type: IImageOptions["type"];
  data: Uint8Array;
  fileName: string;
};

export async function prepareFigureImageMedia(
  content: readonly BlockNode[],
  assetStore: AssetStore,
  sessionId: string,
  assetCache: MappingContext["assetCache"],
): Promise<Map<string, PreparedAssetMedia>> {
  const cache = new Map<string, PreparedAssetMedia>();
  const visit = async (nodes: readonly (BlockNode | InlineNode)[]) => {
    for (const node of nodes) {
      if (node.type === "figure" || node.type === "inline-figure") {
        const key = `${node.assetId}:${node.rotationDeg ?? 0}`;
        if (cache.has(key)) continue;
        const asset = getExportImageAsset(node.assetId, { assetStore, sessionId, assetCache });
        if (!asset) continue; // The mapper reports the missing asset with its node ID.
        const image = await prepareDocxImageData(
          {
            type: imageType(asset.mediaType) as "png" | "jpg" | "bmp" | "tiff",
            data: asset.original,
          },
          node.rotationDeg ?? 0,
          asset.widthPx,
          asset.heightPx,
        );
        cache.set(key, {
          type: image.type as IImageOptions["type"],
          data: image.data,
          fileName: `${hashedId(image.data)}.${image.type}`,
        });
      } else if (node.type === "paragraph" || node.type === "heading") await visit(node.content);
      else if (node.type === "ordered-list" || node.type === "bullet-list") {
        for (const item of node.items) await visit(item.content);
      } else if (node.type === "table") {
        for (const row of node.rows) for (const cell of row.cells) await visit(cell.content);
      }
    }
  };
  await visit(content);
  return cache;
}

type InlineDefaults = Pick<ParagraphAttributes, "defaultFontFamily" | "defaultFontSizePt"> & {
  defaultBold?: boolean;
};

type FormulaNode = Extract<InlineNode, { type: "inline-formula" }> | BlockFormulaNode;
type RasterFormulaImage = Extract<FormulaExport, { kind: "raster" }>["image"];

type ActiveVerticalMerge = {
  remainingRows: number;
  colSpan: number;
  widthTwips: number;
  verticalAlignment: CanonicalTableCell["verticalAlignment"];
  borderStyle: CanonicalTableCell["borderStyle"];
  borderEdges: CanonicalTableCell["borderEdges"];
  paddingMm: CanonicalTableCell["paddingMm"];
};

class PreparedMediaImageRun extends XmlComponent {
  constructor(
    private readonly mediaData: IMediaData,
    originalName: string,
    drawingId: number,
  ) {
    super("w:r");
    this.root.push(new RunProperties({}));
    this.root.push(
      new Drawing(mediaData, {
        docProperties: { id: drawingId.toString(), name: originalName, description: originalName },
      }),
    );
  }

  override prepForXml(context: IContext) {
    context.file.Media.addImage(this.mediaData.fileName, this.mediaData);
    return super.prepForXml(context);
  }
}

export class DocxExportError extends Error {
  constructor(readonly issues: ExportIssue[]) {
    const summary =
      issues.length === 1
        ? (issues[0]?.message ?? "DOCX 导出失败。")
        : issues.length > 1
          ? `DOCX 导出失败，共发现 ${issues.length} 个问题。请查看导出报告。`
          : "DOCX 导出失败。";
    super(summary.slice(0, 500));
    this.name = "DocxExportError";
  }
}

export function millimetresToTwips(mm: number): number {
  return Math.round((mm * 1440) / 25.4);
}

export function pointsToHalfPoints(pt: number): number {
  return Math.round(pt * 2);
}

export function millimetresToPixels(mm: number): number {
  return Math.round((mm * 96) / 25.4);
}

function fontAttributes(fontFamily: string) {
  return {
    ascii: fontFamily,
    hAnsi: fontFamily,
    eastAsia: fontFamily,
    cs: fontFamily,
  };
}

function addIssue(issues: ExportIssue[], issue: ExportIssue): void {
  if (
    !issues.some(
      (existing) =>
        existing.code === issue.code &&
        existing.nodeId === issue.nodeId &&
        existing.message === issue.message,
    )
  ) {
    issues.push(issue);
  }
}

function runOptionsFromMarks(
  marks: TextMark[],
  defaults: InlineDefaults,
  issues: ExportIssue[] = [],
  nodeId: string | null = null,
) {
  let fontFamily = defaults.defaultFontFamily;
  let fontSizePt = defaults.defaultFontSizePt;
  let bold = defaults.defaultBold ?? false;
  let italics = false;
  let underline = false;
  let subScript = false;
  let superScript = false;
  let color: string | undefined;
  let highlight: string | undefined;

  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        bold = true;
        break;
      case "italic":
        italics = true;
        break;
      case "underline":
        underline = true;
        break;
      case "subscript":
        subScript = true;
        break;
      case "superscript":
        superScript = true;
        break;
      case "font-family":
        fontFamily = mark.value;
        break;
      case "font-size":
        fontSizePt = mark.valuePt;
        break;
      case "color":
        color = mark.value.slice(1).toUpperCase();
        break;
      case "background-color":
        highlight = mark.value.slice(1).toUpperCase();
        break;
      case "reference-mark-token":
      case "claim-reference-review":
        break;
    }
  }

  const exportFont = docxDocumentFont(fontFamily, process.platform);
  if (exportFont === null) {
    addIssue(issues, {
      severity: "warning",
      code: "FONT_SUBSTITUTED",
      nodeId,
      message: `字体“${fontFamily}”已替换为“${DEFAULT_FONT}”。`,
    });
    fontFamily = DEFAULT_FONT;
  } else fontFamily = exportFont;

  return {
    font: fontAttributes(fontFamily),
    size: pointsToHalfPoints(fontSizePt),
    bold,
    italics,
    ...(underline ? { underline: { type: UnderlineType.SINGLE } } : {}),
    subScript,
    superScript,
    ...(color ? { color } : {}),
    ...(highlight ? { shading: { fill: highlight } } : {}),
  };
}

export function mapInlineNodes(
  nodes: InlineNode[],
  defaults: InlineDefaults = {
    defaultFontFamily: DEFAULT_FONT,
    defaultFontSizePt: DEFAULT_FONT_SIZE_PT,
  },
  issues: ExportIssue[] = [],
  nodeId: string | null = null,
  context?: MappingContext,
): ParagraphChild[] {
  const effectiveDefaults = {
    ...defaults,
    defaultFontSizePt: effectiveParagraphFontSizePt(
      defaults.defaultFontSizePt,
      nodes
        .filter((node) => node.type === "text")
        .map(
          (node) =>
            node.marks.find((mark) => mark.type === "font-size")?.valuePt ??
            defaults.defaultFontSizePt,
        ),
    ),
  };
  return nodes.map((node) => {
    if (node.type === "text") {
      return new TextRun({
        text: node.text,
        ...runOptionsFromMarks(node.marks, effectiveDefaults, issues, nodeId),
      });
    }
    if (node.type === "hard-break") {
      return new TextRun({
        break: 1,
        ...runOptionsFromMarks([], effectiveDefaults, issues, nodeId),
      });
    }
    if (!context) throw new Error("行内内容导出上下文丢失。");
    if (node.type === "inline-figure") return inlineFigureImageRun(node, context);
    const formula = context.formulaExports.get(node);
    if (!formula) throw new Error("公式导出结果丢失。");
    if (formula.kind === "native") return formula.math;
    return formulaImageRun(formula.image, context);
  });
}

function alignment(value: ParagraphAttributes["alignment"] | FigureNode["alignment"]) {
  switch (value) {
    case "center":
      return AlignmentType.CENTER;
    case "right":
      return AlignmentType.RIGHT;
    case "justify":
      return AlignmentType.JUSTIFIED;
    default:
      return AlignmentType.LEFT;
  }
}

function paragraphFromNode(
  node: ParagraphNode | HeadingNode,
  context: MappingContext,
  options: {
    heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel];
    numbering?: { reference: string; level: number };
    defaultBold?: boolean;
    listParagraph?: boolean;
    keepNext?: boolean;
  } = {},
): Paragraph {
  return new Paragraph({
    ...(options.listParagraph && !options.numbering ? { style: LIST_CONTINUATION_STYLE_ID } : {}),
    ...(options.keepNext ? { keepNext: true } : {}),
    children: mapInlineNodes(
      node.content,
      { ...node.attrs, defaultBold: options.defaultBold ?? false },
      context.issues,
      node.id,
      context,
    ),
    alignment: alignment(node.attrs.alignment),
    ...(options.listParagraph
      ? {
          indent: {
            left: LIST_TEXT_INDENT_TWIPS,
            hanging: options.numbering ? LIST_HANGING_TWIPS : 0,
          },
        }
      : node.attrs.paragraphIndentMm > 0
        ? {
            indent: {
              firstLine: millimetresToTwips(node.attrs.paragraphIndentMm),
            },
          }
        : {}),
    spacing: {
      line: Math.round(node.attrs.lineSpacing * 240),
      ...(node.attrs.spaceBeforePt !== undefined
        ? { before: Math.round(node.attrs.spaceBeforePt * 20) }
        : {}),
      ...(node.attrs.spaceAfterPt !== undefined
        ? { after: Math.round(node.attrs.spaceAfterPt * 20) }
        : {}),
    },
    ...(options.heading ? { heading: options.heading } : {}),
    ...(options.numbering ? { numbering: options.numbering } : {}),
    ...(options.numbering
      ? { tabStops: [{ type: TabStopType.LEFT, position: LIST_TEXT_INDENT_TWIPS }] }
      : {}),
  });
}

function headingLevel(level: HeadingNode["level"]) {
  if (level === 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  return HeadingLevel.HEADING_3;
}

function imageType(mediaType: ExportImageAsset["mediaType"]): IImageOptions["type"] {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff" as IImageOptions["type"];
    default:
      return "png";
  }
}

function getExportImageAsset(
  assetId: string,
  context: Pick<MappingContext, "assetStore" | "sessionId" | "assetCache">,
): ExportImageAsset | null {
  const cached = context.assetCache.get(assetId);
  if (cached !== undefined) return cached;
  const stored = context.assetStore.get(context.sessionId, assetId);
  const asset = stored
    ? {
        original: stored.original,
        mediaType: stored.descriptor.mediaType,
        originalName: stored.descriptor.originalName,
        widthPx: stored.descriptor.widthPx,
        heightPx: stored.descriptor.heightPx,
      }
    : null;
  context.assetCache.set(assetId, asset);
  return asset;
}

function addMissingChemicalStructureAssetIssue(
  issues: ExportIssue[],
  node: ChemicalStructureNode,
): void {
  if (issues.some((issue) => issue.nodeId === node.id && issue.severity === "error")) return;
  addIssue(issues, {
    severity: "error",
    code: "MISSING_ASSET",
    nodeId: node.id,
    message: `化学结构预览资源不存在或已损坏：${node.previewAssetId}`,
  });
}

export async function prepareChemicalStructureAssets(
  document: Pick<CanonicalDocument, "content">,
  assetStore: AssetStore,
  sessionId: string,
  issues: ExportIssue[],
  contentWidthMm: number,
  contentHeightMm: number,
): Promise<ReadonlyMap<ChemicalStructureNode, ExportImageAsset>> {
  const assets = new Map<ChemicalStructureNode, ExportImageAsset>();
  for (const node of document.content) {
    if (node.type !== "chemical-structure") continue;
    const stored = assetStore.get(sessionId, node.previewAssetId);
    const prepared = await prepareChemicalStructureExport(node, stored, {
      contentWidthMm,
      contentHeightMm,
    });
    if (!prepared.ok) {
      addIssue(issues, prepared.issue);
      continue;
    }
    const degradation = stored
      ? chemicalStructureDegradationIssue(node, stored, prepared.media)
      : null;
    if (degradation) addIssue(issues, degradation);
    try {
      const jpeg = await prepareChemicalStructureJpeg(prepared.media);
      const originalName = (stored?.descriptor.originalName ?? "structure").replace(
        /\.[^.]+$/u,
        "",
      );
      assets.set(node, {
        original: jpeg.bytes,
        mediaType: "image/jpeg",
        originalName: `${originalName}.jpg`,
        widthPx: jpeg.widthPx,
        heightPx: jpeg.heightPx,
      });
    } catch {
      addIssue(issues, {
        severity: "error",
        code: "EXPORT_FAILED",
        nodeId: node.id,
        message: "化学结构式图片转换失败，请重试或重新生成该结构式预览。",
      });
    }
  }
  return assets;
}

function getPreparedImageMedia(
  assetId: string,
  asset: ExportImageAsset,
  widthPx: number,
  heightPx: number,
  context: MappingContext,
  rotationDeg = 0,
): IMediaData {
  const oriented = context.preparedAssetMediaCache.get(`${assetId}:${rotationDeg}`);
  let prepared = oriented ?? context.preparedAssetMediaCache.get(assetId);
  if (!prepared) {
    const type = imageType(asset.mediaType);
    prepared = {
      type,
      data: asset.original,
      fileName: `${hashedId(asset.original)}.${type}`,
    };
    context.preparedAssetMediaCache.set(assetId, prepared);
  }
  const mediaData = {
    ...prepared,
    transformation: createTransformation({
      width: widthPx,
      height: heightPx,
      ...(!oriented && rotationDeg ? { rotation: rotationDeg } : {}),
    }),
  } as IMediaData;
  return mediaData;
}

function inlineFigureImageRun(node: InlineFigureNode, context: MappingContext): ParagraphChild {
  const asset = getExportImageAsset(node.assetId, context);
  if (!asset) {
    addIssue(context.issues, {
      severity: "error",
      code: "MISSING_ASSET",
      nodeId: node.id,
      message: `图片资源不存在：${node.assetId}`,
    });
    return new TextRun("");
  }
  context.embeddedMediaTypes.add(asset.mediaType);
  const quarterTurned = node.rotationDeg === 90 || node.rotationDeg === 270;
  const nativeAspectRatio = quarterTurned
    ? asset.widthPx / asset.heightPx
    : asset.heightPx / asset.widthPx;
  const widthMm = Math.min(node.widthMm, context.contentWidthMm);
  const heightMm = widthMm * nativeAspectRatio;
  const run = new PreparedMediaImageRun(
    getPreparedImageMedia(
      node.assetId,
      asset,
      millimetresToPixels(widthMm),
      millimetresToPixels(heightMm),
      context,
      node.rotationDeg ?? 0,
    ),
    asset.originalName,
    context.nextDrawingId,
  );
  context.nextDrawingId += 1;
  return run;
}

function formulaImageRun(
  image: RasterFormulaImage,
  context: MappingContext,
): PreparedMediaImageRun {
  let prepared = context.preparedFormulaMediaCache.get(image);
  if (!prepared) {
    const mediaId = hashedId(image.png);
    prepared = { type: "png", data: image.png, fileName: `${mediaId}.png` };
    context.preparedFormulaMediaCache.set(image, prepared);
  }
  const nativeWidthPx = Math.max(1, Math.round((image.widthPx * 96) / 300));
  const nativeHeightPx = Math.max(1, Math.round((image.heightPx * 96) / 300));
  const maximumWidthPx = millimetresToPixels(context.contentWidthMm);
  const maximumHeightPx = millimetresToPixels(context.contentHeightMm);
  const scale = Math.min(1, maximumWidthPx / nativeWidthPx, maximumHeightPx / nativeHeightPx);
  const widthPx = Math.max(1, Math.round(nativeWidthPx * scale));
  const heightPx = Math.max(1, Math.round(nativeHeightPx * scale));
  const run = new PreparedMediaImageRun(
    {
      ...prepared,
      transformation: createTransformation({ width: widthPx, height: heightPx }),
    } as IMediaData,
    image.altText,
    context.nextDrawingId,
  );
  context.nextDrawingId += 1;
  return run;
}

export function mapFigure(node: FigureNode, context: MappingContext): Paragraph[] {
  const asset = getExportImageAsset(node.assetId, context);
  if (!asset) {
    context.issues.push({
      severity: "error",
      code: "MISSING_ASSET",
      nodeId: node.id,
      message: `附图资源不存在：${node.assetId}`,
    });
    return [];
  }
  context.embeddedMediaTypes.add(asset.mediaType);

  const maxWidthMm = Math.min(node.widthMm, context.contentWidthMm);
  const maxHeightMm = context.contentHeightMm;
  const quarterTurned = node.rotationDeg === 90 || node.rotationDeg === 270;
  const aspectRatio = quarterTurned
    ? asset.widthPx / asset.heightPx
    : asset.heightPx / asset.widthPx;
  let widthMm = maxWidthMm;
  let heightMm = widthMm * aspectRatio;
  if (heightMm > maxHeightMm) {
    heightMm = maxHeightMm;
    widthMm = heightMm / aspectRatio;
  }
  const widthPx = millimetresToPixels(widthMm);
  const heightPx = millimetresToPixels(heightMm);
  const image = new PreparedMediaImageRun(
    getPreparedImageMedia(node.assetId, asset, widthPx, heightPx, context, node.rotationDeg ?? 0),
    asset.originalName,
    context.nextDrawingId,
  );
  context.nextDrawingId += 1;
  return [
    new Paragraph({
      alignment: alignment(node.alignment),
      children: [image],
    }),
  ];
}

function tableVerticalAlignment(value: CanonicalTableCell["verticalAlignment"]) {
  if (value === "middle") return VerticalAlignTable.CENTER;
  if (value === "bottom") return VerticalAlignTable.BOTTOM;
  return VerticalAlignTable.TOP;
}

function cellBorder(style: CanonicalTableCell["borderStyle"]) {
  const borderStyle =
    style === "double"
      ? BorderStyle.DOUBLE
      : style === "single"
        ? BorderStyle.SINGLE
        : BorderStyle.NONE;
  const border = { style: borderStyle, size: style === "none" ? 0 : 4, color: "000000" };
  return border;
}

function cellBorders(cell: Pick<CanonicalTableCell, "borderStyle" | "borderEdges">) {
  const edges = cell.borderEdges ?? {
    top: cell.borderStyle,
    right: cell.borderStyle,
    bottom: cell.borderStyle,
    left: cell.borderStyle,
  };
  return {
    top: cellBorder(edges.top),
    right: cellBorder(edges.right),
    bottom: cellBorder(edges.bottom),
    left: cellBorder(edges.left),
  };
}

function cellMargins(padding: CanonicalTableCell["paddingMm"]) {
  return padding
    ? {
        margins: {
          top: millimetresToTwips(padding.top),
          right: millimetresToTwips(padding.right),
          bottom: millimetresToTwips(padding.bottom),
          left: millimetresToTwips(padding.left),
        },
      }
    : {};
}

function tableCell(
  cell: CanonicalTableCell,
  context: MappingContext,
  widthTwips: number,
  keepNext = false,
  header = false,
): TableCell {
  return new TableCell({
    children: cell.content.map((paragraph) =>
      paragraphFromNode(paragraph, context, {
        defaultBold: header,
        keepNext,
      }),
    ),
    width: { size: widthTwips, type: WidthType.DXA },
    columnSpan: cell.colSpan,
    ...(cell.rowSpan > 1 ? { verticalMerge: VerticalMergeType.RESTART } : {}),
    verticalAlign: tableVerticalAlignment(cell.verticalAlignment),
    borders: cellBorders(cell),
    ...cellMargins(cell.paddingMm),
  });
}

function continuationCell(span: ActiveVerticalMerge, keepNext = false): TableCell {
  return new TableCell({
    children: [new Paragraph(keepNext ? { keepNext: true } : {})],
    width: { size: span.widthTwips, type: WidthType.DXA },
    columnSpan: span.colSpan,
    verticalMerge: VerticalMergeType.CONTINUE,
    verticalAlign: tableVerticalAlignment(span.verticalAlignment),
    borders: cellBorders(span),
    ...cellMargins(span.paddingMm),
  });
}

export function mapTable(node: TableNode, context: MappingContext): Table {
  const columnWidths = resolveTableColumnWidthsMm(node, context.contentWidthMm).map(
    millimetresToTwips,
  );
  const activeVerticalMerges = new Map<number, ActiveVerticalMerge>();
  const rows: TableRow[] = [];

  for (const [rowIndex, row] of node.rows.entries()) {
    const keepWithNote =
      rowIndex === node.rows.length - 1 && Boolean(visibleTableAnnotations(node).note);
    const children: TableCell[] = [];
    let columnIndex = 0;
    const emitContinuation = () => {
      const span = activeVerticalMerges.get(columnIndex);
      if (!span) return false;
      children.push(continuationCell(span, keepWithNote));
      const startColumn = columnIndex;
      columnIndex += span.colSpan;
      span.remainingRows -= 1;
      if (span.remainingRows === 0) activeVerticalMerges.delete(startColumn);
      return true;
    };

    for (const cell of row.cells) {
      while (emitContinuation()) {
        // A canonical row omits grid positions occupied by an earlier row span.
      }
      const widthTwips = columnWidths
        .slice(columnIndex, columnIndex + cell.colSpan)
        .reduce((sum, width) => sum + width, 0);
      children.push(
        tableCell(cell, context, widthTwips, keepWithNote, rowIndex < (node.headerRowCount ?? 0)),
      );
      if (cell.rowSpan > 1) {
        activeVerticalMerges.set(columnIndex, {
          remainingRows: cell.rowSpan - 1,
          colSpan: cell.colSpan,
          widthTwips,
          verticalAlignment: cell.verticalAlignment,
          borderStyle: cell.borderStyle,
          borderEdges: cell.borderEdges,
          paddingMm: cell.paddingMm,
        });
      }
      columnIndex += cell.colSpan;
    }
    while (columnIndex < columnWidths.length && emitContinuation()) {
      // Complete trailing grid positions occupied by an earlier row span.
    }
    rows.push(
      new TableRow({
        children,
        tableHeader: rowIndex < (node.headerRowCount ?? 0),
        ...(row.rowHeightMm !== undefined && row.rowHeightRule !== undefined
          ? {
              height: {
                value: millimetresToTwips(row.rowHeightMm),
                rule: row.rowHeightRule === "exact" ? HeightRule.EXACT : HeightRule.ATLEAST,
              },
            }
          : {}),
      }),
    );
  }

  return new Table({
    rows,
    alignment: node.tableAlignment ?? AlignmentType.LEFT,
    columnWidths,
    width:
      node.layoutMode === "fixed"
        ? { size: columnWidths.reduce((sum, width) => sum + width, 0), type: WidthType.DXA }
        : { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
  });
}

export function validateTable(node: TableNode, bodyWidthMm?: number): ExportIssue[] {
  const issues: ExportIssue[] = [];
  if (bodyWidthMm !== undefined && tableExceedsPage(node, bodyWidthMm)) {
    issues.push({
      severity: "error",
      code: "EXPORT_FAILED",
      nodeId: node.id,
      message: "表格超出正文宽度，请在编辑器中适配正文宽度或减少列数后再导出。",
    });
  }
  const columnCount = node.columnWidthsMm.length;
  const occupiedUntilRow = Array.from({ length: columnCount }, () => 0);

  for (const [rowIndex, row] of node.rows.entries()) {
    let columnIndex = 0;
    const skipOccupiedColumns = () => {
      while (columnIndex < columnCount && (occupiedUntilRow[columnIndex] ?? 0) > rowIndex) {
        columnIndex += 1;
      }
    };

    for (const cell of row.cells) {
      skipOccupiedColumns();
      const endColumn = columnIndex + cell.colSpan;
      const endRow = rowIndex + cell.rowSpan;
      if (
        endColumn > columnCount ||
        endRow > node.rows.length ||
        occupiedUntilRow.slice(columnIndex, endColumn).some((until) => until > rowIndex)
      ) {
        issues.push({
          severity: "error",
          code: "EXPORT_FAILED",
          nodeId: node.id,
          message: "表格合并范围超出持久化网格。",
        });
        return issues;
      }
      for (let occupiedColumn = columnIndex; occupiedColumn < endColumn; occupiedColumn += 1) {
        occupiedUntilRow[occupiedColumn] = endRow;
      }
      columnIndex = endColumn;
    }
    skipOccupiedColumns();
    if (columnIndex !== columnCount) {
      issues.push({
        severity: "error",
        code: "EXPORT_FAILED",
        nodeId: node.id,
        message: "表格行未覆盖完整的持久化网格。",
      });
      return issues;
    }
  }

  return issues;
}

export function mapBlockNode(node: BlockNode, context: MappingContext): FileChild[] {
  switch (node.type) {
    case "paragraph":
      return [paragraphFromNode(node, context)];
    case "heading":
      return [paragraphFromNode(node, context, { heading: headingLevel(node.level) })];
    case "bullet-list": {
      const reference = context.orderedListReferences.get(node.id);
      if (!reference) throw new Error("项目符号列表定义丢失。");
      return node.items.flatMap((item) =>
        item.content.map((paragraph, paragraphIndex) =>
          paragraphFromNode(paragraph, context, {
            listParagraph: true,
            ...(paragraphIndex === 0 ? { numbering: { reference, level: 0 } } : {}),
          }),
        ),
      );
    }
    case "ordered-list": {
      const reference = context.orderedListReferences.get(node.id);
      if (!reference) throw new Error("编号列表定义丢失。");
      return node.items.flatMap((item) =>
        item.content.map((paragraph, paragraphIndex) =>
          paragraphFromNode(paragraph, context, {
            listParagraph: true,
            ...(paragraphIndex === 0 ? { numbering: { reference, level: 0 } } : {}),
          }),
        ),
      );
    }
    case "page-break":
      return [new Paragraph({ children: [new PageBreak()] })];
    case "figure":
      return mapFigure(node, context);
    case "table": {
      const annotations = visibleTableAnnotations(node, context.tableNameNumbers?.get(node.id));
      const font = node.rows[0]?.cells[0]?.content[0]?.attrs;
      const width = resolveTableColumnWidthsMm(node, context.contentWidthMm).reduce(
        (a, b) => a + b,
        0,
      );
      const available = Math.max(0, context.contentWidthMm - width);
      const left =
        node.tableAlignment === "center"
          ? available / 2
          : node.tableAlignment === "right"
            ? available
            : 0;
      const annotationParagraph = (text: string, name: boolean) =>
        new Paragraph({
          alignment: name ? AlignmentType.CENTER : AlignmentType.LEFT,
          indent: {
            left: millimetresToTwips(left),
            right: millimetresToTwips(available - left),
            firstLine: 0,
          },
          keepNext: name,
          keepLines: true,
          spacing: {
            before: name ? 0 : millimetresToTwips(2),
            after: name ? millimetresToTwips(2) : 0,
            line: 360,
          },
          children: text.split("\n").map(
            (line, index) =>
              new TextRun({
                text: line,
                ...(index ? { break: 1 } : {}),
                bold: name,
                font:
                  docxDocumentFont(font?.defaultFontFamily ?? "SimSun", process.platform) ??
                  DEFAULT_FONT,
                size: pointsToHalfPoints(TABLE_ANNOTATION_FONT_SIZE_PT),
              }),
          ),
        });
      const table = mapTable(node, context);
      return [
        ...(annotations.name ? [annotationParagraph(annotations.name, true)] : []),
        table,
        ...(annotations.note ? [annotationParagraph(annotations.note, false)] : []),
      ];
    }
    case "block-formula": {
      const formula = context.formulaExports.get(node);
      if (!formula) throw new Error("公式导出结果丢失。");
      return [
        new Paragraph({
          alignment: node.alignment ?? AlignmentType.CENTER,
          children: [
            formula.kind === "native" ? formula.math : formulaImageRun(formula.image, context),
          ],
        }),
      ];
    }
    case "chemical-structure": {
      const asset = context.chemicalStructureAssets.get(node);
      if (!asset) {
        addMissingChemicalStructureAssetIssue(context.issues, node);
        return [];
      }
      const maxWidthMm = Math.min(node.widthMm, context.contentWidthMm);
      const maxHeightMm = context.contentHeightMm;
      const aspectRatio = asset.heightPx / asset.widthPx;
      let widthMm = maxWidthMm;
      let heightMm = widthMm * aspectRatio;
      if (heightMm > maxHeightMm) {
        heightMm = maxHeightMm;
        widthMm = heightMm / aspectRatio;
      }
      const image = new PreparedMediaImageRun(
        getPreparedImageMedia(
          `chemical-preview:${node.previewAssetId}`,
          asset,
          millimetresToPixels(widthMm),
          millimetresToPixels(heightMm),
          context,
        ),
        asset.originalName,
        context.nextDrawingId,
      );
      context.nextDrawingId += 1;
      return [new Paragraph({ alignment: alignment(node.alignment), children: [image] })];
    }
  }
}

export async function prepareFormulaExports(
  document: Pick<CanonicalDocument, "content">,
  issues: ExportIssue[],
): Promise<ReadonlyMap<FormulaNode, FormulaExport>> {
  const formulas = new Map<FormulaNode, FormulaExport>();
  const renderCache = new Map<string, Promise<FormulaExport>>();
  const prepareFormula = async (
    node: FormulaNode,
    nodeId: string,
    inheritedSize = 14,
  ): Promise<void> => {
    try {
      const fontSizePt = node.fontSizePt ?? inheritedSize;
      const cacheKey = `${node.formulaKind}\u0000${node.source}\u0000${fontSizePt}\u0000${node.color ?? ""}`;
      let pending = renderCache.get(cacheKey);
      if (!pending) {
        pending = exportFormula(node.source, nodeId, node.formulaKind, fontSizePt, node.color);
        renderCache.set(cacheKey, pending);
      }
      const cached = await pending;
      const result: FormulaExport =
        cached.kind === "native"
          ? cached
          : {
              ...cached,
              issues: [{ ...cached.issues[0], nodeId }],
            };
      formulas.set(node, result);
      for (const issue of result.issues) addIssue(issues, issue);
    } catch {
      addIssue(issues, {
        severity: "error",
        code: "EXPORT_FAILED",
        nodeId,
        message: "公式无法导出。",
      });
    }
  };
  const prepareInline = async (
    nodes: InlineNode[],
    nodeId: string,
    fontSizePt: number,
  ): Promise<void> => {
    for (const node of nodes) {
      if (node.type !== "inline-formula") continue;
      await prepareFormula(node, nodeId, fontSizePt);
    }
  };
  const prepareParagraph = async (paragraph: ParagraphNode | HeadingNode): Promise<void> => {
    const defaultSize = paragraph.attrs.defaultFontSizePt;
    const inheritedSize = effectiveParagraphFontSizePt(
      defaultSize,
      paragraph.content
        .filter((node) => node.type === "text")
        .map(
          (node) => node.marks.find((mark) => mark.type === "font-size")?.valuePt ?? defaultSize,
        ),
    );
    await prepareInline(paragraph.content, paragraph.id, inheritedSize);
  };

  for (const node of document.content) {
    if (node.type === "paragraph" || node.type === "heading") {
      await prepareParagraph(node);
    } else if (node.type === "bullet-list" || node.type === "ordered-list") {
      for (const item of node.items) {
        for (const paragraph of item.content) await prepareParagraph(paragraph);
      }
    } else if (node.type === "table") {
      for (const row of node.rows) {
        for (const cell of row.cells) {
          for (const paragraph of cell.content) await prepareParagraph(paragraph);
        }
      }
    } else if (node.type === "block-formula") {
      await prepareFormula(node, node.id);
    }
  }
  return formulas;
}

export function orderedNumbering(document: Pick<CanonicalDocument, "content">) {
  const references = new Map<string, string>();
  const config: INumberingOptions["config"][number][] = [];
  for (const node of document.content) {
    if (node.type !== "ordered-list" && node.type !== "bullet-list") continue;
    const ordered = node.type === "ordered-list";
    const reference = `patent-${ordered ? "decimal" : "bullet"}-${node.id}`;
    references.set(node.id, reference);
    config.push({
      reference,
      levels: [
        {
          level: 0,
          format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: ordered ? "%1." : "•",
          ...(ordered ? { start: node.start } : {}),
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: { indent: { left: LIST_TEXT_INDENT_TWIPS, hanging: LIST_HANGING_TWIPS } },
          },
        },
      ],
    });
  }
  return { config, references };
}

export async function createDocxPackage(
  request: DocxPackageRequest,
  assetStore: AssetStore,
): Promise<DocxPackage> {
  for (const id of referencedDocumentAssetIds(request.document)) {
    await assetStore.descriptorOrLoad(request.sessionId, id);
  }
  const document = {
    ...request.document,
    content: request.document.content.map((node) =>
      node.type === "table" ? normalizeTableColumnWidths(node) : node,
    ),
  };
  const issues: ExportIssue[] = [];
  for (const node of document.content) {
    if (node.type === "table") issues.push(...validateTable(node, pageBodyWidthMm(document.page)));
  }
  if (issues.some((issue) => issue.severity === "error")) throw new DocxExportError(issues);
  const chemicalStructureAssets = await prepareChemicalStructureAssets(
    document,
    assetStore,
    request.sessionId,
    issues,
    Math.max(1, document.page.widthMm - document.page.marginLeftMm - document.page.marginRightMm),
    Math.max(1, document.page.heightMm - document.page.marginTopMm - document.page.marginBottomMm),
  );
  if (issues.some((issue) => issue.severity === "error")) throw new DocxExportError(issues);
  const formulaExports = await prepareFormulaExports(document, issues);
  if (issues.some((issue) => issue.severity === "error")) throw new DocxExportError(issues);
  const numbering = orderedNumbering(document);
  const assetCache: MappingContext["assetCache"] = new Map();
  const context: MappingContext = {
    tableNameNumbers: tableNameNumbers(document.content),
    sessionId: request.sessionId,
    assetStore,
    assetCache,
    preparedAssetMediaCache: await prepareFigureImageMedia(
      document.content,
      assetStore,
      request.sessionId,
      assetCache,
    ),
    preparedFormulaMediaCache: new WeakMap(),
    formulaExports,
    chemicalStructureAssets,
    nextDrawingId: 1,
    contentWidthMm: Math.max(
      1,
      document.page.widthMm - document.page.marginLeftMm - document.page.marginRightMm,
    ),
    contentHeightMm: Math.max(
      1,
      document.page.heightMm - document.page.marginTopMm - document.page.marginBottomMm,
    ),
    issues,
    embeddedMediaTypes: new Set(),
    orderedListReferences: numbering.references,
  };
  const children = document.content.flatMap((node) => mapBlockNode(node, context));
  if (issues.some((issue) => issue.severity === "error")) throw new DocxExportError(issues);

  const docx = new Document({
    title: document.title,
    styles: {
      paragraphStyles: DOCX_LIST_PARAGRAPH_STYLES,
      default: {
        ...DOCX_HEADING_STYLES,
        document: {
          run: {
            font: fontAttributes(DEFAULT_FONT),
            size: pointsToHalfPoints(DEFAULT_FONT_SIZE_PT),
          },
        },
      },
    },
    numbering: { config: numbering.config },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: millimetresToTwips(document.page.widthMm),
              height: millimetresToTwips(document.page.heightMm),
              orientation: PageOrientation.PORTRAIT,
            },
            margin: {
              top: millimetresToTwips(document.page.marginTopMm),
              right: millimetresToTwips(document.page.marginRightMm),
              bottom: millimetresToTwips(document.page.marginBottomMm),
              left: millimetresToTwips(document.page.marginLeftMm),
            },
          },
        },
        children,
      },
    ],
  });
  let buffer = await Packer.toBuffer(docx);
  if (context.embeddedMediaTypes.has("image/tiff")) {
    const contentTypes = (await readDocxEntry(buffer, "[Content_Types].xml")).toString("utf8");
    const withTiffContentTypes = contentTypes.replace(
      "</Types>",
      '<Default Extension="tif" ContentType="image/tiff"/><Default Extension="tiff" ContentType="image/tiff"/></Types>',
    );
    buffer = await Packer.toBuffer(docx, false, [
      { path: "[Content_Types].xml", data: withTiffContentTypes },
    ]);
  }
  return { buffer, issues };
}

function readDocxEntry(buffer: Buffer, entryName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error("DOCX 文件无法打开。"));
        return;
      }
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        if (entry.fileName !== entryName) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`DOCX 文件缺少 ${entryName}。`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => resolve(Buffer.concat(chunks)));
        });
      });
      zip.on("end", () => reject(new Error(`DOCX 文件缺少 ${entryName}。`)));
      zip.readEntry();
    });
  });
}

function openDocx(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("DOCX 文件无法打开。"));
      else resolve(zip);
    });
  });
}

async function verifyDocx(path: string): Promise<void> {
  const zip = await openDocx(path);
  await new Promise<void>((resolve, reject) => {
    let hasDocumentXml = false;
    zip.on("error", reject);
    zip.on("entry", (entry) => {
      if (entry.fileName === "word/document.xml") hasDocumentXml = true;
      zip.readEntry();
    });
    zip.on("end", () => {
      if (hasDocumentXml) resolve();
      else reject(new Error("DOCX 文件缺少 word/document.xml。"));
    });
    zip.readEntry();
  });
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function saveDocxToPath(
  outputPath: string,
  request: DocxPackageRequest,
  assetStore: AssetStore,
): Promise<ExportReport> {
  const packageResult = await createDocxPackage(request, assetStore);
  if (packageResult.issues.some((issue) => issue.severity === "error")) {
    throw new DocxExportError(packageResult.issues);
  }

  const directory = dirname(outputPath);
  const temporaryPath = join(directory, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, packageResult.buffer, { flag: "wx" });
    await verifyDocx(temporaryPath);
    await writeExportFile(outputPath, packageResult.buffer);
    return { format: "docx", outputPath, issues: packageResult.issues };
  } catch (error) {
    if (error instanceof DocxExportError) throw error;
    throw new DocxExportError([
      {
        severity: "error",
        code: "EXPORT_FAILED",
        nodeId: null,
        message: error instanceof Error ? error.message : "DOCX 导出失败。",
      },
    ]);
  } finally {
    await removeIfPresent(temporaryPath).catch(() => undefined);
  }
}
