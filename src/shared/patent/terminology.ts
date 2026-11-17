import type { InlineNode, PatentBookDocument } from "../document/model.js";
import type { JsonObject } from "../ipc/primitives.js";
import type { CanonicalPatent, PatentBookKind, PatentType } from "./model.js";

export type TerminologyReplacement = Readonly<{
  from: number;
  to: number;
  source: string;
  replacement: string;
}>;

const TO_INVENTION_PATTERNS = [
  { source: "实用新型专利", replacement: "发明专利" },
  { source: "本实用新型", replacement: "本发明" },
  { source: "实用新型内容", replacement: "发明内容" },
] as const;

const TO_UTILITY_MODEL_PATTERNS = [
  { source: "发明专利", replacement: "实用新型专利" },
  { source: "本发明", replacement: "本实用新型" },
  { source: "发明内容", replacement: "实用新型内容" },
] as const;

export type PatentTerminologyBookEdit = {
  bookKind: PatentBookKind;
  document: PatentBookDocument;
  editorState: JsonObject;
};

export function scanPatentTerminology(
  text: string,
  targetPatentType: PatentType,
): readonly TerminologyReplacement[] {
  const patterns =
    targetPatentType === "utility-model" ? TO_UTILITY_MODEL_PATTERNS : TO_INVENTION_PATTERNS;
  const replacements: TerminologyReplacement[] = [];

  for (const pattern of patterns) {
    let from = text.indexOf(pattern.source);
    while (from !== -1) {
      const to = from + pattern.source.length;
      if (!isUnsafeMatch(text, from, to) && !overlapsExisting(replacements, from, to)) {
        replacements.push(Object.freeze({ from, to, ...pattern }));
      }
      from = text.indexOf(pattern.source, from + 1);
    }
  }

  return Object.freeze(replacements.sort((left, right) => left.from - right.from));
}

export function applyTerminologyReplacements(
  text: string,
  replacements: readonly TerminologyReplacement[],
): { text: string; inverse: readonly TerminologyReplacement[] } {
  let nextText = "";
  let cursor = 0;
  const inverse: TerminologyReplacement[] = [];

  for (const replacement of [...replacements].sort((left, right) => left.from - right.from)) {
    nextText += text.slice(cursor, replacement.from);
    const inverseFrom = nextText.length;
    nextText += replacement.replacement;
    cursor = replacement.to;
    inverse.push(
      Object.freeze({
        from: inverseFrom,
        to: inverseFrom + replacement.replacement.length,
        source: replacement.replacement,
        replacement: replacement.source,
      }),
    );
  }

  nextText += text.slice(cursor);

  return { text: nextText, inverse: Object.freeze(inverse) };
}

export function createPatentTerminologyBookEdits(
  patent: CanonicalPatent,
  targetPatentType: PatentType,
): PatentTerminologyBookEdit[] {
  return patent.books.flatMap((book) => {
    const document = structuredClone(book.document);
    let replacementCount = 0;

    for (const block of document.content) {
      if (block.type === "paragraph" || block.type === "heading") {
        replacementCount += replaceInlineNodes(block.content, targetPatentType);
      } else if (block.type === "bullet-list" || block.type === "ordered-list") {
        for (const item of block.items) {
          for (const paragraph of item.content) {
            replacementCount += replaceInlineNodes(paragraph.content, targetPatentType);
          }
        }
      } else if (block.type === "table") {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            for (const paragraph of cell.content) {
              replacementCount += replaceInlineNodes(paragraph.content, targetPatentType);
            }
          }
        }
      }
    }

    if (replacementCount === 0) return [];
    document.modifiedAt = new Date().toISOString();
    return [
      {
        bookKind: book.kind,
        document,
        editorState: structuredClone(book.editorState),
      },
    ];
  });
}

function replaceInlineNodes(content: InlineNode[], targetPatentType: PatentType): number {
  let replacementCount = 0;
  for (const inline of content) {
    if (inline.type !== "text") continue;
    const replacements = scanPatentTerminology(inline.text, targetPatentType);
    if (replacements.length === 0) continue;
    inline.text = applyTerminologyReplacements(inline.text, replacements).text;
    replacementCount += replacements.length;
  }
  return replacementCount;
}

function overlapsExisting(
  replacements: readonly TerminologyReplacement[],
  from: number,
  to: number,
): boolean {
  return replacements.some((replacement) => from < replacement.to && to > replacement.from);
}

function isUnsafeMatch(text: string, from: number, to: number): boolean {
  const candidate = text.slice(from, to);
  const after = text.slice(to, to + 2);
  if (candidate === "本发明" && (after.startsWith("人") || after.startsWith("创造"))) return true;
  if (candidate === "发明专利" && text.slice(Math.max(0, from - 1), from) === "实用新型") {
    return true;
  }
  return false;
}
