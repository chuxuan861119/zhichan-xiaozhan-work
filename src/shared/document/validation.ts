import type { AppResult } from "../ipc/result.js";
import {
  type AssetDescriptor,
  type BlockNode,
  BlockNodeSchema,
  type CanonicalDocument,
  CanonicalDocumentSchema,
  type InlineNode,
  MAX_DOCUMENT_NODES,
  type ParagraphNode,
  type PatentBookDocument,
  PatentBookDocumentSchema,
} from "./model.js";

function invalidDocument(message: string): AppResult<CanonicalDocument> {
  return { ok: false, error: { code: "INVALID_INPUT", message } };
}

function invalidPatentBookDocument(message: string): AppResult<PatentBookDocument> {
  return { ok: false, error: { code: "INVALID_INPUT", message } };
}

function topLevelNodeCountExceedsLimit(input: unknown): boolean {
  if (typeof input !== "object" || input === null || !("content" in input)) return false;
  return Array.isArray(input.content) && input.content.length > MAX_DOCUMENT_NODES;
}

type AssetReference = { assetId: string; requireChemicalPreview: boolean };

function addInlineNodes(
  content: readonly InlineNode[],
  identifiers: string[],
  referencedAssets: AssetReference[],
): number {
  for (const node of content) {
    if (node.type !== "inline-figure") continue;
    identifiers.push(node.id);
    referencedAssets.push({ assetId: node.assetId, requireChemicalPreview: false });
  }
  return content.length;
}

function addParagraphNodes(
  paragraph: ParagraphNode,
  identifiers: string[],
  referencedAssets: AssetReference[],
): number {
  identifiers.push(paragraph.id);
  return 1 + addInlineNodes(paragraph.content, identifiers, referencedAssets);
}

function collectBlockMetadata(
  block: BlockNode,
  identifiers: string[],
  referencedAssets: AssetReference[],
): number {
  identifiers.push(block.id);

  switch (block.type) {
    case "paragraph":
    case "heading":
      return 1 + addInlineNodes(block.content, identifiers, referencedAssets);
    case "bullet-list":
    case "ordered-list": {
      let count = 1;
      for (const item of block.items) {
        identifiers.push(item.id);
        count += 1;
        for (const paragraph of item.content) {
          count += addParagraphNodes(paragraph, identifiers, referencedAssets);
        }
      }
      return count;
    }
    case "table": {
      let count = 1;
      for (const row of block.rows) {
        identifiers.push(row.id);
        count += 1;
        for (const cell of row.cells) {
          identifiers.push(cell.id);
          count += 1;
          for (const paragraph of cell.content) {
            count += addParagraphNodes(paragraph, identifiers, referencedAssets);
          }
        }
      }
      return count;
    }
    case "figure":
      referencedAssets.push({ assetId: block.assetId, requireChemicalPreview: false });
      return 1;
    case "chemical-structure":
      referencedAssets.push({ assetId: block.previewAssetId, requireChemicalPreview: true });
      return 1;
    case "page-break":
    case "block-formula":
      return 1;
  }
}

function validateReferencedAssets(
  referencedAssets: readonly AssetReference[],
  availableAssetIds: ReadonlySet<string>,
  descriptors: ReadonlyMap<string, AssetDescriptor>,
): string | null {
  for (const reference of referencedAssets) {
    if (!availableAssetIds.has(reference.assetId)) return `图片资源不存在：${reference.assetId}`;
    const descriptor = descriptors.get(reference.assetId);
    if (!reference.requireChemicalPreview) {
      if (descriptor?.kind === "flowchart-preview") {
        return `五书正文不能直接引用流程图预览资源：${reference.assetId}`;
      }
      continue;
    }

    if (descriptor === undefined) return `结构式预览资源缺少描述信息：${reference.assetId}`;
    if (descriptor.kind === "chemical-preview") {
      if (descriptor.widthPx > 4096 || descriptor.heightPx > 4096) {
        return `结构式预览尺寸不能超过 4096×4096：${reference.assetId}`;
      }
      continue;
    }
    if (descriptor.kind === "image" && descriptor.mediaType === "image/png") {
      if (descriptor.widthPx > 4096 || descriptor.heightPx > 4096) {
        return `结构式预览尺寸不能超过 4096×4096：${reference.assetId}`;
      }
      continue;
    }
    return `结构式预览必须引用化学预览资源：${reference.assetId}`;
  }
  return null;
}

function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

