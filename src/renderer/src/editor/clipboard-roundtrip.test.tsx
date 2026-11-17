import { act, fireEvent, render, screen } from "@testing-library/react";
import type { JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { useState } from "react";
import { createBlankDocument } from "../../../shared/document/defaults";
import type { AssetDescriptor, CanonicalDocument } from "../../../shared/document/model";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { EditorCommandBus } from "../app/command-bus";
import { PatentBookRichTextEditor } from "../patents/editors/patent-book-rich-text-editor";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";
import { RichTextEditorCore } from "./rich-text-editor-core";

vi.mock("../patents/patent-context", () => ({
  usePatentAutomationSession: () => ({ readOnly: false, epoch: 0 }),
}));
vi.mock("../chemistry/ketcher-editor", () => ({ KetcherEditor: () => null }));
const descriptor: AssetDescriptor = {
  assetId: "00000000-0000-4000-8000-000000000901",
  kind: "image",
  originalName: "fixture.png",
  mediaType: "image/png",
  extension: "png",
  byteLength: 4,
  sha256: "A".repeat(64),
  widthPx: 120,
  heightPx: 80,
  previewByteLength: 4,
  previewSha256: "B".repeat(64),
};
function Harness({ bus }: { bus: EditorCommandBus }) {
  const [doc, setDoc] = useState<CanonicalDocument>(() => ({
    ...createBlankDocument("审计样本"),
    assets: [descriptor],
  }));
  return (
    <RichTextEditorCore<CanonicalDocument>
      editorId="audit-editor"
      title="审计样本"
      document={doc}
      commandBus={bus}
      capabilities={{
        headings: true,
        lists: true,
        tables: true,
        images: true,
        formulas: true,
        chemistry: true,
        pageBreaks: true,
      }}
      addImageAsset={(current, asset) => ({
        ...current,
        assets: [...(current.assets ?? []).filter((a) => a.assetId !== asset.assetId), asset],
      })}
      toTiptap={canonicalToTiptap}
      fromTiptap={tiptapToCanonical}
      onDocumentChange={setDoc}
    />
  );
}

test.each(["    ", "\t", "　　"])(
  "preserves manual first-line whitespace %j split into a separate HTML span",
  async (prefix) => {
    const bus = new EditorCommandBus();
    const rendered = render(<Harness bus={bus} />);
    const editor = bus.getEditor("audit-editor");
    if (!editor) throw new Error("Missing editor");
    fireEvent.paste(editor.view.dom, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? `<p><span>${prefix}</span><span>手动缩进正文</span></p>` : "",
      },
    });
    await act(async () => {});
    expect(editor.state.doc.firstChild?.textContent).toBe(
      `${prefix.replaceAll("\t", "    ").replaceAll(" ", "\u00a0")}手动缩进正文`,
    );
    expect(editor.state.doc.firstChild?.attrs.paragraphIndentMm ?? 0).toBe(0);
    const pasted = editor.getJSON();
    act(() => editor.commands.undo());
    expect(editor.getText()).toBe("");
    act(() => editor.commands.redo());
    expect(editor.getJSON()).toEqual(pasted);
    rendered.unmount();
    editor.destroy();
  },
);

test.each([0, 5, 14])("copy/paste retains manually set paragraph indent %s", async (indent) => {
  const bus = new EditorCommandBus();
  const rendered = render(<Harness bus={bus} />);
  const editor = bus.getEditor("audit-editor");
  if (!editor) throw new Error("Missing editor");
  act(() => {
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { paragraphIndentMm: indent },
          content: [{ type: "text", text: "手动缩进正文" }],
        },
        { type: "paragraph", attrs: { paragraphIndentMm: 0 } },
      ],
    });
    const paragraph = editor.state.doc.firstChild;
    if (!paragraph) throw new Error("Missing paragraph");
    editor.commands.setTextSelection({ from: 1, to: paragraph.nodeSize - 1 });
  });
  const values = new Map<string, string>();
  const clipboardData = {
    files: [],
    getData: (key: string) => values.get(key) ?? "",
    setData: (key: string, value: string) => values.set(key, value),
    clearData: () => values.clear(),
  };
  fireEvent.copy(editor.view.dom, { clipboardData });
  act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
  fireEvent.paste(editor.view.dom, { clipboardData });
  await act(async () => {});
  expect(editor.state.doc.lastChild?.textContent).toBe("手动缩进正文");
  expect(editor.state.doc.lastChild?.attrs.paragraphIndentMm).toBe(indent);
  rendered.unmount();
  editor.destroy();
});

