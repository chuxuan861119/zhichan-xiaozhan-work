import type { BlockNode, InlineNode } from "../../document/model.js";
import {
  DESCRIPTION_CHAPTER_ORDER,
  type DescriptionChapterKind,
} from "../../patent/description.js";
import { PATENT_BOOK_LABELS } from "../../patent/model.js";
import { visibleBlockText } from "../../patent/text.js";
import { inspectionChapterKind } from "../description-input.js";
import { OFFICIAL_RULE, OFFICIAL_SOURCES } from "../rule-provenance.js";
import type { InspectionIssueDraft, PatentInspectionRule } from "../types.js";
import { createInspectionRule, type LegacyIssueShape } from "./helpers.js";

const TEXT_BOOK_KINDS = new Set(["claims", "description", "abstract"] as const);

function requiredBookIssues(
  ...[_context, facts]: Parameters<ReturnType<typeof createInspectionRule>["inspect"]>
): LegacyIssueShape[] {
  return [...TEXT_BOOK_KINDS].flatMap((kind) => {
    const hasVisibleText = (facts.books.get(kind)?.visibleText ?? "").trim().length > 0;
    return !hasVisibleText
      ? [
          {
            severity: "error" as const,
            code: "empty-required-book" as const,
            bookKind: kind,
            targetId: null,
            message: `${PATENT_BOOK_LABELS[kind]}尚未填写。`,
            recommendation: "补充文档内容。",
          },
        ]
      : [];
  });
}

function placeholderIssues(
  ...[context, _facts]: Parameters<ReturnType<typeof createInspectionRule>["inspect"]>
): LegacyIssueShape[] {
  return context.patent.books
    .filter((book) => TEXT_BOOK_KINDS.has(book.kind as "claims" | "description" | "abstract"))
    .flatMap((book) => {
      const blocks = book.document.content.filter(
        (candidate) =>
          visibleBlockText(candidate).includes("______") || blockHasUnderlinedWhitespace(candidate),
      );
      return blocks.map((block) => {
        const blockText = visibleBlockText(block);
        const startOffset = blockText.indexOf("______");
        return {
          severity: "warning" as const,
          code: "unresolved-template-placeholder" as const,
          bookKind: book.kind,
          targetId: block.id,
          ...(startOffset < 0
            ? {}
            : {
                startOffset,
                endOffset: startOffset + 6,
                excerpt: "______",
              }),
          recommendation: "填写空白处，或删除不用的模板段落。",
          message: `${book.document.title}还有空白模板内容。`,
        };
      });
    });
}

function blockHasUnderlinedWhitespace(block: BlockNode): boolean {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return block.content.some(inlineIsUnderlinedWhitespace);
    case "bullet-list":
    case "ordered-list":
      return block.items.some((item) =>
        item.content.some((paragraph) => paragraph.content.some(inlineIsUnderlinedWhitespace)),
      );
    case "table":
      return block.rows.some((row) =>
        row.cells.some((cell) =>
          cell.content.some((paragraph) => paragraph.content.some(inlineIsUnderlinedWhitespace)),
        ),
      );
    default:
      return false;
  }
}

function inlineIsUnderlinedWhitespace(node: InlineNode): boolean {
  return (
    node.type === "text" &&
    node.text.length > 0 &&
    node.text.trim().length === 0 &&
    node.marks.some((mark) => mark.type === "underline")
  );
}

function chapterBodyIssues(
  ...[context, facts]: Parameters<ReturnType<typeof createInspectionRule>["inspect"]>
): LegacyIssueShape[] {
  const chapters = facts.books.get("description")?.chapters;
  if (!chapters) return [];
  if (!(facts.books.get("description")?.visibleText ?? "").trim()) return [];
  const labels = {
    "technical-field": "技术领域",
    "background-art": "背景技术",
    "invention-content": context.patent.patentType === "invention" ? "发明内容" : "实用新型内容",
    "beneficial-effects": "有益效果",
    "drawing-explanation": "附图说明",
    "detailed-embodiments": "具体实施方式",
  };
  const requiredChapterOrder = DESCRIPTION_CHAPTER_ORDER.filter(
    (kind) => kind !== "beneficial-effects" && kind !== "drawing-explanation",
  );
  const missing: LegacyIssueShape[] = requiredChapterOrder
    .filter((kind) => !chapters.has(kind))
    .map((kind) => ({
      severity: "warning",
      code: "missing-description-chapter",
      bookKind: "description",
      targetId: null,
      identityKey: `missing:${kind}`,
      confidence: "likely",
      message: `未找到“${labels[kind]}”标题。`,
      recommendation: "核对章节标题；采用其他合理结构时可忽略。",
    }));
  return [
    ...missing,
    ...[...chapters.entries()].flatMap(([kind, chapter]) =>
      chapter.bodyText.trim().length > 0 || kind === "drawing-explanation"
        ? []
        : [
            {
              severity:
                kind === "beneficial-effects" ||
                kind === "technical-problem" ||
                kind === "technical-solution"
                  ? ("suggestion" as const)
                  : ("warning" as const),
              code: "missing-description-chapter" as const,
              bookKind: "description" as const,
              targetId: chapter.headingId,
              message: `“${chapterLabel(kind, context.patent.patentType)}”还没有正文。`,
              recommendation: "补充该章节内容。",
            },
          ],
    ),
  ];
}

