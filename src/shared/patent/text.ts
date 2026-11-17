import type { BlockNode, InlineNode, PatentBookDocument } from "../document/model.js";
import { visibleTableAnnotations } from "../document/table-annotations.js";

export function countUnicodeCharacters(text: string): number {
  return [...text].length;
}

export function visiblePatentBookText(document: PatentBookDocument): string {
  return document.content.map((block) => visibleBlockText(block)).join("");
}

export function visibleBlockText(block: BlockNode): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return visibleInlineText(block.content);
    case "bullet-list":
    case "ordered-list":
      return block.items
        .map((item) => item.content.map((paragraph) => visibleBlockText(paragraph)).join(""))
        .join("");
    case "table":
      return (
        visibleTableAnnotations(block).name +
        block.rows
          .map((row) =>
            row.cells
              .map((cell) => cell.content.map((paragraph) => visibleBlockText(paragraph)).join(""))
              .join(""),
          )
          .join("") +
        visibleTableAnnotations(block).note
      );
    case "figure":
      return "";
    case "block-formula":
      return block.source;
    case "chemical-structure":
      return "[化学结构]";
    case "page-break":
      return "";
  }
}

export function visibleInlineText(content: readonly InlineNode[]): string {
  return content
    .map((inline) => {
      if (inline.type === "text") return inline.text;
      if (inline.type === "hard-break") return "\n";
      if (inline.type === "inline-formula") return inline.source;
      return "";
    })
    .join("");
}
