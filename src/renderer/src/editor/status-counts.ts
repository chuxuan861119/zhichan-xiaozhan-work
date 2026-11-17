import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

function visibleText(doc: ProseMirrorNode, from = 0, to = doc.content.size): string {
  let text = "";
  doc.nodesBetween(from, to, (node, position) => {
    if (["inlineMath", "blockMath"].includes(node.type.name)) {
      if (typeof node.attrs.latex === "string") text += node.attrs.latex;
      return false;
    }
    if (node.isText && node.text) {
      const start = Math.max(0, from - position);
      const end = Math.min(node.text.length, to - position);
      text += node.text.slice(start, end);
    }
    if (node.type.name === "figure") {
      return false;
    }
    return true;
  });
  return text.replace(/\r\n?/gu, "\n");
}

function countVisibleCharacters(text: string): number {
  return countText(text).totalCharacters;
}

type TextCounts = Readonly<{ chineseCharacters: number; totalCharacters: number }>;
// ProseMirror nodes are immutable. An edit only invalidates the changed subtree;
// WeakMap entries disappear together with discarded documents/history nodes.
const countsByNode = new WeakMap<ProseMirrorNode, TextCounts>();

function countText(text: string): TextCounts {
  let chineseCharacters = 0;
  let totalCharacters = 0;
  for (const character of text) {
    if (/\p{Script=Han}/u.test(character)) chineseCharacters += 1;
    if (!/\p{White_Space}/u.test(character)) totalCharacters += 1;
  }
  return { chineseCharacters, totalCharacters };
}

export function countDocumentText(doc: ProseMirrorNode): TextCounts {
  const cached = countsByNode.get(doc);
  if (cached) return cached;
  let counts: TextCounts;
  if (doc.isText) {
    counts = countText(doc.text ?? "");
  } else if (doc.type.name === "inlineMath" || doc.type.name === "blockMath") {
    counts = countText(typeof doc.attrs.latex === "string" ? doc.attrs.latex : "");
  } else {
    let chineseCharacters = 0;
    let totalCharacters = 0;
    if (doc.type.name !== "figure") {
      doc.forEach((child) => {
        const childCounts = countDocumentText(child);
        chineseCharacters += childCounts.chineseCharacters;
        totalCharacters += childCounts.totalCharacters;
      });
    }
    counts = { chineseCharacters, totalCharacters };
  }
  countsByNode.set(doc, counts);
  return counts;
}

export function countSelectedText(doc: ProseMirrorNode, from: number, to: number): number {
  if (from === to) return 0;
  return countVisibleCharacters(visibleText(doc, from, to));
}
