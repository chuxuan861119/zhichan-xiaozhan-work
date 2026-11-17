import { Editor, type JSONContent } from "@tiptap/core";
import { TableMap } from "@tiptap/pm/tables";
import { expect, test } from "vitest";
import { createBlankBookDocument } from "../../../../shared/document/defaults";
import { EditorCommandBus } from "../../app/command-bus";
import { createPatentExtensions } from "../extensions";
import { canonicalToTiptap, tiptapToPatentBookDocument } from "../model-adapter";

// The fractional grid tracks arise when a merged row is split into equal cells
// while other rows retain their previous unequal column boundaries.
test("filling description after a split table preserves cells and supports undo/reopen", () => {
  const widths = [10.583, 3.37275, 13.95575, 0.0395, 13.804, 0.11225, 13.95575];
  const paragraph = (text: string): JSONContent => ({
    type: "paragraph",
    attrs: { nodeId: crypto.randomUUID() },
    content: text ? [{ type: "text", text }] : [],
  });
  const table: JSONContent = {
    type: "table",
    attrs: { nodeId: crypto.randomUUID(), columnWidthsMm: widths, layoutMode: "fixed" },
    content: [
      [2, 1, 3, 1],
      [1, 3, 1, 2],
    ].map((spans) => {
      let column = 0;
      return {
        type: "tableRow",
        attrs: { nodeId: crypto.randomUUID() },
        content: spans.map((colspan, i) => {
          const colwidth = widths
            .slice(column, column + colspan)
            .map((w) => Math.max(1, Math.round((w * 96) / 25.4)));
          column += colspan;
          return {
            type: "tableCell",
            attrs: { nodeId: crypto.randomUUID(), colspan, colwidth },
            content: [paragraph(`数据${i}`)],
          };
        }),
      };
    }),
  };
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: { type: "doc", content: [table, paragraph("原说明")] },
  });
  const bus = new EditorCommandBus();
  bus.register("description", editor);
  try {
    const before = editor.getJSON();
    const saved = tiptapToPatentBookDocument(before, createBlankBookDocument("验收"), new Set());
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    const next = canonicalToTiptap(saved.value);
    next.content!.push(paragraph("图1为控制流程。"));
    expect(bus.replaceDocumentWithHistory("description", next)).toBe(true);
    expect(editor.getText()).toContain("图1为控制流程。");
    expect(TableMap.get(editor.state.doc.firstChild!).width).toBe(7);
    expect(editor.state.doc.firstChild!.textContent).toBe(
      "数据0数据1数据2数据3数据0数据1数据2数据3",
    );
    const after = editor.getJSON();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(after);
    const roundtrip = tiptapToPatentBookDocument(after, saved.value, new Set());
    expect(roundtrip.ok).toBe(true);
    if (!roundtrip.ok) return;
    const reopened = new Editor({
      extensions: createPatentExtensions(),
      content: canonicalToTiptap(roundtrip.value),
    });
    try {
      expect(reopened.getText()).toContain("图1为控制流程。");
      expect(TableMap.get(reopened.state.doc.firstChild!).width).toBe(7);
    } finally {
      reopened.destroy();
    }
  } finally {
    editor.destroy();
  }
});
