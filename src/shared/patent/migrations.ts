import { z } from "zod";
import { addChemicalEditorModes, normalizeFontFamilies } from "../document/migrations.js";
import {
  AssetDescriptorSchema,
  type BlockNode,
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type InlineNode,
  type PatentBookDocument,
  PatentBookDocumentSchema,
  type PatentBookDocumentV1,
  PatentBookDocumentV1Schema,
} from "../document/model.js";
import { JsonObjectSchema } from "../ipc/primitives.js";
import type { AppResult } from "../ipc/result.js";
import {
  CANONICAL_PATENT_FORMAT_VERSION,
  type CanonicalPatent,
  CanonicalPatentSchema,
  EDITABLE_CAD_PATENT_FORMAT_VERSION,
  PATENT_BOOK_ORDER,
  TILED_PATENT_FORMAT_VERSION,
  UNIFIED_CAD_PATENT_FORMAT_VERSION,
} from "./model.js";
import {
  isSystemReferenceLegendPlaceholder,
  lastLegendParagraphAnywhere,
  referenceLegendText,
  sortReferenceMarks,
} from "./reference-mark-legend.js";
import {
  deterministicReferenceMarkId,
  parseReferenceLegendText,
  referenceNumberColor,
} from "./reference-marks.js";

const LegacyPatentBookV3Schema = z
  .object({
    bookId: z.string().uuid(),
    kind: z.enum(["claims", "description", "description-drawings", "abstract", "abstract-drawing"]),
    document: PatentBookDocumentV1Schema,
    editorState: JsonObjectSchema,
    localRevision: z.number().int().nonnegative(),
    persistedRevision: z.number().int().nonnegative(),
  })
  .strict();

/** Version 3 stored five book documents before the chemical-content format update. */
export const CanonicalPatentV3Schema = z
  .object({
    formatVersion: z.literal(3),
    patentId: z.string().uuid(),
    name: z.string().trim().min(1).max(500).nullable(),
    patentType: z.enum(["invention", "utility-model"]),
    createdAt: z.string().datetime(),
    modifiedAt: z.string().datetime(),
    revision: z.number().int().nonnegative(),
    activeBookKind: z.enum([
      "claims",
      "description",
      "description-drawings",
      "abstract",
      "abstract-drawing",
    ]),
    books: z.array(LegacyPatentBookV3Schema).length(PATENT_BOOK_ORDER.length),
    figures: z
      .array(
        z
          .object({
            figureId: z.string().uuid(),
            assetId: z.string().uuid(),
            widthMm: z.number().min(10).max(165),
          })
          .strict(),
      )
      .max(100_000),
    abstractDrawingFigureId: z.string().uuid().nullable(),
    assets: z.array(AssetDescriptorSchema).max(100_000),
  })
  .strict();

function invalidVersion<T>(message: string): AppResult<T> {
  return { ok: false, error: { code: "INVALID_INPUT", message } };
}

export function migratePatentBookDocument(
  input: unknown,
): AppResult<CanonicalPatent["books"][number]["document"]> {
  if (typeof input !== "object" || input === null || !("formatVersion" in input)) {
    return invalidVersion("专利书册文档缺少格式版本。");
  }
  if (input.formatVersion === CANONICAL_DOCUMENT_FORMAT_VERSION) {
    const current = PatentBookDocumentSchema.safeParse(
      stripLegendParagraphsFromRawDocument(input as Record<string, unknown>),
    );
    return current.success
      ? { ok: true, value: normalizeMigratedPatentBookDocument(current.data) }
      : invalidVersion("专利书册文档结构无效或包含不支持的内容。");
  }
  if (input.formatVersion === 2 || input.formatVersion === 3) {
    return validatePatentBookDocumentV2(input);
  }
  if (input.formatVersion !== 1) return invalidVersion("不支持此专利书册文档格式版本。");
  const legacy = PatentBookDocumentV1Schema.safeParse(input);
  if (!legacy.success) return invalidVersion("专利书册文档结构无效或包含不支持的内容。");
  return upgradePatentBookDocumentV1(legacy.data);
}

