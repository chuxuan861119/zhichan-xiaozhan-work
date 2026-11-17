export type ContentSearchSpan = {
  start: number;
  end: number;
  nodeId?: string | undefined;
  textOffset: number;
  annotation?: "name" | "note";
};

/** Keep this factory self-contained: the search worker embeds it without loading renderer code. */
export function createContentSearchTools() {
  function* matches(text: string, query: string) {
    if (!query || query.includes("\u0000")) return;
    const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of text.matchAll(new RegExp(pattern, "giu")))
      yield { from: match.index, to: match.index + match[0].length };
  }
  function collect(value: unknown) {
    const parts: string[] = [];
    const spans: ContentSearchSpan[] = [];
    let length = 0;
    const boundary = () => {
      parts.push("\u0000");
      length++;
    };
    function walk(value: unknown, owner?: { id: string | undefined; offset: number }) {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      const attrs = (node.attrs ?? {}) as Record<string, unknown>;
      const id =
        typeof node.id === "string"
          ? node.id
          : typeof attrs.nodeId === "string"
            ? attrs.nodeId
            : undefined;
      if (node.type === "text" && typeof node.text === "string") {
        spans.push({
          start: length,
          end: length + node.text.length,
          nodeId: owner?.id,
          textOffset: owner?.offset ?? 0,
        });
        parts.push(node.text);
        length += node.text.length;
        if (owner) owner.offset += node.text.length;
        return;
      }
      if (
        [
          "hard-break",
          "hardBreak",
          "page-break",
          "pageBreak",
          "figure",
          "inline-figure",
          "inlineFigure",
          "inline-formula",
          "inlineMath",
          "block-formula",
          "blockMath",
          "chemical-structure",
          "chemicalStructure",
        ].includes(String(node.type))
      ) {
        boundary();
        if (owner) owner.offset++;
        return;
      }
      const annotation = (kind: "name" | "note") => {
        const enabled = kind === "name" ? "tableNameEnabled" : "tableNoteEnabled";
        const field = kind === "name" ? "tableName" : "tableNote";
        const text = node[field] ?? attrs[field];
        if ((node[enabled] ?? attrs[enabled]) !== true || typeof text !== "string" || !text.trim())
          return;
        boundary();
        spans.push({
          start: length,
          end: length + text.length,
          nodeId: id,
          textOffset: 0,
          annotation: kind,
        });
        parts.push(text);
        length += text.length;
        boundary();
      };
      if (node.type === "table") annotation("name");
      const textblock = node.type === "paragraph" || node.type === "heading";
      const current = textblock ? { id, offset: 0 } : owner;
      for (const key of ["content", "items", "rows", "cells"])
        if (Array.isArray(node[key]))
          for (const child of node[key] as unknown[]) walk(child, current);
      if (textblock) boundary();
      if (node.type === "table") annotation("note");
    }
    walk(value);
    return { text: parts.join(""), spans };
  }
  return { matches, collect };
}

export const contentSearchText = createContentSearchTools();
