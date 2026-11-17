import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { runScriptInputCommand } from "./extensions/script-input-mode";
import { changeNumberBrackets } from "./number-brackets";

export type EditorCommand =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "underline"
  | "subscript"
  | "superscript"
  | "align-left"
  | "align-center"
  | "align-right"
  | "align-justify"
  | "bullet-list"
  | "ordered-list"
  | "add-number-brackets"
  | "remove-number-brackets"
  | "page-break";

function setAlignment(editor: Editor, alignment: "left" | "center" | "right"): boolean {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection && selection.node.type.name === "blockMath") {
    return editor.commands.updateAttributes("blockMath", { alignment });
  }
  return editor.chain().focus().setTextAlign(alignment).run();
}

export function runEditorCommand(editor: Editor, command: EditorCommand): boolean {
  switch (command) {
    case "add-number-brackets":
      return changeNumberBrackets(editor, true);
    case "remove-number-brackets":
      return changeNumberBrackets(editor, false);
    case "undo":
      return editor.commands.undo();
    case "redo":
      return editor.commands.redo();
    case "bold":
      return editor.chain().focus().toggleBold().run();
    case "italic":
      return editor.chain().focus().toggleItalic().run();
    case "underline":
      return editor.chain().focus().toggleUnderline().run();
    case "subscript":
      return runScriptInputCommand(editor, "subscript");
    case "superscript":
      return runScriptInputCommand(editor, "superscript");
    case "align-left":
      return setAlignment(editor, "left");
    case "align-center":
      return setAlignment(editor, "center");
    case "align-right":
      return setAlignment(editor, "right");
    case "align-justify":
      return editor.chain().focus().setTextAlign("justify").run();
    case "bullet-list":
      return editor.chain().focus().toggleBulletList().run();
    case "ordered-list":
      return editor.chain().focus().toggleOrderedList().run();
    case "page-break":
      return editor.chain().focus().insertPageBreak().run();
  }
}
