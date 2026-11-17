import { describe, expect, test } from "vitest";
import { createBlankPatent } from "../../patent/defaults.js";
import type { CanonicalPatent } from "../../patent/model.js";
import { runPatentInspection } from "../engine.js";
import { buildPatentFactIndex } from "../facts.js";
import {
  claimMultipleReferenceBaseRule,
  claimMultipleReferenceChoiceRule,
  claimParagraphEndingRule,
  claimReferenceCycleRule,
} from "./claim-drafting.js";
import { claimReferenceRule } from "./claims.js";

const CLAIM_DRAFTING_RULES = [
  claimReferenceRule,
  claimMultipleReferenceChoiceRule,
  claimMultipleReferenceBaseRule,
  claimReferenceCycleRule,
  claimParagraphEndingRule,
] as const;

function withBooks(
  claims: readonly string[],
  descriptionParagraphs: readonly string[] = [],
): CanonicalPatent {
  const patent = createBlankPatent({ patentType: "invention", name: "权利要求撰写测试" });
  return {
    ...patent,
    books: patent.books.map((book) => {
      if (book.kind === "claims") {
        return {
          ...book,
          document: {
            ...book.document,
            content: claims.map((text, index) => paragraph(text, 700 + index)),
          },
        };
      }
      if (book.kind === "description" && descriptionParagraphs.length > 0) {
        return {
          ...book,
          document: {
            ...book.document,
            content: descriptionParagraphs.map((text, index) => paragraph(text, 800 + index)),
          },
        };
      }
      return book;
    }),
  };
}

function paragraph(text: string, suffix: number) {
  return {
    id: `00000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`,
    type: "paragraph" as const,
    attrs: {
      alignment: "left" as const,
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 12,
    },
    content: [{ type: "text" as const, text, marks: [] }],
  };
}

function draftingIssues(claims: readonly string[], descriptionParagraphs: readonly string[] = []) {
  return runPatentInspection(withBooks(claims, descriptionParagraphs), CLAIM_DRAFTING_RULES).issues;
}

function ruleIssues(claims: readonly string[], ruleId: string) {
  return draftingIssues(claims).filter((issue) => issue.ruleId === ruleId);
}

