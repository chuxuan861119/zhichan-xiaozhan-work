import { act, fireEvent, render, screen } from "@testing-library/react";
import { closeHistory } from "@tiptap/pm/history";
import { createBlankDocument } from "../../../shared/document/defaults";
import { EditorCommandBus } from "../app/command-bus";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";
import { RichTextEditorCore } from "./rich-text-editor-core";

function mountEditor() {
  const document = createBlankDocument("列表粘贴");
  const bus = new EditorCommandBus();
  const view = render(
    <RichTextEditorCore
      editorId="list-paste"
      title={document.title}
      document={document}
      commandBus={bus}
      capabilities={{
        headings: true,
        lists: true,
        tables: true,
        formulas: true,
        chemistry: true,
        images: false,
        pageBreaks: true,
      }}
      toTiptap={canonicalToTiptap}
      fromTiptap={tiptapToCanonical}
      onDocumentChange={vi.fn()}
    />,
  );
  const editor = bus.getEditor("list-paste");
  if (!editor) throw new Error("Missing editor");
  return { document, view, editor };
}

test.each(["empty", "end", "middle", "selection"])(
  "pasting later ordered items into a %s root paragraph preserves every number",
  (destination) => {
    const { document, view, editor } = mountEditor();
    try {
      let html = "";
      let text = "";
      act(() => {
        editor.commands.setContent(
          '<ol start="3"><li><p>甲</p></li><li><p>乙</p><p>续段</p></li><li><p>丙</p></li></ol>',
        );
        const positions: Record<string, number> = {};
        editor.state.doc.descendants((node, pos) => {
          if (node.isText && node.text) positions[node.text] = pos;
        });
        const from = positions.乙;
        const last = positions.丙;
        if (from === undefined || last === undefined) throw new Error("Missing copied list items");
        editor.commands.setTextSelection({ from, to: last + 1 });
        const copied = editor.view.serializeForClipboard(editor.state.selection.content());
        html = copied.dom.innerHTML;
        text = copied.text;
        editor.commands.setContent(destination === "empty" ? "<p></p>" : "<p>前后</p>");
        editor.commands.setTextSelection(
          destination === "empty"
            ? 1
            : destination === "end"
              ? 3
              : destination === "selection"
                ? { from: 1, to: 2 }
                : 2,
        );
        editor.view.dispatch(closeHistory(editor.state.tr));
      });
      const before = editor.getJSON();
      fireEvent.paste(screen.getByRole("textbox", { name: "编辑 列表粘贴" }), {
        clipboardData: {
          files: [],
          getData: (type: string) => (type === "text/html" ? html : text),
        },
      });
      const lists = editor.getJSON().content?.filter((node) => node.type === "orderedList");
      expect(lists).toHaveLength(1);
      expect(lists?.[0]?.attrs?.start).toBe(4);
      expect(lists?.[0]?.content).toHaveLength(2);
      expect(editor.view.dom.querySelector("ol > li")?.querySelectorAll(":scope > p")).toHaveLength(
        2,
      );
      expect(editor.state.doc.textContent).toBe(
        destination === "empty"
          ? "乙续段丙"
          : destination === "end"
            ? "前后乙续段丙"
            : destination === "selection"
              ? "乙续段丙后"
              : "前乙续段丙后",
      );
      expect(tiptapToCanonical(editor.getJSON(), document).ok).toBe(true);
      const pasted = editor.getJSON();
      act(() => expect(editor.commands.undo()).toBe(true));
      expect(editor.getJSON()).toEqual(before);
      act(() => expect(editor.commands.redo()).toBe(true));
      expect(editor.getJSON()).toEqual(pasted);
    } finally {
      view.unmount();
      editor.destroy();
    }
  },
);

test.each(["existing-list", "table", "same-document"])(
  "list paste remains valid in %s and leaves the source content intact",
  (destination) => {
    const { document, view, editor } = mountEditor();
    try {
      let html = "";
      act(() => {
        editor.commands.setContent(
          '<ol start="3"><li><p>甲</p></li><li><p>乙</p></li><li><p>丙</p></li></ol><p>目标</p>',
        );
        const positions: Record<string, number> = {};
        editor.state.doc.descendants((node, pos) => {
          if (node.isText && node.text) positions[node.text] = pos;
        });
        const from = positions.乙;
        const last = positions.丙;
        if (from === undefined || last === undefined) throw new Error("Missing copied list items");
        editor.commands.setTextSelection({ from, to: last + 1 });
        html = editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML;
        if (destination === "existing-list") {
          editor.commands.setContent("<ol><li><p>目标</p></li></ol>");
          editor.commands.setTextSelection(5);
        } else if (destination === "table") {
          editor.commands.setContent("<table><tr><td><p>目标</p></td></tr></table>");
          editor.commands.setTextSelection(6);
        } else {
          const target = positions.目标;
          if (target === undefined) throw new Error("Missing target text");
          editor.commands.setTextSelection(target + 2);
        }
      });
      fireEvent.paste(screen.getByRole("textbox", { name: "编辑 列表粘贴" }), {
        clipboardData: {
          files: [],
          getData: (type: string) => (type === "text/html" ? html : "乙丙"),
        },
      });
      expect(tiptapToCanonical(editor.getJSON(), document).ok).toBe(true);
      expect(editor.state.doc.textContent).toBe(
        destination === "same-document" ? "甲乙丙目标乙丙" : "目标乙丙",
      );
      if (destination === "same-document") {
        const lists = editor.getJSON().content?.filter((node) => node.type === "orderedList");
        expect(lists?.map((node) => node.attrs?.start)).toEqual([3, 4]);
        expect(lists?.map((node) => node.content?.length)).toEqual([3, 2]);
      } else if (destination === "existing-list") {
        expect(editor.state.doc.child(0).childCount).toBe(2);
        expect(editor.state.doc.child(0).attrs.start).toBe(1);
      } else {
        expect(editor.state.doc.child(0).type.name).toBe("table");
      }
    } finally {
      view.unmount();
      editor.destroy();
    }
  },
);