function validatePatentBookDocumentV2(
  input: unknown,
): AppResult<CanonicalPatent["books"][number]["document"]> {
  const current = PatentBookDocumentSchema.safeParse(
    stripLegendParagraphsFromRawDocument(
      addChemicalEditorModes({
        ...(input as Record<string, unknown>),
        formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
      }) as Record<string, unknown>,
    ),
  );
  return current.success
    ? { ok: true, value: normalizeMigratedPatentBookDocument(current.data) }
    : invalidVersion("专利书册文档结构无效或包含不支持的内容。");
}

function upgradePatentBookDocumentV1(
  legacy: PatentBookDocumentV1,
): AppResult<CanonicalPatent["books"][number]["document"]> {
  const current = PatentBookDocumentSchema.safeParse(
    stripLegendParagraphsFromRawDocument(
      addChemicalEditorModes({
        ...legacy,
        formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
      }) as Record<string, unknown>,
    ),
  );
  return current.success
    ? { ok: true, value: normalizeMigratedPatentBookDocument(current.data) }
    : invalidVersion("专利书册文档结构无效或包含不支持的内容。");
}

function normalizeMigratedPatentBookDocument(document: PatentBookDocument): PatentBookDocument {
  return normalizeFontFamilies(document);
}

/** Migrates a persisted patent to the current in-memory representation without changing the input. */
export function migrateCanonicalPatent(input: unknown): AppResult<CanonicalPatent> {
  if (typeof input !== "object" || input === null || !("formatVersion" in input)) {
    return invalidVersion("专利缺少格式版本。");
  }
  const formatVersion = input.formatVersion;
  if (typeof formatVersion === "number" && formatVersion > UNIFIED_CAD_PATENT_FORMAT_VERSION) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_VERSION",
        message: "此文件由更新版本的软件创建。当前版本不会覆盖它。",
      },
    };
  }
  if (
    formatVersion === CANONICAL_PATENT_FORMAT_VERSION ||
    formatVersion === TILED_PATENT_FORMAT_VERSION ||
    formatVersion === EDITABLE_CAD_PATENT_FORMAT_VERSION ||
    formatVersion === UNIFIED_CAD_PATENT_FORMAT_VERSION
  ) {
    const parsed = CanonicalPatentSchema.safeParse(
      stripLegendMarkedParagraphsFromRawPatent(input as Record<string, unknown>),
    );
    return parsed.success
      ? { ok: true, value: normalizeLegacyReferenceMarkColors(parsed.data) }
      : invalidVersion("专利结构无效或包含不支持的内容。");
  }
  if (
    (input as { patentType?: unknown }).patentType !== "design" &&
    (formatVersion === 9 || formatVersion === 10 || formatVersion === 11)
  ) {
    const parsed = CanonicalPatentSchema.safeParse(
      stripLegendMarkedParagraphsFromRawPatent({
        ...(input as Record<string, unknown>),
        formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
      }),
    );
    return parsed.success
      ? { ok: true, value: normalizeLegacyReferenceMarkColors(parsed.data) }
      : invalidVersion("专利结构无效或包含不支持的内容。");
  }
  if (formatVersion === 11) {
    const record = input as Record<string, unknown>;
    const designPatent = record.designPatent as Record<string, unknown> | null;
    const views = Array.isArray(designPatent?.views)
      ? designPatent.views.map((view) => ({
          ...(view as Record<string, unknown>),
          assignmentStatus: "confirmed",
          assignmentEvidence: null,
        }))
      : [];
    return migrateCanonicalPatent({
      ...record,
      formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
      designPatent: designPatent === null ? null : { ...designPatent, views },
    });
  }
  if (formatVersion === 10) {
    const record = input as Record<string, unknown>;
    const designPatent = record.designPatent as Record<string, unknown> | null;
    const views = Array.isArray(designPatent?.views)
      ? designPatent.views.map((view) => {
          const item = view as Record<string, unknown>;
          return {
            ...item,
            subjectBounds: item.subjectBounds ?? null,
            subjectBoundsSource: item.subjectBounds == null ? null : "automatic",
            subjectBoundsConfirmed: false,
          };
        })
      : [];
    return migrateCanonicalPatent({
      ...record,
      formatVersion: 11,
      designPatent: designPatent === null ? null : { ...designPatent, views },
    });
  }
  if (formatVersion === 9) {
    return migrateCanonicalPatent({
      ...(input as Record<string, unknown>),
      formatVersion: 10,
    });
  }
  if (formatVersion === 8 && (input as { patentType?: unknown }).patentType === "design") {
    const record = input as Record<string, unknown>;
    return migrateCanonicalPatent({
      ...record,
      formatVersion: 9,
      designPatent: record.designPatent ?? null,
    });
  }
  if (formatVersion === 2) {
    return migrateCanonicalPatent({
      ...(input as Record<string, unknown>),
      formatVersion: 4,
    });
  }
  if (formatVersion === 8) {
    const parsed = CanonicalPatentSchema.safeParse(
      stripLegendMarkedParagraphsFromRawPatent({
        ...(input as Record<string, unknown>),
        formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
        flowchartProjects: [],

        auxiliaryDocuments: [],
        docxImportReport: null,
      }),
    );
    return parsed.success
      ? { ok: true, value: normalizeLegacyReferenceMarkColors(parsed.data) }
      : invalidVersion("专利结构无效或包含不支持的内容。");
  }
  if (formatVersion === 7) {
    const parsed = CanonicalPatentSchema.safeParse(
      stripLegendMarkedParagraphsFromRawPatent({
        ...(input as Record<string, unknown>),
        formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
        drawingBooksEnabled: true,
        flowchartProjects: [],

        auxiliaryDocuments: [],
        docxImportReport: null,
      }),
    );
    return parsed.success
      ? { ok: true, value: normalizeLegacyReferenceMarkColors(parsed.data) }
      : invalidVersion("专利结构无效或包含不支持的内容。");
  }
  if (formatVersion === 6) {
    const record = input as Record<string, unknown>;
    const parsed = CanonicalPatentSchema.safeParse(
      stripLegendMarkedParagraphsFromRawPatent({
        ...record,
        formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
        customer: typeof record.customer === "string" ? record.customer : null,
        drawingBooksEnabled: true,
        flowchartProjects: [],

        auxiliaryDocuments: [],
        docxImportReport: null,
        referenceMarks: Array.isArray(record.referenceMarks)
          ? record.referenceMarks
          : migrateReferenceMarks(record),
        referenceMarkSettings: record.referenceMarkSettings ?? {
          synchronizedEditingEnabled: false,
        },
      }),
    );
    return parsed.success
      ? { ok: true, value: normalizeLegacyReferenceMarkColors(parsed.data) }
      : invalidVersion("专利结构无效或包含不支持的内容。");
  }
  if (formatVersion === 5) {
    const referenceMarks = migrateReferenceMarks(input as Record<string, unknown>);
    const parsed = CanonicalPatentSchema.safeParse(
      stripLegendMarkedParagraphsFromRawPatent({
        ...(input as Record<string, unknown>),
        formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
        customer: null,
        drawingBooksEnabled: true,
        flowchartProjects: [],

        auxiliaryDocuments: [],
        docxImportReport: null,
        referenceMarks,
        referenceMarkSettings: { synchronizedEditingEnabled: false },
      }),
    );
    return parsed.success
      ? { ok: true, value: normalizeLegacyReferenceMarkColors(parsed.data) }
      : invalidVersion("专利结构无效或包含不支持的内容。");
  }
  if (formatVersion === 4) {
    const upgraded = upgradePatentV4Books(input);
    if (!upgraded.ok) return upgraded;
    const parsed = CanonicalPatentSchema.safeParse(
      stripLegendMarkedParagraphsFromRawPatent({
        ...upgraded.value,
        formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
        customer: null,
        drawingBooksEnabled: true,
        flowchartProjects: [],

        auxiliaryDocuments: [],
        docxImportReport: null,
        // 解析必须基于未清理标记段的原始输入：upgrade 已删除标记段，图例文字随之消失。
        referenceMarks: migrateReferenceMarks(input as Record<string, unknown>),
        referenceMarkSettings: { synchronizedEditingEnabled: false },
      }),
    );
    return parsed.success
      ? { ok: true, value: normalizeLegacyReferenceMarkColors(parsed.data) }
      : invalidVersion("专利结构无效或包含不支持的内容。");
  }
  if (formatVersion !== 3) return invalidVersion("不支持此专利格式版本。");

  const legacyRecord = { ...(input as Record<string, unknown>) };
  delete legacyRecord.referenceMarks;
  delete legacyRecord.referenceMarkSettings;
  delete legacyRecord.customer;
  delete legacyRecord.drawingBooksEnabled;
  delete legacyRecord.flowchartProjects;
  delete legacyRecord.drawingProjects;
  delete legacyRecord.scientificChartProjects;
  delete legacyRecord.auxiliaryDocuments;
  delete legacyRecord.docxImportReport;
  delete legacyRecord.designPatent;
  const legacy = CanonicalPatentV3Schema.safeParse(legacyRecord);
  if (!legacy.success) return invalidVersion("专利结构无效或包含不支持的内容。");
  const books = [] as CanonicalPatent["books"];
  for (const book of legacy.data.books) {
    const document = upgradePatentBookDocumentV1(book.document);
    if (!document.ok) return document;
    books.push({ ...book, document: document.value });
  }
  const migrated = CanonicalPatentSchema.safeParse({
    ...legacy.data,
    formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
    customer: null,
    drawingBooksEnabled: true,
    flowchartProjects: [],

    auxiliaryDocuments: [],
    docxImportReport: null,
    books,
    // 解析必须基于保留标记段的原始输入（legacyRecord 未清理）。
    referenceMarks: migrateReferenceMarks(legacyRecord),
    referenceMarkSettings: { synchronizedEditingEnabled: false },
    designPatent: null,
  });
  return migrated.success
    ? { ok: true, value: normalizeLegacyReferenceMarkColors(migrated.data) }
    : invalidVersion("专利结构无效或包含不支持的内容。");
}

