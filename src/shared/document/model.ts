import { z } from "zod";
import { tableGridColumnCount } from "./table-column-widths.js";

export const MAX_DOCUMENT_NODES = 200_000;
export const MAX_TEXT_NODE_CODE_UNITS = 1_000_000;
export const MAX_KET_SOURCE_BYTES = 5 * 1024 * 1024;

export const SemanticRoleSchema = z.enum([
  "invention-title",
  "description-technical-field",
  "description-background",
  "description-summary",
  "description-technical-problem",
  "description-technical-solution",
  "description-beneficial-effects",
  "description-drawings",
  "description-embodiments",
  "claim",
  "abstract",
  "description-drawing",
  "abstract-drawing",
  "description-drawing-explanation",
]);
export type SemanticRole = z.infer<typeof SemanticRoleSchema>;

export const PageSettingsSchema = z
  .object({
    widthMm: z.number().positive().max(1_000),
    heightMm: z.number().positive().max(1_000),
    marginTopMm: z.number().nonnegative().max(200),
    marginRightMm: z.number().nonnegative().max(200),
    marginBottomMm: z.number().nonnegative().max(200),
    marginLeftMm: z.number().nonnegative().max(200),
  })
  .strict();
export type PageSettings = z.infer<typeof PageSettingsSchema>;

const BoldMarkSchema = z.object({ type: z.literal("bold") }).strict();
const ItalicMarkSchema = z.object({ type: z.literal("italic") }).strict();
const UnderlineMarkSchema = z.object({ type: z.literal("underline") }).strict();
const ClaimReferenceReviewMarkSchema = z
  .object({ type: z.literal("claim-reference-review") })
  .strict();
const ReferenceMarkTokenSchema = z
  .object({
    type: z.literal("reference-mark-token"),
    number: z.number().int().positive(),
  })
  .strict();
const SuperscriptMarkSchema = z.object({ type: z.literal("superscript") }).strict();
const SubscriptMarkSchema = z.object({ type: z.literal("subscript") }).strict();
const FontFamilyMarkSchema = z
  .object({ type: z.literal("font-family"), value: z.string().min(1).max(100) })
  .strict();
const FontSizeMarkSchema = z
  .object({ type: z.literal("font-size"), valuePt: z.number().positive().max(200) })
  .strict();
