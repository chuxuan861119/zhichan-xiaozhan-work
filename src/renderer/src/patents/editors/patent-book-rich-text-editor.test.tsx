import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { useState } from "react";
import type { AssetDescriptor, PatentBookDocument } from "../../../../shared/document/model";
import type { ImportedAsset } from "../../../../shared/ipc/contract";
import { createBlankPatent } from "../../../../shared/patent/defaults";
import { PATENT_BODY_PARAGRAPH_ATTRIBUTES } from "../../../../shared/patent/formatting";
import { EditorCommandBus } from "../../app/command-bus";
import { capabilitiesForPatentBook } from "../patent-toolbar-capabilities";
import { PatentBookRichTextEditor, patentBookEditorId } from "./patent-book-rich-text-editor";

function book(kind: "claims" | "description" | "abstract") {
  const patent = createBlankPatent({ patentType: "utility-model", name: "环保回收装置" });
  const found = patent.books.find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`missing ${kind} book`);
  return found.document;
}

function previewAsset(): AssetDescriptor {
  return {
    assetId: "00000000-0000-4000-8000-000000000901",
    kind: "image",
    originalName: "chemical-structure.png",
    mediaType: "image/png",
    extension: "png",
    byteLength: 12,
    sha256: "A".repeat(64),
    widthPx: 120,
    heightPx: 80,
    previewByteLength: 8,
    previewSha256: "B".repeat(64),
  };
}

function importedImage(index: number): ImportedAsset {
  return {
    descriptor: {
      assetId: `00000000-0000-4000-8000-${String(910 + index).padStart(12, "0")}`,
      kind: "image",
      originalName: `image-${index}.png`,
      mediaType: "image/png",
      extension: "png",
      byteLength: 3,
      sha256: String(index).repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 3,
      previewSha256: String(index + 1).repeat(64),
    },
    preview: Uint8Array.from([index, index, index]),
  };
}

function renderedInlineFormula(source: string) {
  return Array.from(
    screen
      .getByRole("textbox", { name: "编辑 说明书" })
      .querySelectorAll("[data-type='inline-math']"),
  ).find((node) => node.getAttribute("data-latex") === source);
}

