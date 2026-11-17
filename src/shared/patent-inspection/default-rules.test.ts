import { describe, expect, test } from "vitest";
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

describe("default patent inspection rules", () => {
  test("registers each rule exactly once", () => {
    const ids = DEFAULT_PATENT_INSPECTION_RULES.map((rule) => rule.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(EXPECTED_RULE_IDS);
  });

  test("registers the full local rule pack", () => {
    expect(
      DEFAULT_PATENT_INSPECTION_RULES.some((rule) => rule.dependencies.includes("figures")),
    ).toBe(true);
    expect(
      DEFAULT_PATENT_INSPECTION_RULES.some((rule) => rule.dependencies.includes("reference-marks")),
    ).toBe(true);
  });

  test("declares cost, dependencies, and provenance on every rule", () => {
    for (const rule of DEFAULT_PATENT_INSPECTION_RULES) {
      expect(rule.cost).toMatch(/^(instant|full)$/u);
      expect(rule.dependencies.length).toBeGreaterThan(0);
      expect(rule.provenance).toMatchObject({
        authority: expect.stringMatching(/^(official|product-policy|heuristic)$/u),
      });
    }

    for (const ruleId of [
      "core.claims.paragraph-ending",
      "core.claims.multiple-reference-choice",
      "core.claims.multiple-reference-base",
      "core.claims.reference-cycle",
    ]) {
      expect(DEFAULT_PATENT_INSPECTION_RULES.find((rule) => rule.id === ruleId)?.cost).toBe("full");
    }
  });
});
