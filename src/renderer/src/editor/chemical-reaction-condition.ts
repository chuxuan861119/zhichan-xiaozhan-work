import type { ChemicalMathField, ChemicalSelection } from "./chemical-mathfield-adapter";

type ReactionCondition = { upper: string; lower: string; reversible: boolean };

export type ReactionConditionTarget = {
  sourceVersion: string;
  selection: ChemicalSelection;
  condition: ReactionCondition | null;
  selectedSource: string;
};

/** Parse only a complete selected arrow, never a substring of a larger formula. */
export function parseReactionCondition(source: string): ReactionCondition | null {
  const text = source.trim();
  const command = /^\\(xrightarrow|xrightleftharpoons)(?![a-zA-Z])/.exec(text);
  if (!command) return null;
  let position = command[0].length;
  const skipSpace = () => {
    while (/\s/.test(text[position] ?? "") && position < text.length) position += 1;
  };
  const readGroup = (opening: "{" | "["): string | null => {
    skipSpace();
    if (text[position] !== opening) return null;
    const start = ++position;
    const stack = [opening === "{" ? "}" : "]"];
    while (position < text.length) {
      const character = text[position++];
      if (character === "\\") {
        position += 1;
        continue;
      }
      if (character === "{") stack.push("}");
      else if (character === "[" && stack.at(-1) === "]") stack.push("]");
      else if (character === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) return text.slice(start, position - 1);
      }
    }
    return null;
  };
  skipSpace();
  const lower = text[position] === "[" ? readGroup("[") : "";
  const upper = readGroup("{");
  skipSpace();
  if (lower === null || upper === null || position !== text.length) return null;
  return { upper, lower, reversible: command[1] === "xrightleftharpoons" };
}

function copySelection(selection: ChemicalSelection): ChemicalSelection {
  return { ...selection, ranges: selection.ranges.map(([start, end]) => [start, end]) };
}

export function captureReactionCondition(field: ChemicalMathField): ReactionConditionTarget | null {
  if (field.selection?.ranges.length !== 1 || !field.executeCommand) return null;
  const selection = copySelection(field.selection);
  const range = selection.ranges[0];
  if (!range) return null;
  const [start, end] = range;
  const selectedSource = start === end ? "" : field.getValue(selection, "latex").trim();
  const condition = parseReactionCondition(selectedSource);
  // Nonempty selections must contain exactly one complete arrow. Never replace arbitrary chemistry.
  if (start !== end && !condition) return null;
  return { sourceVersion: field.value, selection, selectedSource, condition };
}

export function applyReactionCondition(
  field: ChemicalMathField,
  target: ReactionConditionTarget,
  token: string,
): { ok: true; source: string } | { ok: false; reason: "stale" | "command-failed" } {
  if (field.value !== target.sourceVersion) return { ok: false, reason: "stale" };
  const previous = field.selection ? copySelection(field.selection) : undefined;
  if (target.condition && token.trim() === target.selectedSource) {
    field.focus();
    field.selection = copySelection(target.selection);
    return { ok: true, source: field.value };
  }
  try {
    field.focus();
    field.selection = copySelection(target.selection);
    const applied = field.executeCommand?.([
      "insert",
      target.condition ? token.trimEnd() : token,
      { insertionMode: "replaceSelection", selectionMode: "after" },
    ]);
    if (applied && field.value !== target.sourceVersion) return { ok: true, source: field.value };
  } catch {
    // A failed editor command must not fall back to replacing the whole formula.
  }
  if (previous) field.selection = previous;
  return { ok: false, reason: "command-failed" };
}
