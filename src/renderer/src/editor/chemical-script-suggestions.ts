import { isValidChemicalElementSymbol } from "./chemical-keyboard-input";

export type ChemicalSuggestionContext = {
  fragment: string;
  range: [number, number];
  sourceVersion: string;
};

export type ChemicalScriptSuggestion = ChemicalSuggestionContext & {
  id: string;
  latex: string;
  displayText: string;
  reason: "composition" | "charge" | "isotope" | "ambiguous-charge" | "element-case";
};

const SUBSCRIPT: Record<string, string> = Object.fromEntries(
  [..."0123456789"].map((digit, index) => [digit, "₀₁₂₃₄₅₆₇₈₉"[index] ?? digit]),
);

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
};

type FormattedComposition = {
  latex: string;
  displayText: string;
};

function formatDigits(value: string, table: Record<string, string>): string {
  return [...value].map((character) => table[character] ?? character).join("");
}

function isBalanced(value: string): boolean {
  const stack: string[] = [];
  for (const character of value) {
    if (character === "(" || character === "[") stack.push(character);
    if (character === ")" && stack.pop() !== "(") return false;
    if (character === "]" && stack.pop() !== "[") return false;
  }
  return stack.length === 0;
}

function formatComposition(source: string): FormattedComposition | null {
  if (!/^(?:\d+)?(?:[A-Z][a-z]?|[()[\]]|\d)+$/u.test(source) || !isBalanced(source)) {
    return null;
  }

  const coefficient = source.match(/^\d+/u)?.[0] ?? "";
  let index = coefficient.length;
  let latex = coefficient;
  let displayText = coefficient;
  let elementCount = 0;

  while (index < source.length) {
    const element = source.slice(index).match(/^[A-Z][a-z]?/u)?.[0];
    if (element) {
      if (!isValidChemicalElementSymbol(element)) return null;
      elementCount += 1;
      latex += element;
      displayText += element;
      index += element.length;
    } else {
      const groupToken = source[index];
      if (!groupToken || !"()[]".includes(groupToken)) return null;
      latex += groupToken;
      displayText += groupToken;
      index += 1;
    }

    const mayHaveCount =
      element !== undefined || source[index - 1] === ")" || source[index - 1] === "]";
    if (mayHaveCount) {
      const count = source.slice(index).match(/^\d+/u)?.[0] ?? "";
      if (count) {
        latex += `_{${count}}`;
        displayText += formatDigits(count, SUBSCRIPT);
        index += count.length;
      }
    }
  }

  return elementCount > 0 ? { latex, displayText } : null;
}

function candidate(
  context: ChemicalSuggestionContext,
  formatted: FormattedComposition,
  reason: ChemicalScriptSuggestion["reason"],
  rank: number,
): ChemicalScriptSuggestion {
  return {
    ...context,
    id: `${reason}:${rank}:${formatted.latex}`,
    latex: formatted.latex,
    displayText: formatted.displayText,
    reason,
  };
}

function withCharge(formatted: FormattedComposition, charge: string): FormattedComposition {
  return {
    latex: `${formatted.latex}^{${charge}}`,
    displayText: `${formatted.displayText}${formatDigits(charge, SUPERSCRIPT)}`,
  };
}

function ambiguousElementCaseCandidates(source: string): FormattedComposition[] {
  const results: FormattedComposition[] = [];
  for (let index = 0; index < source.length - 1; index += 1) {
    const first = source[index] ?? "";
    const second = source[index + 1] ?? "";
    if (!/^[A-Z]$/u.test(first) || !/^[A-Z]$/u.test(second)) continue;

    const pairedElement = `${first}${second.toLowerCase()}`;
    if (
      !isValidChemicalElementSymbol(first) ||
      !isValidChemicalElementSymbol(second) ||
      !isValidChemicalElementSymbol(pairedElement)
    ) {
      continue;
    }

    const formatted = formatComposition(
      `${source.slice(0, index)}${pairedElement}${source.slice(index + 2)}`,
    );
    if (formatted && !results.some((item) => item.latex === formatted.latex)) {
      results.push(formatted);
    }
  }
  return results;
}

export function suggestChemicalScripts(
  context: ChemicalSuggestionContext,
): ChemicalScriptSuggestion[] {
  const { fragment } = context;
  if (/[{}_\\]/u.test(fragment) || /\((?:s|l|g|aq)\)$/iu.test(fragment)) return [];

  const isotope = fragment.match(/^\^(\d+)([A-Z][a-z]?(?:\d*)?)$/u);
  if (isotope) {
    const body = formatComposition(isotope[2] ?? "");
    if (!body) return [];
    return [
      candidate(
        context,
        {
          latex: `^{${isotope[1]}}${body.latex}`,
          displayText: `${formatDigits(isotope[1] ?? "", SUPERSCRIPT)}${body.displayText}`,
        },
        "isotope",
        0,
      ),
    ];
  }

  const explicitCharge = fragment.match(/^(.*)\^(\d*)([+-])$/u);
  if (explicitCharge) {
    const body = formatComposition(explicitCharge[1] ?? "");
    if (!body) return [];
    return [
      candidate(
        context,
        withCharge(body, `${explicitCharge[2] ?? ""}${explicitCharge[3] ?? ""}`),
        "charge",
        0,
      ),
    ];
  }

  const monatomicCharge = fragment.match(/^([A-Z][a-z]?)(\d+)([+-])$/u);
  if (monatomicCharge && isValidChemicalElementSymbol(monatomicCharge[1] ?? "")) {
    const element = monatomicCharge[1] ?? "";
    return [
      candidate(
        context,
        withCharge(
          { latex: element, displayText: element },
          `${monatomicCharge[2] ?? ""}${monatomicCharge[3] ?? ""}`,
        ),
        "charge",
        0,
      ),
    ];
  }

  const ambiguousCharge = fragment.match(/^(.+?)(\d{2,})([+-])$/u);
  if (ambiguousCharge) {
    const digits = ambiguousCharge[2] ?? "";
    const sign = ambiguousCharge[3] ?? "";
    const preferredBody = formatComposition(`${ambiguousCharge[1] ?? ""}${digits.slice(0, -1)}`);
    const alternativeBody = formatComposition(`${ambiguousCharge[1] ?? ""}${digits}`);
    const results = [
      preferredBody
        ? candidate(
            context,
            withCharge(preferredBody, `${digits.slice(-1)}${sign}`),
            "ambiguous-charge",
            0,
          )
        : null,
      alternativeBody
        ? candidate(context, withCharge(alternativeBody, sign), "ambiguous-charge", 1)
        : null,
    ].filter((item): item is ChemicalScriptSuggestion => item !== null);
    return results
      .filter((item, index) => results.findIndex((other) => other.latex === item.latex) === index)
      .slice(0, 2);
  }

  const signed = fragment.match(/^(.*)([+-])$/u);
  if (signed) {
    const body = formatComposition(signed[1] ?? "");
    if (!body) return [];
    return [candidate(context, withCharge(body, signed[2] ?? ""), "charge", 0)];
  }

  const body = formatComposition(fragment);
  if (!body) return [];

  const results = body.latex !== fragment ? [candidate(context, body, "composition", 0)] : [];
  for (const formatted of ambiguousElementCaseCandidates(fragment)) {
    results.push(candidate(context, formatted, "element-case", results.length));
  }
  return results.slice(0, 2);
}
