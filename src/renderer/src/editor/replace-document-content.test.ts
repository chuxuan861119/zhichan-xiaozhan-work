import { Editor } from "@tiptap/core";
import { expect, test } from "vitest";
import { createPatentExtensions } from "./extensions";
import { replaceDocumentContent } from "./replace-document-content";

test.each([
  ["a", "aa"],
  ["aa", "a"],
  ["前文后文", "前文新增后文"],
  ["相同", "相同"],
])("replaces repeated text exactly: %s -> %s", (before, after) => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: `<p>${before}</p>` });
  try {
    const content = editor.getJSON();
    content.content![0]!.content = [{ type: "text", text: after, marks: [] }];
    const next = editor.schema.nodeFromJSON(content);
    const tr = replaceDocumentContent(editor.state.tr, next);
    expect(tr.doc.eq(next)).toBe(true);
    expect(tr.docChanged).toBe(before !== after);
    editor.view.dispatch(tr);
    expect(editor.getText()).toBe(after);
  } finally {
    editor.destroy();
  }
});
