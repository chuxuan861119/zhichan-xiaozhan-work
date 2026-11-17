import { getChemicalPhysicalLetter, planChemicalLetterInsertion } from "./chemical-keyboard-input";

describe("chemical physical keyboard input", () => {
  test.each([
    [{ code: "KeyH", key: "h" }, "H"],
    [{ code: "KeyO", key: "O", shiftKey: true }, "O"],
    [{ code: "KeyN", key: "Process", isComposing: true }, "N"],
  ])("maps a physical letter key to uppercase English", (event, expected) => {
    expect(getChemicalPhysicalLetter(event)).toBe(expected);
  });

  test.each([
    { code: "KeyA", key: "a", ctrlKey: true },
    { code: "KeyV", key: "v", metaKey: true },
    { code: "KeyF", key: "f", altKey: true },
    { code: "Digit2", key: "2" },
  ])("does not intercept shortcuts or non-letter keys", (event) => {
    expect(getChemicalPhysicalLetter(event)).toBeNull();
  });

  test.each([
    ["N", "A", { latex: "Na", replacePrevious: true }],
    ["C", "L", { latex: "Cl", replacePrevious: true }],
    ["H", "E", { latex: "He", replacePrevious: true }],
  ])("canonicalizes an unambiguous two-letter element %s%s", (previous, letter, expected) => {
    expect(planChemicalLetterInsertion(previous, letter)).toEqual(expected);
  });

  test("keeps separate one-letter elements and exposes the ambiguous element spelling", () => {
    expect(planChemicalLetterInsertion("C", "O")).toEqual({
      latex: "O",
      replacePrevious: false,
      ambiguousElement: "Co",
    });
  });

  test("inserts a new element in uppercase when no two-letter element applies", () => {
    expect(planChemicalLetterInsertion("H", "C")).toEqual({
      latex: "C",
      replacePrevious: false,
    });
  });
});
