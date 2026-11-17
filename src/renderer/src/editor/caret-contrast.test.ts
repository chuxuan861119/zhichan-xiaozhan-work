import { DEFAULT_EDITOR_CARET_COLOR, getEditorCaretColor } from "./caret-contrast";

describe("editor caret contrast", () => {
  test("uses the brand deep blue when there is no known highlight", () => {
    expect(getEditorCaretColor()).toBe(DEFAULT_EDITOR_CARET_COLOR);
    expect(getEditorCaretColor(null)).toBe(DEFAULT_EDITOR_CARET_COLOR);
    expect(getEditorCaretColor("not-a-color")).toBe(DEFAULT_EDITOR_CARET_COLOR);
  });

  test("uses a light caret on a dark known highlight", () => {
    expect(getEditorCaretColor("#0B1F3A")).toBe("#FFFFFF");
    expect(getEditorCaretColor("#2563EB")).toBe("#FFFFFF");
  });

  test("keeps the deep blue caret on light highlights", () => {
    expect(getEditorCaretColor("#FFFF00")).toBe(DEFAULT_EDITOR_CARET_COLOR);
    expect(getEditorCaretColor("#B4C7E7")).toBe(DEFAULT_EDITOR_CARET_COLOR);
  });
});
