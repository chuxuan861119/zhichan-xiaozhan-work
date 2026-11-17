import { describe, expect, test } from "vitest";
import type { ParagraphNode } from "../document/model.js";
import { createBlankPatent } from "../patent/defaults.js";
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
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function book(patent: ReturnType<typeof sample>, kind: string) {
  return required(patent.books.find((item) => item.kind === kind));
}
function sample() {
  const patent = createBlankPatent({ name: "装置", patentType: "invention" });
  for (const book of patent.books) {
    if (book.kind === "claims") book.document.content = [paragraph("1. 一种装置，包括壳体。")];
    if (book.kind === "abstract") book.document.content = [paragraph("本发明公开一种装置。")];
    if (book.kind === "description")
      book.document.content = [
        "技术领域",
        "本发明涉及装置。",
        "背景技术",
        "已有装置存在不足。",
        "发明内容",
        "本发明提供一种装置。",
        "有益效果",
        "便于装配。",
        "附图说明",
        "图1为结构示意图。",
        "具体实施方式",
        "装置由壳体组成。",
      ].map(paragraph);
  }
  patent.figures = [{ figureId: crypto.randomUUID(), assetId: crypto.randomUUID(), widthMm: 80 }];
  return patent;
}
describe("inspection accuracy regression", () => {
  for (const kind of ["claims", "description", "abstract"] as const) {
    test.each(["。。", "，，", "；；", ",,", "：："])(
      `${kind} identifies repeated %s exactly`,
      (marks) => {
        const patent = sample();
        const block = paragraph(
          `${kind === "claims" ? "1. " : ""}装置包括壳体${marks}壳体具有通孔。`,
        );
        book(patent, kind).document.content = [block];
        for (const mode of ["instant", "full"] as const) {
          const found = inspectPatent(patent, mode).issues.filter(
            (i) => i.legacyCode === "repeated-punctuation",
          );
          expect(found).toHaveLength(1);
          expect(found[0]?.category).toBe("punctuation");
          expect(found[0]?.evidence[0]?.excerpt).toBe(marks);
          const location = required(required(found[0]).locations[0]);
          expect(location.targetId).toBe(block.id);
          expect(
            block.content[0]?.type === "text" &&
              block.content[0].text.slice(location.startOffset, location.endOffset),
          ).toBe(marks);
        }
      },
    );
  }
  test("normal ellipses, dashes, decimals and paired punctuation are not duplicates", () => {
    const patent = sample();
    book(patent, "abstract").document.content = [
      paragraph("范围为1.5～2.0……结构——壳体；说明：‘正常’。（另见图1）..."),
    ];
    expect(
      inspectPatent(patent).issues.filter((i) => i.legacyCode === "repeated-punctuation"),
    ).toEqual([]);
  });
  test("a repeated final period produces one diagnosis rather than a numbering warning too", () => {
    const patent = sample();
    book(patent, "claims").document.content = [paragraph("1. 一种装置，包括壳体。。")];
    const issues = inspectPatent(patent).issues.filter(
      (i) => i.locations[0]?.bookKind === "claims",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.legacyCode).toBe("repeated-punctuation");
  });
  test("punctuation across differently formatted runs is still one exact range", () => {
    const patent = sample();
    const block = paragraph("壳体。");
    block.content.push({ type: "text", text: "。", marks: [{ type: "bold" }] });
    book(patent, "abstract").document.content = [block];
    const issue = inspectPatent(patent).issues.find((i) => i.legacyCode === "repeated-punctuation");
    expect(issue?.locations[0]).toMatchObject({ startOffset: 2, endOffset: 4, targetId: block.id });
  });
  test("duplicate chapter detection also ignores formatting", () => {
    const patent = sample();
    const block = paragraph("技术领域");
    block.attrs.paragraphIndentMm = 7.4;
    book(patent, "description").document.content.push(block);
    expect(
      inspectPatent(patent).issues.some((i) => i.legacyCode === "description-chapter-duplicate"),
    ).toBe(true);
  });
  test("heading formatting causes no additional warnings and does not mutate the document", () => {
    const patent = sample();
    const baseline = inspectPatent(patent).issues.map((i) => i.legacyCode);
    const block = required(book(patent, "description").document.content[8]);
    if (block.type !== "paragraph") throw new Error("fixture");
    block.attrs.paragraphIndentMm = 7.4;
    block.attrs.alignment = "center";
    const original = JSON.stringify(patent);
    expect(inspectPatent(patent).issues.map((i) => i.legacyCode)).toEqual(baseline);
    expect(JSON.stringify(patent)).toBe(original);
  });
  test.each([
    "如图1、2所示",
    "如图1至3所示",
    "如图２所示",
    "如图1和图2所示",
    "如图二所示",
    "如图十一所示",
  ])("finds missing drawings in %s", (text) => {
    const patent = sample();
    const block = paragraph(`${text}，装置包括壳体。`);
    book(patent, "description").document.content.push(block);
    const issues = inspectPatent(patent).issues.filter(
      (i) => i.legacyCode === "drawing-missing-figure",
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.locations[0]?.targetId).toBe(block.id);
    expect(issues[0]?.evidence[0]?.excerpt).toContain("图");
  });
  test("when drawing books are disabled external references are not treated as local", () => {
    const patent = sample();
    patent.drawingBooksEnabled = false;
    const description = book(patent, "description");
    description.document.content = [paragraph("现有技术文献的图9示出壳体。")];
    expect(
      inspectPatent(patent).issues.some(
        (i) => i.legacyCode === "drawing-reference-without-drawing-books",
      ),
    ).toBe(false);
    description.document.content.push(paragraph("本申请如图二所示。"));
    expect(
      inspectPatent(patent).issues.some(
        (i) => i.legacyCode === "drawing-reference-without-drawing-books",
      ),
    ).toBe(true);
  });
  test("external figure references do not become missing local figures, local references still do", () => {
    const patent = sample();
    book(patent, "description").document.content.push(
      paragraph("现有技术文献的图9示出另一种壳体。本发明如图2所示。"),
    );
    const issues = inspectPatent(patent).issues.filter(
      (i) => i.legacyCode === "drawing-missing-figure",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.evidence[0]?.excerpt).toBe("图2");
  });
  test("internal full stops are classified as punctuation instead of numbering", () => {
    const patent = sample();
    book(patent, "claims").document.content = [
      paragraph("1. 一种装置，包括壳体。所述壳体具有通孔。"),
    ];
    const issues = inspectPatent(patent).issues.filter((i) =>
      i.summary.includes("内部存在中文句号"),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.category).toBe("punctuation");
  });
  test("the word 一般 following 示意图 is not interpreted as figure one", () => {
    const patent = sample();
    patent.figures = [];
    const block = paragraph("结构示意图一般仅显示主要部件。");
    book(patent, "description").document.content.push(block);
    expect(
      inspectPatent(patent).issues.filter(
        (issue) =>
          issue.legacyCode === "drawing-missing-figure" &&
          issue.locations[0]?.targetId === block.id,
      ),
    ).toEqual([]);
  });
});
