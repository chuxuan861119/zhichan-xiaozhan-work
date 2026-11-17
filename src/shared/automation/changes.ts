import { z } from "zod";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../document/defaults.js";
import {
  type BlockNode,
  BlockNodeSchema,
  type HeadingNode,
  type InlineNode,
  MAX_DOCUMENT_NODES,
  PageSettingsSchema,
  ParagraphAttributesSchema,
  type ParagraphNode,
  type TextMark,
  TextMarkSchema,
} from "../document/model.js";
import { canonicalToTiptap } from "../document/model-adapter.js";
import { validatePatentBookDocument } from "../document/validation.js";
import { randomUuid } from "../id.js";
import { JsonObjectSchema } from "../ipc/primitives.js";
import {
  type CanonicalPatent,
  CanonicalPatentSchema,
  isPatentBookAvailable,
  type PatentBookKind,
  PatentBookKindSchema,
} from "../patent/model.js";
import {
  applyPatentOperation,
  PatentOperationSchema,
  PatentOperationSchemas,
} from "./patent-operations.js";

const bookTarget = { bookKind: PatentBookKindSchema, blockId: z.string().uuid() };
const textRange = {
  expectedText: z.string().max(1_000_000),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
};
const marks = z.array(TextMarkSchema).max(16);
export const AutomationOperationSchema = z.discriminatedUnion("type", [
  ...PatentOperationSchemas,
  z
    .object({
      type: z.literal("replaceBookContent"),
      bookKind: PatentBookKindSchema,
      content: z.array(BlockNodeSchema).max(MAX_DOCUMENT_NODES),
    })
    .strict(),
  z
    .object({
      type: z.literal("insertBlock"),
      bookKind: PatentBookKindSchema,
      afterBlockId: z.string().uuid().nullable(),
      block: BlockNodeSchema,
    })
    .strict(),
  z.object({ type: z.literal("replaceBlock"), ...bookTarget, block: BlockNodeSchema }).strict(),
  z
    .object({
      type: z.literal("moveBlock"),
      ...bookTarget,
      afterBlockId: z.string().uuid().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("setParagraphAttributes"),
      ...bookTarget,
      attrs: ParagraphAttributesSchema.partial(),
    })
    .strict(),
  z
    .object({
      type: z.literal("setBookPage"),
      bookKind: PatentBookKindSchema,
      page: PageSettingsSchema,
    })
    .strict(),
  z.object({ type: z.literal("useAsset"), assetId: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal("insertParagraph"),
      bookKind: PatentBookKindSchema,
      afterBlockId: z.string().uuid().nullable(),
      text: z.string().max(1_000_000),
      marks: marks.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("replaceText"),
      ...bookTarget,
      ...textRange,
      text: z.string().max(1_000_000),
    })
    .strict(),
  z.object({ type: z.literal("setTextMarks"), ...bookTarget, ...textRange, marks }).strict(),
  z.object({ type: z.literal("deleteBlock"), ...bookTarget }).strict(),
  z
    .object({
      type: z.literal("setMetadata"),
      name: z.string().trim().min(1).max(100).nullable().optional(),
      customer: z.string().trim().max(100).nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("attachFigure"),
      assetId: z.string().uuid(),
      widthMm: z.number().min(10).max(165).optional(),
      explanation: z.string().max(100_000).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("selectAbstractFigure"), figureId: z.string().uuid().nullable() })
    .strict(),
]);
export const AutomationOperationsSchema = z.array(AutomationOperationSchema).min(1).max(1_000);
export type AutomationOperation = z.infer<typeof AutomationOperationSchema>;
function isPatentOperation(
  operation: AutomationOperation,
): operation is z.infer<typeof PatentOperationSchema> {
  return PatentOperationSchema.safeParse(operation).success;
}
export type AutomationBaseline = {
  books: Array<{
    bookKind: PatentBookKind;
    blocks: Array<{ blockId: string; signature: string; substantial: boolean }>;
  }>;
};

