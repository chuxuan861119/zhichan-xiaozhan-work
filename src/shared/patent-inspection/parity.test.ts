import { describe, expect, test } from "vitest";
import { createBlankPatent } from "../patent/defaults.js";
import type { CanonicalPatent } from "../patent/model.js";
import { inspectPatent, validatePatentWithEngine } from "../patent/validation.js";
import { DEFAULT_PATENT_INSPECTION_RULES } from "./default-rules.js";

const EXPECTED_RULE_IDS = [
  "core.books.required",
  "core.description.chapter-body",
  "core.description.chapter-structure",
  "core.templates.placeholder",
  "core.claims.numbering",
  "core.claims.internal-punctuation",
  "core.content.repeated-punctuation",
  "core.claims.reference-chain",
  "core.claims.multiple-reference-choice",
  "core.claims.multiple-reference-base",
  "core.claims.reference-cycle",
  "core.claims.paragraph-ending",
  "core.claims.utility-method-wording",
  "core.abstract.length",
  "core.patent-name.length",
  "core.content.promotional-language",
  "core.terminology.patent-type",
  "core.claims.keyword-reference",
  "core.drawings.disabled-references",
  "core.drawings.explanation-heading",
  "core.drawings.books-present",
  "core.drawings.figure-required",
  "core.drawings.abstract-selection",
  "core.drawings.explanation-sync",
  "core.drawings.missing-figure",
  "core.drawings.duplicate-label",
  "core.drawings.explanation-mismatch",
  "core.drawings.abstract-selection-mismatch",
  "core.reference-marks.description-presence",
  "core.reference-marks.legend-match",
  "core.numeric.range-reversed",
  "core.numeric.percentage-total",
  "core.numeric.quantity-mapping",
  "core.numeric.unit-mismatch",
  "core.numeric.subrange-out-of-bounds",
  "core.formula.literal-zero-denominator",
  "core.formula.undefined-symbol",
  "core.formula.duplicate-definition",
  "core.tables.fixed-row-height",
  "core.claims.ordinary-image",
  "core.reference-marks.number-mismatch",
  "core.content.text-pairs",
  "core.content.duplicate-drafting",
  "core.content.table-numbers",
  "core.formula.syntax",
  "core.content.cross-book-reference",
  "core.templates.editing-markers",
  "core.assets.resource-health",
] as const;

function claimsWithErrors(patent: CanonicalPatent): CanonicalPatent {
  return {
    ...patent,
    books: patent.books.map((book) =>
      book.kind === "claims"
        ? {
            ...book,
            document: {
              ...book.document,
              content: [
                {
                  id: "00000000-0000-4000-8000-000000000711",
                  type: "paragraph",
                  attrs: {
                    alignment: "left",
                    paragraphIndentMm: 0,
                    lineSpacing: 1.5,
                    defaultFontFamily: "SimSun",
                    defaultFontSizePt: 12,
                  },
                  content: [
                    {
                      type: "text",
                      text: "3. 根据权利要求9所述的结构，其特征在于通过方法实现。",
                      marks: [],
                    },
                  ],
                },
              ],
            },
          }
        : book,
    ),
  };
}

describe("default patent inspection rule parity", () => {
  test("registers every migrated rule under a stable versioned id", () => {
    expect(DEFAULT_PATENT_INSPECTION_RULES.map((rule) => rule.id)).toEqual(EXPECTED_RULE_IDS);
    expect(DEFAULT_PATENT_INSPECTION_RULES.every((rule) => rule.version === 1)).toBe(true);
  });

  test("declares metadata for the complete local rule pack", () => {
    expect(
      DEFAULT_PATENT_INSPECTION_RULES.every(
        (rule) =>
          (rule.cost === "instant" || rule.cost === "full") &&
          rule.dependencies.length > 0 &&
          ["official", "product-policy", "heuristic"].includes(rule.provenance.authority),
      ),
    ).toBe(true);

    expect(
      DEFAULT_PATENT_INSPECTION_RULES.some((rule) => rule.dependencies.includes("figures")),
    ).toBe(true);
  });

  test("keeps the legacy issue shape for claim checks", () => {
    const patent = claimsWithErrors(
      createBlankPatent({ patentType: "utility-model", name: "引用测试" }),
    );
    const claimIssues = validatePatentWithEngine(patent).filter(
      (issue) => issue.code.startsWith("claim-") || issue.code === "utility-model-method-wording",
    );

    expect(claimIssues).toEqual([
      {
        severity: "warning",
        code: "claim-numbering-warning",
        bookKind: "claims",
        targetId: "00000000-0000-4000-8000-000000000711",
        message: "编号不连续：第1项为3，应为1。",
      },
      {
        severity: "warning",
        code: "claim-reference-warning",
        bookKind: "claims",
        targetId: "00000000-0000-4000-8000-000000000711",
        message: "权利要求3引用了不存在的权利要求9。",
      },
      {
        severity: "warning",
        code: "claim-keyword-reference-warning",
        bookKind: "claims",
        targetId: "00000000-0000-4000-8000-000000000711",
        message: "权利要求3的主题名称“结构”未在说明书中找到完全一致的表述。",
      },
    ]);
  });

  test("all default rule issues contain an explicit location", () => {
    const report = inspectPatent(
      createBlankPatent({ patentType: "utility-model", name: "定位测试" }),
    );

    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.issues.every((issue) => issue.locations.length > 0)).toBe(true);
  });
});
