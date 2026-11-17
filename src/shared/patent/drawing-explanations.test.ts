import { DEFAULT_PAGE_SETTINGS, DEFAULT_PARAGRAPH_ATTRIBUTES } from "../document/defaults.js";
import {
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type HeadingNode,
  type ParagraphNode,
  type PatentBookDocument,
} from "../document/model.js";
import { inspectDrawingExplanationSync } from "./drawing-explanations.js";

const FIGURE_A = "00000000-0000-4000-8000-000000000501";
const FIGURE_B = "00000000-0000-4000-8000-000000000502";
const FIGURE_C = "00000000-0000-4000-8000-000000000503";

function id(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function heading(): HeadingNode {
  return {
    id: id(520),
    type: "heading",
    level: 1,
    semanticRole: "description-drawings",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text", text: "附图说明", marks: [] }],
  };
}

function explanation(index: number, text: string): ParagraphNode {
  return {
    id: id(530 + index),
    type: "paragraph",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text", text, marks: [] }],
  };
}

function legend(): ParagraphNode {
  return {
    id: id(540),
    type: "paragraph",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text", text: "其中，1、箱体。", marks: [] }],
  };
}

function laterHeading(): HeadingNode {
  return {
    id: id(541),
    type: "heading",
    level: 1,
    semanticRole: "description-embodiments",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text", text: "具体实施方式", marks: [] }],
  };
}

function document(content: PatentBookDocument["content"]): PatentBookDocument {
  return {
    formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
    documentId: id(510),
    title: "说明书",
    createdAt: "2026-08-02T00:00:00.000Z",
    modifiedAt: "2026-08-02T00:00:00.000Z",
    page: { ...DEFAULT_PAGE_SETTINGS },
    content,
  };
}

describe("drawing explanation read-only inspection", () => {
  test("recognizes visible 图N paragraphs and an optional legend", () => {
    const sync = inspectDrawingExplanationSync(
      document([
        heading(),
        explanation(1, "图1为整体结构示意图。"),
        explanation(2, "图2为出料头主视示意图。"),
        legend(),
      ]),
      [FIGURE_A, FIGURE_B],
    );

    expect(sync).toMatchObject({
      status: "active",
      headingId: id(520),
      legend: expect.objectContaining({ id: id(540) }),
    });
    expect(sync.status === "active" ? sync.linked.map((item) => item.figureId) : []).toEqual([
      FIGURE_A,
      FIGURE_B,
    ]);
  });

  test("recognizes 附图N as an equivalent visible prefix", () => {
    const sync = inspectDrawingExplanationSync(
      document([heading(), explanation(1, "附图1为整体结构示意图。")]),
      [FIGURE_A],
    );
    expect(sync.status).toBe("active");
  });

  test("reports a missing heading without modifying the document", () => {
    const source = document([explanation(1, "图1为整体结构示意图。")]);
    const before = structuredClone(source);
    expect(inspectDrawingExplanationSync(source, [FIGURE_A])).toMatchObject({
      status: "paused",
      issues: [expect.objectContaining({ code: "missing-heading" })],
    });
    expect(source).toEqual(before);
  });

  test("reports duplicate, missing, unknown, merged, and out-of-order visible numbers", () => {
    const duplicate = inspectDrawingExplanationSync(
      document([
        heading(),
        explanation(1, "图1为整体结构示意图。"),
        explanation(2, "图1为另一视角示意图。"),
      ]),
      [FIGURE_A, FIGURE_B],
    );
    expect(
      duplicate.status === "paused" ? duplicate.issues.map((issue) => issue.code) : [],
    ).toEqual(expect.arrayContaining(["duplicate-figure", "missing-figure"]));

    const unknown = inspectDrawingExplanationSync(
      document([heading(), explanation(1, "图5为现有技术示意图。")]),
      [FIGURE_A],
    );
    expect(unknown.status === "paused" ? unknown.issues.map((issue) => issue.code) : []).toEqual(
      expect.arrayContaining(["unknown-figure", "missing-figure"]),
    );

    const merged = inspectDrawingExplanationSync(
      document([heading(), explanation(1, "图1为整体图，附图2为局部图。")]),
      [FIGURE_A, FIGURE_B],
    );
    expect(merged.status === "paused" ? merged.issues.map((issue) => issue.code) : []).toContain(
      "merged-explanation-line",
    );

    const outOfOrder = inspectDrawingExplanationSync(
      document([
        heading(),
        explanation(1, "图2为局部结构示意图。"),
        explanation(2, "图1为整体结构示意图。"),
      ]),
      [FIGURE_A, FIGURE_B],
    );
    expect(
      outOfOrder.status === "paused" ? outOfOrder.issues.map((issue) => issue.code) : [],
    ).toContain("out-of-order-explanation");
  });

  test("does not treat figure-like text in later chapters as an explanation", () => {
    const sync = inspectDrawingExplanationSync(
      document([
        heading(),
        explanation(1, "图1为整体结构示意图。"),
        laterHeading(),
        explanation(2, "图2示出了具体实施方式。"),
      ]),
      [FIGURE_A, FIGURE_B],
    );
    expect(sync.status === "paused" ? sync.issues : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-figure", figureId: FIGURE_B }),
      ]),
    );
  });

  test("supports three valid explanations without hidden metadata", () => {
    const sync = inspectDrawingExplanationSync(
      document([
        heading(),
        explanation(1, "图1为整体结构示意图。"),
        explanation(2, "图2为局部结构示意图。"),
        explanation(3, "图3为剖切结构示意图。"),
      ]),
      [FIGURE_A, FIGURE_B, FIGURE_C],
    );
    expect(sync.status).toBe("active");
  });
});