function migrateReferenceMarks(record: Record<string, unknown>): CanonicalPatent["referenceMarks"] {
  if (!Array.isArray(record.books)) return [];
  const description = record.books.find(
    (book) =>
      typeof book === "object" &&
      book !== null &&
      (book as Record<string, unknown>).kind === "description",
  ) as Record<string, unknown> | undefined;
  const document = description?.document as PatentBookDocument | undefined;
  return deriveReferenceMarksFromDescription(document);
}

/** Convert the old numbering palette into invisible ownership metadata. */
function normalizeLegacyReferenceMarkColors(patent: CanonicalPatent): CanonicalPatent {
  const numberByColor = new Map<string, number>(
    patent.referenceMarks.map((entry) => [referenceNumberColor(entry.number), entry.number]),
  );
  if (numberByColor.size === 0) return patent;

  const after = structuredClone(patent);
  const mapInline = (node: InlineNode): InlineNode => {
    if (node.type !== "text") return node;
    const legacyNumbers = node.marks.flatMap((mark) => {
      if (mark.type !== "background-color") return [];
      const number = numberByColor.get(mark.value);
      return number === undefined ? [] : [number];
    });
    if (legacyNumbers.length === 0) return node;
    const retained = node.marks.filter(
      (mark) => mark.type !== "background-color" || !numberByColor.has(mark.value),
    );
    for (const number of legacyNumbers) {
      if (
        !retained.some((mark) => mark.type === "reference-mark-token" && mark.number === number)
      ) {
        retained.push({ type: "reference-mark-token", number });
      }
    }
    return { ...node, marks: retained };
  };
  const mapParagraph = (paragraph: Extract<BlockNode, { type: "paragraph" }>) => ({
    ...paragraph,
    content: paragraph.content.map(mapInline),
  });
  const mapBlock = (block: BlockNode): BlockNode => {
    if (block.type === "paragraph") return mapParagraph(block);
    if (block.type === "heading") return { ...block, content: block.content.map(mapInline) };
    if (block.type === "bullet-list" || block.type === "ordered-list") {
      return {
        ...block,
        items: block.items.map((item) => ({ ...item, content: item.content.map(mapParagraph) })),
      };
    }
    if (block.type === "table") {
      return {
        ...block,
        rows: block.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => ({ ...cell, content: cell.content.map(mapParagraph) })),
        })),
      };
    }
    return block;
  };
  for (const book of after.books) book.document.content = book.document.content.map(mapBlock);
  return after;
}

