import { Editor } from "@tiptap/core";
import { runEditorCommand } from "../commands";
import { createPatentExtensions } from "../extensions";

function createTextEditor(text: string): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  });
}

test.each([
  ["superscript", "superscript"],
  ["subscript", "subscript"],
] as const)("shows a small displaced %s caret before text is entered", (command, mode) => {
  const editor = createTextEditor("HX");
  editor.commands.setTextSelection(2);

  expect(runEditorCommand(editor, command)).toBe(true);

  expect(editor.view.dom.classList.contains("has-script-input-caret")).toBe(true);
  expect(editor.view.dom.querySelector(`[data-script-input-caret="${mode}"]`)).not.toBeNull();
  editor.destroy();
});

test.each([
  ["superscript", "superscript"],
  ["subscript", "subscript"],
] as const)(
  "uses the first ArrowRight after %s input to leave the script without skipping the next character",
  (command, markName) => {
    const editor = createTextEditor("HX");
    editor.commands.setTextSelection(2);
    runEditorCommand(editor, command);
    editor.commands.insertContent("2");
    const positionAfterScript = editor.state.selection.from;

    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    editor.view.dom.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(positionAfterScript);
    expect(editor.isActive(markName)).toBe(false);

    editor.commands.insertContent("O");
    expect(editor.getText()).toBe("H2OX");
    const textNodes = editor.getJSON().content?.[0]?.content ?? [];
    expect(textNodes).toEqual([
      expect.objectContaining({ text: "H" }),
      expect.objectContaining({
        text: "2",
        marks: [expect.objectContaining({ type: markName })],
      }),
      expect.objectContaining({ text: "OX" }),
    ]);
    editor.destroy();
  },
);

test("restores the native caret style before dispatching the ArrowRight exit transaction", () => {
  const editor = createTextEditor("HX");
  editor.commands.setTextSelection(2);
  runEditorCommand(editor, "superscript");
  editor.commands.insertContent("2");

  let hadScriptCaretClassAtDispatch: boolean | undefined;
  const originalDispatch = editor.view.dispatch.bind(editor.view);
  vi.spyOn(editor.view, "dispatch").mockImplementation((transaction) => {
    hadScriptCaretClassAtDispatch = editor.view.dom.classList.contains("has-script-input-caret");
    originalDispatch(transaction);
  });

  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(hadScriptCaretClassAtDispatch).toBe(false);
  expect(editor.view.dom.classList.contains("has-script-input-caret")).toBe(true);
  expect(editor.view.dom.querySelector('[data-script-input-caret="normal"]')).not.toBeNull();

  editor.commands.insertContent("O");
  expect(editor.view.dom.classList.contains("has-script-input-caret")).toBe(false);
  expect(editor.view.dom.querySelector('[data-script-input-caret="normal"]')).toBeNull();
  editor.destroy();
});

test("restores the native caret style before toggling script input off from the toolbar", () => {
  const editor = createTextEditor("HX");
  editor.commands.setTextSelection(2);
  runEditorCommand(editor, "subscript");

  let hadScriptCaretClassAtDispatch: boolean | undefined;
  const originalDispatch = editor.view.dispatch.bind(editor.view);
  vi.spyOn(editor.view, "dispatch").mockImplementation((transaction) => {
    hadScriptCaretClassAtDispatch = editor.view.dom.classList.contains("has-script-input-caret");
    originalDispatch(transaction);
  });

  runEditorCommand(editor, "subscript");

  expect(hadScriptCaretClassAtDispatch).toBe(false);
  expect(editor.view.dom.classList.contains("has-script-input-caret")).toBe(true);
  expect(editor.view.dom.querySelector('[data-script-input-caret="normal"]')).not.toBeNull();
  editor.destroy();
});