/** Signatures ignore formatting, IDs and timestamps; retain semantic text and structured data. */
function semanticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const normalized = semanticValue(item);
      const previous = result.at(-1);
      if (
        typeof normalized === "object" &&
        normalized !== null &&
        "type" in normalized &&
        normalized.type === "text" &&
        "text" in normalized &&
        typeof previous === "object" &&
        previous !== null &&
        "type" in previous &&
        previous.type === "text" &&
        "text" in previous
      ) {
        previous.text = String(previous.text) + String(normalized.text);
      } else result.push(normalized);
    }
    return result;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["id", "marks", "attrs", "semanticRole", "figureId"].includes(key))
        .map(([key, item]) => [key, semanticValue(item)]),
    );
  }
  return value;
}
function signature(block: BlockNode): string {
  return JSON.stringify(semanticValue(block));
}
function substantive(block: BlockNode): boolean {
  if (
    block.type === "heading" ||
    ("semanticRole" in block && block.semanticRole === "invention-title") ||
    block.type === "page-break"
  )
    return false;
  if (block.type === "paragraph")
    return block.content.some((node) => node.type !== "text" || node.text.trim().length > 0);
  return true;
}
export function captureAutomationBaseline(patent: CanonicalPatent): AutomationBaseline {
  return {
    books: patent.books.map((book) => ({
      bookKind: book.kind,
      blocks: book.document.content.map((block) => ({
        blockId: block.id,
        signature: signature(block),
        substantial: substantive(block),
      })),
    })),
  };
}
function blockNonempty(block: BlockNode): boolean {
  return block.type === "paragraph" || block.type === "heading"
    ? block.content.some((node) => node.type !== "text" || node.text.length > 0)
    : block.type !== "page-break";
}
function paragraph(text: string, textMarks: TextMark[] = []): ParagraphNode {
  return {
    id: randomUuid(),
    type: "paragraph",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: text ? [{ type: "text", text, marks: structuredClone(textMarks) }] : [],
  };
}
function modifyText(
  block: ParagraphNode | HeadingNode,
  operation: Extract<AutomationOperation, { type: "replaceText" | "setTextMarks" }>,
): void {
  if ((operation.start === undefined) !== (operation.end === undefined))
    throw new Error("Text range requires start and end.");
  const hasStructure = block.content.some((node) => node.type !== "text");
  if (operation.start === undefined && hasStructure)
    throw new Error("Mixed-content blocks require an explicit text-only range.");
  const flattened = block.content
    .map((node) => (node.type === "text" ? node.text : "\uFFFC"))
    .join("");
  const start = operation.start ?? 0;
  const end = operation.end ?? flattened.length;
  if (
    start > end ||
    end > flattened.length ||
    flattened.slice(start, end) !== operation.expectedText
  )
    throw new Error("Text range or expectedText does not match.");
  if (hasStructure && start === end) {
    let position = 0;
    const hasTextAnchor = block.content.some((node) => {
      const nodeStart = position;
      position += node.type === "text" ? node.text.length : 1;
      return node.type === "text" && nodeStart <= start && start <= position;
    });
    if (!hasTextAnchor) throw new Error("Text insertion requires a text anchor in mixed content.");
  }
  // UTF-16 ranges cannot split surrogate pairs.
  const splitsSurrogate = (offset: number) =>
    offset > 0 &&
    offset < flattened.length &&
    /[\uD800-\uDBFF]/u.test(flattened[offset - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(flattened[offset]!);
  if (splitsSurrogate(start) || splitsSurrogate(end))
    throw new Error("Text range splits a character.");
  let offset = 0;
  let inserted = false;
  const result: InlineNode[] = [];
  let insertionMarks: TextMark[] = [];
  for (const node of block.content) {
    const length = node.type === "text" ? node.text.length : 1;
    const nodeStart = offset;
    const nodeEnd = offset + length;
    offset = nodeEnd;
    if (node.type !== "text") {
      if (start < nodeEnd && end > nodeStart)
        throw new Error("Text range intersects a formula, image or break.");
      result.push(node);
      continue;
    }
    if (nodeStart <= start && start <= nodeEnd) insertionMarks = node.marks;
    if (nodeEnd <= start || nodeStart >= end) {
      // Zero-width insertion at a text boundary.
      if (
        operation.type === "replaceText" &&
        !inserted &&
        start === end &&
        start >= nodeStart &&
        start <= nodeEnd
      ) {
        if (start > nodeStart)
          result.push({ ...node, text: node.text.slice(0, start - nodeStart) });
        if (operation.text)
          result.push({ type: "text", text: operation.text, marks: structuredClone(node.marks) });
        if (start < nodeEnd) result.push({ ...node, text: node.text.slice(start - nodeStart) });
        inserted = true;
      } else result.push(node);
      continue;
    }
    const left = Math.max(start - nodeStart, 0);
    const right = Math.min(end - nodeStart, length);
    if (left > 0) result.push({ ...node, text: node.text.slice(0, left) });
    if (operation.type === "setTextMarks") {
      result.push({
        ...node,
        text: node.text.slice(left, right),
        marks: structuredClone(operation.marks),
      });
    } else if (!inserted) {
      if (operation.text)
        result.push({ type: "text", text: operation.text, marks: structuredClone(node.marks) });
      inserted = true;
    }
    if (right < length) result.push({ ...node, text: node.text.slice(right) });
  }
  if (operation.type === "replaceText" && !inserted) {
    if (start !== end) throw new Error("Text range is ambiguous.");
    if (operation.text)
      result.push({ type: "text", text: operation.text, marks: structuredClone(insertionMarks) });
  }
  block.content = result;
}

export function prepareAutomationChange(
  original: CanonicalPatent,
  operationsInput: readonly AutomationOperation[],
  cumulative: AutomationBaseline = captureAutomationBaseline(original),
) {
  const operations = AutomationOperationsSchema.parse(operationsInput);
  const patent = structuredClone(original);
  const reasons = new Set<string>();
  const touchedBooks = new Set<PatentBookKind>();
  const touchedBlocks = new Set<string>();
  for (const operation of operations) {
    if (isPatentOperation(operation)) {
      applyPatentOperation(patent, operation);
      continue;
    }
    if (operation.type === "useAsset") {
      if (!patent.assets.some((asset) => asset.assetId === operation.assetId))
        throw new Error("Asset is unavailable.");
      continue;
    }
    if (operation.type === "setMetadata") {
      if (operation.name !== undefined) patent.name = operation.name;
      if (operation.customer !== undefined) patent.customer = operation.customer?.trim() || null;
      continue;
    }
    if (operation.type === "attachFigure") {
      if (!patent.drawingBooksEnabled) throw new Error("Drawing books are disabled.");
      const asset = patent.assets.find((entry) => entry.assetId === operation.assetId);
      if (!asset || asset.kind === "drawing-source" || asset.kind === "flowchart-preview")
        throw new Error("Figure asset is unavailable.");
      const figureId = randomUuid();
      patent.figures.push({
        figureId,
        assetId: operation.assetId,
        widthMm: operation.widthMm ?? 80,
      });
      if (operation.explanation) {
        const book = patent.books.find((entry) => entry.kind === "description")!;
        const block = paragraph(`图${patent.figures.length} ${operation.explanation}`);
        block.figureId = figureId;
        const heading = book.document.content.findIndex(
          (entry) => "semanticRole" in entry && entry.semanticRole === "description-drawings",
        );
        if (heading < 0) throw new Error("Drawing explanation heading is unavailable.");
        let index = heading + 1;
        while (
          index < book.document.content.length &&
          book.document.content[index]?.type !== "heading"
        )
          index++;
        book.document.content.splice(index, 0, block);
        touchedBooks.add("description");
        touchedBlocks.add(block.id);
      }
      touchedBooks.add("description-drawings");
      continue;
    }
    if (operation.type === "selectAbstractFigure") {
      if (
        operation.figureId !== null &&
        !patent.figures.some((figure) => figure.figureId === operation.figureId)
      )
        throw new Error("Abstract figure is unavailable.");
      patent.abstractDrawingFigureId = operation.figureId;
      touchedBooks.add("abstract-drawing");
      continue;
    }
    if (!isPatentBookAvailable(patent, operation.bookKind)) throw new Error("Book is unavailable.");
    const book = patent.books.find((entry) => entry.kind === operation.bookKind)!;
    touchedBooks.add(operation.bookKind);
    if (operation.type === "replaceBookContent") {
      book.document.content = structuredClone(operation.content);
      reasons.add("destructive-structured-content");
      for (const block of operation.content) touchedBlocks.add(block.id);
      continue;
    }
    if (operation.type === "setBookPage") {
      const page = operation.page;
      if (
        page.widthMm <= page.marginLeftMm + page.marginRightMm ||
        page.heightMm <= page.marginTopMm + page.marginBottomMm
      )
        throw new Error("Page margins leave no writable area.");
      book.document.page = structuredClone(page);
      continue;
    }
    if (operation.type === "insertBlock") {
      const index =
        operation.afterBlockId === null
          ? -1
          : book.document.content.findIndex((block) => block.id === operation.afterBlockId);
      if (operation.afterBlockId !== null && index < 0)
        throw new Error("Insertion anchor is unavailable.");
      book.document.content.splice(index + 1, 0, structuredClone(operation.block));
      touchedBlocks.add(operation.block.id);
      continue;
    }
    if (operation.type === "insertParagraph") {
      const index =
        operation.afterBlockId === null
          ? -1
          : book.document.content.findIndex((entry) => entry.id === operation.afterBlockId);
      if (operation.afterBlockId !== null && index < 0)
        throw new Error("Insertion anchor is unavailable.");
      const block = paragraph(operation.text, operation.marks);
      book.document.content.splice(index + 1, 0, block);
      touchedBlocks.add(block.id);
      continue;
    }
    const index = book.document.content.findIndex((entry) => entry.id === operation.blockId);
    const block = book.document.content[index];
    if (!block) throw new Error("Block is unavailable.");
    touchedBlocks.add(block.id);
    if (operation.type === "replaceBlock") {
      if (operation.block.id !== block.id) throw new Error("Replacement must retain the block ID.");
      book.document.content[index] = structuredClone(operation.block);
      reasons.add("destructive-structured-content");
    } else if (operation.type === "moveBlock") {
      if (operation.afterBlockId === block.id) throw new Error("A block cannot follow itself.");
      book.document.content.splice(index, 1);
      const anchor =
        operation.afterBlockId === null
          ? -1
          : book.document.content.findIndex((node) => node.id === operation.afterBlockId);
      if (operation.afterBlockId !== null && anchor < 0)
        throw new Error("Insertion anchor is unavailable.");
      book.document.content.splice(anchor + 1, 0, block);
    } else if (operation.type === "setParagraphAttributes") {
      if (block.type !== "paragraph") throw new Error("Paragraph attributes require a paragraph.");
      block.attrs = ParagraphAttributesSchema.parse({ ...block.attrs, ...operation.attrs });
    } else if (operation.type === "deleteBlock") {
      if (blockNonempty(block)) reasons.add("deletes-nonempty-block");
      if (
        (block.type !== "paragraph" && block.type !== "heading") ||
        ((block.type === "paragraph" || block.type === "heading") &&
          block.content.some((node) => node.type !== "text"))
      )
        reasons.add("destructive-structured-content");
      book.document.content.splice(index, 1);
    } else {
      if (block.type !== "paragraph" && block.type !== "heading")
        throw new Error("Text operations require a paragraph or heading.");
      modifyText(block, operation);
    }
  }
  for (const book of patent.books) {
    const validation = validatePatentBookDocument(
      book.document,
      new Set(patent.assets.map((asset) => asset.assetId)),
      patent.assets,
    );
    if (!validation.ok) throw new Error(validation.error.message);
  }
  for (const baselineBook of cumulative.books) {
    const substantial = baselineBook.blocks.filter((block) => block.substantial);
    if (substantial.length === 0) continue;
    const current = patent.books.find((book) => book.kind === baselineBook.bookKind)!;
    if (
      substantial.every(
        (block) =>
          !current.document.content.some(
            (entry) => entry.id === block.blockId && signature(entry) === block.signature,
          ),
      )
    )
      reasons.add(`replaces-entire-original-body:${baselineBook.bookKind}`);
  }
  for (const auxiliary of patent.auxiliaryDocuments) {
    const page = auxiliary.document.page;
    if (
      page.widthMm <= page.marginLeftMm + page.marginRightMm ||
      page.heightMm <= page.marginTopMm + page.marginBottomMm
    )
      throw new Error("Page margins leave no writable area.");
    const validation = validatePatentBookDocument(
      auxiliary.document,
      new Set(patent.assets.map((asset) => asset.assetId)),
      patent.assets,
    );
    if (!validation.ok) throw new Error(validation.error.message);
    auxiliary.editorState = JsonObjectSchema.parse(
      canonicalToTiptap({ ...auxiliary.document, assets: patent.assets }),
    );
  }
  for (const book of patent.books)
    if (
      JSON.stringify(book.document) !==
      JSON.stringify(original.books.find((entry) => entry.kind === book.kind)?.document)
    )
      touchedBooks.add(book.kind);
  const diff = {
    drawingProjects: { before: original.drawingProjects, after: patent.drawingProjects },
    auxiliaryDocuments: { before: original.auxiliaryDocuments, after: patent.auxiliaryDocuments },
    settings: {
      before: {
        patentType: original.patentType,
        drawingBooksEnabled: original.drawingBooksEnabled,
        referenceMarks: original.referenceMarks,
        referenceMarkSettings: original.referenceMarkSettings,
      },
      after: {
        patentType: patent.patentType,
        drawingBooksEnabled: patent.drawingBooksEnabled,
        referenceMarks: patent.referenceMarks,
        referenceMarkSettings: patent.referenceMarkSettings,
      },
    },
    metadata: {
      name: { before: original.name, after: patent.name },
      customer: { before: original.customer, after: patent.customer },
    },
    books: patent.books
      .filter(
        (book, index) =>
          JSON.stringify(book.document) !== JSON.stringify(original.books[index]!.document),
      )
      .map((book) => ({
        bookKind: book.kind,
        before: original.books.find((entry) => entry.kind === book.kind)!.document.content,
        after: book.document.content,
        pageBefore: original.books.find((entry) => entry.kind === book.kind)!.document.page,
        pageAfter: book.document.page,
      })),
    figures: {
      before: original.figures,
      after: patent.figures,
      abstractFigureBefore: original.abstractDrawingFigureId,
      abstractFigureAfter: patent.abstractDrawingFigureId,
    },
  };
  return {
    patent: CanonicalPatentSchema.parse(patent),
    risk: {
      requireApproval: false,
      reasons: [...reasons],
      affectedBookKinds: [...touchedBooks],
    },
    diff,
    touched: { bookKinds: [...touchedBooks], blockIds: [...touchedBlocks] },
  };
}