/**
 * 从说明书最后一个“其中”段（纯文本模式，优先附图说明章节、缺标题时全文档兜底）
 * 解析附图标记条目，并生成稳定 ID。只在迁移或旧库缺失 reference-mark-state 行时用于派生；
 * 不写库、不改正文；确实没有合法图例时返回空列表。
 */
export function deriveReferenceMarksFromDescription(
  description: PatentBookDocument | undefined,
): CanonicalPatent["referenceMarks"] {
  if (!description) return [];
  const legend = lastLegendParagraphAnywhere(description);
  if (!legend) return [];
  const text = referenceLegendText(legend);
  if (isSystemReferenceLegendPlaceholder(text)) return [];
  const parsed = parseReferenceLegendText(text);
  if (!parsed.ok) return [];
  return sortReferenceMarks(parsed.entries).map((entry) => ({
    referenceMarkId: deterministicReferenceMarkId(legend.id as string, entry.number, entry.keyword),
    ...entry,
  }));
}

/**
 * 从原始 JSON 中删除带 description-drawing-legend 语义标记的段落（单文档）。
 * 该标记概念已移除：旧数据在迁移时清除标记段落，避免残留的空段/改坏段干扰。
 */
function stripLegendParagraphsFromRawDocument(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const content = input.content;
  if (!Array.isArray(content)) return input;
  return {
    ...input,
    content: content.filter(
      (block) =>
        typeof block !== "object" ||
        block === null ||
        (block as Record<string, unknown>).semanticRole !== "description-drawing-legend",
    ),
  };
}