const ColorMarkSchema = z
  .object({ type: z.literal("color"), value: z.string().regex(/^#[0-9A-F]{6}$/u) })
  .strict();
const BackgroundColorMarkSchema = z
  .object({ type: z.literal("background-color"), value: z.string().regex(/^#[0-9A-F]{6}$/u) })
  .strict();

export const TextMarkSchema = z.discriminatedUnion("type", [
  BoldMarkSchema,
  ItalicMarkSchema,
  UnderlineMarkSchema,
  ClaimReferenceReviewMarkSchema,
  ReferenceMarkTokenSchema,
  SuperscriptMarkSchema,
  SubscriptMarkSchema,
  FontFamilyMarkSchema,
  FontSizeMarkSchema,
  ColorMarkSchema,
  BackgroundColorMarkSchema,
]);
export type TextMark = z.infer<typeof TextMarkSchema>;

export const TextNodeSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().max(MAX_TEXT_NODE_CODE_UNITS),
    marks: z.array(TextMarkSchema).max(16),
  })
  .strict();
export type TextNode = z.infer<typeof TextNodeSchema>;

export const HardBreakNodeSchema = z.object({ type: z.literal("hard-break") }).strict();
export const FormulaKindSchema = z.enum(["math", "chemistry"]);
export type FormulaKind = z.infer<typeof FormulaKindSchema>;

export const ImageRotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);
export type ImageRotation = z.infer<typeof ImageRotationSchema>;

const FigureContentShape = {
  id: z.string().uuid(),
  assetId: z.string().uuid(),
  widthMm: z.number().min(10).max(165),
  alignment: z.enum(["left", "center", "right"]),
  rotationDeg: ImageRotationSchema.optional(),
};

export const InlineFormulaNodeSchema = z
  .object({
    type: z.literal("inline-formula"),
    fontSizePt: z.number().finite().min(8).max(72).optional(),
    color: z
      .string()
      .regex(/^#[0-9A-F]{6}$/u)
      .optional(),
    source: z
      .string()
      .max(100_000)
      .refine((value) => value.trim().length > 0, "公式源码不能为空"),
    formulaKind: FormulaKindSchema.default("math"),
  })
  .strict();

export const InlineFigureNodeSchema = z
  .object({
    ...FigureContentShape,
    type: z.literal("inline-figure"),
  })
  .strict();
export type InlineFigureNode = z.infer<typeof InlineFigureNodeSchema>;

export const InlineNodeSchema = z.discriminatedUnion("type", [
  TextNodeSchema,
  HardBreakNodeSchema,
  InlineFormulaNodeSchema,
  InlineFigureNodeSchema,
]);
export type InlineNode = z.infer<typeof InlineNodeSchema>;

export const ParagraphAttributesSchema = z
  .object({
    alignment: z.enum(["left", "center", "right", "justify"]),
    paragraphIndentMm: z.number().min(0).max(80),
    lineSpacing: z.number().min(1).max(3),
    spaceBeforePt: z.number().finite().min(0).max(200).optional(),
    spaceAfterPt: z.number().finite().min(0).max(200).optional(),
    defaultFontFamily: z.string().min(1).max(100),
    defaultFontSizePt: z.number().positive().max(200),
  })
  .strict();
export type ParagraphAttributes = z.infer<typeof ParagraphAttributesSchema>;

const BlockIdentityShape = {
  id: z.string().uuid(),
  semanticRole: SemanticRoleSchema.optional(),
};

export const ParagraphNodeSchema = z
  .object({
    ...BlockIdentityShape,
    type: z.literal("paragraph"),
    figureId: z.string().uuid().optional(),
    attrs: ParagraphAttributesSchema,
    content: z.array(InlineNodeSchema).max(MAX_DOCUMENT_NODES),
  })
  .strict()
  .superRefine((paragraph, ctx) => {
    if (paragraph.semanticRole === "description-drawing-explanation") {
      if (!paragraph.figureId) {
        ctx.addIssue({
          code: "custom",
          message: "附图说明段落必须关联附图编号。",
          path: ["figureId"],
        });
      }
      return;
    }

    if (paragraph.figureId) {
      ctx.addIssue({
        code: "custom",
        message: "只有附图说明段落可以关联附图编号。",
        path: ["figureId"],
      });
    }
  });
export type ParagraphNode = z.infer<typeof ParagraphNodeSchema>;

export const HeadingNodeSchema = z
  .object({
    ...BlockIdentityShape,
    type: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    attrs: ParagraphAttributesSchema,
    content: z.array(InlineNodeSchema).max(MAX_DOCUMENT_NODES),
  })
  .strict();
export type HeadingNode = z.infer<typeof HeadingNodeSchema>;

export const ListItemSchema = z
  .object({
    id: z.string().uuid(),
    content: z.array(ParagraphNodeSchema).min(1).max(MAX_DOCUMENT_NODES),
  })
  .strict();
export type ListItem = z.infer<typeof ListItemSchema>;

export const BulletListNodeSchema = z
  .object({
    ...BlockIdentityShape,
    type: z.literal("bullet-list"),
    items: z.array(ListItemSchema).min(1).max(MAX_DOCUMENT_NODES),
  })
  .strict();

export const OrderedListNodeSchema = z
  .object({
    ...BlockIdentityShape,
    type: z.literal("ordered-list"),
    start: z.number().int().min(1).max(1_000_000),
    items: z.array(ListItemSchema).min(1).max(MAX_DOCUMENT_NODES),
  })
  .strict();

export const PageBreakNodeSchema = z
  .object({ ...BlockIdentityShape, type: z.literal("page-break") })
  .strict();

export const FigureNodeSchema = z
  .object({
    ...FigureContentShape,
    semanticRole: z.enum(["description-drawing", "abstract-drawing"]).optional(),
    type: z.literal("figure"),
  })
  .strict();
export type FigureNode = z.infer<typeof FigureNodeSchema>;

const TableBorderStyleSchema = z.enum(["none", "single", "double"]);
const TableBorderEdgesSchema = z
  .object({
    top: TableBorderStyleSchema,
    right: TableBorderStyleSchema,
    bottom: TableBorderStyleSchema,
    left: TableBorderStyleSchema,
  })
  .strict();

export const TableCellSchema = z
  .object({
    id: z.string().uuid(),
    rowSpan: z.number().int().min(1).max(1_000),
    colSpan: z.number().int().min(1).max(1_000),
    horizontalAlignment: z.enum(["left", "center", "right"]),
    verticalAlignment: z.enum(["top", "middle", "bottom"]),
    borderStyle: TableBorderStyleSchema,
    borderEdges: TableBorderEdgesSchema.optional(),
    paddingMm: z
      .object({
        top: z.number().finite().min(0).max(20),
        right: z.number().finite().min(0).max(20),
        bottom: z.number().finite().min(0).max(20),
        left: z.number().finite().min(0).max(20),
      })
      .strict()
      .optional(),
    content: z.array(ParagraphNodeSchema).min(1).max(MAX_DOCUMENT_NODES),
  })
  .strict();
export type TableCell = z.infer<typeof TableCellSchema>;

export const TABLE_ROW_HEIGHT_MIN_MM = 3;
export const TABLE_ROW_HEIGHT_MAX_MM = 300;

export const TableRowSchema = z
  .object({
    id: z.string().uuid(),
    rowHeightMm: z
      .number()
      .finite()
      .min(TABLE_ROW_HEIGHT_MIN_MM)
      .max(TABLE_ROW_HEIGHT_MAX_MM)
      .optional(),
    rowHeightRule: z.enum(["at-least", "exact"]).optional(),
    // A row may be entirely covered by cells spanning down from an earlier row.
    cells: z.array(TableCellSchema).max(1_000),
  })
  .strict()
  .superRefine((row, context) => {
    if ((row.rowHeightMm === undefined) === (row.rowHeightRule === undefined)) return;
    context.addIssue({
      code: "custom",
      message: "表格行高和值规则必须同时设置。",
      path: row.rowHeightMm === undefined ? ["rowHeightMm"] : ["rowHeightRule"],
    });
  });
export type TableRow = z.infer<typeof TableRowSchema>;

export const TableNodeSchema = z
  .object({
    ...BlockIdentityShape,
    type: z.literal("table"),
    columnWidthsMm: z.array(z.number().positive().max(500)).min(1).max(1_000),
    headerRowCount: z.union([z.literal(0), z.literal(1)]).optional(),
    layoutMode: z.enum(["fit-page", "fixed"]).optional(),
    tableAlignment: z.enum(["left", "center", "right"]).optional(),
    tableNameEnabled: z.boolean().optional(),
    tableName: z.string().max(2_000).optional(),
    tableNoteEnabled: z.boolean().optional(),
    tableNote: z.string().max(10_000).optional(),
    rows: z.array(TableRowSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((table, context) => {
    if (table.rows.some((row) => row.cells.length === 0) && tableGridColumnCount(table) === null) {
      context.addIssue({
        code: "custom",
        message: "空表格行必须由上方跨行单元格完整覆盖。",
        path: ["rows"],
      });
    }
  });
export type TableNode = z.infer<typeof TableNodeSchema>;

export const BlockFormulaNodeSchema = z
  .object({
    ...BlockIdentityShape,
    type: z.literal("block-formula"),
    fontSizePt: z.number().finite().min(8).max(72).optional(),
    color: z
      .string()
      .regex(/^#[0-9A-F]{6}$/u)
      .optional(),
    source: z
      .string()
      .max(100_000)
      .refine((value) => value.trim().length > 0, "公式源码不能为空"),
    formulaKind: FormulaKindSchema.default("math"),
    alignment: z.enum(["left", "center", "right"]).optional(),
  })
  .strict();
export type BlockFormulaNode = z.infer<typeof BlockFormulaNodeSchema>;

export const ChemicalEditorModeSchema = z.enum(["molecule", "macromolecule"]);
export type ChemicalEditorMode = z.infer<typeof ChemicalEditorModeSchema>;

export const ChemicalStructureNodeSchema = z
  .object({
    id: z.string().uuid(),
    type: z.literal("chemical-structure"),
    ketSource: z
      .string()
      .refine((value) => value.trim().length > 0, "KET 源码不能为空")
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= MAX_KET_SOURCE_BYTES,
        `KET 源码不能超过 ${MAX_KET_SOURCE_BYTES} 字节`,
      ),
    editorMode: ChemicalEditorModeSchema.optional(),
    previewAssetId: z.string().uuid(),
    widthMm: z.number().min(10).max(165),
    alignment: z.enum(["left", "center", "right"]),
  })
  .strict();
export type ChemicalStructureNode = z.infer<typeof ChemicalStructureNodeSchema>;

export const BlockNodeSchema = z.discriminatedUnion("type", [
  ParagraphNodeSchema,
  HeadingNodeSchema,
  BulletListNodeSchema,
  OrderedListNodeSchema,
  PageBreakNodeSchema,
  FigureNodeSchema,
  TableNodeSchema,
  BlockFormulaNodeSchema,
  ChemicalStructureNodeSchema,
]);
export type BlockNode = z.infer<typeof BlockNodeSchema>;

export const ImageAssetDescriptorSchema = z
  .object({
    assetId: z.string().uuid(),
    kind: z.literal("image"),
    originalName: z.string().min(1).max(255),
    mediaType: z.enum(["image/png", "image/jpeg", "image/bmp", "image/tiff"]),
    extension: z.enum(["png", "jpg", "jpeg", "bmp", "tif", "tiff"]),
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024 * 1024),
    sha256: z.string().regex(/^[0-9A-F]{64}$/u),
    widthPx: z.number().int().positive().max(100_000),
    heightPx: z.number().int().positive().max(100_000),
    previewByteLength: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024 * 1024),
    previewSha256: z.string().regex(/^[0-9A-F]{64}$/u),
  })
  .strict();
export type ImageAssetDescriptor = z.infer<typeof ImageAssetDescriptorSchema>;

export const ChemicalPreviewAssetDescriptorSchema = z
  .object({
    assetId: z.string().uuid(),
    kind: z.literal("chemical-preview"),
    originalName: z.string().min(1).max(255),
    mediaType: z.literal("image/svg+xml"),
    extension: z.literal("svg"),
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024 * 1024),
    sha256: z.string().regex(/^[0-9A-F]{64}$/u),
    widthPx: z.number().int().positive().max(100_000),
    heightPx: z.number().int().positive().max(100_000),
    previewByteLength: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024 * 1024),
    previewSha256: z.string().regex(/^[0-9A-F]{64}$/u),
  })
  .strict();
export type ChemicalPreviewAssetDescriptor = z.infer<typeof ChemicalPreviewAssetDescriptorSchema>;

export const FlowchartPreviewAssetDescriptorSchema = ChemicalPreviewAssetDescriptorSchema.extend({
  kind: z.literal("flowchart-preview"),
}).strict();
export type FlowchartPreviewAssetDescriptor = z.infer<typeof FlowchartPreviewAssetDescriptorSchema>;

export const VectorImageAssetDescriptorSchema = z
  .object({
    assetId: z.string().uuid(),
    kind: z.literal("vector-image"),
    originalName: z.string().min(1).max(255),
    mediaType: z.literal("image/svg+xml"),
    extension: z.literal("svg"),
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024 * 1024),
    sha256: z.string().regex(/^[0-9A-F]{64}$/u),
    widthPx: z.number().int().positive().max(100_000),
    heightPx: z.number().int().positive().max(100_000),
    previewByteLength: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024 * 1024),
    previewSha256: z.string().regex(/^[0-9A-F]{64}$/u),
  })
  .strict();
export type VectorImageAssetDescriptor = z.infer<typeof VectorImageAssetDescriptorSchema>;

export const DrawingSourceAssetDescriptorSchema = ImageAssetDescriptorSchema.extend({
  kind: z.literal("drawing-source"),
  mediaType: z.enum(["application/pdf", "image/vnd.dwg", "image/vnd.dxf"]),
  extension: z.enum(["pdf", "dwg", "dxf"]),
}).strict();

export const DrawingTilesAssetDescriptorSchema = VectorImageAssetDescriptorSchema.extend({
  kind: z.literal("drawing-tiles"),
  mediaType: z.literal("application/vnd.zxw.cad-tiles+zip"),
  extension: z.literal("cadtiles"),
  byteLength: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 * 1024),
}).strict();

