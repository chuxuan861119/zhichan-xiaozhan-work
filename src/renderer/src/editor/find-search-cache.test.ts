import { Editor } from "@tiptap/core";
import { createPatentExtensions } from "./extensions";
import { prepareFindSearch } from "./find-replace";

test("switching literal and regex modes reuses chunks while changed documents invalidate them", () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>甲<br>乙</p>" });
  try {
    const doc = editor.state.doc;
    const literal = prepareFindSearch(doc, {});
    const regex = prepareFindSearch(doc, { searchMode: "regex" });
    expect(prepareFindSearch(doc, {})).toBe(literal);
    expect(prepareFindSearch(doc, { searchMode: "regex" })).toBe(regex);
    expect(regex).not.toEqual(literal);
    editor.commands.insertContentAt(1, "新增");
    expect(prepareFindSearch(editor.state.doc, {})).not.toBe(literal);
  } finally {
    editor.destroy();
  }
});
