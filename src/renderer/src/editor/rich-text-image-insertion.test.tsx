import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { CellSelection } from "@tiptap/pm/tables";
import { type ComponentProps, useState } from "react";
import { createBlankDocument } from "../../../shared/document/defaults";
import type { AssetDescriptor, CanonicalDocument } from "../../../shared/document/model";
import { ApplicationCloseProvider } from "../app/application-close-coordinator";
import { EditorCommandBus } from "../app/command-bus";
import { createDocumentSession } from "../documents/document-reducer";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";
import { PatentEditor } from "./PatentEditor";
import { RichTextEditorCore } from "./rich-text-editor-core";

vi.mock("../chemistry/ketcher-editor", () => ({ KetcherEditor: () => null }));
const descriptor: AssetDescriptor = {
  assetId: "00000000-0000-4000-8000-000000000901",
  kind: "image",
  originalName: "test.png",
  mediaType: "image/png",
  extension: "png",
  byteLength: 4,
  sha256: "A".repeat(64),
  widthPx: 120,
  heightPx: 80,
  previewByteLength: 4,
  previewSha256: "B".repeat(64),
};
const imageHtml =
  '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQMBgQlpWQAAAABJRU5ErkJggg==">';

function StatefulEditor(props: ComponentProps<typeof RichTextEditorCore<CanonicalDocument>>) {
  const [document, setDocument] = useState(props.document);
  return (
    <RichTextEditorCore
      {...props}
      document={document}
      onDocumentChange={(next) => {
        setDocument(next);
        props.onDocumentChange(next);
      }}
    />
  );
}

test.each(["edit", "unmount", "read-only", "close-cancel"])(
  "legacy document image import discards results after %s",
  async (action) => {
    let finish:
      | ((result: {
          ok: true;
          value: { descriptor: AssetDescriptor; preview: Uint8Array }[];
        }) => void)
      | undefined;
    const importMany = vi.fn(
      () =>
        new Promise<{ ok: true; value: { descriptor: AssetDescriptor; preview: Uint8Array }[] }>(
          (resolve) => {
            finish = resolve;
          },
        ),
    );
    const discardImports = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    let prepareClose: ((token: string) => void) | undefined;
    let cancelClose: (() => void) | undefined;
    const closeResult = vi.fn(
      () =>
        new Promise((resolve) => {
          cancelClose = () =>
            resolve({ ok: false, error: { code: "CANCELLED", message: "cancelled" } });
        }),
    );
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        application: {
          onPrepareClose: (listener: (token: string) => void) => {
            prepareClose = listener;
            return () => {};
          },
          closeResult,
        },
        assets: {
          importMany,
          discardImports,
          getPreview: vi
            .fn()
            .mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "fixture" } }),
        },
      },
    });
    const bus = new EditorCommandBus();
    const session = createDocumentSession("旧文档插图", "00000000-0000-4000-8000-000000000902");
    const view = render(
      <ApplicationCloseProvider>
        <PatentEditor session={session} commandBus={bus} onModelChange={vi.fn()} />
      </ApplicationCloseProvider>,
    );
    const editor = bus.getEditor(session.sessionId);
    if (!editor) throw new Error("Missing editor");
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 旧文档插图" }), {
      clipboardData: {
        files: [],
        getData: (kind: string) => (kind === "text/html" ? `<p>${imageHtml}</p>` : ""),
      },
    });
    await waitFor(() => expect(importMany).toHaveBeenCalledOnce());
    if (action === "edit") act(() => editor.commands.insertContent("后续修改"));
    else if (action === "read-only") act(() => editor.setEditable(false));
    else if (action === "close-cancel") {
      act(() => prepareClose?.("test-close"));
      await waitFor(() => expect(closeResult).toHaveBeenCalledOnce());
      expect(editor.isEditable).toBe(false);
      await act(async () => cancelClose?.());
      expect(editor.isEditable).toBe(true);
    } else view.unmount();
    await act(async () => {
      finish?.({ ok: true, value: [{ descriptor, preview: new Uint8Array() }] });
    });
    await waitFor(() =>
      expect(discardImports).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        operationId: expect.any(String),
        assetIds: [descriptor.assetId],
      }),
    );
    expect(JSON.stringify(editor.getJSON())).not.toContain(descriptor.assetId);
    if (action === "edit") expect(editor.getText()).toBe("后续修改");
    view.unmount();
    editor.destroy();
  },
);

