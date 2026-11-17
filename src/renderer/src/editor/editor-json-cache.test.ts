import { Editor } from "@tiptap/core";
import { createEditorJsonCache } from "./editor-json-cache";
import { createPatentExtensions } from "./extensions";

test("cached node serialization matches the editor and reuses unchanged paragraphs through edit and undo", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<p>甲<strong>乙</strong></p><p>丙</p>",
  });
  const read = createEditorJsonCache();
  const before = read(editor.state.doc);
  expect(before).toEqual(editor.getJSON());
  editor.commands.insertContentAt(1, "丁");
  const after = read(editor.state.doc);
  expect(after).toEqual(editor.getJSON());
  expect(after.content?.[1]).toBe(before.content?.[1]);
  expect(after.content?.[0]).not.toBe(before.content?.[0]);
  expect(before.content?.[0]?.content?.[0]?.text).toBe("甲");
  editor.commands.undo();
  expect(read(editor.state.doc)).toEqual(editor.getJSON());
  editor.destroy();
});
