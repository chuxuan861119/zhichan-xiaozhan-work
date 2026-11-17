import type { ChemicalMathField } from "./chemical-mathfield-adapter";
import {
  applyReactionCondition,
  captureReactionCondition,
  parseReactionCondition,
} from "./chemical-reaction-condition";

describe("reaction condition selection", () => {
  test.each([
    [String.raw`\xrightarrow{Pt}`, { upper: "Pt", lower: "", reversible: false }],
    [
      String.raw` \xrightleftharpoons [加热]{MnO_{2}} `,
      { upper: "MnO_{2}", lower: "加热", reversible: true },
    ],
    [
      String.raw`\xrightarrow[\text{[热]}]{\frac{a}{b}}`,
      { upper: String.raw`\frac{a}{b}`, lower: String.raw`\text{[热]}`, reversible: false },
    ],
    [String.raw`\xrightarrow{\{x\}}`, { upper: String.raw`\{x\}`, lower: "", reversible: false }],
    [String.raw`\xrightarrow[Δ]{}`, { upper: "", lower: "Δ", reversible: false }],
  ])("parses a complete arrow: %s", (source, expected) => {
    expect(parseReactionCondition(source)).toEqual(expected);
  });

  test.each([
    "Pt",
    String.raw`A\xrightarrow{Pt}`,
    String.raw`\xrightarrow{Pt}B`,
    String.raw`\xrightarrow{Pt}\xrightarrow{Ni}`,
    String.raw`\xrightarrow{Pt`,
    String.raw`\xrightarrow[Δ{}`,
  ])("rejects partial or mixed selection: %s", (source) => {
    expect(parseReactionCondition(source)).toBeNull();
  });

  function field() {
    return {
      value: String.raw`A\xrightarrow{Pt}B`,
      selection: { ranges: [[1, 4]], direction: "forward" },
      getValue: vi.fn().mockReturnValue(String.raw`\xrightarrow{Pt}`),
      executeCommand: vi.fn().mockReturnValue(false),
      focus: vi.fn(),
    } as unknown as ChemicalMathField;
  }

  test("captures editor offsets without interpreting them as string indices", () => {
    const editor = field();
    const target = captureReactionCondition(editor);
    expect(target?.condition?.upper).toBe("Pt");
    const range = editor.selection?.ranges[0];
    if (!range) throw new Error("Missing test selection");
    range[0] = 0;
    expect(target?.selection.ranges).toEqual([[1, 4]]);
  });

  test("rejects multiple arrows without changing the source", () => {
    const editor = field();
    vi.mocked(editor.getValue).mockReturnValue(String.raw`\xrightarrow{Pt}\xrightarrow{Ni}`);
    expect(captureReactionCondition(editor)).toBeNull();
    expect(editor.executeCommand).not.toHaveBeenCalled();
  });

  test("rejects a stale target without issuing a command", () => {
    const editor = field();
    const target = captureReactionCondition(editor);
    if (!target) throw new Error("Missing test target");
    editor.value += "C";
    expect(applyReactionCondition(editor, target, String.raw`\xrightarrow{Ni}`)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(editor.executeCommand).not.toHaveBeenCalled();
  });

  test("keeps original source and selection if insertion fails", () => {
    const editor = field();
    const target = captureReactionCondition(editor);
    if (!target) throw new Error("Missing test target");
    editor.selection = { ranges: [[0, 0]] };
    const before = editor.value;
    expect(applyReactionCondition(editor, target, String.raw`\xrightarrow{Ni}`)).toEqual({
      ok: false,
      reason: "command-failed",
    });
    expect(editor.value).toBe(before);
    expect(editor.selection?.ranges).toEqual([[0, 0]]);
  });
});
