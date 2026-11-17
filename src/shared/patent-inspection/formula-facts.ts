import type { BlockFormulaNode } from "../document/model.js";
import type { PatentLocation } from "./types.js";

export type FormulaFact = Readonly<{
  location: PatentLocation;
  raw: string;
  formulaKind: "math" | "chemistry";
  symbols: readonly string[];
}>;

export function extractFormulaFacts(
  formula: Pick<BlockFormulaNode, "source" | "formulaKind"> | string,
  location: PatentLocation,
): readonly FormulaFact[] {
  const raw = typeof formula === "string" ? formula : formula.source;
  const formulaKind = typeof formula === "string" ? "math" : formula.formulaKind;
  const symbols = formulaKind === "chemistry" ? [] : extractSymbols(raw);
  return [{ location, raw, formulaKind, symbols }];
}

function extractSymbols(source: string): readonly string[] {
  const withoutCommands = source.replace(/\\[A-Za-z]+/gu, " ");
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const match of withoutCommands.matchAll(/[A-Za-z](?:[A-Za-z0-9_]*)?/gu)) {
    const symbol = match[0] ?? "";
    if (symbol.length === 0 || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols;
}