describe("patent book rich text editor", () => {
  test("preserves the live document during save-status rerenders and applies external edits", async () => {
    const commandBus = new EditorCommandBus();
    const document = book("description");
    const renderBook = (saveState: "saved" | "saving", current = document) => (
      <PatentBookRichTextEditor
        editorId="stable-adapter"
        bookKind="description"
        document={current}
        availableAssetIds={new Set()}
        assets={[]}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        saveState={saveState}
        onDocumentChange={() => undefined}
        onTextCounts={() => undefined}
      />
    );
    const ui = render(renderBook("saved"));
    await waitFor(() => expect(commandBus.has("stable-adapter")).toBe(true));
    const before = commandBus.getEditor("stable-adapter")?.state.doc;
    ui.rerender(renderBook("saving"));
    ui.rerender(renderBook("saved"));
    expect(commandBus.getEditor("stable-adapter")?.state.doc).toBe(before);
    const external = structuredClone(document);
    const paragraph = external.content.find((node) => node.type === "paragraph");
    if (!paragraph || paragraph.type !== "paragraph") throw new Error("缺少段落");
    paragraph.content = [{ type: "text", text: "外部修改", marks: [] }];
    ui.rerender(renderBook("saved", external));
    expect(commandBus.getEditor("stable-adapter")?.getText()).toContain("外部修改");
  });

  test("memoized editor events use the newest callbacks while preserving the live editor", async () => {
    const commandBus = new EditorCommandBus();
    const document = book("description");
    const first = vi.fn(),
      latest = vi.fn();
    const view = (onDocumentChange: typeof first) => (
      <PatentBookRichTextEditor
        editorId="latest-callback"
        bookKind="description"
        document={document}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        onDocumentChange={onDocumentChange}
      />
    );
    const ui = render(view(first));
    await waitFor(() => expect(commandBus.has("latest-callback")).toBe(true));
    const editor = commandBus.getEditor("latest-callback");
    if (!editor) throw new Error("Missing editor");
    first.mockClear();
    ui.rerender(view(latest));
    expect(commandBus.getEditor("latest-callback")).toBe(editor);
    act(() => {
      editor.commands.insertContent("最新编辑回调");
    });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalled();
    expect(latest.mock.calls.at(-1)?.[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining("最新编辑回调") }),
          ]),
        }),
      ]),
    );
  });

  test("publishes changed counts immediately without duplicate reports from the same edit", async () => {
    const commandBus = new EditorCommandBus();
    const counts = vi.fn();
    render(
      <PatentBookRichTextEditor
        editorId="count-reports"
        bookKind="description"
        document={book("description")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        onDocumentChange={() => undefined}
        onTextCounts={counts}
      />,
    );
    await waitFor(() => expect(commandBus.has("count-reports")).toBe(true));
    const editor = commandBus.getEditor("count-reports");
    if (!editor) throw new Error("Missing editor");
    act(() => {
      editor.commands.setTextSelection(1);
    });
    const previous = counts.mock.lastCall?.[0];
    counts.mockClear();
    act(() => {
      editor.commands.insertContent("性能");
    });
    expect(counts).toHaveBeenCalledTimes(1);
    expect(counts.mock.lastCall?.[0].totalCharacters).toBe(previous.totalCharacters + 2);
    counts.mockClear();
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.setTextSelection(2);
    });
    expect(counts).not.toHaveBeenCalled();
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 3 });
    });
    expect(counts.mock.lastCall?.[0].selectedCharacters).toBe(2);
  });

  test.each(
    (["claims", "description", "abstract"] as const).flatMap((bookKind) =>
      (["plain", "word", "internal"] as const).map((clipboardKind) => ({
        bookKind,
        clipboardKind,
      })),
    ),
  )(
    "keeps $bookKind full-selection $clipboardKind paste undoable after punctuation layout",
    async ({ bookKind, clipboardKind }) => {
      const commandBus = new EditorCommandBus();
      const editorId = patentBookEditorId("punctuation-regression", bookKind);
      const changes = vi.fn();
      function Harness() {
        const [document, setDocument] = useState(book(bookKind));
        return (
          <PatentBookRichTextEditor
            editorId={editorId}
            bookKind={bookKind}
            document={document}
            availableAssetIds={new Set()}
            commandBus={commandBus}
            capabilities={capabilitiesForPatentBook(bookKind)}
            onDocumentChange={(next) => {
              changes(next);
              setDocument(next);
            }}
          />
        );
      }
      const ui = render(<Harness />);
      try {
        await waitFor(() => expect(commandBus.has(editorId)).toBe(true));
        const editor = commandBus.getEditor(editorId);
        if (!editor) throw new Error("missing editor");
        const before = editor.getText();
        const beforeJson = editor.getJSON();
        const resize = () => window.dispatchEvent(new Event("resize"));
        act(() => {
          resize();
          editor.commands.selectAll();
        });
        const internalClipboard = editor.view.serializeForClipboard(
          editor.state.selection.content(),
        );
        const html =
          clipboardKind === "plain"
            ? ""
            : clipboardKind === "internal"
              ? internalClipboard.dom.innerHTML
              : '<html><body><!--StartFragment--><p class="MsoNormal"><span style="font-size:14pt;font-family:宋体">短文，测试。</span></p><!--EndFragment--></body></html>';
        fireEvent.paste(ui.getByRole("textbox"), {
          clipboardData: {
            files: [],
            getData: (type: string) =>
              type === "text/html"
                ? html
                : type === "text/plain"
                  ? clipboardKind === "internal"
                    ? internalClipboard.text
                    : "短文，测试。"
                  : "",
          },
        });
        await waitFor(() => expect(changes).toHaveBeenCalled());
        const pasted = editor.getText();
        expect(pasted).toBe(clipboardKind === "internal" ? before : "短文，测试。");
        act(() => {
          resize();
          expect(editor.commands.undo()).toBe(true);
        });
        expect(editor.getJSON()).toEqual(beforeJson);
        act(() => {
          resize();
          expect(editor.commands.redo()).toBe(true);
        });
        expect(editor.getText()).toBe(pasted);
        expect(changes.mock.calls.length).toBeGreaterThanOrEqual(3);
      } finally {
        ui.unmount();
      }
    },
  );

  test("builds stable editor ids from the patent session and book kind", () => {
    expect(patentBookEditorId("session-1", "claims")).toBe("session-1:claims");
    expect(patentBookEditorId("session-1", "description")).toBe("session-1:description");
  });

  test("forwards inactive pane selection display to the rich text core", async () => {
    const commandBus = new EditorCommandBus();
    const editorId = patentBookEditorId("session-1", "description");
    const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [DOMRect.fromRect({ x: 10, y: 10, width: 80, height: 18 })],
    });
    const outside = window.document.createElement("button");
    window.document.body.append(outside);

    const { container, unmount } = render(
      <PatentBookRichTextEditor
        editorId={editorId}
        bookKind="description"
        document={book("description")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        onDocumentChange={vi.fn()}
        inactiveSelectionVisible
      />,
    );
    await waitFor(() => expect(commandBus.has(editorId)).toBe(true));
    const editor = commandBus.getEditor(editorId);
    if (!editor) throw new Error("missing editor");
    act(() => editor.commands.setTextSelection({ from: 2, to: 8 }));
    outside.focus();
    await waitFor(() =>
      expect(
        container.querySelector('.editor-selection-overlay[data-tone="background"]'),
      ).not.toBeNull(),
    );

    unmount();
    outside.remove();
    if (originalRangeRects) {
      Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
    } else {
      Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
  });

  test("registers the active book under its own editor id", async () => {
    const commandBus = new EditorCommandBus();
    const registered: { id?: string; editor?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registered.id = id;
      registered.editor = editor;
      return register(id, editor, ...rest);
    });
    const document = book("claims");

    render(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "claims")}
        bookKind="claims"
        document={document}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("claims")}
        onDocumentChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("textbox", { name: "编辑 权利要求书" })).toBeDefined();
    await waitFor(() => expect(registered.id).toBe("session-1:claims"));
    expect(registered.editor?.getText()).toContain(
      `1. 环保回收装置，其特征在于：${" ".repeat(12)}。`,
    );
    expect(
      screen
        .getByRole("textbox", { name: "编辑 权利要求书" })
        .closest(".patent-book-rich-text")
        ?.getAttribute("data-book-kind"),
    ).toBe("claims");
  });

  test("uses the patent asset dimensions when building an inline image node", async () => {
    const commandBus = new EditorCommandBus();
    const editorId = patentBookEditorId("session-1", "description");
    const asset = previewAsset();
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          getPreview: vi.fn().mockResolvedValue({
            ok: false,
            error: { code: "NOT_FOUND", message: "测试中不加载预览" },
          }),
        },
      },
    });
    const blankDocument = book("description");
    const blankParagraph = blankDocument.content[0];
    if (blankParagraph?.type !== "paragraph") throw new Error("missing description paragraph");
    const document: PatentBookDocument = {
      ...blankDocument,
      content: [
        {
          ...blankParagraph,
          content: [
            {
              id: "00000000-0000-4000-8000-000000000906",
              type: "inline-figure",
              assetId: asset.assetId,
              widthMm: 30,
              alignment: "center",
              rotationDeg: 0,
            },
          ],
        },
      ],
    };

    render(
      <PatentBookRichTextEditor
        editorId={editorId}
        bookKind="description"
        document={document}
        availableAssetIds={new Set([asset.assetId])}
        sessionId="00000000-0000-4000-8000-000000000907"
        assets={[asset]}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        onDocumentChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(commandBus.getEditor(editorId)).toBeDefined());
    const editorJson = JSON.stringify(commandBus.getEditor(editorId)?.getJSON());
    expect(editorJson).toContain('"type":"inlineFigure"');
    expect(editorJson).toContain('"sourceAspectRatio":1.5');
  });

  test("supports Word-style line, paragraph, document and drag selection from the left gutter", async () => {
    const commandBus = new EditorCommandBus();
    const editorId = patentBookEditorId("session-1", "description");
    const selectLines = vi
      .spyOn(commandBus, "selectVisualLinesFromCoordinates")
      .mockReturnValue(true);
    const selectParagraph = vi
      .spyOn(commandBus, "selectParagraphFromCoordinates")
      .mockReturnValue(true);
    const selectAll = vi.spyOn(commandBus, "selectAll").mockReturnValue(true);

    const { container } = render(
      <PatentBookRichTextEditor
        editorId={editorId}
        bookKind="description"
        document={book("description")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(commandBus.has(editorId)).toBe(true));
    const gutter = container.querySelector<HTMLElement>("[data-patent-selection-gutter]");
    if (!gutter) throw new Error("missing text selection gutter");
    gutter.setPointerCapture = vi.fn();
    gutter.releasePointerCapture = vi.fn();

    fireEvent.click(gutter, { detail: 1, clientY: 220 });
    expect(selectLines).toHaveBeenLastCalledWith(editorId, 220, 220);

    fireEvent.click(gutter, { detail: 2, clientX: 240, clientY: 260 });
    expect(selectParagraph).toHaveBeenLastCalledWith(editorId, { x: 240, y: 260 });

    fireEvent.click(gutter, { detail: 3, clientY: 300 });
    expect(selectAll).toHaveBeenLastCalledWith(editorId);

    selectLines.mockClear();
    fireEvent.pointerDown(gutter, { pointerId: 7, clientY: 340 });
    fireEvent.pointerMove(gutter, { pointerId: 7, clientY: 410 });
    expect(selectLines).toHaveBeenLastCalledWith(editorId, 340, 410);
    selectLines.mockClear();
    fireEvent.pointerUp(gutter, { pointerId: 7, clientY: 410 });
    expect(selectLines).toHaveBeenLastCalledWith(editorId, 340, 410);
  });

  test("enables chemical structures when the patent book has a session asset interface", async () => {
    const commandBus = new EditorCommandBus();
    const editorId = patentBookEditorId("session-1", "claims");

    render(
      <PatentBookRichTextEditor
        editorId={editorId}
        bookKind="claims"
        document={book("claims")}
        availableAssetIds={new Set()}
        sessionId="00000000-0000-4000-8000-000000000201"
        assets={[]}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("claims")}
        onDocumentChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(commandBus.has(editorId)).toBe(true));
    act(() => expect(commandBus.openChemistryEditor(editorId)).toBe(true));

    expect(screen.queryByText("当前书册暂不支持化学结构式。")).toBeNull();
    act(() => expect(commandBus.openChemistryEditor(editorId, "structure")).toBe(true));
    expect(await screen.findByRole("tabpanel", { name: "化学结构式" })).toBeDefined();
  });

  test.each(["paste", "drop"] as const)(
    "imports every image in one %s batch for claims",
    async (eventType) => {
      const imported = [importedImage(1), importedImage(2)];
      const importMany = vi.fn().mockResolvedValue({ ok: true, value: imported });
      const importBytes = vi.fn().mockResolvedValue({ ok: true, value: imported[0] });
      Object.defineProperty(window, "patentApi", {
        configurable: true,
        value: {
          assets: {
            importMany,
            importBytes,
            getPreview: vi.fn().mockResolvedValue({
              ok: false,
              error: { code: "NOT_FOUND", message: "测试中不加载预览" },
            }),
          },
        },
      });
      const commandBus = new EditorCommandBus();
      const onDocumentChange = vi.fn();
      const sessionId = "00000000-0000-4000-8000-000000000202";
      render(
        <PatentBookRichTextEditor
          editorId={patentBookEditorId(sessionId, "claims")}
          bookKind="claims"
          document={book("claims")}
          availableAssetIds={new Set()}
          sessionId={sessionId}
          assets={[]}
          commandBus={commandBus}
          capabilities={capabilitiesForPatentBook("claims")}
          onDocumentChange={onDocumentChange}
        />,
      );
      const files = [
        new File([Uint8Array.from([1, 1, 1])], "first.png", { type: "image/png" }),
        new File([Uint8Array.from([2, 2, 2])], "second.png", { type: "image/png" }),
      ];
      files.forEach((file, index) => {
        Object.defineProperty(file, "arrayBuffer", {
          value: vi.fn().mockResolvedValue(Uint8Array.from([index + 1]).buffer),
        });
      });
      const editor = await screen.findByRole("textbox", { name: "编辑 权利要求书" });

      if (eventType === "paste") {
        fireEvent.paste(editor, {
          clipboardData: { files, getData: vi.fn().mockReturnValue("") },
        });
      } else {
        fireEvent.drop(editor, { dataTransfer: { files }, clientX: 20, clientY: 20 });
      }

      await waitFor(() => expect(importMany).toHaveBeenCalledOnce());
      expect(importBytes).not.toHaveBeenCalled();
      expect(importMany).toHaveBeenCalledWith({
        sessionId,
        operationId: expect.any(String),
        images: [
          expect.objectContaining({ originalName: "first.png", declaredMediaType: "image/png" }),
          expect.objectContaining({ originalName: "second.png", declaredMediaType: "image/png" }),
        ],
      });
      await waitFor(() =>
        expect(
          onDocumentChange.mock.calls.some((call) => {
            const [document, assets] = call as [PatentBookDocument, AssetDescriptor[]];
            return (
              document.content.filter((node) => node.type === "figure").length === 2 &&
              assets.map((asset) => asset.assetId).join("|") ===
                imported.map(({ descriptor }) => descriptor.assetId).join("|")
            );
          }),
        ).toBe(true),
      );
    },
  );

  test("rejects more than 100 dropped images before reading file bytes", async () => {
    const importMany = vi.fn();
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          importMany,
          getPreview: vi.fn(),
        },
      },
    });
    const sessionId = "00000000-0000-4000-8000-000000000203";
    render(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId(sessionId, "claims")}
        bookKind="claims"
        document={book("claims")}
        availableAssetIds={new Set()}
        sessionId={sessionId}
        assets={[]}
        commandBus={new EditorCommandBus()}
        capabilities={capabilitiesForPatentBook("claims")}
        onDocumentChange={vi.fn()}
      />,
    );
    const files = Array.from({ length: 101 }, (_, index) => ({
      name: `claim-${index}.png`,
      type: "image/png",
      size: 1,
      arrayBuffer: vi.fn(),
    })) as unknown as File[];

    fireEvent.drop(await screen.findByRole("textbox", { name: "编辑 权利要求书" }), {
      dataTransfer: { files },
      clientX: 20,
      clientY: 20,
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(importMany).not.toHaveBeenCalled();
    expect(files.every((file) => !vi.mocked(file.arrayBuffer).mock.calls.length)).toBe(true);
  });

  test("opens the chemistry dialog when a patent book chemistry formula is double-clicked", async () => {
    const commandBus = new EditorCommandBus();
    const registered: { editor?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registered.editor = editor;
      return register(id, editor, ...rest);
    });

    render(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "description")}
        bookKind="description"
        document={book("description")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        onDocumentChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(registered.editor).toBeDefined());
    const editor = registered.editor;
    if (!editor) throw new Error("编辑器未注册");
    act(() =>
      expect(
        editor.commands.insertContent({
          type: "inlineMath",
          attrs: { latex: String.raw`\ce{H2O}`, formulaKind: "chemistry" },
        }),
      ).toBe(true),
    );
    const chemistryFormula = await waitFor(() => {
      const node = renderedInlineFormula(String.raw`\ce{H2O}`);
      if (!node) throw new Error("插入的化学公式节点未渲染");
      return node;
    });

    fireEvent.click(chemistryFormula, { detail: 1 });
    fireEvent.click(chemistryFormula, { detail: 2 });
    fireEvent.doubleClick(chemistryFormula, { detail: 2 });

    expect(await screen.findByRole("dialog", { name: "编辑化学方程式" })).toBeDefined();
  });

  test("loads a book chemical structure preview with the patent session id", async () => {
    const commandBus = new EditorCommandBus();
    const sessionId = "00000000-0000-4000-8000-000000000201";
    const preview = previewAsset();
    const getPreview = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "NOT_FOUND", message: "preview unavailable" },
    });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { assets: { getPreview, importBytes: vi.fn() } },
    });
    const document: PatentBookDocument = {
      ...book("description"),
      content: [
        {
          id: "00000000-0000-4000-8000-000000000902",
          type: "chemical-structure",
          ketSource: "(ket) (atom C)",
          previewAssetId: preview.assetId,
          widthMm: 80,
          alignment: "center",
        },
      ],
    };

    render(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId(sessionId, "description")}
        bookKind="description"
        document={document}
        availableAssetIds={new Set([preview.assetId])}
        sessionId={sessionId}
        assets={[preview]}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        onDocumentChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(getPreview).toHaveBeenCalledWith(sessionId, preview.assetId));
  });

  test("emits a chemistry formula edit when the book also has a structure preview asset", async () => {
    const commandBus = new EditorCommandBus();
    const registered: { editor?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registered.editor = editor;
      return register(id, editor, ...rest);
    });
    const preview = previewAsset();
    const originalSource = String.raw`\ce{2H2 + O2 -> 2H2O}`;
    const editedSource = String.raw`\ce{3H2 + N2 -> 2NH3}`;
    const document: PatentBookDocument = {
      ...book("description"),
      content: [
        {
          id: "00000000-0000-4000-8000-000000000903",
          type: "paragraph",
          attrs: PATENT_BODY_PARAGRAPH_ATTRIBUTES,
          content: [
            {
              type: "inline-formula",
              source: originalSource,
              formulaKind: "chemistry",
            },
          ],
        },
        {
          id: "00000000-0000-4000-8000-000000000904",
          type: "chemical-structure",
          ketSource: "(ket) (atom C)",
          previewAssetId: preview.assetId,
          widthMm: 80,
          alignment: "center",
        },
      ],
    };
    const onDocumentChange = vi.fn();

    render(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "description")}
        bookKind="description"
        document={document}
        availableAssetIds={new Set([preview.assetId])}
        assets={[preview]}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        onDocumentChange={onDocumentChange}
      />,
    );

    await waitFor(() => expect(registered.editor).toBeDefined());
    const editor = registered.editor;
    if (!editor) throw new Error("编辑器未注册");
    act(() => expect(editor.commands.updateInlineMath({ latex: editedSource, pos: 1 })).toBe(true));

    await waitFor(() =>
      expect(onDocumentChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              content: [expect.objectContaining({ source: editedSource })],
            }),
            expect.objectContaining({
              type: "chemical-structure",
              previewAssetId: preview.assetId,
            }),
          ]),
        }),
        [preview],
      ),
    );
  });

  test("renders a non-editable page header above each text patent book body", async () => {
    const commandBus = new EditorCommandBus();
    const { rerender } = render(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "claims")}
        bookKind="claims"
        document={book("claims")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("claims")}
        onDocumentChange={vi.fn()}
      />,
    );

    const claimsEditor = await screen.findByRole("textbox", { name: "编辑 权利要求书" });
    const claimsPage = claimsEditor.closest(".patent-book-rich-text");
    expect(claimsPage).toBeInstanceOf(HTMLElement);
    expect(claimsPage?.querySelector(".patent-book-page-header")?.textContent).toBe("权利要求书");
    expect(claimsEditor.querySelector(".patent-book-page-header")).toBeNull();

    rerender(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "description")}
        bookKind="description"
        document={book("description")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        onDocumentChange={vi.fn()}
      />,
    );

    const descriptionEditor = await screen.findByRole("textbox", { name: "编辑 说明书" });
    expect(
      descriptionEditor.closest(".patent-book-rich-text")?.querySelector(".patent-book-page-header")
        ?.textContent,
    ).toBe("说明书");

    rerender(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "abstract")}
        bookKind="abstract"
        document={book("abstract")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("abstract")}
        onDocumentChange={vi.fn()}
      />,
    );

    const abstractEditor = await screen.findByRole("textbox", { name: "编辑 说明书摘要" });
    expect(
      abstractEditor.closest(".patent-book-rich-text")?.querySelector(".patent-book-page-header")
        ?.textContent,
    ).toBe("说明书摘要");
  });

  test("switches editor identity and content when the active book changes", async () => {
    const commandBus = new EditorCommandBus();
    const registeredIds: string[] = [];
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredIds.push(id);
      return register(id, editor, ...rest);
    });

    const { rerender } = render(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "claims")}
        bookKind="claims"
        document={book("claims")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("claims")}
        onDocumentChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("textbox", { name: "编辑 权利要求书" })).toBeDefined();
    rerender(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "description")}
        bookKind="description"
        document={book("description")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        onDocumentChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("textbox", { name: "编辑 说明书" })).toBeDefined();
    await waitFor(() => expect(registeredIds).toContain("session-1:description"));
    expect(commandBus.execute("session-1:claims", "bold")).toBe(false);
  });

  test("creates indented four-point patent body paragraphs on Enter", async () => {
    const commandBus = new EditorCommandBus();
    const registered: { editor?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registered.editor = editor;
      return register(id, editor, ...rest);
    });

    render(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "claims")}
        bookKind="claims"
        document={book("claims")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("claims")}
        onDocumentChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(registered.editor).toBeDefined());
    const editor = registered.editor;
    if (!editor) throw new Error("编辑器未注册");
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "编辑 权利要求书" }), { key: "Enter" });

    const paragraphs = editor.getJSON().content?.filter((node) => node.type === "paragraph") ?? [];
    expect(paragraphs.at(-1)?.attrs).toMatchObject({
      textAlign: PATENT_BODY_PARAGRAPH_ATTRIBUTES.alignment,
      paragraphIndentMm: PATENT_BODY_PARAGRAPH_ATTRIBUTES.paragraphIndentMm,
      lineHeight: PATENT_BODY_PARAGRAPH_ATTRIBUTES.lineSpacing,
      defaultFontFamily: PATENT_BODY_PARAGRAPH_ATTRIBUTES.defaultFontFamily,
      defaultFontSizePt: PATENT_BODY_PARAGRAPH_ATTRIBUTES.defaultFontSizePt,
    });
  });

  test("renders default claims paragraphs with a visible two-character first-line indent", async () => {
    const commandBus = new EditorCommandBus();

    render(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "claims")}
        bookKind="claims"
        document={book("claims")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("claims")}
        onDocumentChange={vi.fn()}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "编辑 权利要求书" });
    const firstParagraph = editor.querySelector("p");

    expect(firstParagraph?.getAttribute("data-paragraph-indent-mm")).toBe(
      String(PATENT_BODY_PARAGRAPH_ATTRIBUTES.paragraphIndentMm),
    );
    expect(firstParagraph?.style.textIndent).toBe(
      `${PATENT_BODY_PARAGRAPH_ATTRIBUTES.paragraphIndentMm}mm`,
    );
    expect(firstParagraph?.style.fontSize).toBe(
      `${PATENT_BODY_PARAGRAPH_ATTRIBUTES.defaultFontSizePt}pt`,
    );
    expect(firstParagraph?.style.fontFamily).toContain(
      PATENT_BODY_PARAGRAPH_ATTRIBUTES.defaultFontFamily,
    );
  });

  test("renders patent default text templates with body indentation and a centered description title", async () => {
    const commandBus = new EditorCommandBus();
    const { rerender } = render(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "description")}
        bookKind="description"
        document={book("description")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("description")}
        onDocumentChange={vi.fn()}
      />,
    );

    const descriptionEditor = await screen.findByRole("textbox", { name: "编辑 说明书" });
    const paragraphs = Array.from(descriptionEditor.querySelectorAll("p"));
    const title = paragraphs[0];
    const bodyParagraph = paragraphs[1];

    expect(title).toBeInstanceOf(HTMLElement);
    expect((title as HTMLElement).style.textAlign).toBe("center");
    expect((title as HTMLElement).style.textIndent).toBe("0mm");
    expect((title as HTMLElement).hasAttribute("data-semantic-role")).toBe(false);
    expect(bodyParagraph?.style.textIndent).toBe(
      `${PATENT_BODY_PARAGRAPH_ATTRIBUTES.paragraphIndentMm}mm`,
    );

    rerender(
      <PatentBookRichTextEditor
        editorId={patentBookEditorId("session-1", "abstract")}
        bookKind="abstract"
        document={book("abstract")}
        availableAssetIds={new Set()}
        commandBus={commandBus}
        capabilities={capabilitiesForPatentBook("abstract")}
        onDocumentChange={vi.fn()}
      />,
    );

    const abstractEditor = await screen.findByRole("textbox", { name: "编辑 说明书摘要" });
    expect(abstractEditor.querySelector("p")?.style.textIndent).toBe(
      `${PATENT_BODY_PARAGRAPH_ATTRIBUTES.paragraphIndentMm}mm`,
    );
  });
});
