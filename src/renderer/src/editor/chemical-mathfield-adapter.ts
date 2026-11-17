import { planChemicalLetterInsertion } from "./chemical-keyboard-input";
import type {
  ChemicalScriptSuggestion,
  ChemicalSuggestionContext,
} from "./chemical-script-suggestions";

export type ChemicalScriptMode = "superscript" | "subscript";

export type ChemicalSelection = {
  ranges: Array<[number, number]>;
  direction?: "forward" | "backward" | "none";
};

export type ChemicalMathField = HTMLElement & {
  value: string;
  mode?: "math" | "text" | "latex";
  position?: number;
  lastOffset?: number;
  selectionIsCollapsed?: boolean;
  selection?: ChemicalSelection;
  getValue(range?: unknown, format?: string): string;
  executeCommand?(command: unknown): boolean;
};

const MAX_FRAGMENT_OFFSETS = 128;
const CHEMICAL_FRAGMENT_CHARACTERS = /^[A-Za-z0-9()[\]^+-]+$/u;
const PLAIN_FRAGMENT = /^\^?\d*[A-Z][A-Za-z0-9()[\]^+-]*$/u;

function restoreSelection(
  field: ChemicalMathField,
  previousSelection: ChemicalSelection | undefined,
): void {
  if (previousSelection) field.selection = previousSelection;
  else delete field.selection;
  field.focus();
}

export function readChemicalSuggestionContext(
  field: ChemicalMathField,
): ChemicalSuggestionContext | null {
  if (
    field.selectionIsCollapsed === false ||
    typeof field.position !== "number" ||
    typeof field.getValue !== "function"
  ) {
    return null;
  }

  const end = field.position;
  const minimum = Math.max(0, end - MAX_FRAGMENT_OFFSETS);
  let best: ChemicalSuggestionContext | null = null;

  for (let start = end - 1; start >= minimum; start -= 1) {
    const fragment = field.getValue([start, end], "latex");
    if (!CHEMICAL_FRAGMENT_CHARACTERS.test(fragment)) break;
    if (PLAIN_FRAGMENT.test(fragment)) {
      best = { fragment, range: [start, end], sourceVersion: field.value };
    }
  }

  return best;
}

export function applyChemicalSuggestion(
  field: ChemicalMathField,
  suggestion: ChemicalScriptSuggestion,
): { ok: true; source: string } | { ok: false; reason: "stale" | "command-failed" } {
  if (
    field.value !== suggestion.sourceVersion ||
    field.getValue(suggestion.range, "latex") !== suggestion.fragment
  ) {
    return { ok: false, reason: "stale" };
  }
  if (!field.executeCommand) return { ok: false, reason: "command-failed" };

  const previousSelection = field.selection;
  field.selection = { ranges: [suggestion.range], direction: "forward" };
  field.focus();
  const sourceBefore = field.value;
  const handled = field.executeCommand([
    "insert",
    suggestion.latex,
    { insertionMode: "replaceSelection", selectionMode: "after" },
  ]);

  if (!handled || field.value === sourceBefore) {
    restoreSelection(field, previousSelection);
    return { ok: false, reason: "command-failed" };
  }
  return { ok: true, source: field.value };
}

export function enterChemicalScript(field: ChemicalMathField, mode: ChemicalScriptMode): boolean {
  field.focus();
  return (
    field.executeCommand?.([mode === "superscript" ? "moveToSuperscript" : "moveToSubscript"]) ===
    true
  );
}

export function exitChemicalScript(field: ChemicalMathField): boolean {
  field.focus();
  return field.executeCommand?.(["moveAfterParent"]) === true;
}

export function insertChemicalPhysicalLetter(
  field: ChemicalMathField,
  letter: string,
):
  | { ok: true; source: string; ambiguousElement?: string }
  | { ok: false; reason: "unsupported-mode" | "command-failed" } {
  if (field.mode === "latex") return { ok: false, reason: "unsupported-mode" };
  if (!field.executeCommand) return { ok: false, reason: "command-failed" };

  const previousSelection = field.selection;
  const position = field.position;
  const canInspectPrevious =
    field.selectionIsCollapsed !== false && typeof position === "number" && position > 0;
  const previousSymbol = canInspectPrevious
    ? field.getValue([position - 1, position], "latex")
    : null;
  const plan = planChemicalLetterInsertion(previousSymbol, letter);
  if (plan.replacePrevious && typeof position === "number") {
    field.selection = {
      ranges: [[position - 1, position]],
      direction: "forward",
    };
  }

  field.focus();
  const sourceBefore = field.value;
  const handled = field.executeCommand([
    "insert",
    plan.latex,
    { insertionMode: "replaceSelection", selectionMode: "after" },
  ]);
  if (!handled || field.value === sourceBefore) {
    restoreSelection(field, previousSelection);
    return { ok: false, reason: "command-failed" };
  }

  return {
    ok: true,
    source: field.value,
    ...(plan.ambiguousElement ? { ambiguousElement: plan.ambiguousElement } : {}),
  };
}

export function toggleSelectedChemicalScript(
  field: ChemicalMathField,
  mode: ChemicalScriptMode,
): { ok: true; source: string } | { ok: false; reason: "complex-selection" | "command-failed" } {
  if (
    field.selectionIsCollapsed !== false ||
    !field.selection ||
    !field.executeCommand ||
    typeof field.getValue !== "function"
  ) {
    return { ok: false, reason: "command-failed" };
  }

  const selected = field.getValue(field.selection, "latex").trim();
  if (!selected) return { ok: false, reason: "command-failed" };

  const wrapper = mode === "superscript" ? /^\^\{([^{}]+)\}$/u : /^_\{([^{}]+)\}$/u;
  const unwrapped = selected.match(wrapper)?.[1] ?? null;
  const elementCount = selected.match(/[A-Z][a-z]?/gu)?.length ?? 0;
  if (!unwrapped && (/[\\{}]/u.test(selected) || elementCount > 1)) {
    return { ok: false, reason: "complex-selection" };
  }

  const replacement = unwrapped ?? (mode === "superscript" ? `^{${selected}}` : `_{${selected}}`);
  const previousSelection = field.selection;
  const sourceBefore = field.value;
  field.focus();
  const handled = field.executeCommand([
    "insert",
    replacement,
    { insertionMode: "replaceSelection", selectionMode: "after" },
  ]);

  if (!handled || field.value === sourceBefore) {
    restoreSelection(field, previousSelection);
    return { ok: false, reason: "command-failed" };
  }
  return { ok: true, source: field.value };
}
