import { z } from "zod";
import {
  AssetDescriptorSchema,
  type BlockNode,
  ImageRotationSchema,
  type ParagraphNode,
  type PatentBookDocument,
  PatentBookDocumentSchema,
} from "../document/model.js";
import { drawingAssetIds } from "../drawing-markup/cad-state.js";
import { DrawingProjectsSchema } from "../drawing-markup/model.js";
import {
  FlowchartFigureLinkSchema,
  FlowchartProjectDescriptorSchema,
} from "../flowcharts/model.js";
import { JsonObjectSchema } from "../ipc/primitives.js";
import { DesignPatentSchema } from "./design-patent.js";
import { PatentReferenceMarkSchema, PatentReferenceMarkSettingsSchema } from "./reference-marks.js";

export const PatentTypeSchema = z.enum(["invention", "utility-model", "design"]);
export type PatentType = z.infer<typeof PatentTypeSchema>;

export const PatentBookKindSchema = z.enum([
  "claims",
  "description",
  "description-drawings",
  "abstract",
  "abstract-drawing",
]);
export type PatentBookKind = z.infer<typeof PatentBookKindSchema>;

export const PATENT_BOOK_ORDER = [
  "claims",
  "description",
  "description-drawings",
  "abstract",
  "abstract-drawing",
] as const satisfies readonly PatentBookKind[];

export const DRAWING_BOOK_KINDS = [
  "description-drawings",
  "abstract-drawing",
] as const satisfies readonly PatentBookKind[];

export function isPatentBookAvailable(
  patent: Pick<CanonicalPatent, "drawingBooksEnabled" | "patentType">,
  kind: PatentBookKind,
): boolean {
  if (patent.patentType === "design") return false;
  return (
    patent.drawingBooksEnabled ||
    !DRAWING_BOOK_KINDS.includes(kind as (typeof DRAWING_BOOK_KINDS)[number])
  );
}

export function availablePatentBookKinds(
  patent: Pick<CanonicalPatent, "drawingBooksEnabled" | "patentType">,
): PatentBookKind[] {
  return PATENT_BOOK_ORDER.filter((kind) => isPatentBookAvailable(patent, kind));
}

export const PATENT_BOOK_LABELS: Readonly<Record<PatentBookKind, string>> = {
  claims: "权利要求书",
  description: "说明书",
  "description-drawings": "说明书附图",
  abstract: "说明书摘要",
  "abstract-drawing": "摘要附图",
};

export const MIN_PATENT_FIGURE_WIDTH_MM = 10;
export const DEFAULT_PATENT_FIGURE_WIDTH_MM = 80;
export const MAX_PATENT_FIGURE_WIDTH_MM = 165;
/** 新建和编辑入口的元数据上限；旧库中已有的更长值仍须可读取。 */
export const PATENT_NAME_MAX_LENGTH = 100;
export const PATENT_CUSTOMER_MAX_LENGTH = 100;

const CurrentPatentFigureSchema = z
  .object({
    figureId: z.string().uuid(),
    assetId: z.string().uuid(),
    widthMm: z.number().min(MIN_PATENT_FIGURE_WIDTH_MM).max(MAX_PATENT_FIGURE_WIDTH_MM),
    rotationDeg: ImageRotationSchema.optional(),
    flowchartLink: FlowchartFigureLinkSchema.optional(),
  })
  .strict();
export const PatentFigureSchema = z.preprocess((input) => {
  if (typeof input !== "object" || input === null) return input;
  const { scientificChartLink: _retiredLink, ...figure } = input as Record<string, unknown>;
  return figure;
}, CurrentPatentFigureSchema);
export type PatentFigure = z.infer<typeof PatentFigureSchema>;