test("pasted paragraph spacing switches modes and supports undo/redo without changing text marks", async () => {
  const bus = new EditorCommandBus();
  const rendered = render(
    <div className="patent-page-with-rail">
      <div className="patent-global-function-rail__body" />
      <Harness bus={bus} />
    </div>,
  );
  const editor = bus.getEditor("audit-editor");
  if (!editor) throw new Error("Missing editor");
  editor.setOptions({
    editorProps: { ...editor.options.editorProps, handleScrollToSelection: () => true },
  });
  fireEvent.paste(editor.view.dom, {
    clipboardData: {
      files: [],
      getData: (type: string) =>
        type === "text/html"
          ? '<p style="line-height:2;margin-top:6pt;margin-bottom:8pt"><span style="font-weight:700">正文</span></p>'
          : "",
    },
  });
  await act(async () => {});
  expect(editor.state.doc.firstChild?.attrs).toMatchObject({
    lineHeight: 2,
    spaceBeforePt: 6,
    spaceAfterPt: 8,
  });
  fireEvent.click(await screen.findByRole("button", { name: "使用正文段落格式" }));
  expect(editor.state.doc.firstChild?.attrs).toMatchObject({
    lineHeight: 1.5,
    spaceBeforePt: null,
    spaceAfterPt: null,
  });
  fireEvent.click(await screen.findByRole("button", { name: "保留原段落格式" }));
  expect(editor.state.doc.firstChild?.attrs).toMatchObject({
    lineHeight: 2,
    spaceBeforePt: 6,
    spaceAfterPt: 8,
  });
  act(() => editor.commands.undo());
  expect(editor.state.doc.firstChild?.attrs.lineHeight).toBe(1.5);
  act(() => editor.commands.redo());
  expect(editor.state.doc.firstChild?.attrs.lineHeight).toBe(2);
  expect(
    editor.state.doc.firstChild?.firstChild?.marks.some((mark) => mark.type.name === "bold"),
  ).toBe(true);
  rendered.unmount();
  editor.destroy();
});
test.each(
  ["copy", "cut"].flatMap((action) =>
    ["block", "inline", "list", "table"].map((layout) => ({ action, layout })),
  ),
)("$action and paste preserves a $layout image and its text", async ({ action, layout }) => {
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        getPreview: vi
          .fn()
          .mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "fixture" } }),
        copyImages: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      },
    },
  });
  const bus = new EditorCommandBus();
  const view = render(<Harness bus={bus} />);
  const editor = bus.getEditor("audit-editor");
  if (!editor) throw new Error("Missing editor");
  act(() => {
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "图片前文" }] },
        {
          type: "figure",
          attrs: {
            nodeId: crypto.randomUUID(),
            assetId: descriptor.assetId,
            widthMm: 80,
            alignment: "center",
            rotationDeg: 0,
            sourceAspectRatio: 1.5,
          },
        },
        { type: "paragraph", content: [{ type: "text", text: "图片后文" }] },
      ],
    });
    editor.commands.selectAll();
  });
  if (layout !== "block") {
    act(() => {
      const figure = editor.getJSON().content?.[1];
      if (!figure) throw new Error("Missing figure");
      const paragraph: JSONContent = {
        type: "paragraph",
        content: [
          { type: "text", text: "图片前文" },
          { ...figure, type: "inlineFigure" },
          { type: "text", text: "图片后文" },
        ],
      };
      const node =
        layout === "list"
          ? { type: "bulletList", content: [{ type: "listItem", content: [paragraph] }] }
          : layout === "table"
            ? {
                type: "table",
                content: [
                  { type: "tableRow", content: [{ type: "tableCell", content: [paragraph] }] },
                ],
              }
            : paragraph;
      editor.commands.setContent({ type: "doc", content: [node, { type: "paragraph" }] });
      editor.commands.selectAll();
    });
  }
  act(() => editor.view.dispatch(closeHistory(editor.state.tr)));
  const values = new Map<string, string>();
  const clipboardData = {
    files: [],
    getData: (key: string) => values.get(key) ?? "",
    setData: (key: string, value: string) => values.set(key, value),
    clearData: () => values.clear(),
  };
  const element = screen.getByRole("textbox", { name: "编辑 审计样本" });
  if (action === "cut") fireEvent.cut(element, { clipboardData });
  else fireEvent.copy(element, { clipboardData });
  act(() => editor.commands.setTextSelection(Math.max(1, editor.state.doc.content.size - 1)));
  act(() => editor.view.dispatch(closeHistory(editor.state.tr)));
  fireEvent.paste(element, { clipboardData });
  await act(async () => {});
  let figures = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "figure" || node.type.name === "inlineFigure") figures++;
  });
  expect(figures).toBe(action === "cut" ? 1 : 2);
  expect(editor.getText()).toContain("图片前文");
  expect(editor.getText()).toContain("图片后文");
  const pasted = editor.getJSON();
  act(() => editor.commands.undo());
  let remaining = 0;
  editor.state.doc.descendants((node) => {
    if (["figure", "inlineFigure"].includes(node.type.name)) remaining++;
  });
  expect(remaining).toBe(action === "cut" ? 0 : 1);
  act(() => editor.commands.redo());
  expect(editor.getJSON()).toEqual(pasted);
  view.unmount();
  editor.destroy();
});