/** 从原始 JSON 专利记录的所有书册文档中删除带图例标记的段落。 */
function stripLegendMarkedParagraphsFromRawPatent(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const books = input.books;
  if (!Array.isArray(books)) return input;
  return {
    ...input,
    auxiliaryDocuments: Array.isArray(input.auxiliaryDocuments)
      ? input.auxiliaryDocuments.map((entry) => {
          if (typeof entry !== "object" || entry === null) return entry;
          const document = (entry as Record<string, unknown>).document;
          return typeof document === "object" &&
            document !== null &&
            (document as Record<string, unknown>).formatVersion === 3
            ? {
                ...entry,
                document: { ...document, formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION },
              }
            : entry;
        })
      : input.auxiliaryDocuments,
    figures: Array.isArray(input.figures)
      ? input.figures.map((figure) =>
          typeof figure === "object" && figure !== null && !("rotationDeg" in figure)
            ? { ...figure, rotationDeg: 0 }
            : figure,
        )
      : input.figures,
    books: books.map((book) => {
      if (typeof book !== "object" || book === null) return book;
      const document = (book as Record<string, unknown>).document;
      if (typeof document !== "object" || document === null) return book;
      return {
        ...(book as Record<string, unknown>),
        document: stripLegendParagraphsFromRawDocument(
          (document as Record<string, unknown>).formatVersion === 3
            ? { ...document, formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION }
            : (document as Record<string, unknown>),
        ),
      };
    }),
  };
}

function upgradePatentV4Books(input: unknown): AppResult<Omit<CanonicalPatent, "formatVersion">> {
  const record = input as Record<string, unknown>;
  const booksInput = record.books;
  if (!Array.isArray(booksInput)) return invalidVersion("专利结构无效或包含不支持的内容。");
  const books: unknown[] = [];
  for (const book of booksInput) {
    if (typeof book !== "object" || book === null || !("document" in book)) {
      return invalidVersion("专利书册结构无效。");
    }
    const document = migratePatentBookDocument((book as { document: unknown }).document);
    if (!document.ok) return document;
    books.push({ ...(book as Record<string, unknown>), document: document.value });
  }
  return { ok: true, value: { ...record, books } as Omit<CanonicalPatent, "formatVersion"> };
}
