import { Editor } from "@tiptap/core";
import { vi } from "vitest";
import { createPatentExtensions } from "./extensions";
import { countDocumentText, countSelectedText } from "./status-counts";

test("reuses immutable paragraphs while counts follow edits and undo immediately", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<p>专利😀</p><p>未变段落</p>",
  });
  const original = editor.state.doc;
  expect(countDocumentText(original)).toEqual({ chineseCharacters: 6, totalCharacters: 7 });
  expect(countDocumentText(original)).toBe(countDocumentText(original));
  const unchanged = original.child(1);
  const traverse = vi.spyOn(unchanged, "forEach");
  editor.commands.setTextSelection(3);
  editor.commands.insertContent("测试 A");
  expect(editor.state.doc.child(1)).toBe(unchanged);
  expect(countDocumentText(editor.state.doc)).toEqual({
    chineseCharacters: 8,
    totalCharacters: 10,
  });
  expect(traverse).not.toHaveBeenCalled();
  expect(countSelectedText(editor.state.doc, 3, 3)).toBe(0);
  editor.commands.undo();
  expect(countDocumentText(editor.state.doc)).toEqual({ chineseCharacters: 6, totalCharacters: 7 });
  editor.commands.redo();
  expect(countDocumentText(editor.state.doc)).toEqual({
    chineseCharacters: 8,
    totalCharacters: 10,
  });
  editor.commands.selectAll();
  editor.commands.deleteSelection();
  expect(countDocumentText(editor.state.doc)).toEqual({ chineseCharacters: 0, totalCharacters: 0 });
  traverse.mockRestore();
  editor.destroy();
});

test("counts visible Unicode code points, Han characters and formula source", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "专利😀A" },
            { type: "inlineMath", attrs: { latex: "中文+x" } },
          ],
        },
      ],
    },
  });
  expect(countDocumentText(editor.state.doc)).toEqual({ chineseCharacters: 4, totalCharacters: 8 });
  editor.commands.setTextSelection({ from: 1, to: 4 });
  expect(
    countSelectedText(editor.state.doc, editor.state.selection.from, editor.state.selection.to),
  ).toBe(3);
  editor.destroy();
});

test("does not count layout whitespace in document or selected character totals", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "专利" },
            { type: "text", text: "      ", marks: [{ type: "underline" }] },
            { type: "text", text: "A　B\tC" },
          ],
        },
      ],
    },
  });

  expect(countDocumentText(editor.state.doc)).toEqual({
    chineseCharacters: 2,
    totalCharacters: 5,
  });
  editor.commands.selectAll();
  expect(
    countSelectedText(editor.state.doc, editor.state.selection.from, editor.state.selection.to),
  ).toBe(5);
  editor.destroy();
});
