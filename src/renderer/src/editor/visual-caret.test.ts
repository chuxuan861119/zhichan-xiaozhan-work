import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPatentExtensions } from "./extensions";
import { preserveClickedLineEnd } from "./visual-caret";

let editor: Editor;
let modify: ReturnType<typeof vi.fn>;
function domSelection() {
  const selection = document.getSelection();
  if (!selection) throw new Error("missing DOM selection");
  return selection;
}
beforeEach(() => {
  editor = new Editor({ extensions: createPatentExtensions(), content: "<p>甲乙丙丁</p>" });
  document.body.append(editor.view.dom);
  editor.commands.setTextSelection(3);
  const selected = domSelection();
  const dom = editor.view.domAtPos(3);
  selected.collapse(dom.node, dom.offset);
  modify = vi.fn();
  Object.defineProperty(selected, "modify", { value: modify, configurable: true });
  vi.spyOn(editor.view, "coordsAtPos").mockImplementation((_pos, side) =>
    side === -1
      ? { left: 100, right: 100, top: 10, bottom: 30 }
      : { left: 0, right: 0, top: 40, bottom: 60 },
  );
});
afterEach(() => {
  editor.destroy();
  vi.restoreAllMocks();
});

test("uses a native visual line boundary without editing text, selection or history", () => {
  const doc = editor.getJSON();
  const selection = editor.state.selection;
  const dispatch = vi.spyOn(editor.view, "dispatch");
  preserveClickedLineEnd(editor.view, 3, { x: 110, y: 20 });
  expect(modify.mock.calls).toEqual([
    ["move", "backward", "character"],
    ["move", "forward", "lineboundary"],
  ]);
  expect(editor.getJSON()).toEqual(doc);
  expect(editor.state.selection).toBe(selection);
  expect(dispatch).not.toHaveBeenCalled();
});

test("does not change a caret on the next line or within a non-wrapped line", () => {
  preserveClickedLineEnd(editor.view, 3, { x: 0, y: 50 });
  vi.mocked(editor.view.coordsAtPos).mockReturnValue({
    left: 100,
    right: 100,
    top: 10,
    bottom: 30,
  });
  preserveClickedLineEnd(editor.view, 3, { x: 110, y: 20 });
  expect(modify).not.toHaveBeenCalled();
});

test("does not touch a range selection, a paragraph boundary, or composition", () => {
  editor.commands.setTextSelection({ from: 1, to: 3 });
  preserveClickedLineEnd(editor.view, 3, { x: 110, y: 20 });
  editor.commands.setTextSelection(1);
  preserveClickedLineEnd(editor.view, 1, { x: 110, y: 20 });
  editor.commands.setTextSelection(3);
  vi.spyOn(editor.view, "composing", "get").mockReturnValue(true);
  preserveClickedLineEnd(editor.view, 3, { x: 110, y: 20 });
  expect(modify).not.toHaveBeenCalled();
});

test("restores the original DOM caret if native movement changes its document position", () => {
  const selected = domSelection();
  const original = { node: selected.focusNode, offset: selected.focusOffset };
  modify.mockImplementation(() => selected.collapse(original.node, 0));
  preserveClickedLineEnd(editor.view, 3, { x: 110, y: 20 });
  expect(selected.focusNode).toBe(original.node);
  expect(selected.focusOffset).toBe(original.offset);
});
