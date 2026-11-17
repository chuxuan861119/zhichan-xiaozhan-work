import { describe, expect, test } from "vitest";
import type { BlockFormulaNode } from "../document/model.js";
import { extractFormulaFacts } from "./formula-facts.js";

const location = {
  kind: "book" as const,
  bookKind: "description" as const,
  targetId: "formula-1",
};

function blockFormula(
  source: string,
  formulaKind: "math" | "chemistry" = "math",
): BlockFormulaNode {
  return {
    id: "00000000-0000-4000-8000-000000000901",
    type: "block-formula",
    source,
    formulaKind,
  };
}

describe("extractFormulaFacts", () => {
  test("extracts symbols from mathematical block formulas", () => {
    const [fact] = extractFormulaFacts(blockFormula("x=y/z"), location);

    expect(fact?.symbols).toEqual(["x", "y", "z"]);
  });

  test("does not expose chemistry formulas as undefined mathematical symbols", () => {
    const [fact] = extractFormulaFacts(blockFormula("C6H12O6", "chemistry"), location);

    expect(fact?.formulaKind).toBe("chemistry");
    expect(fact?.symbols).toEqual([]);
  });
});
