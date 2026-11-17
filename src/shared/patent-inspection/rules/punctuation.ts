import { inspectionTextBlocks } from "../blocks.js";
import { HEURISTIC_RULE } from "../rule-provenance.js";
import { createInspectionRule, type LegacyIssueShape } from "./helpers.js";

export const repeatedPunctuationRule = createInspectionRule(
  {
    id: "core.content.repeated-punctuation",
    category: "punctuation",
    cost: "instant",
    dependencies: ["claims", "description", "abstract"],
    provenance: HEURISTIC_RULE,
    code: "repeated-punctuation",
  },
  ({ patent }) => {
    const issues: LegacyIssueShape[] = [];
    for (const book of patent.books) {
      if (!["claims", "description", "abstract"].includes(book.kind)) continue;
      for (const block of inspectionTextBlocks(book.document.content)) {
        const text = block.text;
        // Leave ellipses, dashes, decimal dots and paired quotation marks alone.
        for (const match of text.matchAll(/([。，、；：,;:!?！？])\1+|(?<!\.)\.{2}(?!\.)/gu)) {
          const start = match.index;
          issues.push({
            code: "repeated-punctuation",
            severity: "warning",
            confidence: "likely",
            identityKey: `${block.key}:${start}`,
            bookKind: book.kind,
            targetId: block.id,
            startOffset: start,
            endOffset: start + match[0].length,
            excerpt: match[0],
            message: `发现重复标点“${match[0]}”，请核对。`,
            recommendation: `如非有意使用，建议仅保留一个“${match[0][0]}”。`,
          });
        }
      }
    }
    return issues;
  },
);