export const PatentBookSchema = z
  .object({
    bookId: z.string().uuid(),
    kind: PatentBookKindSchema,
    document: PatentBookDocumentSchema,
    editorState: JsonObjectSchema,
    localRevision: z.number().int().nonnegative(),
    persistedRevision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((book, ctx) => {
    if (book.document.title !== PATENT_BOOK_LABELS[book.kind]) {
      ctx.addIssue({
        code: "custom",
        message: "五书文档标题必须匹配固定书册标签",
        path: ["document", "title"],
      });
    }
  });
export type PatentBook = z.infer<typeof PatentBookSchema>;

const SafeImportedFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(260)
  .refine((value) => !/[\\/\0]/u.test(value), "导入来源只能保存文件名");

export const AuxiliaryDocumentSchema = z
  .object({
    auxiliaryDocumentId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    document: PatentBookDocumentSchema,
    editorState: JsonObjectSchema,
    localRevision: z.number().int().nonnegative(),
    persistedRevision: z.number().int().nonnegative(),
    sourceFileName: SafeImportedFileNameSchema.nullable(),
  })
  .strict()
  .superRefine((document, ctx) => {
    if (document.document.title !== document.title) {
      ctx.addIssue({
        code: "custom",
        message: "其他文档标题必须与正文标题一致",
        path: ["document", "title"],
      });
    }
  });
export type AuxiliaryDocument = z.infer<typeof AuxiliaryDocumentSchema>;

export const DocxImportAssignmentSchema = z
  .object({
    unitId: z.string().uuid(),
    sourceFileName: SafeImportedFileNameSchema,
    title: z.string().trim().min(1).max(200),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("official-book"), bookKind: PatentBookKindSchema }).strict(),
      z.object({ kind: z.literal("auxiliary"), auxiliaryDocumentId: z.string().uuid() }).strict(),
    ]),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(z.string().trim().min(1).max(500)).max(50),
  })
  .strict();
export type DocxImportAssignment = z.infer<typeof DocxImportAssignmentSchema>;

export const DocxImportWarningSchema = z
  .object({
    warningId: z.string().uuid(),
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1_000),
    severity: z.enum(["information", "important"]),
  })
  .strict();
export type DocxImportWarning = z.infer<typeof DocxImportWarningSchema>;

export const DocxImportReportSchema = z
  .object({
    importedAt: z.string().datetime(),
    sourceFileNames: z.array(SafeImportedFileNameSchema).min(1).max(100),
    assignments: z.array(DocxImportAssignmentSchema).max(500),
    warnings: z.array(DocxImportWarningSchema).max(2_000),
  })
  .strict();
export type DocxImportReport = z.infer<typeof DocxImportReportSchema>;
export const CANONICAL_PATENT_FORMAT_VERSION = 12 as const;
export const TILED_PATENT_FORMAT_VERSION = 13 as const;
export const EDITABLE_CAD_PATENT_FORMAT_VERSION = 14 as const;
export const UNIFIED_CAD_PATENT_FORMAT_VERSION = 15 as const;

const CanonicalPatentObjectSchema = z
  .object({
    formatVersion: z.union([
      z.literal(CANONICAL_PATENT_FORMAT_VERSION),
      z.literal(TILED_PATENT_FORMAT_VERSION),
      z.literal(EDITABLE_CAD_PATENT_FORMAT_VERSION),
      z.literal(UNIFIED_CAD_PATENT_FORMAT_VERSION),
    ]),
    patentId: z.string().uuid(),
    name: z.string().trim().min(1).max(500).nullable(),
    customer: z.string().trim().max(200).nullable(),
    patentType: PatentTypeSchema,
    createdAt: z.string().datetime(),
    modifiedAt: z.string().datetime(),
    revision: z.number().int().nonnegative(),
    drawingBooksEnabled: z.boolean(),
    activeBookKind: PatentBookKindSchema,
    books: z.array(PatentBookSchema).length(PATENT_BOOK_ORDER.length),
    auxiliaryDocuments: z.array(AuxiliaryDocumentSchema).max(10_000).default([]),
    docxImportReport: DocxImportReportSchema.nullable().default(null),
    figures: z.array(PatentFigureSchema).max(100_000),
    flowchartProjects: z.array(FlowchartProjectDescriptorSchema).max(100_000).default([]),
    drawingProjects: DrawingProjectsSchema.default([]),
    abstractDrawingFigureId: z.string().uuid().nullable(),
    assets: z.array(AssetDescriptorSchema).max(100_000),

    referenceMarks: z.array(PatentReferenceMarkSchema).max(100_000),
    referenceMarkSettings: PatentReferenceMarkSettingsSchema,
    designPatent: DesignPatentSchema.nullable().default(null),
  })
  .strict();

