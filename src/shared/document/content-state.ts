import type { BlockNode, CanonicalDocument, InlineNode } from "./model.js";

function inlineHasVisibleContent(node: InlineNode): boolean {
  switch (node.type) {
    case "text":
      return node.text.trim().length > 0;
    case "hard-break":
    case "inline-formula":
    case "inline-figure":
      return true;
  }
}

function blockHasVisibleContent(block: BlockNode): boolean {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return block.content.some(inlineHasVisibleContent);
    case "bullet-list":
    case "ordered-list":
      return block.items.some((item) => item.content.some(blockHasVisibleContent));
    case "page-break":
    case "figure":
    case "table":
    case "block-formula":
    case "chemical-structure":
      return true;
  }
}

export function isCanonicalDocumentBlank(document: CanonicalDocument): boolean {
  return document.content.every((block) => !blockHasVisibleContent(block));
}
