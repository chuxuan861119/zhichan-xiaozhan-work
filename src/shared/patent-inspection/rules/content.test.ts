import { describe, expect, test } from "vitest";
import { createBlankPatent } from "../../patent/defaults.js";
import { runPatentInspection } from "../engine.js";
import {
  abstractLengthRule,
  issuesForTitle,
  patentNameLengthRule,
  promotionalLanguageRule,
} from "./content.js";

function issuesForText(text: string) {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const abstract = patent.books.find((book) => book.kind === "abstract");
  if (!abstract) throw new Error("fixture");
  abstract.document.content = [
    {
      id: "00000000-0000-4000-8000-000000000101",
      type: "paragraph",
      attrs: {
        alignment: "left",
        paragraphIndentMm: 0,
        lineSpacing: 1.5,
        defaultFontFamily: "SimSun",
        defaultFontSizePt: 12,
      },
      content: [{ type: "text", text, marks: [] }],
    },
  ];
  return runPatentInspection(patent, [abstractLengthRule]).issues;
}

describe("patent title and abstract content rules", () => {
  test("uses suggestion and warning boundaries for the patent name", () => {
    expect(issuesForTitle("甲".repeat(25))).toEqual([]);
    expect(issuesForTitle("甲".repeat(26))[0]).toMatchObject({ severity: "suggestion" });
    expect(issuesForTitle("甲".repeat(60))[0]).toMatchObject({ severity: "suggestion" });
    expect(issuesForTitle("甲".repeat(61))[0]).toMatchObject({ severity: "warning" });
    expect(issuesForTitle("甲".repeat(26))[0]?.locations).toEqual([
      {
        kind: "book",
        bookKind: "abstract",
        targetId: null,
        metadataField: "patent-name",
      },
    ]);

    const patent = createBlankPatent({ patentType: "invention", name: "甲".repeat(26) });
    const issue = runPatentInspection(patent, [patentNameLengthRule]).issues[0];
    expect(issue?.locations[0]).toEqual({
      kind: "book",
      bookKind: "abstract",
      targetId: null,
      metadataField: "patent-name",
    });
  });

  test("counts only the visible abstract text and keeps 300 characters valid", () => {
    expect(issuesForText("甲".repeat(300))).toEqual([]);
    expect(issuesForText("甲".repeat(301))[0]).toMatchObject({
      severity: "warning",
      summary: "摘要超过 300 字，请人工压缩。",
    });
  });

  test("does not count a separately stored name twice", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "甲".repeat(10) });
    const abstract = patent.books.find((book) => book.kind === "abstract");
    if (!abstract) throw new Error("fixture");
    abstract.document.content = [
      {
        id: "00000000-0000-4000-8000-000000000102",
        type: "paragraph",
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text", text: "甲".repeat(290), marks: [] }],
      },
    ];
    expect(runPatentInspection(patent, [abstractLengthRule]).issues).toEqual([]);
  });

  test("matches only complete promotional phrases and ignores punctuation endings", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "名称" });
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    description.document.content = [
      {
        id: "00000000-0000-4000-8000-000000000103",
        type: "paragraph",
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [
          { type: "text", text: "本装置技术方案完整；本方法具有世界领先水平。", marks: [] },
        ],
      },
    ];
    const issues = runPatentInspection(patent, [promotionalLanguageRule]).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: "core.content.promotional-language",
      confidence: "likely",
      severity: "suggestion",
      locations: [{ kind: "book", bookKind: "description" }],
    });
  });

  test("reports every occurrence of a promotional phrase in the same block", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "名称" });
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const paragraph = description.document.content.find((block) => block.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [{ type: "text", text: "本方案世界领先，并再次声称世界领先。", marks: [] }];

    const issues = runPatentInspection(patent, [promotionalLanguageRule]).issues;
    expect(issues).toHaveLength(2);
    expect(
      issues.map((item) => item.locations[0]?.startOffset).sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([3, 13]);
  });
});