type PatentShape = z.infer<typeof CanonicalPatentObjectSchema>;

function refinePatent(
  patent: PatentShape,
  ctx: z.RefinementCtx,
  trustedBooks: ReadonlySet<PatentBook> = new Set(),
  trustedAuxiliary: ReadonlySet<AuxiliaryDocument> = new Set(),
): void {
  const projectIds = new Set<string>();
  patent.drawingProjects.forEach((project, index) => {
    if (projectIds.has(project.projectId))
      ctx.addIssue({
        code: "custom",
        message: "图纸工作稿编号重复",
        path: ["drawingProjects", index, "projectId"],
      });
    projectIds.add(project.projectId);
    for (const assetId of drawingAssetIds(project)) {
      if (!patent.assets.some((asset) => asset.assetId === assetId))
        ctx.addIssue({
          code: "custom",
          message: "图纸工作稿源资源不存在",
          path: ["drawingProjects", index],
        });
    }
  });
  patent.figures.forEach((figure, index) => {
    const kind = patent.assets.find((asset) => asset.assetId === figure.assetId)?.kind;
    if (kind === "drawing-source" || kind === "drawing-tiles")
      ctx.addIssue({
        code: "custom",
        message: "原始图纸须成图后加入附图",
        path: ["figures", index, "assetId"],
      });
  });
  if (patent.patentType === "utility-model" && !patent.drawingBooksEnabled) {
    ctx.addIssue({
      code: "custom",
      message: "实用新型必须启用说明书附图和摘要附图",
      path: ["drawingBooksEnabled"],
    });
  }
  if (patent.patentType !== "design" && !isPatentBookAvailable(patent, patent.activeBookKind)) {
    ctx.addIssue({
      code: "custom",
      message: "当前书册不可用",
      path: ["activeBookKind"],
    });
  }
  if ((patent.patentType === "design") !== (patent.designPatent !== null)) {
    ctx.addIssue({
      code: "custom",
      message: "专利类型与外观设计工作台数据不一致",
      path: ["designPatent"],
    });
  }
  patent.books.forEach((book, index) => {
    if (book.kind !== PATENT_BOOK_ORDER[index]) {
      ctx.addIssue({
        code: "custom",
        message: "专利五书必须完整且按固定顺序排列",
        path: ["books", index, "kind"],
      });
    }
  });

  addDuplicateIssue(
    ctx,
    patent.books.map((book) => book.bookId),
    ["books"],
    "书册编号重复",
  );
  addDuplicateIssue(
    ctx,
    [
      ...patent.books.map((book) => book.document.documentId),
      ...patent.auxiliaryDocuments.map((document) => document.document.documentId),
    ],
    ["books"],
    "专利文档编号重复",
  );
  addDuplicateIssue(
    ctx,
    patent.auxiliaryDocuments.map((document) => document.auxiliaryDocumentId),
    ["auxiliaryDocuments"],
    "其他文档编号重复",
  );
  addDuplicateIssue(
    ctx,
    patent.figures.map((figure) => figure.figureId),
    ["figures"],
    "附图编号重复",
  );
  addDuplicateIssue(
    ctx,
    patent.flowchartProjects.map((project) => project.projectId),
    ["flowchartProjects"],
    "流程图工程编号重复",
  );
  addDuplicateIssue(
    ctx,
    patent.assets.map((asset) => asset.assetId),
    ["assets"],
    "资源编号重复",
  );
  addDuplicateIssue(
    ctx,
    patent.referenceMarks.map((mark) => mark.referenceMarkId),
    ["referenceMarks"],
    "附图标记编号重复",
  );
  addDuplicateIssue(
    ctx,
    patent.referenceMarks.map((mark) => mark.number),
    ["referenceMarks"],
    "附图标记序号重复",
  );
  addDuplicateIssue(
    ctx,
    patent.referenceMarks.map((mark) => mark.keyword),
    ["referenceMarks"],
    "附图标记关键词重复",
  );
  const assetIds = new Set(patent.assets.map((asset) => asset.assetId));
  const assetsById = new Map(patent.assets.map((asset) => [asset.assetId, asset]));
  patent.books.forEach((book, index) => {
    if (!trustedBooks.has(book)) validateBookContent(book, index, assetsById, ctx);
  });
  patent.auxiliaryDocuments.forEach((document, index) => {
    if (trustedAuxiliary.has(document)) return;
    validateDocumentContent(
      document.document.content,
      ["auxiliaryDocuments", index, "document", "content"],
      assetsById,
      ctx,
    );
  });

  patent.figures.forEach((figure, index) => {
    if (
      !assetIds.has(figure.assetId) ||
      assetsById.get(figure.assetId)?.kind === "design-editor-project"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "附图资源不存在",
        path: ["figures", index, "assetId"],
      });
    }
    if (
      figure.flowchartLink &&
      !patent.flowchartProjects.some(
        (project) => project.projectId === figure.flowchartLink?.projectId,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "附图关联的流程图工程不存在",
        path: ["figures", index, "flowchartLink", "projectId"],
      });
    }
  });

  patent.designPatent?.views.forEach((view, index) => {
    const path = ["designPatent", "views", index];
    const source = assetsById.get(view.assetId);
    if (!source || source.kind === "design-editor-project")
      ctx.addIssue({
        code: "custom",
        message: "外观设计视图资源不存在",
        path: [...path, "assetId"],
      });
    if (!view.editor) return;
    const { sourceAssetId, applied } = view.editor;
    if (sourceAssetId !== view.assetId)
      ctx.addIssue({
        code: "custom",
        message: "编辑工程来源与原图不一致",
        path: [...path, "editor", "sourceAssetId"],
      });
    for (const key of ["saved", "recovery", "applied"] as const) {
      const checkpoint = view.editor[key];
      if (checkpoint && assetsById.get(checkpoint.projectAssetId)?.kind !== "design-editor-project")
        ctx.addIssue({
          code: "custom",
          message: "分层编辑工程资产不存在或类型不正确",
          path: [...path, "editor", key, "projectAssetId"],
        });
    }
    if (applied) {
      const image = assetsById.get(applied.imageAssetId),
        project = assetsById.get(applied.projectAssetId);
      if (
        image?.kind !== "image" ||
        image.widthPx !== applied.widthPx ||
        image.heightPx !== applied.heightPx ||
        project?.kind !== "design-editor-project" ||
        project.widthPx !== applied.widthPx ||
        project.heightPx !== applied.heightPx
      )
        ctx.addIssue({
          code: "custom",
          message: "已应用图片与分层工程尺寸或资源不一致",
          path: [...path, "editor", "applied"],
        });
    }
  });
  if (
    patent.abstractDrawingFigureId !== null &&
    !patent.figures.some((figure) => figure.figureId === patent.abstractDrawingFigureId)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "摘要附图编号不存在",
      path: ["abstractDrawingFigureId"],
    });
  }
}

