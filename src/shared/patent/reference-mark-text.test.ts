import { describe, expect, test } from "vitest";
import { createBlankPatent } from "./defaults.js";
import { classifyDescriptionChapterBlock } from "./description.js";
import {
  cancelClaimsKeywordNumber,
  cancelEmbodimentKeywordNumber,
  countKeyword,
  keywordNumbers,
  maxParenthesizedNumber,
  numberClaimsKeyword,
  protectedClaimsKeywordSearches,
  recolorClaimsKeywordNumber,
  renameKeyword,
  renumberClaimsKeyword,
  renumberEmbodimentKeyword,
  renumberTextBookKeyword,
} from "./reference-mark-text.js";
import { AUTOMATIC_EDIT_RED, referenceNumberColor } from "./reference-marks.js";

function claimsContaining(keyword: string) {
  const patent = createBlankPatent({ patentType: "invention", name: keyword });
  const claims = patent.books.find((book) => book.kind === "claims");
  const paragraph = claims?.document.content.find((block) => block.type === "paragraph");
  if (!claims || paragraph?.type !== "paragraph") throw new Error("fixture");
  paragraph.content = [{ type: "text", text: keyword, marks: [] }];
  claims.document.content = [paragraph];
  return claims;
}

describe("reference mark text operations", () => {
  test("preserves unchanged suffix formatting during rename and cancellation", () => {
    const book = claimsContaining("箱体");
    const paragraph = book.document.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [
      { type: "text", text: "箱", marks: [{ type: "bold" }] },
      { type: "text", text: "体", marks: [{ type: "italic" }] },
      { type: "text", text: "(5)", marks: [{ type: "underline" }] },
    ];
    const renamed = renameKeyword(book.document, "箱体", "机箱体");
    const cancelled = cancelClaimsKeywordNumber(renamed.document, "机箱体", 5);
    const changed = cancelled.document.content[0];
    if (changed?.type !== "paragraph") throw new Error("fixture");
    const runs = changed.content.filter((node) => node.type === "text");
    expect(runs.map((node) => node.text).join("")).toBe("机箱体");
    expect(runs[0]?.marks).toContainEqual({ type: "bold" });
    expect(runs.at(-1)?.marks).toContainEqual({ type: "italic" });
    expect(runs.at(-1)?.marks).not.toContainEqual({ type: "bold" });
    expect(paragraph.content[2]).toMatchObject({ text: "(5)", marks: [{ type: "underline" }] });
  });
  test.each(["claims", "description"] as const)(
    "preserves mixed formatting when renumbering %s",
    (kind) => {
      const book = claimsContaining("箱体");
      const paragraph = book.document.content[0];
      if (paragraph?.type !== "paragraph") throw new Error("fixture");
      paragraph.content = [
        { type: "text", text: "箱", marks: [{ type: "bold" }] },
        { type: "text", text: "体", marks: [{ type: "italic" }] },
        { type: "text", text: kind === "claims" ? "(5)" : "5", marks: [{ type: "underline" }] },
      ];
      const result = (kind === "claims" ? renumberClaimsKeyword : renumberTextBookKeyword)(
        book.document,
        "箱体",
        5,
        8,
      );
      const changed = result.document.content[0];
      if (changed?.type !== "paragraph") throw new Error("fixture");
      expect(changed.content).toEqual([
        {
          type: "text",
          text: "箱",
          marks: [{ type: "bold" }, { type: "reference-mark-token", number: 8 }],
        },
        {
          type: "text",
          text: "体",
          marks: [{ type: "italic" }, { type: "reference-mark-token", number: 8 }],
        },
        {
          type: "text",
          text: kind === "claims" ? "(8)" : "8",
          marks: [{ type: "underline" }, { type: "reference-mark-token", number: 8 }],
        },
      ]);
    },
  );
  test.each([
    ["甲电池包主体(1)", "甲电池", "电池包主体", 0],
    ["甲电池包主体(1)", "主体(", "电池包主体", 0],
    ["池池池池(1)", "池池池", "池池", 0],
    ["池池池(1)", "池池", "池池", 0],
    ["甲电池包主体(1)", "甲", "电池包主体", 1],
    ["电池包主体组件", "电池包主体组件", "电池包主体", 1],
  ] as const)(
    "protects partial keyword intersections in %s when numbering %s",
    (text, keyword, registeredKeyword, count) => {
      const claims = claimsContaining(text);
      const before = structuredClone(claims.document);
      const result = numberClaimsKeyword(claims.document, keyword, 2, {
        protectedSearches: protectedClaimsKeywordSearches(claims.document, keyword, [
          { keyword: registeredKeyword, number: 1 },
        ]),
      });
      expect(result.replacementCount).toBe(count);
      expect(claims.document).toEqual(before);
      if (count === 0) expect(result.document).toEqual(before);
    },
  );

  test("numbers and later cancels literal claim keywords while retaining text", () => {
    const claims = claimsContaining("测试");
    const numbered = numberClaimsKeyword(claims.document, "测试", 1);
    expect(JSON.stringify(numbered.document)).toContain("测试(1)");
    expect(numbered.replacementCount).toBe(1);
    const numberedText = numbered.document.content.flatMap((block) =>
      block.type === "paragraph" ? block.content : [],
    );
    expect(numberedText).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          marks: expect.arrayContaining([{ type: "reference-mark-token", number: 1 }]),
        }),
      ]),
    );
    expect(JSON.stringify(numbered.document)).not.toContain(referenceNumberColor(1));
    const cancelled = cancelClaimsKeywordNumber(numbered.document, "测试", 1);
    expect(JSON.stringify(cancelled.document)).toContain("测试");
    const cancelledNodes = cancelled.document.content.flatMap((block) =>
      block.type === "paragraph" ? block.content : [],
    );
    const cancelledKeyword = cancelledNodes.find(
      (node) => node.type === "text" && node.text.includes("测试"),
    );
    if (cancelledKeyword?.type !== "text") throw new Error("fixture");
    expect(cancelledKeyword.marks).toContainEqual({ type: "color", value: AUTOMATIC_EDIT_RED });
    expect(cancelledKeyword.marks.some((mark) => mark.type === "background-color")).toBe(false);
  });

  test("renames and renumbers exact text occurrences", () => {
    const claims = claimsContaining("箱体");
    const numbered = numberClaimsKeyword(claims.document, "箱体", 4);
    expect(keywordNumbers(numbered.document, "箱体")).toEqual([4]);
    expect(maxParenthesizedNumber(numbered.document)).toBe(4);
    const renumbered = renumberClaimsKeyword(numbered.document, "箱体", 4, 7);
    expect(JSON.stringify(renumbered.document)).toContain("箱体(7)");
    const renamed = renameKeyword(renumbered.document, "箱体", "回收箱");
    expect(countKeyword(renamed.document, "回收箱")).toBeGreaterThan(0);
  });

  test("numbers a keyword split across adjacent rich-text runs", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "拆分" });
    const claims = patent.books.find((book) => book.kind === "claims");
    const paragraph = claims?.document.content.find((block) => block.type === "paragraph");
    if (!claims || paragraph?.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [
      { type: "text", text: "箱", marks: [{ type: "bold" }] },
      { type: "text", text: "体", marks: [{ type: "underline" }] },
    ];

    const numbered = numberClaimsKeyword(claims.document, "箱体", 3);
    const result = numbered.document.content.find(
      (block) => block.type === "paragraph" && block.id === paragraph.id,
    );
    if (result?.type !== "paragraph") throw new Error("fixture");
    expect(result.content.map((node) => (node.type === "text" ? node.text : "")).join("")).toBe(
      "箱体(3)",
    );
    expect(numbered.replacementCount).toBe(1);
  });

  test("does not renumber an embodiment number that is part of a longer number", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "边界" });
    const description = patent.books.find((book) => book.kind === "description");
    const embodimentsIndex =
      description?.document.content.findIndex(
        (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
      ) ?? -1;
    const paragraph = description?.document.content
      .slice(embodimentsIndex + 1)
      .find((block) => block.type === "paragraph");
    if (!description || paragraph?.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [
      { type: "text", text: "箱体10与箱体1共存。", marks: [] },
      { type: "text", text: "箱体1", marks: [] },
    ];

    const renumbered = renumberEmbodimentKeyword(description.document, "箱体", 1, 3);
    const result = renumbered.document.content.find(
      (block) => block.type === "paragraph" && block.id === paragraph.id,
    );
    if (result?.type !== "paragraph") throw new Error("fixture");
    const text = result.content.map((node) => (node.type === "text" ? node.text : "")).join("");
    expect(text).toBe("箱体10与箱体3共存。箱体3");
    expect(text).toContain("箱体10");
    expect(renumbered.replacementCount).toBe(2);
    const highlighted = result.content.filter(
      (node) => node.type === "text" && node.text.includes("箱体3"),
    );
    expect(highlighted).not.toHaveLength(0);
    for (const node of highlighted) {
      if (node.type !== "text") throw new Error("fixture");
      expect(node.marks).toContainEqual({ type: "reference-mark-token", number: 3 });
      expect(node.marks).not.toContainEqual({
        type: "background-color",
        value: referenceNumberColor(3),
      });
      expect(node.marks).not.toContainEqual({ type: "color", value: AUTOMATIC_EDIT_RED });
    }
  });

  test("does not cancel an embodiment number that is part of a longer number", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "边界" });
    const description = patent.books.find((book) => book.kind === "description");
    const embodimentsIndex =
      description?.document.content.findIndex(
        (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
      ) ?? -1;
    const paragraph = description?.document.content
      .slice(embodimentsIndex + 1)
      .find((block) => block.type === "paragraph");
    if (!description || paragraph?.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [{ type: "text", text: "箱体10与箱体1共存。", marks: [] }];

    const cancelled = cancelEmbodimentKeywordNumber(description.document, "箱体", 1);
    const result = cancelled.document.content.find(
      (block) => block.type === "paragraph" && block.id === paragraph.id,
    );
    if (result?.type !== "paragraph") throw new Error("fixture");
    const text = result.content.map((node) => (node.type === "text" ? node.text : "")).join("");
    expect(text).toBe("箱体10与箱体共存。");
    expect(cancelled.replacementCount).toBe(1);
  });

  test("normalizes existing numbered occurrences without retaining legacy automatic colors", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "重涂" });
    const claims = patent.books.find((book) => book.kind === "claims");
    const paragraph = claims?.document.content.find((block) => block.type === "paragraph");
    if (!claims || paragraph?.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [
      {
        type: "text",
        text: "箱体（2）",
        marks: [
          { type: "color", value: "#123456" },
          { type: "background-color", value: "#FFFFFF" },
        ],
      },
    ];

    const recolored = recolorClaimsKeywordNumber(claims.document, "箱体", 2);
    const result = recolored.document.content.find(
      (block) => block.type === "paragraph" && block.id === paragraph.id,
    );
    if (result?.type !== "paragraph") throw new Error("fixture");
    const node = result.content.find((inline) => inline.type === "text");
    if (node?.type !== "text") throw new Error("fixture");
    expect(node.text).toBe("箱体(2)");
    expect(node.marks).toContainEqual({ type: "color", value: "#123456" });
    expect(node.marks).toContainEqual({ type: "background-color", value: "#FFFFFF" });
    expect(node.marks).toContainEqual({ type: "reference-mark-token", number: 2 });
    expect(node.marks).not.toContainEqual({
      type: "background-color",
      value: referenceNumberColor(2),
    });
  });

  test("excludes only the drawing legend while counting an ordinary sentence beginning with 其中", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "图例计数边界" });
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const embodimentsIndex = description.document.content.findIndex(
      (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
    );
    const body = description.document.content
      .slice(embodimentsIndex + 1)
      .find((block) => block.type === "paragraph");
    if (body?.type !== "paragraph") throw new Error("fixture");
    body.content = [{ type: "text", text: "其中一个实施例包含箱体。", marks: [] }];
    description.document.content.splice(embodimentsIndex, 0, {
      id: "00000000-0000-4000-8000-000000009936",
      type: "paragraph",
      attrs: { ...body.attrs },
      content: [{ type: "text", text: "其中：1、箱体。", marks: [] }],
    });

    expect(countKeyword(description.document, "箱体")).toBe(2);
    expect(countKeyword(description.document, "箱体", { excludeLegend: true })).toBe(1);
  });
});
