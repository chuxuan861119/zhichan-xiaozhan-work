import { Editor } from "@tiptap/core";
import { expect, test } from "vitest";
import { createPatentExtensions } from "../extensions";
import { inspectionSelectionKey } from "./inspection-selection";

test("inspection selection stays quiet until the user changes selection", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<p>测试文字内容</p>",
  });
  editor.chain().setMeta(inspectionSelectionKey, true).setTextSelection({ from: 1, to: 4 }).run();
  expect(inspectionSelectionKey.getState(editor.state)).toBe(true);
  editor.view.dispatch(editor.state.tr.setMeta("unrelated", true));
  expect(inspectionSelectionKey.getState(editor.state)).toBe(true);
  editor.commands.setTextSelection({ from: 2, to: 5 });
  expect(inspectionSelectionKey.getState(editor.state)).toBe(false);
  editor.destroy();
});

test("manual pointer selection clears suppression even at the same position", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<p>测试文字内容</p>",
  });
  editor.chain().setMeta(inspectionSelectionKey, true).setTextSelection({ from: 1, to: 4 }).run();
  editor.view.dom.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(inspectionSelectionKey.getState(editor.state)).toBe(false);
  editor.destroy();
});
