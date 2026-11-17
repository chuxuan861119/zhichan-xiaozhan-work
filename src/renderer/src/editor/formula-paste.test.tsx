import { act, fireEvent, render, screen } from "@testing-library/react";
import { closeHistory } from "@tiptap/pm/history";
import { createBlankDocument } from "../../../shared/document/defaults";
import { EditorCommandBus } from "../app/command-bus";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";
import { RichTextEditorCore } from "./rich-text-editor-core";

test.each(
  ["math", "chemistry"].flatMap((kind) => [false, true].map((legacy) => ({ kind, legacy }))),
)(
  "real serialized clipboard retains mixed text and $kind formula formatting (legacy=$legacy)",
  ({ kind, legacy }) => {
    const document = createBlankDocument("混排粘贴");
    const bus = new EditorCommandBus();
    const view = render(
      <RichTextEditorCore
        editorId="mixed-paste"
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
    const editor = bus.getEditor("mixed-paste");
    if (!editor) throw new Error("Missing editor");
    const latex = kind === "math" ? String.raw`\frac{x^2+1}{2}` : String.raw`\ce{2H2 + O2 -> 2H2O}`;
    try {
      act(() =>
        editor.commands.setContent({
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: {
                defaultFontFamily: "KaiTi",
                defaultFontSizePt: 12,
                textAlign: "right",
                paragraphIndentMm: 9.88,
                lineHeight: 1.5,
                spaceBeforePt: 6,
                spaceAfterPt: 8,
              },
              content: [
                {
                  type: "text",
                  text: "原文  𠮷α",
                  marks: [
                    { type: "bold" },
                    {
                      type: "textStyle",
                      attrs: { fontFamily: "FangSong", fontSizePt: 10.5, color: "#123ABC" },
                    },
                  ],
                },
                {
                  type: "inlineMath",
                  attrs: {
                    latex,
                    formulaKind: kind,
                    fontSizePt: 10.5,
                    ...(legacy ? {} : { color: "#FF0000" }),
                  },
                  ...(legacy
                    ? { marks: [{ type: "textStyle", attrs: { color: "#FF0000" } }] }
                    : {}),
                },
                { type: "text", text: "后文", marks: [{ type: "italic" }, { type: "underline" }] },
              ],
            },
          ],
        }),
      );
      const original = tiptapToCanonical(editor.getJSON(), document);
      if (!original.ok) throw new Error(original.error.message);
      const html = editor.view.serializeForClipboard(
        editor.state.doc.slice(0, editor.state.doc.content.size),
      ).dom.innerHTML;
      act(() => {
        editor.commands.setContent("<p></p>");
        editor.commands.setTextSelection(1);
        editor.view.dispatch(closeHistory(editor.state.tr));
      });
      const before = editor.getJSON();
      fireEvent.paste(screen.getByRole("textbox", { name: "编辑 混排粘贴" }), {
        clipboardData: { files: [], getData: (type: string) => (type === "text/html" ? html : "") },
      });
      const saved = tiptapToCanonical(editor.getJSON(), document);
      if (!saved.ok) throw new Error(saved.error.message);
      const withoutIds = (value: unknown) =>
        JSON.parse(JSON.stringify(value, (key, item) => (key === "id" ? undefined : item)));
      expect(withoutIds(saved.value.content)).toEqual(withoutIds(original.value.content));
      const after = editor.getJSON();
      act(() => {
        expect(editor.commands.undo()).toBe(true);
      });
      expect(editor.getJSON()).toEqual(before);
      act(() => {
        expect(editor.commands.redo()).toBe(true);
      });
      expect(editor.getJSON()).toEqual(after);
      act(() => editor.commands.setContent(canonicalToTiptap(saved.value)));
      const reopened = tiptapToCanonical(editor.getJSON(), document);
      if (!reopened.ok) throw new Error(reopened.error.message);
      expect(reopened.value.content).toEqual(saved.value.content);
    } finally {
      view.unmount();
      editor.destroy();
    }
  },
);

test.each(
  ["math", "chemistry"].flatMap((kind) =>
    ["document", "document-middle", "table", "list", "read-only"].map((target) => ({
      kind,
      target,
    })),
  ),
)("preserves pasted block $kind formula in $target", ({ kind, target }) => {
  const document = createBlankDocument("公式粘贴");
  const bus = new EditorCommandBus();
  const onChange = vi.fn();
  const view = render(
    <RichTextEditorCore
      editorId="formula-paste"
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
      onDocumentChange={onChange}
    />,
  );
  const editor = bus.getEditor("formula-paste");
  if (!editor) throw new Error("Missing editor");
  try {
    act(() => {
      if (target === "table")
        editor.commands.setContent("<table><tr><td><p></p></td><td><p>保留</p></td></tr></table>");
      if (target === "list")
        editor.commands.setContent("<ul><li><p></p></li><li><p>保留</p></li></ul>");
      if (target === "document-middle") editor.commands.setContent("<p>前后</p>");
      editor.commands.setTextSelection(
        target === "document" || target === "read-only" ? 1 : target === "document-middle" ? 2 : 3,
      );
      editor.view.dispatch(closeHistory(editor.state.tr));
      if (target === "read-only") editor.setEditable(false);
    });
    const before = editor.getJSON();
    const source = kind === "math" ? "x^2" : String.raw`\ce{H2O}`;
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 公式粘贴" }), {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? `<div data-pm-slice="0 0 []" data-type="block-math" data-latex="${source}" data-formula-kind="${kind}" data-formula-alignment="right" data-font-size-pt="10.5" data-formula-color="#123ABC"></div>`
            : "",
      },
    });
    if (target === "read-only") {
      expect(editor.getJSON()).toEqual(before);
      return;
    }
    let count = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name !== (target.startsWith("document") ? "blockMath" : "inlineMath")) return;
      count++;
      expect(node.attrs.latex).toBe(source);
      expect(node.attrs.formulaKind).toBe(kind);
      expect(node.attrs.fontSizePt).toBe(10.5);
      expect(node.attrs.color).toBe("#123ABC");
      if (target.startsWith("document")) expect(node.attrs.alignment).toBe("right");
    });
    expect(count).toBe(1);
    editor.state.doc.check();
    if (!target.startsWith("document")) expect(editor.state.doc.textContent).toBe("保留");
    if (target === "document-middle") expect(editor.state.doc.textContent).toBe("前后");
    expect(onChange).toHaveBeenCalled();
    act(() => expect(editor.commands.undo()).toBe(true));
    let formulaCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "inlineMath" || node.type.name === "blockMath") formulaCount++;
    });
    expect(formulaCount).toBe(0);
    if (target === "document-middle") expect(editor.state.doc.textContent).toBe("前后");
    if (!target.startsWith("document")) expect(editor.state.doc.textContent).toBe("保留");
    act(() => expect(editor.commands.redo()).toBe(true));
    editor.state.doc.check();
    const restoredFormulas: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "inlineMath" || node.type.name === "blockMath")
        restoredFormulas.push(node.attrs.latex);
    });
    expect(restoredFormulas).toEqual([source]);
    const saved = tiptapToCanonical(editor.getJSON(), document);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    act(() => editor.commands.setContent(canonicalToTiptap(saved.value)));
    editor.state.doc.descendants((node) => {
      if (node.type.name === "inlineMath" || node.type.name === "blockMath")
        expect(node.attrs).toMatchObject({ latex: source, fontSizePt: 10.5, color: "#123ABC" });
    });
  } finally {
    view.unmount();
    editor.destroy();
  }
});
