import type { CanonicalDocument, InlineNode } from "./model.js";

/** Remap resource references only; text and other UUIDs must stay unchanged. */
export function remapAssetIds<T>(input: T, replacements: ReadonlyMap<string, string>): T {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        [
          "assetId",
          "previewAssetId",
          "sourceAssetId",
          "baseAssetId",
          "bodyAssetId",
          "overlayAssetId",
        ].includes(key) && typeof nested === "string"
          ? (replacements.get(nested) ?? nested)
          : visit(nested),
      ]),
    );
  };
  return visit(input) as T;
}

/** Resources rendered by a document, excluding editable CAD source/history bodies. */
export function referencedDocumentAssetIds(document: Pick<CanonicalDocument, "content">): string[] {
  const assetIds = new Set<string>();
  const collectInline = (content: readonly InlineNode[]) => {
    for (const node of content) if (node.type === "inline-figure") assetIds.add(node.assetId);
  };
  for (const node of document.content) {
    if (node.type === "figure") assetIds.add(node.assetId);
    else if (node.type === "chemical-structure") assetIds.add(node.previewAssetId);
    else if (node.type === "paragraph" || node.type === "heading") collectInline(node.content);
    else if (node.type === "bullet-list" || node.type === "ordered-list") {
      for (const item of node.items)
        for (const paragraph of item.content) collectInline(paragraph.content);
    } else if (node.type === "table") {
      for (const row of node.rows)
        for (const cell of row.cells)
          for (const paragraph of cell.content) collectInline(paragraph.content);
    }
  }
  return [...assetIds];
}