export function validateCanonicalDocument(input: unknown): AppResult<CanonicalDocument> {
  if (topLevelNodeCountExceedsLimit(input)) {
    return invalidDocument(`文档节点数量超过 ${MAX_DOCUMENT_NODES} 个。`);
  }

  const parsed = CanonicalDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return invalidDocument("文档结构无效或包含不支持的内容。");
  }

  const identifiers: string[] = [];
  const referencedAssets: AssetReference[] = [];
  let nodeCount = 0;
  for (const block of parsed.data.content) {
    nodeCount += collectBlockMetadata(block, identifiers, referencedAssets);
  }

  if (nodeCount > MAX_DOCUMENT_NODES) {
    return invalidDocument(`文档节点数量超过 ${MAX_DOCUMENT_NODES} 个。`);
  }

  const duplicateNodeId = firstDuplicate(identifiers);
  if (duplicateNodeId) {
    return invalidDocument(`节点编号重复：${duplicateNodeId}`);
  }

  const assetIds = parsed.data.assets.map((asset) => asset.assetId);
  const duplicateAssetId = firstDuplicate(assetIds);
  if (duplicateAssetId) {
    return invalidDocument(`资源编号重复：${duplicateAssetId}`);
  }

  const availableAssets = new Set(assetIds);
  const assetValidationError = validateReferencedAssets(
    referencedAssets,
    availableAssets,
    new Map(parsed.data.assets.map((asset) => [asset.assetId, asset])),
  );
  if (assetValidationError) return invalidDocument(assetValidationError);

  return { ok: true, value: parsed.data };
}

export function validatePatentBookDocument(
  input: unknown,
  availableAssetIds: ReadonlySet<string>,
  availableAssetDescriptors: readonly AssetDescriptor[] = [],
): AppResult<PatentBookDocument> {
  if (topLevelNodeCountExceedsLimit(input)) {
    return invalidPatentBookDocument(`文档节点数量超过 ${MAX_DOCUMENT_NODES} 个。`);
  }
  const parsed = PatentBookDocumentSchema.safeParse(input);
  if (!parsed.success) return invalidPatentBookDocument("文档结构无效或包含不支持的内容。");
  return validateBookReferences(parsed.data, availableAssetIds, availableAssetDescriptors);
}

function validateBookReferences(
  document: PatentBookDocument,
  availableAssetIds: ReadonlySet<string>,
  availableAssetDescriptors: readonly AssetDescriptor[],
): AppResult<PatentBookDocument> {
  const identifiers: string[] = [];
  const referencedAssets: AssetReference[] = [];
  let nodeCount = 0;
  for (const block of document.content) {
    nodeCount += collectBlockMetadata(block, identifiers, referencedAssets);
  }
  if (nodeCount > MAX_DOCUMENT_NODES) {
    return invalidPatentBookDocument(`文档节点数量超过 ${MAX_DOCUMENT_NODES} 个。`);
  }
  const duplicateNodeId = firstDuplicate(identifiers);
  if (duplicateNodeId) return invalidPatentBookDocument(`节点编号重复：${duplicateNodeId}`);
  const assetValidationError = validateReferencedAssets(
    referencedAssets,
    availableAssetIds,
    new Map(availableAssetDescriptors.map((asset) => [asset.assetId, asset])),
  );
  if (assetValidationError) return invalidPatentBookDocument(assetValidationError);
  return { ok: true, value: document };
}

const BookMetadataSchema = PatentBookDocumentSchema.omit({ content: true });

function freezeValidatedBlock(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeValidatedBlock(child);
  Object.freeze(value);
}

/**
 * Private immutable editor blocks only, never an IPC/import validation boundary.
 * Reuses schema-normalized blocks; global IDs, node limits and current resource
 * descriptors are still checked on every edit. Frozen output protects the cache.
 */
export function createImmutablePatentBookValidator() {
  const blocks = new WeakMap<BlockNode, BlockNode>();
  return (
    input: PatentBookDocument,
    ids: ReadonlySet<string>,
    assets: readonly AssetDescriptor[],
  ): AppResult<PatentBookDocument> => {
    if (input.content.length > MAX_DOCUMENT_NODES)
      return invalidPatentBookDocument(`文档节点数量超过 ${MAX_DOCUMENT_NODES} 个。`);
    const { content, ...metadata } = input;
    const parsed = BookMetadataSchema.safeParse(metadata);
    if (!parsed.success) return invalidPatentBookDocument("文档结构无效或包含不支持的内容。");
    const validated: BlockNode[] = [];
    for (const block of content) {
      let cached = blocks.get(block);
      if (!cached) {
        const result = BlockNodeSchema.safeParse(block);
        if (!result.success) return invalidPatentBookDocument("文档结构无效或包含不支持的内容。");
        cached = result.data;
        freezeValidatedBlock(cached);
        blocks.set(block, cached);
      }
      validated.push(cached);
    }
    return validateBookReferences({ ...parsed.data, content: validated }, ids, assets);
  };
}
