import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../document/defaults.js";
import type { ParagraphNode } from "../document/model.js";
import { richDraftClipboardFormats } from "./claims-rich-text.js";
import { prepareClaimsForDescription } from "./claims-to-description.js";
import { createBlankPatent } from "./defaults.js";
import { classifyDescriptionChapterBlock } from "./description.js";

function paragraph(text: string): ParagraphNode {
  return {
    id: crypto.randomUUID(),
    type: "paragraph",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text", text, marks: [] }],
  };
}
function fixture(
  texts = [
    "1. 一种箱体装置，包括箱体(1)，其特征在于：所述箱体(1)设有通孔。",
    "2. 根据权利要求1所述的箱体装置，其特征在于：所述箱体(1)的壁厚为5mm；",
    "所述通孔有5个。",
  ],
) {
  const patent = createBlankPatent({ patentType: "invention", name: "箱体装置" });
  patent.books.find((b) => b.kind === "claims")!.document.content = texts.map(paragraph);
  patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), keyword: "箱体", number: 1 }];
  // A subject name should not overlap a registered part in this fixture.
  patent.books.find((b) => b.kind === "claims")!.document.content = texts.map((t) =>
    paragraph(t.replaceAll("箱体装置", "储存装置")),
  );
  return patent;
}

describe("claims to description", () => {
  test("retains styles across removed phrases, references and generated prefixes", () => {
    const patent = fixture();
    const blocks = patent.books.find((b) => b.kind === "claims")!.document
      .content as ParagraphNode[];
    blocks[0]!.content = [
      { type: "text", text: "1. 一种储存装置，其特征在于：所述", marks: [] },
      {
        type: "text",
        text: "箱体",
        marks: [
          { type: "color", value: "#FF0000" },
          { type: "background-color", value: "#FFFF00" },
          { type: "underline" },
          { type: "reference-mark-token", number: 1 },
        ],
      },
      {
        type: "text",
        text: "(1)具有通孔。",
        marks: [{ type: "italic" }, { type: "font-size", valuePt: 16 }],
      },
    ];
    const before = structuredClone(patent);
    for (const target of ["invention-content", "detailed-embodiments"] as const) {
      const result = prepareClaimsForDescription(patent, target);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const formats = richDraftClipboardFormats(result.paragraphs);
      expect(formats.text).toBe(result.text);
      expect(formats.html).toContain(
        "color:#FF0000;background-color:#FFFF00;text-decoration:underline",
      );
      expect(formats.html).toContain("font-style:italic;font-size:16pt");
      expect(formats.html).not.toContain("reference-mark");
      expect(formats.html).not.toContain("其特征在于");
    }
    expect(patent).toEqual(before);
  });
  test("uses the configured prefix only for invention dependent claims", () => {
    const patent = fixture();
    const before = structuredClone(patent);
    const draft = prepareClaimsForDescription(patent, "invention-content", "进一步地，");
    expect(draft).toMatchObject({ ok: true });
    if (draft.ok) {
      expect(draft.text).toContain("\n进一步地，所述箱体的壁厚");
      expect(draft.text).not.toContain("作为优化");
      expect(draft.text.startsWith("一种储存装置")).toBe(true);
    }
    expect(prepareClaimsForDescription(patent, "detailed-embodiments", "进一步地，")).toEqual(
      prepareClaimsForDescription(patent, "detailed-embodiments"),
    );
    expect(patent).toEqual(before);
  });
  test("keeps independent preamble features, transforms dependent claims, preserves paragraphs and source", () => {
    const patent = fixture();
    const before = structuredClone(patent);
    expect(prepareClaimsForDescription(patent, "invention-content")).toMatchObject({
      ok: true,
      text: "一种储存装置，包括箱体，所述箱体设有通孔。\n作为优化，所述箱体的壁厚为5mm；\n所述通孔有5个。",
      claimCount: 2,
    });
    expect(patent).toEqual(before);
  });
  test("embodiments retain numbers without parentheses and without optimization prefixes", () => {
    expect(prepareClaimsForDescription(fixture(), "detailed-embodiments")).toMatchObject({
      ok: true,
      text: "一种储存装置，包括箱体1，所述箱体1设有通孔。\n所述箱体1的壁厚为5mm；\n所述通孔有5个。",
    });
  });
  test("removes a separate title but preserves soft breaks, spaces and blank paragraphs inside a claim", () => {
    const patent = fixture([
      "箱体装置",
      "1. 一种工艺，其特征在于：先  加热；",
      "",
      "S1：保持5mm间距\n再冷却。",
    ]);
    patent.name = "储存装置";
    patent.referenceMarks = [];
    expect(prepareClaimsForDescription(patent, "invention-content")).toMatchObject({
      ok: true,
      text: "一种工艺，先  加热；\n\nS1：保持5mm间距\n再冷却。",
    });
  });
  test("supports full-width punctuation and digits without confusing ordinary dimensions", () => {
    expect(
      prepareClaimsForDescription(
        fixture(["1．一种装置，其特征在于：箱体（１）厚5mm（毫米）。"]),
        "detailed-embodiments",
      ),
    ).toMatchObject({ ok: true, text: "一种装置，箱体1厚5mm（毫米）。" });
  });
  test.each([
    ["1. 一种装置，其特征在于：箱体(2)。", "编号"],
    ["1. 一种装置，其特征在于：箱 体(1)。", "编号"],
    ["1. 一种装置，其特征在于：箱体。", "标记"],
    ["1. 一种装置，其特征在于：公式(9)。", "(9)"],
    ["1. 一种装置，其特征在于：______。", "未填写"],
    ["任意未编号内容", "编号"],
    ["1. 一种装置，其特征在于：第一步；\n2. 第二步。", "分组"],
    ["1. 根据权利要求2所述的装置，其特征在于：完成加工。", "引用"],
  ])("blocks unsafe input: %s", (text, message) => {
    const result = prepareClaimsForDescription(fixture(text.split("\n")), "invention-content");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(message);
  });
  test("does not strip substantive dependent features before the characterizing phrase", () => {
    const patent = fixture([
      "1. 一种装置，其特征在于：设有通孔。",
      "2. 根据权利要求1所述的装置，包括支架，其特征在于：支架能够移动。",
    ]);
    patent.referenceMarks = [];
    expect(prepareClaimsForDescription(patent, "invention-content")).toMatchObject({
      ok: true,
      text: "一种装置，设有通孔。\n作为优化，包括支架，支架能够移动。",
    });
  });
  test("keeps multiple independent claims separate and only prefixes dependent claims", () => {
    const patent = fixture([
      "1. 一种装置，其特征在于：设有通孔。",
      "2. 一种制造方法，其特征在于：进行加工。",
      "3. 根据权利要求1或2所述的装置或方法，其特征在于：进行冷却。",
    ]);
    patent.referenceMarks = [];
    expect(prepareClaimsForDescription(patent, "invention-content")).toMatchObject({
      ok: true,
      claimCount: 3,
      text: "一种装置，设有通孔。\n一种制造方法，进行加工。\n作为优化，进行冷却。",
    });
  });
  test("blocks an ambiguous dependent subject instead of deleting technical features without a separator", () => {
    const patent = fixture([
      "1. 一种装置，其特征在于：设有通孔。",
      "2. 根据权利要求1所述的装置包括支架，其特征在于：支架能够移动。",
    ]);
    patent.referenceMarks = [];
    expect(prepareClaimsForDescription(patent, "invention-content")).toMatchObject({ ok: false });
  });
  test("rejects formula objects but preserves superscripts", () => {
    const patent = fixture();
    const block = patent.books[0]!.document.content[0] as ParagraphNode;
    block.content.push({ type: "inline-formula", formulaKind: "math", source: "x^2" });
    expect(prepareClaimsForDescription(patent, "invention-content")).toMatchObject({ ok: false });
    block.content.pop();
    block.content[0] = {
      type: "text",
      text: "1. 一种装置，其特征在于：x2。",
      marks: [{ type: "superscript" }],
    };
    const result = prepareClaimsForDescription(patent, "invention-content");
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.paragraphs[0]!.content[0]).toMatchObject({ marks: [{ type: "superscript" }] });
  });
  test("keeps converting when the destination heading is missing or duplicated", () => {
    const patent = fixture();
    const description = patent.books.find((b) => b.kind === "description")!.document;
    const chapter = description.content.find(
      (b) => classifyDescriptionChapterBlock(b) === "invention-content",
    ) as ParagraphNode;
    expect(chapter).toBeDefined();
    chapter.content = [{ type: "text", text: "实用新型内容", marks: [] }];
    expect(prepareClaimsForDescription(patent, "invention-content")).toMatchObject({
      ok: true,
      targetNodeId: chapter.id,
    });
    // A duplicated heading is ambiguous to jump to, yet the text still converts and stays copyable.
    description.content.push({ ...chapter, id: crypto.randomUUID() });
    const duplicated = prepareClaimsForDescription(patent, "invention-content");
    expect(duplicated).toMatchObject({ ok: true, targetNodeId: null });
    if (duplicated.ok) expect(duplicated.text.length).toBeGreaterThan(0);
    // Same with no heading at all: only the jump target is absent.
    description.content = [];
    const missing = prepareClaimsForDescription(patent, "invention-content");
    expect(missing).toMatchObject({ ok: true, targetNodeId: null });
    if (missing.ok) expect(missing.text.length).toBeGreaterThan(0);
  });
});