const CurrentAssetDescriptorSchema = z.discriminatedUnion("kind", [
  DrawingSourceAssetDescriptorSchema,
  DrawingTilesAssetDescriptorSchema,
  ImageAssetDescriptorSchema,
  ChemicalPreviewAssetDescriptorSchema,
  FlowchartPreviewAssetDescriptorSchema,
  VectorImageAssetDescriptorSchema,
]);
export const AssetDescriptorSchema = z.preprocess((input) => {
  if (
    typeof input === "object" &&
    input !== null &&
    "kind" in input &&
    input.kind === "scientific-chart-preview"
  ) {
    return { ...input, kind: "vector-image" };
  }
  return input;
}, CurrentAssetDescriptorSchema);
export type AssetDescriptor = z.infer<typeof AssetDescriptorSchema>;

export const CANONICAL_DOCUMENT_FORMAT_VERSION = 4 as const;

export const CanonicalDocumentSchema = z
  .object({
    formatVersion: z.literal(CANONICAL_DOCUMENT_FORMAT_VERSION),
    documentId: z.string().uuid(),
    title: z.string().min(1).max(500),
    patentType: z.enum(["invention", "utility-model"]).nullable(),
    createdAt: z.string().datetime(),
    modifiedAt: z.string().datetime(),
    page: PageSettingsSchema,
    content: z.array(BlockNodeSchema).max(MAX_DOCUMENT_NODES),
    assets: z.array(AssetDescriptorSchema).max(100_000),
  })
  .strict();

