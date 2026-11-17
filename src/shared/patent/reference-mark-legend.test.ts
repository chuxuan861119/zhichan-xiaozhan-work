import { describe, expect, test } from "vitest";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../document/defaults.js";
import {
  type BlockNode,
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type PatentBookDocument,
  type SemanticRole,
} from "../document/model.js";
import {
  lastLegendParagraph,
  lastLegendParagraphAnywhere,
  legendParagraphsInSegment,
  sortReferenceMarksByAppearance,
} from "./reference-mark-legend.js";

let sequence = 0;

function heading(
  text: string,
  semanticRole?: SemanticRole,
): Extract<BlockNode, { type: "heading" }> {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    type: "heading",
    level: 1,
    ...(semanticRole ? { semanticRole } : {}),
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text", text, marks: [] }],
  };
}

function paragraph(
  text: string,
  semanticRole?: SemanticRole,
): Extract<BlockNode, { type: "paragraph" }> {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    type: "paragraph",
    ...(semanticRole ? { semanticRole } : {}),
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text", text, marks: [] }],
  };
}

function description(content: BlockNode[]): PatentBookDocument {
  return {
    formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
    documentId: "00000000-0000-4000-8000-000000000001",
    title: "说明书",
    createdAt: "2026-08-08T00:00:00.000Z",
    modifiedAt: "2026-08-08T00:00:00.000Z",
    page: {
      widthMm: 210,
      heightMm: 297,
      marginTopMm: 25.4,
      marginRightMm: 31.7,
      marginBottomMm: 25.4,
      marginLeftMm: 31.7,
    },
    content,
  };
}

describe("reference mark legend location (text mode)", () => {
  test("locates the legend paragraph by its “其中” text inside the drawing explanation segment", () => {
    const legend = paragraph("其中：1、箱体。");
    const document = description([
      paragraph("有益效果"),
      heading("附图说明", "description-drawings"),
      paragraph("图1为本实用新型的结构示意图。"),
      legend,
      paragraph("具体实施方式"),
    ]);

    expect(legendParagraphsInSegment(document)).toEqual([legend]);
    expect(lastLegendParagraph(document)).toBe(legend);
  });

  test("returns the last matching paragraph when several start with “其中”", () => {
    const first = paragraph("其中：1、箱体。");
    const second = paragraph("其中：1、箱体；2、箱盖。");
    const document = description([
      heading("附图说明", "description-drawings"),
      paragraph("图1为本实用新型的结构示意图。"),
      first,
      second,
      paragraph("具体实施方式"),
    ]);

    expect(legendParagraphsInSegment(document)).toEqual([first, second]);
    expect(lastLegendParagraph(document)).toBe(second);
  });

  test("ignores paragraphs that do not start with “其中”", () => {
    const document = description([
      heading("附图说明", "description-drawings"),
      paragraph("附图标记包括：1、箱体。"),
      paragraph("图1为本实用新型的结构示意图。"),
      paragraph("具体实施方式"),
    ]);

    expect(legendParagraphsInSegment(document)).toEqual([]);
    expect(lastLegendParagraph(document)).toBeNull();
  });

  test("does not treat an ordinary sentence beginning with “其中” as the drawing legend", () => {
    const ordinary = paragraph("其中一个实施例采用弹簧连接。");
    const document = description([
      heading("附图说明", "description-drawings"),
      paragraph("图1为本实用新型的结构示意图。"),
      ordinary,
      paragraph("具体实施方式"),
    ]);

    expect(legendParagraphsInSegment(document)).toEqual([]);
    expect(lastLegendParagraph(document)).toBeNull();
  });

  test("returns no legend when the drawing explanation heading is missing", () => {
    const document = description([
      paragraph("有益效果"),
      paragraph("其中：1、箱体。"),
      paragraph("具体实施方式"),
    ]);

    expect(legendParagraphsInSegment(document)).toEqual([]);
    expect(lastLegendParagraph(document)).toBeNull();
  });

  test("falls back to the whole document when the heading is missing", () => {
    const legend = paragraph("其中：1、箱体。");
    const document = description([paragraph("有益效果"), legend, paragraph("具体实施方式")]);

    expect(lastLegendParagraphAnywhere(document)).toBe(legend);
  });

  test("prefers the drawing explanation segment over other chapters in the fallback scan", () => {
    const outside = paragraph("其中：9、旧部件。");
    const inside = paragraph("其中：1、箱体。");
    const document = description([
      outside,
      heading("附图说明", "description-drawings"),
      inside,
      paragraph("具体实施方式"),
    ]);

    expect(lastLegendParagraphAnywhere(document)).toBe(inside);
  });
});

describe("sortReferenceMarksByAppearance", () => {
  test("sorts by keyword appearance order in claims rather than by number", () => {
    const claims = description([
      paragraph(
        "一种设备，包括箱体（1）、电机（2）和齿轮（3），箱体上还设有支架（301）、连杆（302），以及开关（4）、指示灯（5）。",
      ),
    ]);
    const entries = [
      { number: 4, keyword: "开关" },
      { number: 301, keyword: "支架" },
      { number: 1, keyword: "箱体" },
      { number: 302, keyword: "连杆" },
      { number: 2, keyword: "电机" },
      { number: 3, keyword: "齿轮" },
      { number: 5, keyword: "指示灯" },
    ];

    const sorted = sortReferenceMarksByAppearance(entries, claims);
    expect(sorted.map((entry) => entry.number)).toEqual([1, 2, 3, 301, 302, 4, 5]);
  });

  test("falls back to number order when claims are missing", () => {
    const entries = [
      { number: 301, keyword: "支架" },
      { number: 2, keyword: "电机" },
    ];
    expect(sortReferenceMarksByAppearance(entries, undefined).map((entry) => entry.number)).toEqual(
      [2, 301],
    );
  });

  test("puts keywords absent from claims after present ones", () => {
    const claims = description([paragraph("设备包含电机（2）。")]);
    const entries = [
      { number: 1, keyword: "箱体" },
      { number: 2, keyword: "电机" },
    ];
    const sorted = sortReferenceMarksByAppearance(entries, claims);
    expect(sorted.map((entry) => entry.keyword)).toEqual(["电机", "箱体"]);
  });

  test("does not count a short keyword nested inside a longer numbered keyword as its first appearance", () => {
    const claims = description([paragraph("自行车把手(2)与自行车(1)连接。")]);
    const entries = [
      { number: 1, keyword: "自行车" },
      { number: 2, keyword: "自行车把手" },
    ];

    expect(sortReferenceMarksByAppearance(entries, claims).map((entry) => entry.keyword)).toEqual([
      "自行车把手",
      "自行车",
    ]);
  });

  test("recognizes an interrupted longer keyword as its numbered appearance", () => {
    const claims = description([paragraph("自行车(1)把手(2)与自行车(1)连接。")]);
    const entries = [
      { number: 1, keyword: "自行车" },
      { number: 2, keyword: "自行车把手" },
    ];

    expect(sortReferenceMarksByAppearance(entries, claims).map((entry) => entry.keyword)).toEqual([
      "自行车把手",
      "自行车",
    ]);
  });

  test("keeps the earliest unnumbered appearance ahead of a later numbered appearance", () => {
    const claims = description([paragraph("箱体先出现，随后为电机(2)及箱体(1)。")]);
    const entries = [
      { number: 1, keyword: "箱体" },
      { number: 2, keyword: "电机" },
    ];

    expect(sortReferenceMarksByAppearance(entries, claims).map((entry) => entry.keyword)).toEqual([
      "箱体",
      "电机",
    ]);
  });
});
