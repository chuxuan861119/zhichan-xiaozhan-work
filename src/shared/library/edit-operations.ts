import { z } from "zod";
import {
  AssetDescriptorSchema,
  BlockNodeSchema,
  type CanonicalDocument,
  PageSettingsSchema,
} from "../document/model.js";
import { validateCanonicalDocument } from "../document/validation.js";
import { JsonObjectSchema, StableIdSchema } from "../ipc/primitives.js";
import { LibraryDocumentIdSchema, LibraryRevisionSchema } from "./model.js";

const MAX_EDIT_OPERATIONS = 10_000;
const MAX_ORDERED_BLOCKS = 100_000;
const MAX_EDIT_ASSETS = 10_000;

export const CanonicalEditOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("set-title"),
      title: z
        .string()
        .min(1)
        .max(255)
        .refine((value) => value.trim().length > 0, "标题不能为空。"),
    })
    .strict(),
  z
    .object({
      type: z.literal("set-page"),
      page: PageSettingsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("put-block"),
      index: z.number().int().nonnegative(),
      block: BlockNodeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("remove-block"),
      blockId: StableIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("set-order"),
      blockIds: z.array(StableIdSchema).max(MAX_ORDERED_BLOCKS),
    })
    .strict(),
  z
    .object({
      type: z.literal("set-assets"),
      assets: z.array(AssetDescriptorSchema).max(MAX_EDIT_ASSETS),
    })
    .strict(),
]);
export type CanonicalEditOperation = z.infer<typeof CanonicalEditOperationSchema>;

export const LibraryEditBatchSchema = z
  .object({
    libraryDocumentId: LibraryDocumentIdSchema,
    sessionId: z.string().uuid(),
    operationId: z.string().uuid(),
    baseRevision: LibraryRevisionSchema,
    targetRevision: LibraryRevisionSchema,
    modelVersion: z.literal(1),
    operations: z.array(CanonicalEditOperationSchema).min(1).max(MAX_EDIT_OPERATIONS),
    editorState: JsonObjectSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.targetRevision !== value.baseRevision + 1) {
      context.addIssue({
        code: "custom",
        message: "修订号必须连续。",
        path: ["targetRevision"],
      });
    }
  });
export type LibraryEditBatch = z.infer<typeof LibraryEditBatchSchema>;

function cloneDocument(document: CanonicalDocument): CanonicalDocument {
  return structuredClone(document);
}

function blockIds(document: CanonicalDocument): string[] {
  return document.content.map((block) => block.id);
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function assertValidDocument(document: CanonicalDocument): CanonicalDocument {
  const result = validateCanonicalDocument(document);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertUniqueIds(ids: readonly string[], message: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(message);
    seen.add(id);
  }
}

function changedBlockIds(before: CanonicalDocument, after: CanonicalDocument): Set<string> {
  const beforeById = new Map(before.content.map((block) => [block.id, serialized(block)]));
  const changed = new Set<string>();
  for (const block of after.content) {
    if (beforeById.get(block.id) !== serialized(block)) changed.add(block.id);
  }
  return changed;
}

export function diffCanonicalDocument(
  beforeInput: CanonicalDocument,
  afterInput: CanonicalDocument,
): CanonicalEditOperation[] {
  const before = assertValidDocument(beforeInput);
  const after = assertValidDocument(afterInput);
  const operations: CanonicalEditOperation[] = [];

  if (before.title !== after.title) operations.push({ type: "set-title", title: after.title });

  if (serialized(before.page) !== serialized(after.page)) {
    operations.push({ type: "set-page", page: after.page });
  }

  const afterById = new Map(after.content.map((block) => [block.id, block]));
  const afterIds = blockIds(after);
  const workingIds = blockIds(before);
  for (const block of before.content) {
    if (!afterById.has(block.id)) {
      operations.push({ type: "remove-block", blockId: block.id });
      workingIds.splice(workingIds.indexOf(block.id), 1);
    }
  }

  const changed = changedBlockIds(before, after);
  for (const [index, block] of after.content.entries()) {
    const currentIndex = workingIds.indexOf(block.id);
    if (currentIndex >= 0) {
      if (changed.has(block.id)) {
        operations.push({ type: "put-block", index: currentIndex, block });
      }
      continue;
    }

    const insertIndex = Math.min(index, workingIds.length);
    operations.push({ type: "put-block", index: insertIndex, block });
    workingIds.splice(insertIndex, 0, block.id);
  }

  if (!sameOrder(workingIds, afterIds)) {
    operations.push({ type: "set-order", blockIds: afterIds });
  }

  if (serialized(before.assets) !== serialized(after.assets)) {
    operations.push({ type: "set-assets", assets: after.assets });
  }

  return operations;
}

function applyPutBlock(document: CanonicalDocument, operation: CanonicalEditOperation): void {
  if (operation.type !== "put-block") return;
  const existingIndex = document.content.findIndex((block) => block.id === operation.block.id);
  if (existingIndex >= 0) {
    if (operation.index !== existingIndex) {
      throw new Error("Block ID already exists at a different index.");
    }
    document.content[existingIndex] = structuredClone(operation.block);
    return;
  }

  if (operation.index > document.content.length) throw new Error("Block index is out of range.");
  document.content.splice(operation.index, 0, structuredClone(operation.block));
}

function applySetOrder(document: CanonicalDocument, blockIdsToApply: readonly string[]): void {
  assertUniqueIds(blockIdsToApply, "Block order contains duplicate IDs.");
  const currentIds = blockIds(document);
  if (blockIdsToApply.length !== currentIds.length) {
    throw new Error("Block order must include every current block ID.");
  }

  const blocksById = new Map(document.content.map((block) => [block.id, block]));
  const reordered = blockIdsToApply.map((blockId) => {
    const block = blocksById.get(blockId);
    if (block === undefined) throw new Error("Block order references an unknown ID.");
    return block;
  });
  document.content = reordered;
}

export function applyCanonicalOperations(
  documentInput: CanonicalDocument,
  operationsInput: readonly CanonicalEditOperation[],
): CanonicalDocument {
  const document = cloneDocument(assertValidDocument(documentInput));
  const operations = operationsInput.map((operation) =>
    CanonicalEditOperationSchema.parse(operation),
  );

  for (const operation of operations) {
    switch (operation.type) {
      case "set-title":
        document.title = operation.title;
        break;
      case "set-page":
        document.page = structuredClone(operation.page);
        break;
      case "put-block":
        applyPutBlock(document, operation);
        break;
      case "remove-block": {
        const index = document.content.findIndex((block) => block.id === operation.blockId);
        if (index < 0) throw new Error("Cannot remove an unknown block ID.");
        document.content.splice(index, 1);
        break;
      }
      case "set-order":
        applySetOrder(document, operation.blockIds);
        break;
      case "set-assets":
        document.assets = structuredClone(operation.assets);
        break;
    }
  }

  return assertValidDocument(document);
}
