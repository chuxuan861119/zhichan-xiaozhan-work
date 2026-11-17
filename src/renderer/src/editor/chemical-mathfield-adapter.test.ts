import {
  applyChemicalSuggestion,
  type ChemicalMathField,
  enterChemicalScript,
  exitChemicalScript,
  insertChemicalPhysicalLetter,
  readChemicalSuggestionContext,
  toggleSelectedChemicalScript,
} from "./chemical-mathfield-adapter";
import type { ChemicalScriptSuggestion } from "./chemical-script-suggestions";

type FakeMathField = ChemicalMathField & {
  executeCommand: ReturnType<typeof vi.fn>;
  focus: ChemicalMathField["focus"] & ReturnType<typeof vi.fn>;
  getValue: ReturnType<typeof vi.fn>;
};

function firstRange(range: unknown): [number, number] | null {
  if (Array.isArray(range)) return range as [number, number];
  return (range as { ranges?: Array<[number, number]> } | undefined)?.ranges?.[0] ?? null;
}

function fakeMathField(
  initialValue: string,
  initialPosition: number,
  commandResult = true,
): FakeMathField {
  const field = document.createElement("div") as unknown as FakeMathField;
  field.value = initialValue;
  field.position = initialPosition;
  field.selectionIsCollapsed = true;
  field.selection = { ranges: [[initialPosition, initialPosition]], direction: "forward" };
  field.getValue = vi.fn((range?: unknown) => {
    const normalizedRange = firstRange(range);
    if (!normalizedRange) return field.value;
    return field.value.slice(normalizedRange[0], normalizedRange[1]);
  });
  field.focus = vi.fn() as FakeMathField["focus"];
  field.executeCommand = vi.fn((command: unknown) => {
    if (!commandResult) return false;
    if (Array.isArray(command) && command[0] === "insert") {
      const [start, end] = field.selection?.ranges[0] ?? [field.position ?? 0, field.position ?? 0];
      field.value = `${field.value.slice(0, start)}${String(command[1])}${field.value.slice(end)}`;
    }
    return true;
  });
  return field;
}

function suggestion(sourceVersion = "H2O"): ChemicalScriptSuggestion {
  return {
    id: "composition:0:H_{2}O",
    fragment: "H2O",
    range: [0, 3],
    sourceVersion,
    latex: "H_{2}O",
    displayText: "H₂O",
    reason: "composition",
  };
}

describe("chemical MathLive adapter", () => {
  test("reads the longest plain chemical fragment ending at the caret", () => {
    const field = fakeMathField(" + 2H2O", 7);

    expect(readChemicalSuggestionContext(field)).toEqual({
      fragment: "2H2O",
      range: [3, 7],
      sourceVersion: " + 2H2O",
    });
  });

  test("limits caret lookbehind to 128 MathLive offsets", () => {
    const source = "H".repeat(129);
    const field = fakeMathField(source, source.length);

    expect(readChemicalSuggestionContext(field)).toMatchObject({
      fragment: "H".repeat(128),
      range: [1, 129],
    });
  });

  test("does not read a candidate context from a non-collapsed selection", () => {
    const field = fakeMathField("H2O", 3);
    field.selectionIsCollapsed = false;

    expect(readChemicalSuggestionContext(field)).toBeNull();
  });

  test("applies one candidate through a replace-selection command", () => {
    const field = fakeMathField("H2O", 3);

    expect(applyChemicalSuggestion(field, suggestion())).toEqual({
      ok: true,
      source: "H_{2}O",
    });
    expect(field.executeCommand).toHaveBeenCalledWith([
      "insert",
      "H_{2}O",
      { insertionMode: "replaceSelection", selectionMode: "after" },
    ]);
  });

  test("rejects a stale candidate before changing selection or source", () => {
    const field = fakeMathField("H2O2", 4);
    const selectionBefore = field.selection;

    expect(applyChemicalSuggestion(field, suggestion("H2O"))).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(field.selection).toBe(selectionBefore);
    expect(field.executeCommand).not.toHaveBeenCalled();
  });

  test("restores the previous selection when the insert command fails", () => {
    const field = fakeMathField("H2O", 3, false);
    const selectionBefore = field.selection;

    expect(applyChemicalSuggestion(field, suggestion())).toEqual({
      ok: false,
      reason: "command-failed",
    });
    expect(field.value).toBe("H2O");
    expect(field.selection).toBe(selectionBefore);
  });

  test("enters complementary scripts and leaves the current parent", () => {
    const field = fakeMathField("H", 1);

    expect(enterChemicalScript(field, "superscript")).toBe(true);
    expect(enterChemicalScript(field, "subscript")).toBe(true);
    expect(exitChemicalScript(field)).toBe(true);
    expect(field.executeCommand.mock.calls.map(([command]) => command)).toEqual([
      ["moveToSuperscript"],
      ["moveToSubscript"],
      ["moveAfterParent"],
    ]);
  });

  test("inserts uppercase physical letters and canonicalizes an unambiguous element", () => {
    const first = fakeMathField("", 0);
    expect(insertChemicalPhysicalLetter(first, "N")).toEqual({ ok: true, source: "N" });

    const second = fakeMathField("N", 1);
    expect(insertChemicalPhysicalLetter(second, "A")).toEqual({ ok: true, source: "Na" });
    expect(second.executeCommand).toHaveBeenCalledWith([
      "insert",
      "Na",
      { insertionMode: "replaceSelection", selectionMode: "after" },
    ]);
  });

  test("reports an ambiguous two-letter element without changing the uppercase default", () => {
    const field = fakeMathField("C", 1);

    expect(insertChemicalPhysicalLetter(field, "O")).toEqual({
      ok: true,
      source: "CO",
      ambiguousElement: "Co",
    });
  });

  test("leaves raw LaTeX mode and failed commands untouched", () => {
    const latexField = fakeMathField(String.raw`\alp`, 4);
    latexField.mode = "latex";
    expect(insertChemicalPhysicalLetter(latexField, "H")).toEqual({
      ok: false,
      reason: "unsupported-mode",
    });
    expect(latexField.executeCommand).not.toHaveBeenCalled();

    const failedField = fakeMathField("N", 1, false);
    const selectionBefore = failedField.selection;
    expect(insertChemicalPhysicalLetter(failedField, "A")).toEqual({
      ok: false,
      reason: "command-failed",
    });
    expect(failedField.value).toBe("N");
    expect(failedField.selection).toBe(selectionBefore);
  });

  test("wraps and unwraps a simple selected script", () => {
    const plain = fakeMathField("2", 1);
    plain.selectionIsCollapsed = false;
    plain.selection = { ranges: [[0, 1]], direction: "forward" };
    expect(toggleSelectedChemicalScript(plain, "subscript")).toEqual({
      ok: true,
      source: "_{2}",
    });

    const wrapped = fakeMathField("_{2}", 4);
    wrapped.selectionIsCollapsed = false;
    wrapped.selection = { ranges: [[0, 4]], direction: "forward" };
    expect(toggleSelectedChemicalScript(wrapped, "subscript")).toEqual({
      ok: true,
      source: "2",
    });
  });

  test("rejects a complex selected expression without changing it", () => {
    const field = fakeMathField("H_{2}+O^{2-}", 13);
    field.selectionIsCollapsed = false;
    field.selection = { ranges: [[0, 13]], direction: "forward" };

    expect(toggleSelectedChemicalScript(field, "superscript")).toEqual({
      ok: false,
      reason: "complex-selection",
    });
    expect(field.value).toBe("H_{2}+O^{2-}");
    expect(field.executeCommand).not.toHaveBeenCalled();
  });
});