describe("claim drafting rules", () => {
  test("accepts a valid multi-paragraph claim with a final full stop", () => {
    const validParagraphs = ["1. 一种装置，包括：", "壳体；", "设置在所述壳体内的控制器。"];

    expect(ruleIssues(validParagraphs, "core.claims.paragraph-ending")).toEqual([]);
  });

  test("warns when a non-final claim paragraph ends with a full stop", () => {
    const invalidMiddlePeriod = ["1. 一种装置，包括。", "设置在壳体内的控制器。"];

    expect(ruleIssues(invalidMiddlePeriod, "core.claims.paragraph-ending")).toEqual([
      expect.objectContaining({
        legacyCode: "claim-paragraph-ending",
        severity: "warning",
        locations: [
          expect.objectContaining({
            targetId: "00000000-0000-4000-8000-0000000002bc",
          }),
        ],
      }),
    ]);
  });

  test("warns when a non-final claim paragraph contains a full stop before later text", () => {
    const issues = ruleIssues(
      ["1. 一种装置，包括：", "壳体。后续内容", "控制器。"],
      "core.claims.paragraph-ending",
    );

    expect(issues).toEqual([
      expect.objectContaining({
        legacyCode: "claim-paragraph-ending",
        severity: "warning",
        summary: expect.stringContaining("非末段"),
        locations: [
          expect.objectContaining({
            targetId: "00000000-0000-4000-8000-0000000002bd",
          }),
        ],
      }),
    ]);
  });

  test("suggests a full stop only for a claim's final non-empty paragraph", () => {
    const issues = ruleIssues(["1. 一种装置，包括：", "壳体"], "core.claims.paragraph-ending");

    expect(issues).toEqual([
      expect.objectContaining({
        legacyCode: "claim-paragraph-ending",
        severity: "suggestion",
        summary: expect.stringContaining("末段缺少中文句号"),
      }),
    ]);
  });

  test("allows semicolon, colon, and comma endings in non-final claim paragraphs", () => {
    expect(
      ruleIssues(
        ["1. 一种装置，包括：", "壳体，", "设置在所述壳体内的控制器。"],
        "core.claims.paragraph-ending",
      ),
    ).toEqual([]);
    expect(
      ruleIssues(
        ["1. 一种装置，包括：", "壳体；", "设置在所述壳体内的控制器。"],
        "core.claims.paragraph-ending",
      ),
    ).toEqual([]);
  });

  test("does not apply claim paragraph-ending checks to description paragraphs", () => {
    expect(
      draftingIssues(["1. 一种装置。"], ["说明书正文：", "壳体；", "控制器："]),
    ).not.toContainEqual(expect.objectContaining({ ruleId: "core.claims.paragraph-ending" }));
  });

  test("requires an explicit choice expression for a multiple dependent claim", () => {
    const issues = ruleIssues(
      ["1. 一种装置。", "2. 一种控制器。", "3. 根据权利要求1、2和3所述的装置。"],
      "core.claims.multiple-reference-choice",
    );

    expect(issues).toEqual([
      expect.objectContaining({
        legacyCode: "claim-multiple-reference-choice",
        severity: "warning",
        summary: expect.stringContaining("择一"),
      }),
    ]);
  });

  test("accepts an explicit alternative reference expression", () => {
    expect(
      ruleIssues(
        ["1. 一种装置。", "2. 一种控制器。", "3. 根据权利要求1或2所述的装置。"],
        "core.claims.multiple-reference-choice",
      ),
    ).toEqual([]);
  });

  test("reports a multiple dependent claim that cites another multiple dependent claim", () => {
    const issues = ruleIssues(
      [
        "1. 一种装置。",
        "2. 一种控制器。",
        "3. 根据权利要求1或2所述的装置。",
        "4. 根据权利要求3或1所述的装置。",
      ],
      "core.claims.multiple-reference-base",
    );

    expect(issues).toEqual([
      expect.objectContaining({
        legacyCode: "claim-multiple-reference-base",
        summary: expect.stringContaining("多项从属"),
      }),
    ]);
  });

  test("reports an explicit claim reference cycle", () => {
    const issues = ruleIssues(
      ["1. 根据权利要求2所述的装置。", "2. 根据权利要求1所述的装置。"],
      "core.claims.reference-cycle",
    );

    expect(issues).toEqual([
      expect.objectContaining({
        legacyCode: "claim-reference-cycle",
        summary: expect.stringContaining("循环"),
      }),
    ]);
  });

  test("does not reject multiple independent claims", () => {
    expect(draftingIssues(["1. 一种装置。", "2. 一种方法。"])).not.toContainEqual(
      expect.objectContaining({ severity: "error" }),
    );
  });

  test("keeps self and forward references visible in the existing reference rule", () => {
    const issues = draftingIssues([
      "1. 根据权利要求1所述的装置。",
      "2. 根据权利要求3所述的装置。",
      "3. 一种装置。",
    ]);

    expect(issues.map((issue) => issue.legacyCode)).toEqual(
      expect.arrayContaining(["claim-reference-warning"]),
    );
  });

  test("degrades instead of silently passing when the full claim graph is absent", () => {
    const patent = withBooks(["1. 一种装置。"]);
    const report = runPatentInspection(patent, [claimMultipleReferenceChoiceRule], {
      buildFacts: (source) => buildPatentFactIndex(source, "instant"),
    });

    expect(report.issues).toEqual([]);
    expect(report.degradedRules).toEqual([
      { ruleId: "core.claims.multiple-reference-choice", message: "该项检查未完成。" },
    ]);
  });
});

test("explains duplicate numbering when claim graph checks are paused", () => {
  const report = runPatentInspection(
    withBooks(["1. 一种装置。", "1. 一种另一装置。"]),
    CLAIM_DRAFTING_RULES,
  );
  expect(report.degradedRules).toHaveLength(3);
  expect(
    report.degradedRules.every(
      (r) => r.message === "权利要求编号重复，引用关系检查暂时无法完成。请先修正编号，再重新检查。",
    ),
  ).toBe(true);
});
