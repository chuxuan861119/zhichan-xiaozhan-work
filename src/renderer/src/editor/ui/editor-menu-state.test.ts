import { Editor } from "@tiptap/core";
import FontFamily from "@tiptap/extension-font-family";
import { TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import {
  menuFormatValue,
  pasteIntoMenuEditor,
  runMenuClipboard,
  selectContextTarget,
} from "./editor-menu-state";

function fixture() {
  return new Editor({
    extensions: [StarterKit, TextStyle, FontFamily],
    content: "<p>alpha beta</p>",
  });
}
test("right click inside preserves selection; outside relocates it", () => {
  const editor = fixture();
  editor.commands.setTextSelection({ from: 1, to: 6 });
  selectContextTarget(editor, 3);
  expect(editor.state.selection.to).toBe(6);
  selectContextTarget(editor, 8);
  expect(editor.state.selection.empty).toBe(true);
  expect(editor.state.selection.from).toBe(8);
  editor.destroy();
});
test("mixed values are not reported as a single font size", () => {
  const editor = fixture();
  editor.commands.setContent(
    '<p><span style="font-family:SimSun">a</span><span style="font-family:Source Han Serif CN">b</span></p>',
  );
  editor.commands.setTextSelection({ from: 1, to: 3 });
  expect(menuFormatValue(editor, "fontFamily", "SimSun")).toBe("mixed");
  editor.destroy();
});
test("failed clipboard copy cannot delete selected content", () => {
  const editor = fixture();
  editor.commands.setTextSelection({ from: 1, to: 6 });
  expect(runMenuClipboard(editor, "cut", () => false)).toBe(false);
  expect(editor.getText()).toBe("alpha beta");
  expect(runMenuClipboard(editor, "cut", () => true)).toBe(true);
  expect(editor.getText()).toBe(" beta");
  editor.commands.undo();
  expect(editor.getText()).toBe("alpha beta");
  editor.destroy();
});

test.each(["other editor", "changed selection"])(
  "delayed native paste refuses %s",
  async (reason) => {
    const editor = fixture();
    document.body.append(editor.view.dom);
    const result = pasteIntoMenuEditor(editor, async () => ({ ok: true }));
    if (reason === "changed selection") editor.commands.setTextSelection(4);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    (reason === "other editor" ? document.body : editor.view.dom).dispatchEvent(event);
    expect(await result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getText()).toBe("alpha beta");
    editor.view.dom.remove();
    editor.destroy();
  },
);

test("handled but rejected copy cannot erase the selection", () => {
  const editor = fixture();
  editor.commands.setTextSelection({ from: 1, to: 6 });
  const native = () => {
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: [] } });
    event.preventDefault();
    document.dispatchEvent(event);
    return true;
  };
  expect(runMenuClipboard(editor, "cut", native)).toBe(false);
  expect(editor.getText()).toBe("alpha beta");
  editor.destroy();
});