test.each(["same-book", "other-book"])(
  "copying chemical structure and text into %s keeps both",
  async (target) => {
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          getPreview: vi
            .fn()
            .mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "fixture" } }),
          copyImages: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        },
      },
    });
    const book = createBlankPatent({ patentType: "invention", name: "结构式审计样本" }).books.find(
      (b) => b.kind === "description",
    )!;
    const asset: AssetDescriptor = {
      ...descriptor,
      kind: "chemical-preview",
      extension: "svg",
      mediaType: "image/svg+xml",
    };
    const bus = new EditorCommandBus();
    const view = render(
      <PatentBookRichTextEditor
        editorId="audit-chem"
        sessionId="audit-session"
        bookKind="description"
        document={book.document}
        availableAssetIds={new Set([asset.assetId])}
        assets={[asset]}
        commandBus={bus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          images: true,
          formulas: true,
          chemistry: true,
          pageBreaks: true,
        }}
        onDocumentChange={() => {}}
      />,
    );
    const editor = bus.getEditor("audit-chem")!;
    act(() => {
      editor.commands.setContent({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "前文" }] },
          {
            type: "chemicalStructure",
            attrs: {
              nodeId: crypto.randomUUID(),
              ketSource: "(ket) (atom O)",
              editorMode: "molecule",
              previewAssetId: asset.assetId,
              widthMm: 80,
              alignment: "center",
            },
          },
          { type: "paragraph", content: [{ type: "text", text: "后文" }] },
        ],
      });
      editor.commands.selectAll();
    });
    const values = new Map<string, string>();
    const clipboardData = {
      files: [],
      getData: (k: string) => values.get(k) ?? "",
      setData: (k: string, v: string) => values.set(k, v),
      clearData: () => values.clear(),
    };
    fireEvent.copy(editor.view.dom, { clipboardData });
    if (target === "other-book") {
      const stageReferences = vi
        .fn()
        .mockResolvedValue({ ok: true, value: [{ descriptor: asset }] });
      Object.assign(window.patentApi.assets, { stageReferences });
      const changed = vi.fn();
      const targetView = render(
        <PatentBookRichTextEditor
          editorId="target-chem"
          sessionId="target-session"
          bookKind="description"
          document={book.document}
          assets={[]}
          availableAssetIds={new Set()}
          commandBus={bus}
          capabilities={{
            headings: true,
            lists: true,
            tables: true,
            images: true,
            formulas: true,
            chemistry: true,
            pageBreaks: true,
          }}
          onDocumentChange={changed}
        />,
      );
      const destination = bus.getEditor("target-chem");
      if (!destination) throw new Error("Missing destination");
      act(() => destination.commands.setTextSelection(1));
      fireEvent.paste(destination.view.dom, { clipboardData });
      await act(async () => {});
      expect(stageReferences).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceSessionId: "audit-session",
          targetSessionId: "target-session",
          assetIds: [asset.assetId],
        }),
      );
      expect(JSON.stringify(destination.getJSON())).toContain("(ket) (atom O)");
      expect(destination.getText()).toContain("前文");
      expect(destination.getText()).toContain("后文");
      expect(changed.mock.calls.at(-1)?.[1]).toContainEqual(asset);
      targetView.unmount();
      destination.destroy();
      view.unmount();
      editor.destroy();
      return;
    }
    act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
    fireEvent.paste(editor.view.dom, { clipboardData });
    await act(async () => {});
    let structures = 0;
    editor.state.doc.descendants((n) => {
      if (n.type.name === "chemicalStructure") structures++;
    });
    view.unmount();
    editor.destroy();
    expect(structures).toBe(2);
  },
);
