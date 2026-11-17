import type { BlockNode, InlineNode } from "../document/model.js";

export type AiContentBlock = {
  id: string;
  type: "paragraph" | "heading" | "object";
  structure: string;
  parts: Array<{ text: string; description?: string }>;
};
export type MixedSpan = {
  blockId: string;
  blockType: AiContentBlock["type"];
  startOffset: number;
  endOffset: number;
};
export type MixedLine = {
  text: string;
  prefix: string;
  span: MixedSpan;
  parts: Array<{ start: number; end: number; text: string; token?: string }>;
};

function inlineParts(nodes: InlineNode[]): AiContentBlock["parts"] {
  return nodes.map((node) =>
    node.type === "text"
      ? { text: node.text }
      : node.type === "hard-break"
        ? { text: "\n", description: "换行" }
        : node.type === "inline-formula"
          ? { text: "\uFFFC", description: `公式 ${JSON.stringify(node.source)}` }
          : { text: "\uFFFC", description: "图片（未读取图像内容）" },
  );
}

// One shared traversal supplies local offsets, readable context and protected objects.
export function aiContentBlocks(content: readonly BlockNode[]): AiContentBlock[] {
  const result: AiContentBlock[] = [];
  let tableIndex = 0;
  for (const block of content) {
    if (block.type === "paragraph" || block.type === "heading") {
      result.push({
        id: block.id,
        type: block.type,
        structure: block.type === "heading" ? "标题" : "正文",
        parts: inlineParts(block.content),
      });
    } else if (block.type === "bullet-list" || block.type === "ordered-list") {
      for (const [i, item] of block.items.entries()) {
        for (const p of item.content) {
          result.push({
            id: p.id,
            type: "paragraph",
            structure: `${block.type === "ordered-list" ? "有序" : "无序"}列表 项${i + (block.type === "ordered-list" ? block.start : 1)}`,
            parts: inlineParts(p.content),
          });
        }
      }
    } else if (block.type === "table") {
      tableIndex++;
      const occupied: number[] = [];
      block.rows.forEach((row, r) => {
        let column = 0;
        row.cells.forEach((cell) => {
          while ((occupied[column] ?? 0) > r) column++;
          const start = column;
          for (let c = start; c < start + cell.colSpan; c++) occupied[c] = r + cell.rowSpan;
          column += cell.colSpan;
          for (const p of cell.content) {
            result.push({
              id: p.id,
              type: "paragraph",
              structure: `表${tableIndex} 行${r + 1} 列${start + 1} 跨${cell.rowSpan}行${cell.colSpan}列${r < (block.headerRowCount ?? 0) ? " 表头" : ""}`,
              parts: inlineParts(p.content),
            });
          }
        });
      });
    } else {
      result.push({
        id: block.id,
        type: "object",
        structure: "只读对象",
        parts: [
          {
            text: "\uFFFC",
            description:
              block.type === "block-formula"
                ? `公式 ${JSON.stringify(block.source)}`
                : block.type === "page-break"
                  ? "分页"
                  : "图片或结构图（未读取图像内容）",
          },
        ],
      });
    }
  }
  return result;
}

export function mixedSelection(blocks: readonly AiContentBlock[], spans: readonly MixedSpan[]) {
  let previous = -1;
  const lines = spans.map((span, index): MixedLine => {
    const at = blocks.findIndex((b) => b.id === span.blockId);
    const block = blocks[at];
    if (
      !block ||
      at <= previous ||
      block.type !== span.blockType ||
      span.startOffset < 0 ||
      span.endOffset < span.startOffset ||
      span.endOffset > block.parts.reduce((n, p) => n + p.text.length, 0)
    )
      throw new Error("选区结构已变化，请重新选择。");
    previous = at;
    let offset = 0;
    const parts: MixedLine["parts"] = [];
    for (const part of block.parts) {
      const start = Math.max(offset, span.startOffset),
        end = Math.min(offset + part.text.length, span.endOffset);
      if (end > start) {
        const text = part.text.slice(start - offset, end - offset);
        parts.push({
          start,
          end,
          text,
          ...(part.description
            ? { token: `〔只读${index + 1}.${parts.length + 1} ${part.description}〕` }
            : {}),
        });
      }
      offset += part.text.length;
    }
    const prefix = `〔片段${index + 1} ${block.structure}〕`;
    return { prefix, span, parts, text: prefix + parts.map((p) => p.token ?? p.text).join("") };
  });
  return { text: lines.map((line) => line.text).join("\n"), lines };
}

// Validate every protected boundary before preparing any editor transaction.
export function mixedTextRuns(
  line: MixedLine,
  revised: string,
): Array<{ start: number; end: number; text: string }> | null {
  if (!revised.startsWith(line.prefix)) return null;
  let cursor = line.prefix.length,
    start = line.span.startOffset;
  const runs: Array<{ start: number; end: number; text: string }> = [];
  for (const part of line.parts) {
    if (!part.token) continue;
    const at = revised.indexOf(part.token, cursor);
    if (at < 0) return null;
    const text = revised.slice(cursor, at);
    if (text.includes("〔") || text.includes("〕") || text.includes("\uFFFC")) return null;
    runs.push({ start, end: part.start, text });
    cursor = at + part.token.length;
    start = part.end;
  }
  const text = revised.slice(cursor);
  if (text.includes("〔") || text.includes("〕") || text.includes("\uFFFC")) return null;
  runs.push({ start, end: line.span.endOffset, text });
  return runs;
}

export function mixedTextForDisplay(text: string): string {
  return text
    .replace(/^〔片段\d+ [^〕]*〕/gmu, "")
    .replace(
      /〔只读\d+\.\d+ (公式 "(?:\\.|[^"\\])*"|换行|[^〕]*)〕/gu,
      (_match, description: string) => {
        if (description === "换行") return "\n";
        if (description.startsWith("公式 ")) {
          try {
            return JSON.parse(description.slice(3)) as string;
          } catch {
            return description;
          }
        }
        return `〔${description}〕`;
      },
    );
}
