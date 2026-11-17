import { planDependentClaimInsertion } from "./caret-aware-claim-plan";

describe("caret-aware dependent claim plan", () => {
  test.each([
    ["1. ，其特征在于：", "编号后缺少名称"],
    ["1. 一种装置", "名称后未找到逗号"],
  ])("briefly explains the missing name for %s", (text) => {
    const result = planDependentClaimInsertion({
      paragraphs: [text],
      cursorParagraphIndex: 0,
      cursorParagraphIsEmpty: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toBe("缺少独立权利要求名称。");
  });
  test("uses the whole multi-paragraph claim when the caret is in a continuation paragraph", () => {
    const result = planDependentClaimInsertion({
      paragraphs: [
        "1． 一种电池回收装置，包括：",
        "回收箱体。",
        "2、根据权利要求1所述的一种电池回收装置，包括：",
        "压紧机构。",
      ],
      cursorParagraphIndex: 1,
      cursorParagraphIsEmpty: false,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        insertionIndex: 2,
        // 标号分隔符保持文档既有风格：第一段为全角点，受影响段（顿号）编号替换保持顿号。
        replacementText: "2． 根据权利要求 1 所述的一种电池回收装置，其特征在于：",
        paragraphNumberReplacements: [{ paragraphIndex: 2, text: "3、" }],
      },
    });
  });

  test("inserts after the active claim and preserves its independent claim name", () => {
    const result = planDependentClaimInsertion({
      paragraphs: [
        "1. 一种电池回收装置，其特征在于：",
        "2. 根据权利要求1所述的一种电池回收装置，其特征在于：",
        "3. 根据权利要求2所述的一种电池回收装置，其特征在于：",
        "4. 根据权利要求3所述的一种电池回收装置，其特征在于：",
      ],
      cursorParagraphIndex: 1,
      cursorParagraphIsEmpty: false,
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        insertionIndex: 2,
        reuseEmptyParagraph: false,
        replacementText: "3. 根据权利要求 2 所述的一种电池回收装置，其特征在于：",
        referenceReviewRanges: [{ from: 9, to: 12 }],
        paragraphNumberReplacements: [
          { paragraphIndex: 2, from: 0, to: 2, text: "4." },
          { paragraphIndex: 3, from: 0, to: 2, text: "5." },
        ],
        referenceReplacements: [{ paragraphIndex: 3, from: 9, to: 10, text: " 4 " }],
      }),
    });
  });

  test("reuses the active empty paragraph immediately after a claim", () => {
    const result = planDependentClaimInsertion({
      paragraphs: [
        "1. 一种电池回收装置，其特征在于：",
        "",
        "2. 根据权利要求1所述的一种电池回收装置，其特征在于：",
      ],
      cursorParagraphIndex: 1,
      cursorParagraphIsEmpty: true,
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        insertionIndex: 1,
        reuseEmptyParagraph: true,
        replacementText: "2. 根据权利要求 1 所述的一种电池回收装置，其特征在于：",
      }),
    });
  });

  test("uses the characteristic phrase as the name boundary when no comma exists", () => {
    const result = planDependentClaimInsertion({
      paragraphs: ["1. 一种电池回收装置其特征在于：", "2. 根据权利要求1所述的装置，其特征在于："],
      cursorParagraphIndex: 1,
      cursorParagraphIsEmpty: false,
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        replacementText: "3. 根据权利要求 2 所述的一种电池回收装置，其特征在于：",
      }),
    });
  });

  test.each([
    ...["1. ", "1. ，其特征在于：", "1. 一种装置"].map((text) => ({
      name: "missing independent name or separator",
      paragraphs: [text],
      cursorParagraphIndex: 0,
      cursorParagraphIsEmpty: false,
      code: "EMPTY_INDEPENDENT_NAME",
    })),
    {
      name: "a numbering gap",
      paragraphs: ["1. 一种装置，其特征在于：", "3. 根据权利要求1所述的一种装置，其特征在于："],
      cursorParagraphIndex: 1,
      cursorParagraphIsEmpty: false,
      code: "INVALID_NUMBERING",
    },
    {
      name: "ordinary unnumbered preface text at the caret",
      paragraphs: ["普通文字", "1. 一种装置，其特征在于："],
      cursorParagraphIndex: 0,
      cursorParagraphIsEmpty: false,
      code: "NO_ACTIVE_CLAIM",
    },
    {
      name: "no independent claim before the active claim",
      paragraphs: ["1. 根据权利要求2所述的装置，其特征在于："],
      cursorParagraphIndex: 0,
      cursorParagraphIsEmpty: false,
      code: "NO_INDEPENDENT_CLAIM",
    },
    {
      name: "an ambiguous affected reference",
      paragraphs: [
        "1. 一种装置，其特征在于：",
        "2. 根据权利要求1所述的一种装置，其特征在于：",
        "3. 根据权利要求1以及2所述的一种装置，其特征在于：",
      ],
      cursorParagraphIndex: 1,
      cursorParagraphIsEmpty: false,
      code: "AMBIGUOUS_REFERENCE",
    },
  ])(
    "returns $code without a partial plan for $name",
    ({ paragraphs, cursorParagraphIndex, cursorParagraphIsEmpty, code }) => {
      const result = planDependentClaimInsertion({
        paragraphs,
        cursorParagraphIndex,
        cursorParagraphIsEmpty,
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({ code }),
      });
    },
  );
});
