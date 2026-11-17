import type { BlockNode, HeadingNode, ParagraphNode } from "../document/model.js";
import { visibleTableAnnotations } from "../document/table-annotations.js";
import { visibleBlockText } from "../patent/text.js";

export function literalText(node: ParagraphNode | HeadingNode): string {
  // Preserve canonical offsets without treating formula syntax as prose.
  return node.content
    .map((n) =>
      n.type === "text"
        ? n.text
        : n.type === "hard-break"
          ? "\n"
          : n.type === "inline-formula"
            ? " ".repeat(n.source.length)
            : "",
    )
    .join("");
}

/** Inspect each paragraph/caption independently, never joining cells or list items. */
export function inspectionTextBlocks(
  blocks: readonly BlockNode[],
  includeFormulas = false,
): Array<{ id: string; key: string; text: string }> {
  return blocks.flatMap((block) => {
    if (block.type === "paragraph" || block.type === "heading")
      return [
        {
          id: block.id,
          key: block.id,
          text: includeFormulas ? visibleBlockText(block) : literalText(block),
        },
      ];
    if (block.type === "block-formula" && includeFormulas)
      return [{ id: block.id, key: block.id, text: block.source }];
    if (block.type === "table") {
      const { name, note } = visibleTableAnnotations(block);
      return [
        ...(name ? [{ id: block.id, key: `${block.id}:name`, text: name }] : []),
        ...block.rows.flatMap((row) =>
          row.cells.flatMap((cell) => inspectionTextBlocks(cell.content, includeFormulas)),
        ),
        ...(note ? [{ id: block.id, key: `${block.id}:note`, text: note }] : []),
      ];
    }
    if (block.type === "bullet-list" || block.type === "ordered-list")
      return block.items.flatMap((item) => inspectionTextBlocks(item.content, includeFormulas));
    return [];
  });
}

export function nestedBlocks(blocks: readonly BlockNode[]): BlockNode[] {
  return blocks.flatMap((block) => [
    block,
    ...(block.type === "table"
      ? block.rows.flatMap((r) => r.cells.flatMap((c) => nestedBlocks(c.content)))
      : block.type === "bullet-list" || block.type === "ordered-list"
        ? block.items.flatMap((i) => nestedBlocks(i.content))
        : []),
  ]);
}