test.each(
  ["table", "list", "cell-selection"].flatMap((container) =>
    ["file", "html"].map((source) => ({ container, source })),
  ),
)("$source image paste remains in its $container", async ({ container, source }) => {
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        getPreview: vi
          .fn()
          .mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "fixture" } }),
      },
    },
  });
  const bus = new EditorCommandBus();
  const document = createBlankDocument("图片插入");
  const onChange = vi.fn();
  const view = render(
    <StatefulEditor
      editorId="paste-image"
      title={document.title}
      document={document}
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
      importImages={async () => ({ ok: true, value: [{ descriptor, preview: new Uint8Array() }] })}
      addImageAsset={(current, asset) => ({ ...current, assets: [...current.assets, asset] })}
      toTiptap={canonicalToTiptap}
      fromTiptap={tiptapToCanonical}
      onDocumentChange={onChange}
    />,
  );
  await waitFor(() => expect(bus.getEditor("paste-image")).toBeDefined());
  const editor = bus.getEditor("paste-image");
  if (!editor) throw new Error("Missing editor");
  act(() => {
    editor.commands.setContent(
      container !== "list"
        ? "<table><tr><td><p>前后</p></td><td><p>保留</p></td></tr></table>"
        : "<ul><li><p>前后</p></li><li><p>保留</p></li></ul>",
    );
    let position = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "前后") position = pos + 1;
    });
    editor.commands.setTextSelection(position);
    if (container === "cell-selection") {
      editor.view.dispatch(
        editor.state.tr.setSelection(CellSelection.create(editor.state.doc, position - 3)),
      );
    }
    editor.view.dispatch(closeHistory(editor.state.tr));
  });
  const original = editor.state.doc.toJSON();
  fireEvent.paste(screen.getByRole("textbox", { name: "编辑 图片插入" }), {
    clipboardData: {
      files:
        source === "file"
          ? [
              {
                name: "test.png",
                type: "image/png",
                size: 4,
                arrayBuffer: async () => new ArrayBuffer(4),
              },
            ]
          : [],
      getData: (type: string) =>
        source === "html" && type === "text/html" ? `<p>${imageHtml}</p>` : "",
    },
  });
  await waitFor(() => expect(JSON.stringify(editor.getJSON())).toContain("inlineFigure"));
  expect(editor.state.doc.textContent).toBe(container === "cell-selection" ? "保留" : "前后保留");
  expect(editor.getJSON().content?.map((node) => node.type)).toEqual(
    original.content.map((node: { type: string }) => node.type),
  );
  editor.state.doc.check();
  const inserted = editor.getJSON();
  expect(onChange.mock.lastCall?.[0].assets).toContainEqual(descriptor);
  act(() => editor.commands.undo());
  expect(editor.state.doc.toJSON()).toEqual(original);
  act(() => editor.commands.redo());
  expect(editor.getJSON()).toEqual(inserted);
  view.unmount();
  editor.destroy();
});

test.each([
  {
    name: "table including header and empty cell",
    html: `<table><tr><th><p>标题${imageHtml}</p></th><td><p></p></td></tr><tr><td><p>正文</p></td><td><p>末尾</p></td></tr></table>`,
    type: "table",
  },
  {
    name: "list",
    html: `<ul><li><p>前${imageHtml}后</p></li><li><p>末尾</p></li></ul>`,
    type: "bulletList",
  },
  { name: "heading", html: `<h2>前${imageHtml}后</h2>`, type: "heading" },
])("pastes an image-bearing $name without invalid structure", async ({ html, type }) => {
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      assets: {
        getPreview: vi
          .fn()
          .mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "fixture" } }),
      },
    },
  });
  const bus = new EditorCommandBus();
  const document = createBlankDocument("带图内容");
  const onChange = vi.fn();
  const view = render(
    <StatefulEditor
      editorId="nested-image"
      title={document.title}
      document={document}
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
      importImages={async () => ({ ok: true, value: [{ descriptor, preview: new Uint8Array() }] })}
      addImageAsset={(current, asset) => ({ ...current, assets: [...current.assets, asset] })}
      toTiptap={canonicalToTiptap}
      fromTiptap={tiptapToCanonical}
      onDocumentChange={onChange}
    />,
  );
  await waitFor(() => expect(bus.getEditor("nested-image")).toBeDefined());
  const editor = bus.getEditor("nested-image");
  if (!editor) throw new Error("Missing editor");
  const original = editor.getJSON();
  fireEvent.paste(screen.getByRole("textbox", { name: "编辑 带图内容" }), {
    clipboardData: { files: [], getData: (kind: string) => (kind === "text/html" ? html : "") },
  });
  await waitFor(() => expect(JSON.stringify(editor.getJSON())).toContain("inlineFigure"));
  editor.state.doc.check();
  const inserted = editor.getJSON();
  expect(inserted.content?.some((node) => node.type === type)).toBe(true);
  if (type === "table") {
    const table = (inserted as JSONContent).content?.find((node) => node.type === "table");
    expect(table?.content).toHaveLength(2);
    expect(table?.content?.[0]?.content).toHaveLength(2);
    expect(table?.content?.[0]?.content?.[1]?.content?.[0]?.type).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe("标题正文末尾");
  }
  const saved = onChange.mock.lastCall?.[0];
  expect(saved.assets).toContainEqual(descriptor);
  const restored = editor.schema.nodeFromJSON(canonicalToTiptap(saved));
  restored.check();
  expect(restored.textContent).toBe(editor.state.doc.textContent);
  expect(JSON.stringify(restored.toJSON())).toContain(descriptor.assetId);
  act(() => editor.commands.undo());
  expect(editor.getJSON()).toEqual(original);
  act(() => editor.commands.redo());
  expect(editor.getJSON()).toEqual(inserted);
  view.unmount();
  editor.destroy();
});