const CurrentCanonicalPatentSchema = CanonicalPatentObjectSchema.superRefine((patent, ctx) =>
  refinePatent(patent, ctx),
);

function normalizePatentVersion(input: unknown) {
  if (typeof input !== "object" || input === null) return input;
  const { scientificChartProjects: _retiredProjects, ...patent } = input as Record<string, unknown>;
  const legacyCadVersion = [
    CANONICAL_PATENT_FORMAT_VERSION,
    TILED_PATENT_FORMAT_VERSION,
    EDITABLE_CAD_PATENT_FORMAT_VERSION,
  ].some((version) => patent.formatVersion === version);
  const carriesUnifiedCad = (checkpoint?: {
    unified?: unknown;
    objects?: unknown;
    overlayAssetId?: unknown;
    backgroundSize?: unknown;
    semanticKey?: unknown;
  }) =>
    checkpoint?.unified !== undefined ||
    checkpoint?.objects !== undefined ||
    checkpoint?.overlayAssetId !== undefined ||
    checkpoint?.backgroundSize !== undefined ||
    checkpoint?.semanticKey !== undefined;
  if (
    legacyCadVersion &&
    Array.isArray(patent.drawingProjects) &&
    patent.drawingProjects.some(
      (project) =>
        carriesUnifiedCad(project?.cad) ||
        project?.detailViews?.some(
          (detail: { cadSource?: { unified?: unknown; objects?: unknown } }) =>
            carriesUnifiedCad(detail?.cadSource),
        ),
    )
  )
    return { ...patent, formatVersion: UNIFIED_CAD_PATENT_FORMAT_VERSION };
  if (
    legacyCadVersion &&
    ((Array.isArray(patent.drawingProjects) &&
      patent.drawingProjects.some(
        (project) =>
          project?.cad ||
          project?.detailViews?.some((detail: { cadSource?: unknown }) => detail?.cadSource),
      )) ||
      (Array.isArray(patent.assets) && patent.assets.some((asset) => asset?.extension === "dxf")))
  )
    return { ...patent, formatVersion: EDITABLE_CAD_PATENT_FORMAT_VERSION };
  if (
    patent.formatVersion === 12 &&
    Array.isArray(patent.assets) &&
    patent.assets.some((a) => a?.kind === "drawing-tiles")
  )
    return { ...patent, formatVersion: TILED_PATENT_FORMAT_VERSION };
  if (
    patent.formatVersion === 13 &&
    Array.isArray(patent.assets) &&
    !patent.assets.some((a) => a?.kind === "drawing-tiles")
  )
    return { ...patent, formatVersion: 12 };
  return patent;
}
export const CanonicalPatentSchema = z.preprocess(
  normalizePatentVersion,
  CurrentCanonicalPatentSchema,
);
export type CanonicalPatent = z.infer<typeof CanonicalPatentSchema>;