const CHAPTER_LABELS: Record<DescriptionChapterKind, string> = {
  "technical-field": "技术领域",
  "background-art": "背景技术",
  "invention-content": "发明内容",
  "technical-problem": "要解决的技术问题",
  "technical-solution": "技术方案",
  "beneficial-effects": "有益效果",
  "drawing-explanation": "附图说明",
  "detailed-embodiments": "具体实施方式",
};

function chapterLabel(kind: DescriptionChapterKind, patentType: "invention" | "utility-model") {
  return kind === "invention-content" && patentType === "utility-model"
    ? "实用新型内容"
    : CHAPTER_LABELS[kind];
}

export const descriptionChapterStructureRule: PatentInspectionRule = {
  id: "core.description.chapter-structure",
  version: 1,
  category: "formal",
  defaultSeverity: "suggestion",
  cost: "instant",
  dependencies: ["description", "patent-metadata"],
  provenance: OFFICIAL_RULE(
    OFFICIAL_SOURCES.implementingRegulations2023,
    "第二十条说明书通常按照规定方式和顺序撰写，允许合理例外",
  ),
  appliesTo: () => true,
  inspect: (context): readonly InspectionIssueDraft[] => {
    const description = context.patent.books.find((book) => book.kind === "description");
    if (!description) return [];
    const primaryOrder = DESCRIPTION_CHAPTER_ORDER;
    const orderIndex = new Map(primaryOrder.map((kind, index) => [kind, index]));
    const seen = new Map<DescriptionChapterKind, string>();
    const issues: InspectionIssueDraft[] = [];
    let lastIndex = -1;
    for (const block of description.document.content) {
      const kind = inspectionChapterKind(block);
      if (!kind || kind === "technical-problem" || kind === "technical-solution") continue;
      const location = {
        kind: "book" as const,
        bookKind: "description" as const,
        targetId: block.id,
      };
      const previous = seen.get(kind);
      if (previous) {
        issues.push({
          legacyCode: "description-chapter-duplicate",
          identityKey: `duplicate:${kind}:${block.id}`,
          severity: "suggestion",
          confidence: "certain",
          summary: `说明书章节“${chapterLabel(kind, context.patent.patentType)}”重复出现。`,
          evidence: [{ location, excerpt: visibleBlockText(block) }],
          locations: [location],
          recommendation: "请确认是否需要合并重复章节；确有必要时可保留。",
        });
      } else {
        seen.set(kind, block.id);
      }
      const currentIndex = orderIndex.get(kind) ?? lastIndex;
      if (currentIndex < lastIndex) {
        issues.push({
          legacyCode: "description-chapter-order",
          identityKey: `order:${kind}:${block.id}`,
          severity: "suggestion",
          confidence: "likely",
          summary: `说明书章节“${chapterLabel(kind, context.patent.patentType)}”的顺序与通常撰写顺序不一致。`,
          evidence: [{ location, excerpt: visibleBlockText(block) }],
          locations: [location],
          recommendation: "请核对章节顺序；若当前顺序更简洁且不影响准确理解，可人工忽略。",
        });
      }
      lastIndex = Math.max(lastIndex, currentIndex);
    }
    return issues;
  },
};

export const requiredBooksRule = createInspectionRule(
  {
    id: "core.books.required",
    category: "formal",
    cost: "instant",
    dependencies: ["claims", "description", "abstract", "patent-metadata"],
    provenance: OFFICIAL_RULE(
      OFFICIAL_SOURCES.examinationGuidelines2023,
      "申请文件组成与形式审查要求",
    ),
    code: "empty-required-book",
  },
  requiredBookIssues,
);
export const descriptionChapterBodyRule = createInspectionRule(
  {
    id: "core.description.chapter-body",
    category: "formal",
    cost: "instant",
    dependencies: ["description", "figures", "patent-metadata"],
    provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "说明书的组成和撰写要求"),
    code: "missing-description-chapter",
  },
  chapterBodyIssues,
);
export const unresolvedTemplatePlaceholderRule = createInspectionRule(
  {
    id: "core.templates.placeholder",
    category: "formal",
    cost: "instant",
    dependencies: ["claims", "description", "abstract", "patent-metadata"],
    provenance: OFFICIAL_RULE(OFFICIAL_SOURCES.examinationGuidelines2023, "申请文件应当完整、清楚"),
    code: "unresolved-template-placeholder",
  },
  placeholderIssues,
);
