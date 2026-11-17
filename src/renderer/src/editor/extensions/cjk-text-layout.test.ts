import { Editor } from "@tiptap/core";
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPatentExtensions } from "../extensions";

afterEach(() => vi.useRealTimers());

describe("native CJK text layout", () => {
  test("does not split punctuation into probes or dispatch delayed layout transactions", () => {
    vi.useFakeTimers();
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: "<p>电池包，继续描述。</p>",
    });
    try {
      vi.advanceTimersByTime(1000);
      editor.commands.insertContentAt(1, "新");
      editor.commands.undo();
      editor.commands.setTextSelection({ from: 2, to: 5 });
      const document = editor.getJSON();
      const selection = editor.state.selection.toJSON();
      const transaction = vi.fn();
      editor.on("transaction", transaction);
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(1000);
      expect(editor.view.dom.querySelector(".cjk-closing-punctuation")).toBeNull();
      expect(transaction).not.toHaveBeenCalled();
      expect(editor.getJSON()).toEqual(document);
      expect(editor.state.selection.toJSON()).toEqual(selection);
      expect(undoDepth(editor.state)).toBe(0);
      expect(redoDepth(editor.state)).toBe(1);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getText()).toBe("新电池包，继续描述。");
    } finally {
      editor.destroy();
    }
  });

  test.each(["短文", "<p>短。</p>", "<p>新内容。</p><p>另一段。</p>", ""])(
    "preserves full replacement/deletion and history with punctuation: %s",
    (replacement) => {
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { nodeId: "original-paragraph" },
              content: [{ type: "text", text: "电池包，继续描述。" }],
            },
          ],
        },
      });
      try {
        const before = editor.getJSON();
        editor.commands.selectAll();
        if (replacement) editor.commands.insertContent(replacement);
        else editor.commands.deleteSelection();
        const after = editor.getJSON();
        expect(editor.getText()).not.toContain("电池包");
        expect(editor.commands.undo()).toBe(true);
        expect(editor.getJSON()).toEqual(before);
        expect(editor.commands.redo()).toBe(true);
        expect(editor.getJSON()).toEqual(after);
      } finally {
        editor.destroy();
      }
    },
  );
});