/** Internal incremental validation. Reuse only already validated, unchanged book objects.
 * The caller must keep these objects private and verify persisted bytes before reuse.
 * Any asset change invalidates all cross-document resource checks. */
export function parsePatentWithVerifiedBooks(
  input: unknown,
  verified: Pick<CanonicalPatent, "books" | "auxiliaryDocuments" | "assets">,
  verifiedDocuments: ReadonlySet<PatentBookDocument> = new Set(),
): CanonicalPatent {
  if (
    !input ||
    typeof input !== "object" ||
    !("assets" in input) ||
    JSON.stringify(input.assets) !== JSON.stringify(verified.assets)
  )
    return CanonicalPatentSchema.parse(input);
  const books = new Set(verified.books);
  const auxiliary = new Set(verified.auxiliaryDocuments);
  return CanonicalPatentObjectSchema.extend({
    books: z
      .array(
        z.union([
          z.custom<PatentBook>((value) => books.has(value as PatentBook)),
          PatentBookSchema.safeExtend({
            document: z.union([
              z.custom<PatentBookDocument>((value) =>
                verifiedDocuments.has(value as PatentBookDocument),
              ),
              PatentBookDocumentSchema,
            ]),
          }),
        ]),
      )
      .length(PATENT_BOOK_ORDER.length),
    auxiliaryDocuments: z
      .array(
        z.union([
          z.custom<AuxiliaryDocument>((value) => auxiliary.has(value as AuxiliaryDocument)),
          AuxiliaryDocumentSchema,
        ]),
      )
      .max(10_000),
  })
    .superRefine((patent, ctx) => refinePatent(patent, ctx, books, auxiliary))
    .parse(normalizePatentVersion(input));
}

function validateBookContent(
  book: PatentBook,
  bookIndex: number,
  assetsById: ReadonlyMap<string, z.infer<typeof AssetDescriptorSchema>>,
  ctx: z.RefinementCtx,
): void {
  validateDocumentContent(
    book.document.content,
    ["books", bookIndex, "document", "content"],
    assetsById,
    ctx,
  );
}

function validateDocumentContent(
  content: readonly BlockNode[],
  path: (string | number)[],
  assetsById: ReadonlyMap<string, z.infer<typeof AssetDescriptorSchema>>,
  ctx: z.RefinementCtx,
): void {
  const seenIds = new Set<string>();

  content.forEach((block, index) => {
    visitBlock(block, [...path, index], seenIds, assetsById, ctx);
  });
}