export type CanonicalDocument = z.infer<typeof CanonicalDocumentSchema>;

type Version1ContentScan = "compatible" | "version-2-content" | "malformed";

/** Scan only known document-content edges so hostile object graphs cannot recurse indefinitely. */
function scanVersion1DocumentContent(value: unknown): Version1ContentScan {
  if (typeof value !== "object" || value === null || !("content" in value)) return "compatible";
  const rootContent = (value as { content: unknown }).content;
  if (!Array.isArray(rootContent)) return "compatible";

  const pending: unknown[] = [];
  for (const node of rootContent) pending.push(node);
  const seen = new WeakSet<object>();
  let visited = 0;

  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null) continue;
    if (seen.has(node)) return "malformed";
    seen.add(node);
    visited += 1;
    if (visited > MAX_DOCUMENT_NODES) return "malformed";

    const record = node as Record<string, unknown>;
    if (record.type === "chemical-structure") return "version-2-content";
    if (
      (record.type === "inline-formula" || record.type === "block-formula") &&
      "formulaKind" in record
    ) {
      return "version-2-content";
    }

    switch (record.type) {
      case "paragraph":
      case "heading":
        if (Array.isArray(record.content)) {
          for (const inline of record.content) pending.push(inline);
        }
        break;
      case "bullet-list":
      case "ordered-list":
        if (Array.isArray(record.items)) {
          for (const item of record.items) {
            if (typeof item !== "object" || item === null || !("content" in item)) continue;
            const paragraphs = (item as { content: unknown }).content;
            if (Array.isArray(paragraphs)) {
              for (const paragraph of paragraphs) pending.push(paragraph);
            }
          }
        }
        break;
      case "table":
        if (Array.isArray(record.rows)) {
          for (const row of record.rows) {
            if (typeof row !== "object" || row === null || !("cells" in row)) continue;
            const cells = (row as { cells: unknown }).cells;
            if (!Array.isArray(cells)) continue;
            for (const cell of cells) {
              if (typeof cell !== "object" || cell === null || !("content" in cell)) continue;
              const paragraphs = (cell as { content: unknown }).content;
              if (Array.isArray(paragraphs)) {
                for (const paragraph of paragraphs) pending.push(paragraph);
              }
            }
          }
        }
        break;
    }
  }

  return "compatible";
}

const Version1DocumentContentSchema = z.unknown().superRefine((value, ctx) => {
  const scan = scanVersion1DocumentContent(value);
  if (scan === "version-2-content") {
    ctx.addIssue({ code: "custom", message: "版本 1 文档不能包含版本 2 内容。" });
  } else if (scan === "malformed") {
    ctx.addIssue({ code: "custom", message: "版本 1 文档内容结构无效。" });
  }
});

export const CanonicalDocumentV1Schema = Version1DocumentContentSchema.pipe(
  CanonicalDocumentSchema.extend({
    formatVersion: z.literal(1),
  }),
);
export type CanonicalDocumentV1 = z.infer<typeof CanonicalDocumentV1Schema>;

export const PatentBookDocumentSchema = CanonicalDocumentSchema.omit({
  patentType: true,
  assets: true,
});

export type PatentBookDocument = z.infer<typeof PatentBookDocumentSchema>;

export const PatentBookDocumentV1Schema = Version1DocumentContentSchema.pipe(
  PatentBookDocumentSchema.extend({
    formatVersion: z.literal(1),
  }),
);
export type PatentBookDocumentV1 = z.infer<typeof PatentBookDocumentV1Schema>;
