import { Editor } from "@tiptap/core";
import { Decoration } from "@tiptap/pm/view";
import { createPatentExtensions } from "../extensions";
import { findLiteralMatches } from "../find-replace";
import { setFindReplaceHighlights } from "./find-replace-highlights";

test("moving the active match retains other highlights and maps them through edits", () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "甲 甲 甲" });
  const matches = findLiteralMatches(editor.state.doc, "甲");
  setFindReplaceHighlights(editor, matches, matches[0]!);
  const create = vi.spyOn(Decoration, "inline");
  setFindReplaceHighlights(editor, matches, matches[1]!);
  expect(editor.view.dom.querySelectorAll(".find-replace-match")).toHaveLength(3);
  expect(editor.view.dom.querySelector(".find-replace-match.is-active")?.textContent).toBe("甲");
  expect(create).toHaveBeenCalledTimes(2);
  create.mockRestore();
  editor.commands.insertContentAt(1, "乙");
  expect(editor.view.dom.querySelectorAll(".find-replace-match")).toHaveLength(3);
  setFindReplaceHighlights(editor, [], null);
  expect(editor.view.dom.querySelectorAll(".find-replace-match")).toHaveLength(0);
  editor.destroy();
});

test("fresh worker results with identical positions reuse existing highlights", () => {
  const editor = new Editor({ extensions: createPatentExtensions(), content: "甲 甲 甲" });
  const matches = findLiteralMatches(editor.state.doc, "甲");
  setFindReplaceHighlights(editor, matches, matches[0]!);
  const create = vi.spyOn(Decoration, "inline");
  try {
    setFindReplaceHighlights(
      editor,
      matches.map((match) => ({ ...match })),
      matches[0]!,
    );
    expect(create).not.toHaveBeenCalled();
    setFindReplaceHighlights(
      editor,
      matches.map((match) => ({ ...match })),
      matches[1]!,
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(editor.view.dom.querySelectorAll(".find-replace-match")).toHaveLength(3);
  } finally {
    create.mockRestore();
    editor.destroy();
  }
});
