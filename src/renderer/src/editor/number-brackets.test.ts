import { Editor } from "@tiptap/core";
import { EditorCommandBus } from "../app/command-bus";
import type { EditorCommand } from "./commands";
import { runEditorCommand } from "./commands";
import { createPatentExtensions } from "./extensions";

test("wraps selected digit runs across marks, preserves format and supports undo/redo", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<p>外9 关键词1，关键词<strong>20</strong>1</p><p>尾8</p>",
  });
  editor.commands.setTextSelection({ from: 4, to: 17 });
  const original = editor.getText();
  expect(runEditorCommand(editor, "add-number-brackets" as EditorCommand)).toBe(true);
  expect(editor.getText()).toBe("外9 关键词(1)，关键词(201)\n\n尾8");
  expect(editor.getHTML()).toContain("<strong>");
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getText()).toEqual(original);
  expect(editor.getHTML()).toContain("<strong>20</strong>");
  expect(editor.commands.redo()).toBe(true);
  expect(editor.getText()).toContain("关键词(201)");
  editor.destroy();
});

test("does not nest existing parentheses, even when only their digits are selected", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<p>词(201)词（2）</p>",
  });
  editor.commands.setTextSelection({ from: 3, to: 6 });
  expect(runEditorCommand(editor, "add-number-brackets" as EditorCommand)).toBe(false);
  editor.commands.selectAll();
  expect(runEditorCommand(editor, "add-number-brackets" as EditorCommand)).toBe(false);
  editor.destroy();
});

test("removes brackets throughout the selection, keeping their content and outside text", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<p>外(9)</p><p>词(201)（内容）[2]【3】{4}</p>",
  });
  editor.commands.setTextSelection({ from: 7, to: editor.state.doc.content.size - 1 });
  expect(runEditorCommand(editor, "remove-number-brackets" as EditorCommand)).toBe(true);
  expect(editor.getText()).toBe("外(9)\n\n词201内容234");
  editor.destroy();
});

test.each(["add-number-brackets", "remove-number-brackets"])(
  "%s rejects an empty selection",
  (command) => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>词(1)</p>" });
    expect(runEditorCommand(editor, command as EditorCommand)).toBe(false);
    expect(editor.getText()).toBe("词(1)");
    editor.destroy();
  },
);

test("selection availability is published when only the selection changes", () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>关键词201</p>" });
  const bus = new EditorCommandBus();
  bus.register("test", editor);
  const listener = vi.fn();
  const unsubscribe = bus.subscribeFormatState("test", listener);
  editor.commands.setTextSelection({ from: 1, to: 7 });
  expect(listener.mock.lastCall?.[0].hasBracketTextSelection).toBe(true);
  expect(bus.execute("test", "add-number-brackets")).toBe(true);
  expect(editor.getText()).toBe("关键词(201)");
  editor.commands.setTextSelection(1);
  expect(listener.mock.lastCall?.[0].hasBracketTextSelection).toBe(false);
  unsubscribe();
  editor.destroy();
});

test("all-selection processes multiple paragraphs and read-only documents cannot change", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<p>词1</p><p>词201</p>",
  });
  editor.commands.selectAll();
  expect(runEditorCommand(editor, "add-number-brackets")).toBe(true);
  expect(editor.getText()).toBe("词(1)\n\n词(201)");
  expect(runEditorCommand(editor, "add-number-brackets")).toBe(false);
  editor.setEditable(false);
  expect(runEditorCommand(editor, "remove-number-brackets")).toBe(false);
  editor.destroy();
});
