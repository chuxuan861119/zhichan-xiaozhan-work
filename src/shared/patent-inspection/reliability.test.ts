import { describe, expect, test } from "vitest";
import type { ParagraphNode } from "../document/model.js";
import { createBlankPatent } from "../patent/defaults.js";
import type { CanonicalPatent, PatentBookKind } from "../patent/model.js";
import { inspectPatent } from "../patent/validation.js";

function paragraph(text: string): ParagraphNode {
  return {
    id: crypto.randomUUID(),
    type: "paragraph",
    attrs: {
      alignment: "left",
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 14,
    },
    content: [{ type: "text", text, marks: [] }],
  };
}
function replace(patent: CanonicalPatent, kind: PatentBookKind, texts: string[]): CanonicalPatent {
  return {
    ...patent,
    books: patent.books.map((book) =>
      book.kind === kind
        ? { ...book, document: { ...book.document, content: texts.map(paragraph) } }
        : book,
    ),
  };
}
function sample() {
  let patent = createBlankPatent({ name: "装置", patentType: "invention" });
  patent = replace(patent, "claims", ["1. 一种装置，包括壳体。"]);
  patent = replace(patent, "abstract", ["本发明公开一种装置。"]);
  return replace(patent, "description", [
    "技术领域",
    "本发明涉及装置。",
    "背景技术",
    "已有装置存在不足。",
    "发明内容",
    "本发明提供一种装置。",
    "有益效果",
    "便于装配。",
    "附图说明",
    "图1为示意图。",
    "具体实施方式",
    "装置由壳体组成。",
  ]);
}
describe("quick inspection reliability", () => {
  test.each(["1或者9", "第9项", "９", "一"])(
    "does not silently lose references: %s",
    (reference) => {
      const report = inspectPatent(
        replace(sample(), "claims", ["1. 一种装置。", `2. 根据权利要求${reference}所述的装置。`]),
      );
      expect(report.issues.some((i) => i.legacyCode === "claim-reference-warning")).toBe(true);
    },
  );
  test("recognizes exact chapter text regardless of formatting and beneficial alias", () => {
    const patent = sample();
    const changed = {
      ...patent,
      books: patent.books.map((b) =>
        b.kind === "description"
          ? {
              ...b,
              document: {
                ...b.document,
                content: b.document.content.map((block) =>
                  block.type === "paragraph"
                    ? {
                        ...block,
                        attrs: { ...block.attrs, paragraphIndentMm: 7.4 },
                        content: block.content.map((n) =>
                          n.type === "text" && n.text === "有益效果"
                            ? { ...n, text: "有益之处" }
                            : n,
                        ),
                      }
                    : block,
                ),
              },
            }
          : b,
      ),
    };
    expect(
      inspectPatent(changed).issues.some(
        (issue) =>
          issue.legacyCode === "missing-description-chapter" ||
          issue.legacyCode === "description-chapter-duplicate" ||
          issue.legacyCode === "description-chapter-order",
      ),
    ).toBe(false);
  });
  test("counts subsection text toward invention content", () => {
    const patent = replace(sample(), "description", [
      "技术领域",
      "正文",
      "背景技术",
      "正文",
      "发明内容",
      "要解决的技术问题",
      "正文",
      "技术方案",
      "正文",
      "有益效果",
      "正文",
      "附图说明",
      "正文",
      "具体实施方式",
      "正文",
    ]);
    expect(
      inspectPatent(patent).issues.some(
        (issue) => issue.legacyCode === "missing-description-chapter",
      ),
    ).toBe(false);
  });
  test("aggregates dense multiple-dependent references", () => {
    const patent = replace(
      sample(),
      "claims",
      Array.from({ length: 100 }, (_, i) =>
        i < 2 ? `${i + 1}. 一种装置。` : `${i + 1}. 根据权利要求1至${i}任一项所述的装置。`,
      ),
    );
    expect(inspectPatent(patent).issues.length).toBeLessThan(150);
  });
  test("bounds range expansion and reports the unsupported range", () => {
    const report = inspectPatent(
      replace(sample(), "claims", ["1. 一种装置。", "2. 根据权利要求1至20000所述的装置。"]),
    );
    expect(report.issues.length).toBeLessThan(30);
    expect(report.issues.some((i) => /引用范围.*过大/u.test(i.summary))).toBe(true);
  });
  test("rejects huge numeric ranges before allocation", () => {
    const report = inspectPatent(
      replace(sample(), "claims", ["1. 一种装置。", "2. 根据权利要求1至99999999所述的装置。"]),
    );
    expect(report.issues.length).toBeLessThan(30);
    expect(report.issues.some((i) => /引用范围.*过大/u.test(i.summary))).toBe(true);
    expect(report.degradedRules).toEqual([]);
  });
  test("uses document navigation for book-level issues and block navigation for placeholders", () => {
    const patent = replace(replace(sample(), "abstract", ["甲".repeat(301)]), "claims", [
      "1. 一种______装置。",
    ]);
    const report = inspectPatent(patent);
    expect(
      report.issues.find((i) => i.legacyCode === "abstract-too-long")?.locations[0]?.targetId,
    ).toBeNull();
    expect(
      report.issues.find((i) => i.legacyCode === "unresolved-template-placeholder")?.locations[0]
        ?.targetId,
    ).toBe(patent.books.find((b) => b.kind === "claims")?.document.content[0]?.id);
  });
  test("duplicate numbers do not suppress unrelated checks", () => {
    const patent = replace(
      replace(sample(), "claims", ["1. 一种装置。", "1. 一种设备。"]),
      "abstract",
      ["甲".repeat(301)],
    );
    const report = inspectPatent(patent);
    expect(report.issues.some((i) => /重复/u.test(i.summary))).toBe(true);
    expect(report.issues.some((i) => i.legacyCode === "abstract-too-long")).toBe(true);
    expect(report.degradedRules.some((r) => r.ruleId === "engine.facts")).toBe(false);
  });
  test("detects missing chapters even when none are recognized", () => {
    const report = inspectPatent(replace(sample(), "description", ["本发明涉及一种装置。"]));
    expect(report.issues.some((i) => /未找到.*技术领域/u.test(i.summary))).toBe(true);
  });
  test("does not require a drawing chapter for an invention without drawing books", () => {
    const patent = replace(sample(), "description", [
      "技术领域",
      "正文",
      "背景技术",
      "正文",
      "发明内容",
      "正文",
      "有益效果",
      "正文",
      "具体实施方式",
      "正文",
    ]);
    expect(
      inspectPatent({ ...patent, drawingBooksEnabled: false }).issues.some(
        (issue) => issue.legacyCode === "missing-description-chapter",
      ),
    ).toBe(false);
  });
  test("accepts a range followed directly by 任一项", () => {
    const report = inspectPatent(
      replace(sample(), "claims", [
        "1. 一种装置。",
        "2. 一种设备。",
        "3. 根据权利要求1至2任一项所述的装置。",
      ]),
    );
    expect(report.issues.some((i) => i.legacyCode === "claim-multiple-reference-choice")).toBe(
      false,
    );
  });
  test("reports reversed reference ranges", () => {
    const report = inspectPatent(
      replace(sample(), "claims", ["1. 一种装置。", "2. 根据权利要求3至1所述的装置。"]),
    );
    expect(report.issues.some((i) => /引用范围.*无效/u.test(i.summary))).toBe(true);
  });
  test("locates empty chapters at real headings and terminology in its actual book", () => {
    const patent = replace(replace(sample(), "description", ["背景技术"]), "claims", [
      "1. 本实用新型包括壳体。",
    ]);
    const report = inspectPatent(patent);
    const heading = patent.books.find((b) => b.kind === "description")?.document.content[0];
    expect(report.issues.some((i) => i.locations[0]?.targetId === heading?.id)).toBe(true);
    const term = report.issues.find((i) => i.legacyCode === "terminology-mismatch");
    expect(term?.locations[0]).toMatchObject({
      bookKind: "claims",
      targetId: patent.books.find((b) => b.kind === "claims")?.document.content[0]?.id,
    });
  });
});