function visitBlock(
  block: BlockNode,
  path: (string | number)[],
  seenIds: Set<string>,
  assetsById: ReadonlyMap<string, z.infer<typeof AssetDescriptorSchema>>,
  ctx: z.RefinementCtx,
): void {
  addContentId(block.id, path, seenIds, ctx);

  switch (block.type) {
    case "paragraph":
    case "heading":
      visitInlineFigures(block.content, path, seenIds, assetsById, ctx);
      break;
    case "bullet-list":
    case "ordered-list":
      block.items.forEach((item, itemIndex) => {
        addContentId(item.id, [...path, "items", itemIndex], seenIds, ctx);
        item.content.forEach((paragraph, paragraphIndex) => {
          visitParagraph(
            paragraph,
            [...path, "items", itemIndex, "content", paragraphIndex],
            seenIds,
            assetsById,
            ctx,
          );
        });
      });
      break;
    case "table":
      block.rows.forEach((row, rowIndex) => {
        addContentId(row.id, [...path, "rows", rowIndex], seenIds, ctx);
        row.cells.forEach((cell, cellIndex) => {
          addContentId(cell.id, [...path, "rows", rowIndex, "cells", cellIndex], seenIds, ctx);
          cell.content.forEach((paragraph, paragraphIndex) => {
            visitParagraph(
              paragraph,
              [...path, "rows", rowIndex, "cells", cellIndex, "content", paragraphIndex],
              seenIds,
              assetsById,
              ctx,
            );
          });
        });
      });
      break;
    case "figure":
      validateBodyImage(block.assetId, path, assetsById, ctx);
      break;
    case "chemical-structure": {
      const preview = assetsById.get(block.previewAssetId);
      if (!preview) {
        ctx.addIssue({
          code: "custom",
          message: "结构式预览资源不存在",
          path: [...path, "previewAssetId"],
        });
      } else if (
        (preview.kind !== "chemical-preview" &&
          !(preview.kind === "image" && preview.mediaType === "image/png")) ||
        preview.widthPx > 4096 ||
        preview.heightPx > 4096
      ) {
        ctx.addIssue({
          code: "custom",
          message: "结构式预览必须引用不超过 4096×4096 的化学预览资源",
          path: [...path, "previewAssetId"],
        });
      }
      break;
    }
    default:
      break;
  }
}

function visitParagraph(
  paragraph: ParagraphNode,
  path: (string | number)[],
  seenIds: Set<string>,
  assetsById: ReadonlyMap<string, z.infer<typeof AssetDescriptorSchema>>,
  ctx: z.RefinementCtx,
): void {
  addContentId(paragraph.id, path, seenIds, ctx);
  visitInlineFigures(paragraph.content, path, seenIds, assetsById, ctx);
}

function visitInlineFigures(
  content: ParagraphNode["content"],
  path: (string | number)[],
  seenIds: Set<string>,
  assetsById: ReadonlyMap<string, z.infer<typeof AssetDescriptorSchema>>,
  ctx: z.RefinementCtx,
): void {
  content.forEach((node, index) => {
    if (node.type !== "inline-figure") return;
    const nodePath = [...path, "content", index];
    addContentId(node.id, nodePath, seenIds, ctx);
    validateBodyImage(node.assetId, nodePath, assetsById, ctx);
  });
}

function validateBodyImage(
  assetId: string,
  path: (string | number)[],
  assetsById: ReadonlyMap<string, z.infer<typeof AssetDescriptorSchema>>,
  ctx: z.RefinementCtx,
): void {
  const asset = assetsById.get(assetId);
  if (!asset) {
    ctx.addIssue({ code: "custom", message: "正文图片资源不存在", path: [...path, "assetId"] });
  } else if (
    ["flowchart-preview", "drawing-source", "drawing-tiles", "design-editor-project"].includes(
      asset.kind ?? "",
    )
  ) {
    ctx.addIssue({
      code: "custom",
      message: "五书正文不能直接引用工程预览或原始图纸资源",
      path: [...path, "assetId"],
    });
  }
}

function addContentId(
  id: string,
  path: (string | number)[],
  seenIds: Set<string>,
  ctx: z.RefinementCtx,
): void {
  if (seenIds.has(id)) {
    ctx.addIssue({
      code: "custom",
      message: "书册正文节点编号重复",
      path: [...path, "id"],
    });
    return;
  }
  seenIds.add(id);
}

function addDuplicateIssue<T extends string | number>(
  ctx: z.RefinementCtx,
  values: readonly T[],
  path: (string | number)[],
  message: string,
): void {
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) {
      ctx.addIssue({
        code: "custom",
        message,
        path,
      });
      return;
    }
    seen.add(value);
  }
}
