import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor, type JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { StrictMode, useEffect, useState } from "react";
import { createBlankDocument } from "../../../shared/document/defaults";
import {
  type AssetDescriptor,
  type CanonicalDocument,
  MAX_TEXT_NODE_CODE_UNITS,
} from "../../../shared/document/model";
import { PATENT_FIRST_LINE_INDENT_MM } from "../../../shared/patent/formatting";
import { EditorCommandBus } from "../app/command-bus";
import { onApplicationError } from "../shared/error-dialog";
import { inheritDocumentEcho } from "./content-fingerprint";
import { createPatentExtensions } from "./extensions";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";
import {
  CHEMICAL_STRUCTURE_CLIPBOARD_MIME,
  RichTextEditorCore,
  replaceChemicalStructureWithDraft,
} from "./rich-text-editor-core";

vi.mock("../chemistry/ketcher-editor", () => ({
  KetcherEditor: ({
    onReady,
    onContentChange,
  }: {
    onReady(adapter: { readDraft(): Promise<unknown> }): void;
    onContentChange?(state: { hasContent: boolean; dirty: boolean }): void;
  }) => {
    useEffect(() => {
      onReady({
        readDraft: async () => ({ ok: true, value: { ket: "(ket)", svg: "<svg/>" } }),
      });
      onContentChange?.({ hasContent: true, dirty: false });
    }, [onReady, onContentChange]);
    return <p>结构编辑器已就绪</p>;
  },
}));

function expectStructurePasteKeepsContainers(
  editor: Editor,
  textbox: HTMLElement,
  clipboardData: { getData(type: string): string },
) {
  const original = editor.getJSON();
  for (const html of [
    "<table><tr><td><p>前后</p></td><td><p>保留</p></td></tr></table>",
    "<ul><li><p>前后</p></li><li><p>保留</p></li></ul>",
  ]) {
    act(() => {
      editor.commands.setContent(html);
      editor.commands.setTextSelection(4);
    });
    const before = editor.getJSON();
    fireEvent.paste(textbox, { clipboardData });
    expect(editor.getJSON()).toEqual(before);
  }
  act(() => editor.commands.setContent(original));
}

test.each(["external", "internal", "empty", "selected", "merged-target"])(
  "pastes %s table cells into an existing table and can undo",
  async (source) => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("表格粘贴");
    let editor: Editor | undefined;
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, instance, ...rest) => {
      editor = instance;
      return register(id, instance, ...rest);
    });
    const view = render(
      <RichTextEditorCore
        editorId="table-paste"
        title={document.title}
        document={document}
        commandBus={commandBus}
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
    await waitFor(() => expect(editor).toBeDefined());
    if (!editor) throw new Error("Missing editor");
    const target = editor;
    act(() => {
      commandBus.insertTable("table-paste", {
        rows: source === "selected" || source === "merged-target" ? 2 : 1,
        columns: source === "selected" || source === "merged-target" ? 2 : 1,
        headerRowCount: 0,
        layoutMode: "fit-page",
      });
      if (source === "selected" || source === "merged-target") {
        const cells: number[] = [];
        target.state.doc.descendants((node, pos) => {
          if (node.type.name === "tableCell") cells.push(pos);
        });
        target.commands.setCellSelection({
          anchorCell: cells[0] ?? 0,
          headCell: cells.at(-1) ?? 0,
        });
        if (source === "merged-target") target.commands.mergeCells();
      }
      target.view.dispatch(closeHistory(target.state.tr));
    });
    const before = target.getJSON();
    const html = `<table${source === "internal" ? ' data-pm-slice="3 3 []"' : ""}><tbody><tr><td><p>甲</p></td><td><p>乙</p></td></tr><tr><td><p>丙</p></td><td><p>丁</p></td></tr></tbody></table>`;
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 表格粘贴" }), {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? source === "empty"
              ? html.replace(/[甲乙丙丁]/gu, "")
              : html
            : source === "empty"
              ? ""
              : "甲\t乙\n丙\t丁",
      },
    });
    const tables = (target.getJSON() as JSONContent).content?.filter(
      (node) => node.type === "table",
    );
    expect(tables).toHaveLength(1);
    expect(tables?.[0]?.content?.map((row) => row.content?.length)).toEqual([2, 2]);
    if (source !== "empty") {
      expect(target.getText()).toContain("甲");
      expect(target.getText()).toContain("丁");
    }
    expect(tiptapToCanonical(target.getJSON(), document).ok).toBe(true);
    act(() => {
      expect(target.commands.undo()).toBe(true);
    });
    expect(target.getJSON().content?.map((node) => node.type)).toEqual(
      before.content?.map((node) => node.type),
    );
    expect((target.getJSON() as JSONContent).content?.[0]?.content).toEqual(
      (before as JSONContent).content?.[0]?.content,
    );
    expect((target.getJSON() as JSONContent).content?.[0]?.attrs?.layoutMode).toBe("fit-page");
    act(() => {
      expect(target.commands.redo()).toBe(true);
    });
    if (source !== "empty") expect(target.getText()).toContain("丁");
    view.unmount();
  },
);

test("pastes a whole table between paragraphs without absorbing surrounding text", async () => {
  const commandBus = new EditorCommandBus();
  const document = createBlankDocument("整表边界");
  let editor: Editor | undefined;
  const register = commandBus.register.bind(commandBus);
  vi.spyOn(commandBus, "register").mockImplementation((id, instance, ...rest) => {
    editor = instance;
    return register(id, instance, ...rest);
  });
  const view = render(
    <RichTextEditorCore
      editorId="whole-table"
      title={document.title}
      document={document}
      commandBus={commandBus}
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
  await waitFor(() => expect(editor).toBeDefined());
  if (!editor) throw new Error("Missing editor");
  const target = editor;
  act(() => {
    target.commands.setContent("<p>前文后文</p>");
    target.commands.setTextSelection(3);
    target.view.dispatch(closeHistory(target.state.tr));
  });
  fireEvent.paste(screen.getByRole("textbox", { name: "编辑 整表边界" }), {
    clipboardData: {
      files: [],
      getData: (type: string) =>
        type === "text/html"
          ? "<table><tr><td><p>甲</p></td><td><p>乙</p></td></tr></table>"
          : "甲\t乙",
    },
  });
  const nodes = Array.from({ length: target.state.doc.childCount }, (_, i) =>
    target.state.doc.child(i),
  );
  expect(nodes.map((node) => [node.type.name, node.textContent])).toEqual([
    ["paragraph", "前文"],
    ["table", "甲乙"],
    ["paragraph", "后文"],
  ]);
  act(() => {
    expect(target.commands.undo()).toBe(true);
  });
  expect(target.state.doc.textContent).toBe("前文后文");
  view.unmount();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function documentWithText(title: string, text: string): CanonicalDocument {
  const document = createBlankDocument(title);
  const paragraph = document.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("缺少段落");
  return {
    ...document,
    content: [
      {
        ...paragraph,
        content: [{ type: "text", text, marks: [] }],
      },
    ],
  };
}

test("skips verified local clone echoes but applies external replacements and retains undo", async () => {
  const bus = new EditorCommandBus();
  const source = documentWithText("回显保护", "原始内容");
  const convert = vi.fn(canonicalToTiptap);
  let replace!: (document: CanonicalDocument) => void;
  function Parent({ converter = convert }: { converter?: typeof convert }) {
    const [document, setDocument] = useState(source);
    replace = setDocument;
    return (
      <RichTextEditorCore
        editorId="echo-safety"
        title="回显保护"
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
        toTiptap={converter}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={(next) => {
          const copy = structuredClone(next);
          inheritDocumentEcho(next, copy);
          setDocument(copy as CanonicalDocument);
        }}
      />
    );
  }
  const view = render(<Parent />);
  await waitFor(() => expect(bus.getEditor("echo-safety")).toBeDefined());
  const editor = bus.getEditor("echo-safety")!;
  convert.mockClear();
  act(() => {
    editor.commands.insertContentAt(2, "甲");
  });
  expect(convert).toHaveBeenCalledTimes(1);
  expect(editor.getText()).toContain("甲");
  const changedConverter = vi.fn(canonicalToTiptap);
  view.rerender(<Parent converter={changedConverter} />);
  expect(changedConverter.mock.calls.length).toBeGreaterThan(0);
  act(() => {
    editor.commands.undo();
  });
  expect(editor.getText()).toBe("原始内容");
  act(() => {
    editor.commands.redo();
  });
  expect(editor.getText()).toContain("甲");
  changedConverter.mockClear();
  act(() => replace(documentWithText("回显保护", "外部替换")));
  expect(changedConverter.mock.calls.length).toBeGreaterThan(0);
  expect(editor.getText()).toBe("外部替换");
  view.unmount();
});

function documentWithHighlightedText(
  title: string,
  text: string,
  backgroundColor: string,
): CanonicalDocument {
  const document = documentWithText(title, text);
  const paragraph = document.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("缺少段落");
  return {
    ...document,
    content: [
      {
        ...paragraph,
        content: [
          {
            type: "text",
            text,
            marks: [{ type: "background-color", value: backgroundColor }],
          },
        ],
      },
    ],
  };
}

describe("rich text editor core", () => {
  const structureId = "00000000-0000-4000-8000-000000000701";
  const previewAssetId = "00000000-0000-4000-8000-000000000702";
  const previewDescriptor = {
    assetId: previewAssetId,
    kind: "chemical-preview" as const,
    originalName: "structure.svg",
    mediaType: "image/svg+xml" as const,
    extension: "svg" as const,
    byteLength: 4,
    sha256: "A".repeat(64),
    widthPx: 128,
    heightPx: 96,
    previewByteLength: 4,
    previewSha256: "B".repeat(64),
  };

  function structureDraft(ketSource = "(ket) (atom O)") {
    return {
      kind: "structure" as const,
      ketSource,
      editorMode: "molecule" as const,
      previewAssetId,
      previewDescriptor,
    };
  }

  test("keeps undo and redo history when the same editor leaves and re-enters the layout", async () => {
    const commandBus = new EditorCommandBus();
    const initialDocument = documentWithText("跨布局历史", "原始内容");
    let currentDocument = initialDocument;
    const onDocumentChange = vi.fn((nextDocument: CanonicalDocument) => {
      currentDocument = nextDocument;
    });
    const capabilities = {
      headings: true,
      lists: true,
      tables: true,
      formulas: true,
      chemistry: true,
      images: true,
      pageBreaks: true,
    };
    const renderEditor = (document: CanonicalDocument) => (
      <RichTextEditorCore
        editorId="layout-history"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={capabilities}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />
    );

    const firstMount = render(renderEditor(initialDocument));
    await waitFor(() => expect(commandBus.getEditor("layout-history")).not.toBeNull());
    const firstEditor = commandBus.getEditor("layout-history");
    if (!firstEditor) throw new Error("编辑器未注册");
    act(() => {
      firstEditor.commands.setTextSelection(firstEditor.state.doc.content.size);
      firstEditor.commands.insertContent("已修改");
    });
    expect(firstEditor.getText()).toContain("已修改");
    await waitFor(() => expect(onDocumentChange).toHaveBeenCalled());

    firstMount.unmount();
    render(renderEditor(currentDocument));
    await waitFor(() => expect(commandBus.getEditor("layout-history")).not.toBeNull());
    const remountedEditor = commandBus.getEditor("layout-history");
    expect(remountedEditor).toBe(firstEditor);
    expect(commandBus.execute("layout-history", "undo")).toBe(true);
    expect(remountedEditor?.getText()).toBe("原始内容");
    expect(commandBus.execute("layout-history", "redo")).toBe(true);
    expect(remountedEditor?.getText()).toContain("已修改");
  });

  test("renders and clears temporary exact reference-mark review highlights", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithText("待核对高亮", "箱体与箱体以及^#");
    const editor = (keyword: string | null, activeIndex: number | null = null) => (
      <RichTextEditorCore
        editorId="reference-mark-review-highlight"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        referenceMarkReviewKeyword={keyword}
        referenceMarkReviewActiveIndex={activeIndex}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />
    );
    const { container, rerender } = render(editor("箱体"));

    await waitFor(() =>
      expect(container.querySelectorAll(".reference-mark-review-match")).toHaveLength(2),
    );
    rerender(editor("箱体", 1));
    await waitFor(() =>
      expect(container.querySelectorAll("[data-reference-mark-review-active='true']")).toHaveLength(
        1,
      ),
    );
    rerender(editor("^#"));
    await waitFor(() =>
      expect(container.querySelectorAll(".reference-mark-review-match")).toHaveLength(1),
    );
    rerender(editor(null));
    await waitFor(() =>
      expect(container.querySelectorAll(".reference-mark-review-match")).toHaveLength(0),
    );
  });

  test("activates a decorated reference-mark keyword on double click without affecting ordinary text", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithText("零部件定位", "电池包(7)与普通文字");
    const onReferenceMarkActivate = vi.fn();
    const { container, rerender } = render(
      <RichTextEditorCore
        editorId="reference-mark-keyword-locator"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        referenceMarkLocatorEnabled
        referenceMarkBookKind="claims"
        referenceMarks={[{ referenceMarkId: "mark-battery", keyword: "电池包", number: 7 }]}
        activeReferenceMarkId={null}
        recentReferenceMarkId="mark-battery"
        onReferenceMarkActivate={onReferenceMarkActivate}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );

    const keyword = await waitFor(() => {
      const target = container.querySelector<HTMLElement>(
        "[data-reference-mark-id='mark-battery']",
      );
      expect(target).not.toBeNull();
      return target as HTMLElement;
    });
    expect(keyword.textContent).toBe("电池包(7)");
    expect(keyword.classList.contains("is-recent")).toBe(true);
    const keywordSecondMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      detail: 2,
    });
    expect(keyword.dispatchEvent(keywordSecondMouseDown)).toBe(false);
    expect(keywordSecondMouseDown.defaultPrevented).toBe(true);
    fireEvent.doubleClick(keyword);
    expect(onReferenceMarkActivate).toHaveBeenCalledWith("mark-battery");

    rerender(
      <RichTextEditorCore
        editorId="reference-mark-keyword-locator"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        referenceMarkLocatorEnabled
        referenceMarkBookKind="claims"
        referenceMarks={[{ referenceMarkId: "mark-battery", keyword: "电池包", number: 7 }]}
        activeReferenceMarkId="mark-battery"
        recentReferenceMarkId={null}
        onReferenceMarkActivate={onReferenceMarkActivate}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    const activeKeyword = await waitFor(() => {
      const target = container.querySelector<HTMLElement>(
        "[data-reference-mark-id='mark-battery']",
      );
      expect(target?.classList.contains("is-active")).toBe(true);
      return target as HTMLElement;
    });
    fireEvent.doubleClick(activeKeyword);
    expect(onReferenceMarkActivate).toHaveBeenLastCalledWith(null);

    const ordinaryText = screen.getByText(/普通文字/u);
    fireEvent.doubleClick(ordinaryText);
    expect(onReferenceMarkActivate).toHaveBeenCalledTimes(2);

    rerender(
      <RichTextEditorCore
        editorId="reference-mark-keyword-locator"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        referenceMarkLocatorEnabled={false}
        referenceMarkBookKind="claims"
        referenceMarks={[{ referenceMarkId: "mark-battery", keyword: "电池包", number: 7 }]}
        activeReferenceMarkId={null}
        recentReferenceMarkId="mark-battery"
        onReferenceMarkActivate={onReferenceMarkActivate}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".reference-mark-keyword-block")).toHaveLength(0),
    );
  });

  test("shows a gray retained selection only while the editor is an inactive visible pane", async () => {
    const commandBus = new EditorCommandBus();
    const patentDocument = documentWithText("后台选区", "该装置能够稳定工作。\n");
    const onDocumentChange = vi.fn();
    const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [DOMRect.fromRect({ x: 16, y: 24, width: 120, height: 20 })],
    });
    const outside = window.document.createElement("button");
    window.document.body.append(outside);

    const { container, rerender, unmount } = render(
      <RichTextEditorCore
        editorId="inactive-selection"
        title={patentDocument.title}
        document={patentDocument}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(commandBus.has("inactive-selection")).toBe(true));
    const editor = commandBus.getEditor("inactive-selection");
    if (!editor) throw new Error("missing editor");
    act(() => editor.commands.setTextSelection({ from: 2, to: 7 }));
    outside.focus();

    rerender(
      <RichTextEditorCore
        editorId="inactive-selection"
        title={patentDocument.title}
        document={patentDocument}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
        inactiveSelectionVisible
      />,
    );

    await waitFor(() =>
      expect(
        container.querySelector('.editor-selection-overlay[data-tone="background"]'),
      ).not.toBeNull(),
    );
    expect(commandBus.captureSelection("inactive-selection")).toEqual({ from: 2, to: 7 });
    expect(onDocumentChange).not.toHaveBeenCalled();

    rerender(
      <RichTextEditorCore
        editorId="inactive-selection"
        title={patentDocument.title}
        document={patentDocument}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(container.querySelector(".editor-selection-overlay")).toBeNull());
    expect(commandBus.captureSelection("inactive-selection")).toEqual({ from: 2, to: 7 });

    unmount();
    outside.remove();
    if (originalRangeRects) {
      Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
    } else {
      Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
  });

  test("keeps the active editor selection visible while focus is in a function rail", async () => {
    const commandBus = new EditorCommandBus();
    const patentDocument = documentWithText("自定义编号选区", "该装置能够稳定工作。\n");
    const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [DOMRect.fromRect({ x: 16, y: 24, width: 120, height: 20 })],
    });
    const outsideInput = window.document.createElement("input");
    window.document.body.append(outsideInput);

    const { container, unmount } = render(
      <RichTextEditorCore
        editorId="active-selection"
        title={patentDocument.title}
        document={patentDocument}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
        activeSelectionVisible
      />,
    );
    await waitFor(() => expect(commandBus.has("active-selection")).toBe(true));
    const editor = commandBus.getEditor("active-selection");
    if (!editor) throw new Error("missing editor");
    act(() => editor.commands.setTextSelection({ from: 2, to: 7 }));
    outsideInput.focus();

    await waitFor(() =>
      expect(
        container.querySelector('.editor-selection-overlay[data-tone="active"]'),
      ).not.toBeNull(),
    );
    expect(commandBus.captureSelection("active-selection")).toEqual({ from: 2, to: 7 });

    unmount();
    outsideInput.remove();
    if (originalRangeRects) {
      Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
    } else {
      Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
  });

  test.each([
    ["Win32", "ctrlKey"],
    ["MacIntel", "metaKey"],
  ] as const)("routes sentence selection for %s", async (platform, modifier) => {
    const platformOverride = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const commandBus = new EditorCommandBus();
    const selectSentence = vi
      .spyOn(commandBus, "selectSentenceFromCoordinates")
      .mockReturnValue(true);
    const document = documentWithText("整句选择", "第一句。第二句！");

    render(
      <RichTextEditorCore
        editorId="sentence-selection"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(commandBus.has("sentence-selection")).toBe(true));

    fireEvent.click(screen.getByRole("textbox", { name: "编辑 整句选择" }), {
      button: 0,
      clientX: 120,
      clientY: 240,
      [modifier]: true,
    });

    expect(selectSentence).toHaveBeenCalledWith("sentence-selection", { x: 120, y: 240 });
    platformOverride.mockRestore();
  });

  test("sets a contrasting native caret color for the active highlight", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithHighlightedText("高亮光标", "深色背景中的文字", "#0B1F3A");

    render(
      <RichTextEditorCore
        editorId="caret-contrast"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );

    const textbox = await screen.findByRole("textbox", { name: "编辑 高亮光标" });
    await waitFor(() => expect(commandBus.has("caret-contrast")).toBe(true));
    expect(textbox.style.getPropertyValue("--editor-caret-color")).toBe("#FFFFFF");
  });

  test("passes a failed patent-book save state into the structure editor", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("保存状态提示");
    const onRetrySave = vi.fn();

    render(
      <RichTextEditorCore
        editorId="chemistry-save-warning"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        saveState="failed"
        onRetrySave={onRetrySave}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(commandBus.has("chemistry-save-warning")).toBe(true));
    act(() =>
      expect(commandBus.openChemistryEditor("chemistry-save-warning", "structure")).toBe(true),
    );
    expect(
      await screen.findByText("当前专利保存失败，结构式插入后尚未安全写入专利文件。"),
    ).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "重试保存" }));
    expect(onRetrySave).toHaveBeenCalledOnce();
  });

  function chemicalEditor() {
    return new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "chemicalStructure",
            attrs: {
              nodeId: structureId,
              ketSource: "(ket) (atom C)",
              editorMode: "molecule",
              previewAssetId: "00000000-0000-4000-8000-000000000703",
              widthMm: 80,
              alignment: "center",
            },
          },
        ],
      },
    });
  }

  test.each(["read-only", "changed"])(
    "does not overwrite a %s chemical structure",
    async (state) => {
      const editor = chemicalEditor();
      const addAsset = vi.fn();
      if (state === "read-only") editor.setEditable(false);
      else
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(0, undefined, {
            ...editor.state.doc.firstChild?.attrs,
            ketSource: "(ket) (atom N)",
          }),
        );
      const before = editor.getJSON();
      const result = await replaceChemicalStructureWithDraft({
        editor,
        request: {
          nodeId: structureId,
          ketSource: "(ket) (atom C)",
          editorMode: "molecule",
          position: 0,
        },
        draft: structureDraft(),
        addAsset,
      });
      expect(result.ok).toBe(false);
      expect(editor.getJSON()).toEqual(before);
      expect(addAsset).not.toHaveBeenCalled();
      editor.destroy();
    },
  );

  test("rejects an invalid structure draft without touching the existing node", async () => {
    const editor = chemicalEditor();
    const before = editor.getJSON();
    const dispatch = vi.spyOn(editor.view, "dispatch");
    const addAsset = vi.fn();

    await replaceChemicalStructureWithDraft({
      editor,
      request: {
        nodeId: structureId,
        ketSource: "(ket) (atom C)",
        editorMode: "molecule",
        position: 0,
      },
      draft: { ...structureDraft("   "), previewAssetId: "" },
      addAsset,
    });

    expect(editor.getJSON()).toEqual(before);
    expect(dispatch).not.toHaveBeenCalled();
    expect(addAsset).not.toHaveBeenCalled();
    editor.destroy();
  });

  test("rejects a draft whose descriptor is not a chemical preview asset", async () => {
    const editor = chemicalEditor();
    const before = editor.getJSON();
    const dispatch = vi.spyOn(editor.view, "dispatch");
    const addAsset = vi.fn();

    await replaceChemicalStructureWithDraft({
      editor,
      request: {
        nodeId: structureId,
        ketSource: "(ket) (atom C)",
        editorMode: "molecule",
        position: 0,
      },
      draft: {
        ...structureDraft(),
        previewDescriptor: {
          ...previewDescriptor,
          kind: "image",
        } as unknown as typeof previewDescriptor,
      },
      addAsset,
    });

    expect(editor.getJSON()).toEqual(before);
    expect(dispatch).not.toHaveBeenCalled();
    expect(addAsset).not.toHaveBeenCalled();
    editor.destroy();
  });

  test("replaces the structure with the staged preview in one undoable transaction", async () => {
    const editor = chemicalEditor();
    const dispatch = vi.spyOn(editor.view, "dispatch");
    const addAsset = vi.fn();

    await replaceChemicalStructureWithDraft({
      editor,
      request: {
        nodeId: structureId,
        ketSource: "(ket) (atom C)",
        editorMode: "molecule",
        position: 0,
      },
      draft: structureDraft(),
      addAsset,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(addAsset).toHaveBeenCalledWith(previewDescriptor);
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "chemicalStructure",
      attrs: {
        ketSource: "(ket) (atom O)",
        editorMode: "molecule",
        previewAssetId,
      },
    });
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON().content?.[0]?.attrs?.ketSource).toBe("(ket) (atom C)");
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON().content?.[0]?.attrs?.ketSource).toBe("(ket) (atom O)");
    editor.destroy();
  });

  test("does not replace a node that was deleted while the dialog was open", async () => {
    const editor = chemicalEditor();
    const addAsset = vi.fn();
    editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.content.size));

    const result = await replaceChemicalStructureWithDraft({
      editor,
      request: {
        nodeId: structureId,
        ketSource: "(ket) (atom C)",
        editorMode: "molecule",
        position: 0,
      },
      draft: structureDraft(),
      addAsset,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(addAsset).not.toHaveBeenCalled();
    expect(editor.getJSON().content?.some((node) => node.type === "chemicalStructure")).toBe(false);
    editor.destroy();
  });

  test("relocates by node id and replaces the structure after the node moved", async () => {
    const editor = chemicalEditor();
    const addAsset = vi.fn();
    editor
      .chain()
      .insertContentAt(0, {
        type: "paragraph",
        content: [{ type: "text", text: "前置段落", marks: [] }],
      })
      .run();

    const result = await replaceChemicalStructureWithDraft({
      editor,
      request: {
        nodeId: structureId,
        ketSource: "(ket) (atom C)",
        editorMode: "molecule",
        position: 0,
      },
      draft: structureDraft(),
      addAsset,
    });

    expect(result).toMatchObject({ ok: true });
    expect(addAsset).toHaveBeenCalledWith(previewDescriptor);
    expect(editor.getJSON().content?.[1]).toMatchObject({
      type: "chemicalStructure",
      attrs: { ketSource: "(ket) (atom O)", previewAssetId },
    });
    editor.destroy();
  });

  test("does not dispatch a superseded structure confirmation", async () => {
    const editor = chemicalEditor();
    const before = editor.getJSON();
    const dispatch = vi.spyOn(editor.view, "dispatch");
    const current = false;

    const result = await replaceChemicalStructureWithDraft({
      editor,
      request: {
        nodeId: structureId,
        ketSource: "(ket) (atom C)",
        editorMode: "molecule",
        position: 0,
      },
      draft: structureDraft(),
      addAsset: vi.fn(),
      isCurrent: () => current,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(editor.getJSON()).toEqual(before);
    expect(dispatch).not.toHaveBeenCalled();
    editor.destroy();
  });

  test("uses a private clipboard MIME for a chemical structure without exposing KET in HTML", async () => {
    const document = createBlankDocument("结构式剪贴板");
    const structureDocument: CanonicalDocument = {
      ...document,
      assets: [
        {
          ...previewDescriptor,
          assetId: previewAssetId,
        },
      ],
      content: [
        {
          id: structureId,
          type: "chemical-structure",
          ketSource: "(ket) (atom Cl)",
          editorMode: "macromolecule",
          previewAssetId,
          widthMm: 80,
          alignment: "center",
        },
      ],
    };
    const commandBus = new EditorCommandBus();
    const registered: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registered.current = editor;
      return register(id, editor, ...rest);
    });
    const onDocumentChange = vi.fn();
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          getPreview: vi.fn().mockResolvedValue({
            ok: false,
            error: { code: "NOT_FOUND", message: "test preview" },
          }),
          copyImages: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        },
      },
    });
    const rendered = render(
      <RichTextEditorCore
        editorId="clipboard-core"
        title={structureDocument.title}
        document={structureDocument}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(registered.current).toBeDefined());
    const editor = registered.current;
    if (!editor) throw new Error("编辑器未注册");
    const clipboard = new Map<string, string>();
    const clipboardData = {
      files: [],
      clearData: vi.fn(() => clipboard.clear()),
      setData: vi.fn((type: string, value: string) => clipboard.set(type, value)),
      getData: vi.fn((type: string) => clipboard.get(type) ?? ""),
    };
    const textbox = screen.getByRole("textbox", { name: "编辑 结构式剪贴板" });

    act(() => editor.commands.setNodeSelection(0));
    fireEvent.copy(textbox, { clipboardData });
    const privatePayload = clipboard.get(CHEMICAL_STRUCTURE_CLIPBOARD_MIME);
    expect(JSON.parse(privatePayload ?? "")).toEqual({
      version: 1,
      token: expect.any(String),
    });
    const copiedToken = (JSON.parse(privatePayload ?? "") as { token: string }).token;
    expect(privatePayload).not.toContain("ketSource");
    expect(privatePayload).not.toContain("(ket) (atom Cl)");
    expectStructurePasteKeepsContainers(editor, textbox, clipboardData);
    expect(editor.getHTML()).not.toContain("(ket) (atom Cl)");

    act(() => editor.commands.setTextSelection(editor.state.doc.content.size));
    fireEvent.paste(textbox, { clipboardData });
    await waitFor(() =>
      expect(
        onDocumentChange.mock.calls
          .at(-1)
          ?.at(0)
          .content.filter((node: { type: string }) => node.type === "chemical-structure"),
      ).toHaveLength(2),
    );
    const latest = onDocumentChange.mock.calls.at(-1)?.[0] as CanonicalDocument;
    expect(latest.content.findLast((node) => node.type === "chemical-structure")).toMatchObject({
      type: "chemical-structure",
      ketSource: "(ket) (atom Cl)",
      editorMode: "macromolecule",
      previewAssetId,
    });

    act(() => editor.commands.setTextSelection(editor.state.doc.content.size));
    fireEvent.paste(textbox, { clipboardData });
    await waitFor(() =>
      expect(
        onDocumentChange.mock.calls
          .at(-1)
          ?.at(0)
          .content.filter((node: { type: string }) => node.type === "chemical-structure"),
      ).toHaveLength(3),
    );

    const externalClipboard = {
      files: [],
      getData: vi.fn((type: string) => (type === "text/html" ? editor.getHTML() : "")),
    };
    act(() => editor.commands.setTextSelection(editor.state.doc.content.size));
    fireEvent.paste(textbox, { clipboardData: externalClipboard });
    expect(
      editor.getJSON().content?.filter((node) => node.type === "chemicalStructure"),
    ).toHaveLength(3);

    const fullForgedStructure = {
      id: "00000000-0000-4000-8000-000000000704",
      type: "chemical-structure",
      ketSource: "(ket) (atom Br)",
      previewAssetId,
      widthMm: 80,
      alignment: "center",
    };
    const forgedClipboard = {
      files: [],
      getData: vi.fn((type: string) =>
        type === CHEMICAL_STRUCTURE_CLIPBOARD_MIME
          ? JSON.stringify({
              version: 1,
              token: copiedToken,
              structure: fullForgedStructure,
            })
          : "",
      ),
    };
    fireEvent.paste(textbox, { clipboardData: forgedClipboard });
    expect(
      editor.getJSON().content?.filter((node) => node.type === "chemicalStructure"),
    ).toHaveLength(3);

    const forgedAssetClipboard = {
      files: [],
      getData: vi.fn((type: string) =>
        type === CHEMICAL_STRUCTURE_CLIPBOARD_MIME
          ? JSON.stringify({
              version: 1,
              token: globalThis.crypto.randomUUID(),
              structure: {
                ...fullForgedStructure,
                previewAssetId: "00000000-0000-4000-8000-000000000705",
              },
            })
          : "",
      ),
    };
    fireEvent.paste(textbox, { clipboardData: forgedAssetClipboard });
    expect(
      editor.getJSON().content?.filter((node) => node.type === "chemicalStructure"),
    ).toHaveLength(3);

    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const overflowPayloads: string[] = [];
      act(() => editor.commands.setNodeSelection(0));
      for (let index = 0; index < 17; index += 1) {
        fireEvent.copy(textbox, { clipboardData });
        overflowPayloads.push(clipboard.get(CHEMICAL_STRUCTURE_CLIPBOARD_MIME) ?? "");
      }
      // Count clipboard-expiry timers, not React/editor scheduling timers.
      expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 5 * 60 * 1000)).toHaveLength(
        17,
      );

      const evictedClipboard = {
        files: [],
        getData: vi.fn((type: string) =>
          type === CHEMICAL_STRUCTURE_CLIPBOARD_MIME ? overflowPayloads[0] : "",
        ),
      };
      act(() => editor.commands.setTextSelection(editor.state.doc.content.size));
      fireEvent.paste(textbox, { clipboardData: evictedClipboard });
      expect(
        editor.getJSON().content?.filter((node) => node.type === "chemicalStructure"),
      ).toHaveLength(3);

      const latestClipboard = {
        files: [],
        getData: vi.fn((type: string) =>
          type === CHEMICAL_STRUCTURE_CLIPBOARD_MIME ? overflowPayloads.at(-1) : "",
        ),
      };
      fireEvent.paste(textbox, { clipboardData: latestClipboard });
      expect(
        editor.getJSON().content?.filter((node) => node.type === "chemicalStructure"),
      ).toHaveLength(4);

      act(() => vi.advanceTimersByTime(5 * 60 * 1000));
      fireEvent.paste(textbox, { clipboardData: latestClipboard });
      expect(
        editor.getJSON().content?.filter((node) => node.type === "chemicalStructure"),
      ).toHaveLength(4);

      clearTimeoutSpy.mockClear();
      act(() => editor.commands.setNodeSelection(0));
      fireEvent.copy(textbox, { clipboardData });
      const previousSessionTimerIndex = setTimeoutSpy.mock.calls.findLastIndex(
        ([, delay]) => delay === 5 * 60 * 1000,
      );
      const previousSessionTimer = setTimeoutSpy.mock.results[previousSessionTimerIndex]?.value;
      const previousSessionClipboard = {
        files: [],
        getData: vi.fn((type: string) =>
          type === CHEMICAL_STRUCTURE_CLIPBOARD_MIME
            ? (clipboard.get(CHEMICAL_STRUCTURE_CLIPBOARD_MIME) ?? "")
            : "",
        ),
      };
      expect(previousSessionTimer).toBeDefined();
      rendered.rerender(
        <RichTextEditorCore
          editorId="clipboard-core-rerendered"
          title={structureDocument.title}
          document={structureDocument}
          commandBus={commandBus}
          capabilities={{
            headings: true,
            lists: true,
            tables: true,
            formulas: true,
            chemistry: true,
            images: true,
            pageBreaks: true,
          }}
          toTiptap={canonicalToTiptap}
          fromTiptap={tiptapToCanonical}
          onDocumentChange={onDocumentChange}
        />,
      );
      expect(clearTimeoutSpy).toHaveBeenCalledWith(previousSessionTimer);
      const rerenderedEditor = registered.current;
      if (!rerenderedEditor) throw new Error("rerendered editor missing");
      const rerenderedTextbox = screen.getByRole("textbox", { name: "编辑 结构式剪贴板" });
      const beforePreviousSessionPaste = rerenderedEditor
        .getJSON()
        .content?.filter((node) => node.type === "chemicalStructure").length;
      act(() =>
        rerenderedEditor.commands.setTextSelection(rerenderedEditor.state.doc.content.size),
      );
      fireEvent.paste(rerenderedTextbox, { clipboardData: previousSessionClipboard });
      expect(
        rerenderedEditor.getJSON().content?.filter((node) => node.type === "chemicalStructure"),
      ).toHaveLength(beforePreviousSessionPaste ?? 0);

      clearTimeoutSpy.mockClear();
      act(() => rerenderedEditor.commands.setNodeSelection(0));
      fireEvent.copy(rerenderedTextbox, { clipboardData });
      const cleanupTimer = setTimeoutSpy.mock.results.at(-1)?.value;
      expect(cleanupTimer).toBeDefined();
      rendered.unmount();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(cleanupTimer);
    } finally {
      vi.useRealTimers();
    }

    const newCommandBus = new EditorCommandBus();
    const newRegistered: { current?: Editor } = {};
    const newRegister = newCommandBus.register.bind(newCommandBus);
    vi.spyOn(newCommandBus, "register").mockImplementation((id, newEditor, ...rest) => {
      newRegistered.current = newEditor;
      return newRegister(id, newEditor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="clipboard-core-recreated"
        title={structureDocument.title}
        document={structureDocument}
        commandBus={newCommandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(newRegistered.current).toBeDefined());
    const recreatedEditor = newRegistered.current;
    if (!recreatedEditor) throw new Error("重建编辑器未注册");
    const recreatedTextbox = screen.getByRole("textbox", { name: "编辑 结构式剪贴板" });
    act(() => recreatedEditor.commands.setTextSelection(recreatedEditor.state.doc.content.size));
    // This assertion concerns the editor-local legacy token. Cross-session
    // image-selection tokens use the asset staging path tested separately.
    fireEvent.paste(recreatedTextbox, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === CHEMICAL_STRUCTURE_CLIPBOARD_MIME ? (clipboard.get(type) ?? "") : "",
      },
    });
    expect(
      recreatedEditor.getJSON().content?.filter((node) => node.type === "chemicalStructure"),
    ).toHaveLength(1);
  });
  test("falls back to plain text when sanitized HTML has no insertable content", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithText("HTML 回退", "前缀替换后缀");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="html-fallback-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");
    act(() => editor.commands.setTextSelection({ from: 3, to: 5 }));
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 HTML 回退" }), {
      clipboardData: {
        files: [],
        getData: vi.fn((type: string) =>
          type === "text/html"
            ? '<script>alert(1)</script><img src="https://evil.test/tracker.png">'
            : type === "text/plain"
              ? "第一段\n第二段\r\n第三段"
              : "",
        ),
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "继续粘贴" }));
    await waitFor(() => expect(editor.getText()).toContain("第一段"));
    expect(editor.getText()).toContain("第二段");
    expect(editor.getText()).toContain("第三段");
    expect(editor.getText()).toContain("前缀");
    expect(editor.getText()).toContain("后缀");
    expect(editor.getText()).not.toContain("\uE010PIMG");
  });

  test("merges the first and last pasted plain-text lines with content outside the selection", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithText("多段回退", "前缀替换后缀");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="multiline-html-fallback-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    act(() => editor.commands.setTextSelection({ from: 3, to: 5 }));
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 多段回退" }), {
      clipboardData: {
        files: [],
        getData: vi.fn((type: string) =>
          type === "text/html"
            ? '<script>alert(1)</script><img src="https://evil.test/tracker.png">'
            : type === "text/plain"
              ? "第一段\n第二段\r\n第三段"
              : "",
        ),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "继续粘贴" }));
    await waitFor(() => expect(editor.getJSON().content).toHaveLength(3));
    expect(
      editor
        .getJSON()
        .content?.map((node) =>
          node.content?.map((child) => ("text" in child ? (child.text ?? "") : "")).join(""),
        ),
    ).toEqual(["前缀第一段", "第二段", "第三段后缀"]);
    expect(editor.getText()).toMatch(/前缀第一段\n+第二段\n+第三段后缀/u);
  });

  test.each(["office", "plain"])(
    "offers %s paragraph formatting without changing earlier paragraphs and supports undo",
    async (source) => {
      const commandBus = new EditorCommandBus();
      const document = documentWithText("粘贴排版切换", "原有");
      const registeredEditor: { current?: Editor } = {};
      const register = commandBus.register.bind(commandBus);
      vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
        registeredEditor.current = editor;
        return register(id, editor, ...rest);
      });
      render(
        <div className="patent-page-with-rail">
          <div className="patent-global-function-rail__body" />
          <RichTextEditorCore
            editorId="paste-formatting"
            title={document.title}
            document={document}
            commandBus={commandBus}
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
          />
        </div>,
      );
      await waitFor(() => expect(registeredEditor.current).toBeDefined());
      const editor = registeredEditor.current;
      if (!editor) throw new Error("编辑器未注册");
      act(() => {
        editor.commands.setTextSelection(3);
        editor.commands.splitBlock();
      });
      // jsdom has no Range geometry; this test checks document/history, not scrolling.
      editor.setOptions({
        editorProps: { ...editor.options.editorProps, handleScrollToSelection: () => true },
      });
      const originalIndent = editor.state.doc.firstChild?.attrs.paragraphIndentMm;
      fireEvent.paste(screen.getByRole("textbox", { name: "编辑 粘贴排版切换" }), {
        clipboardData: {
          files: [],
          getData: (type: string) =>
            source === "plain"
              ? type === "text/plain"
                ? "技术领域\n正文"
                : ""
              : type === "text/html"
                ? '<p class="MsoNormal" style="text-indent:0;text-align:left">技术领域</p><p class="MsoNormal">正文</p>'
                : "",
        },
      });
      expect(editor.state.doc.child(1).attrs.paragraphIndentMm).toBe(
        source === "office" ? 0 : PATENT_FIRST_LINE_INDENT_MM,
      );
      fireEvent.click(await screen.findByRole("button", { name: "保留原段落格式" }));
      expect(editor.state.doc.child(1).attrs.paragraphIndentMm).toBe(0);
      fireEvent.click(await screen.findByRole("button", { name: "使用正文段落格式" }));
      expect(editor.state.doc.child(1).attrs.paragraphIndentMm).toBe(PATENT_FIRST_LINE_INDENT_MM);
      expect(editor.state.doc.child(2).attrs.paragraphIndentMm).toBe(PATENT_FIRST_LINE_INDENT_MM);
      expect(editor.state.doc.firstChild?.attrs.paragraphIndentMm).toBe(originalIndent);
      act(() => {
        editor.commands.undo();
      });
      expect(editor.state.doc.child(1).attrs.paragraphIndentMm).toBe(0);
      expect(screen.queryByRole("button", { name: "使用正文段落格式" })).toBeNull();
      act(() => {
        editor.commands.redo();
      });
      expect(editor.state.doc.child(1).attrs.paragraphIndentMm).toBe(PATENT_FIRST_LINE_INDENT_MM);
      act(() => {
        editor.commands.insertContent("继续输入");
      });
      expect(screen.queryByRole("button", { name: "使用正文段落格式" })).toBeNull();
    },
  );

  test("keeps a one-paragraph HTML paste inline at the caret", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithText("HTML 行内粘贴", "前后");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="inline-html-paste-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    act(() => {
      editor.commands.setTextSelection(2);
      editor.commands.updateAttributes("paragraph", {
        paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM,
      });
    });
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 HTML 行内粘贴" }), {
      clipboardData: {
        files: [],
        getData: vi.fn((type: string) =>
          type === "text/html"
            ? '<p class="MsoNormal" style="text-indent:0">H<sub>2</sub>O。</p>'
            : type === "text/plain"
              ? "H₂O。"
              : "",
        ),
      },
    });

    await waitFor(() => expect(editor.getText()).toBe("前H2O。后"));
    expect(editor.getJSON().content).toHaveLength(1);
    expect(editor.getHTML()).toContain("<sub>2</sub>");
    expect(editor.state.doc.firstChild?.attrs.paragraphIndentMm).toBe(PATENT_FIRST_LINE_INDENT_MM);
    expect(screen.queryByRole("button", { name: "使用正文段落格式" })).toBeNull();
  });

  test.each(["text/plain", "text/html"])(
    "separates %s paste from adjacent typing in undo history",
    async (format) => {
      const commandBus = new EditorCommandBus();
      const document = documentWithText("粘贴撤销", "原有");
      const registeredEditor: { current?: Editor } = {};
      const register = commandBus.register.bind(commandBus);
      vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
        registeredEditor.current = editor;
        return register(id, editor, ...rest);
      });
      render(
        <RichTextEditorCore
          editorId="paste-history"
          title={document.title}
          document={document}
          commandBus={commandBus}
          capabilities={{
            headings: true,
            lists: true,
            tables: true,
            formulas: true,
            chemistry: true,
            chemicalStructures: true,
            images: false,
            pageBreaks: true,
          }}
          toTiptap={canonicalToTiptap}
          fromTiptap={tiptapToCanonical}
          onDocumentChange={vi.fn()}
        />,
      );
      await waitFor(() => expect(registeredEditor.current).toBeDefined());
      const editor = registeredEditor.current;
      if (!editor) throw new Error("编辑器未注册");
      act(() => {
        editor.commands.setTextSelection(3);
        editor.commands.insertContent("手打");
        fireEvent.paste(screen.getByRole("textbox", { name: "编辑 粘贴撤销" }), {
          clipboardData: {
            files: [],
            getData: (type: string) =>
              type === format ? (format === "text/html" ? "<p>粘贴</p>" : "粘贴") : "",
          },
        });
        editor.commands.insertContent("后打");
      });
      expect(editor.getText()).toBe("原有手打粘贴后打");
      for (const text of ["原有手打粘贴", "原有手打", "原有"]) {
        act(() => {
          editor.commands.undo();
        });
        expect(editor.getText()).toBe(text);
      }
      for (const text of ["原有手打", "原有手打粘贴", "原有手打粘贴后打"]) {
        act(() => {
          editor.commands.redo();
        });
        expect(editor.getText()).toBe(text);
      }
    },
  );

  test.each(["math", "chemistry"])(
    "restores the editor selection after canceling the %s window",
    async (kind) => {
      const commandBus = new EditorCommandBus();
      const document = documentWithText("公式取消焦点", "原有文字");
      render(
        <RichTextEditorCore
          editorId="formula-cancel-focus"
          title={document.title}
          document={document}
          commandBus={commandBus}
          capabilities={{
            headings: true,
            lists: true,
            tables: true,
            formulas: true,
            chemistry: true,
            chemicalStructures: true,
            images: false,
            pageBreaks: true,
          }}
          toTiptap={canonicalToTiptap}
          fromTiptap={tiptapToCanonical}
          onDocumentChange={vi.fn()}
        />,
      );
      await waitFor(() => expect(commandBus.has("formula-cancel-focus")).toBe(true));
      act(() => {
        commandBus.restoreSelection("formula-cancel-focus", { from: 2, to: 3 });
      });
      await waitFor(() =>
        expect(globalThis.document.activeElement).toBe(
          screen.getByRole("textbox", { name: "编辑 公式取消焦点" }),
        ),
      );
      act(() => {
        if (kind === "math") commandBus.openFormulaEditor("formula-cancel-focus");
        else commandBus.openChemistryEditor("formula-cancel-focus");
      });
      const dialog = await screen.findByRole("dialog", {
        name: kind === "math" ? "插入数学公式" : "插入化学方程式",
      });
      const cancel = Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent === "取消",
      );
      if (!cancel) throw new Error("缺少取消按钮");
      // In the real window the close control owns focus, not the editor.
      cancel.focus();
      fireEvent.click(cancel);
      await waitFor(() =>
        expect(globalThis.document.activeElement).toBe(
          screen.getByRole("textbox", { name: "编辑 公式取消焦点" }),
        ),
      );
      expect(commandBus.captureSelection("formula-cancel-focus")).toEqual({ from: 2, to: 3 });
    },
  );

  test("preserves boundary spaces from an internal ProseMirror HTML copy", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithText("内部空格粘贴", "前后");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="internal-whitespace-paste-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    act(() => editor.commands.setTextSelection(2));
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 内部空格粘贴" }), {
      clipboardData: {
        files: [],
        getData: vi.fn((type: string) =>
          type === "text/html"
            ? '<p data-pm-slice="1 1 []"> 复制内容 </p>'
            : type === "text/plain"
              ? " 复制内容 "
              : "",
        ),
      },
    });

    await waitFor(() => expect(editor.getText()).toBe("前 复制内容 后"));
  });

  test.each(
    ["plain", "html"].flatMap((format) =>
      ["粘贴文字", "第一段\n第二段", "第一段\n"].flatMap((text) =>
        [null, "", "后文"].map((following) => ({ format, text, following })),
      ),
    ),
  )(
    "keeps the paste caret at the inserted end: $format / $text / $following",
    async ({ format, text, following }) => {
      const commandBus = new EditorCommandBus();
      const document = createBlankDocument("空行粘贴光标");
      const registeredEditor: { current?: Editor } = {};
      const register = commandBus.register.bind(commandBus);
      vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
        registeredEditor.current = editor;
        return register(id, editor, ...rest);
      });
      render(
        <RichTextEditorCore
          editorId="empty-paste-caret-core"
          title={document.title}
          document={document}
          commandBus={commandBus}
          capabilities={{
            headings: true,
            lists: true,
            tables: true,
            formulas: true,
            chemistry: true,
            chemicalStructures: true,
            images: false,
            pageBreaks: true,
          }}
          toTiptap={canonicalToTiptap}
          fromTiptap={tiptapToCanonical}
          onDocumentChange={vi.fn()}
        />,
      );
      await waitFor(() => expect(registeredEditor.current).toBeDefined());
      const editor = registeredEditor.current;
      if (!editor) throw new Error("编辑器未注册");
      const paragraph = (value: string) => ({
        type: "paragraph",
        content: value ? [{ type: "text", text: value }] : [],
      });
      act(() => {
        editor.commands.setContent({
          type: "doc",
          content: [
            paragraph("前文"),
            paragraph(""),
            ...(following === null ? [] : [paragraph(following)]),
          ],
        });
        editor.commands.setTextSelection(5);
      });
      const lines = text.split("\n");
      fireEvent.paste(screen.getByRole("textbox", { name: "编辑 空行粘贴光标" }), {
        clipboardData: {
          files: [],
          getData: (type: string) =>
            type === "text/plain"
              ? text
              : type === "text/html" && format === "html"
                ? lines.map((line) => `<p style="text-align:center">${line}</p>`).join("")
                : "",
        },
      });
      const last = lines.at(-1) ?? "";
      const expected = ["前文", ...lines, ...(following === null ? [] : [following])];
      expect(editor.state.selection.empty).toBe(true);
      expect(editor.state.selection.$from.index(0)).toBe(lines.length);
      expect(editor.state.selection.$from.parent.textContent).toBe(last);
      expect(editor.state.selection.$from.parentOffset).toBe(last.length);
      act(() => {
        editor.commands.insertContent("继续");
      });
      expected[lines.length] += "继续";
      expect(
        Array.from(
          { length: editor.state.doc.childCount },
          (_, index) => editor.state.doc.child(index).textContent,
        ),
      ).toEqual(expected);
      if (format === "html") {
        expect(editor.state.doc.child(1).attrs.textAlign).toBe("center");
      }
    },
  );

  test("preserves pasted paragraph alignment in an empty editor", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("空白页段落格式");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="empty-html-alignment-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 空白页段落格式" }), {
      clipboardData: {
        files: [],
        getData: vi.fn((type: string) =>
          type === "text/html"
            ? '<p style="text-align:center">标题</p><p style="text-align:justify">正文</p>'
            : type === "text/plain"
              ? "标题\n正文"
              : "",
        ),
      },
    });

    await waitFor(() => expect(editor.getJSON().content).toHaveLength(2));
    expect(editor.getJSON().content?.[0]?.attrs).toMatchObject({ textAlign: "center" });
    expect(editor.getJSON().content?.[1]?.attrs).toMatchObject({ textAlign: "justify" });
  });

  test("keeps full-width and half-width leading spaces unchanged on plain-text paste", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("附图说明缩进粘贴");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="drawing-explanation-indent-paste-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 附图说明缩进粘贴" }), {
      clipboardData: {
        files: [],
        getData: vi.fn((type: string) =>
          type === "text/plain"
            ? "　　图1为本发明的结构示意图。\n    图2为本发明的流程示意图。\t附注\n      图3为本发明的连接示意图。"
            : "",
        ),
      },
    });

    await waitFor(() => expect(editor.getJSON().content).toHaveLength(3));
    const paragraphs = editor.getJSON().content ?? [];
    expect(
      paragraphs.map((node) =>
        node.content?.map((child) => ("text" in child ? (child.text ?? "") : "")).join(""),
      ),
    ).toEqual([
      "　　图1为本发明的结构示意图。",
      "    图2为本发明的流程示意图。    附注",
      "      图3为本发明的连接示意图。",
    ]);
    expect(paragraphs.map((node) => node.attrs?.paragraphIndentMm)).toEqual([0, 0, 0]);
  });

  test("indents every paragraph pasted as plain text with no leading-space indent", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("纯文本段落缩进");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="plain-text-indent-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 纯文本段落缩进" }), {
      clipboardData: {
        files: [],
        getData: vi.fn((type: string) =>
          type === "text/plain" ? "第一段内容\n第二段内容\n第三段内容" : "",
        ),
      },
    });

    await waitFor(() => expect(editor.getJSON().content).toHaveLength(3));
    const paragraphs = editor.getJSON().content ?? [];
    expect(paragraphs.map((node) => node.attrs?.paragraphIndentMm)).toEqual([
      PATENT_FIRST_LINE_INDENT_MM,
      PATENT_FIRST_LINE_INDENT_MM,
      PATENT_FIRST_LINE_INDENT_MM,
    ]);
  });

  test("indents paragraphs pasted from html that carry no source indent", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("富文本段落缩进");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="html-indent-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 富文本段落缩进" }), {
      clipboardData: {
        files: [],
        getData: vi.fn((type: string) =>
          type === "text/html"
            ? "<div>第一段内容</div><p>第二段内容</p>"
            : type === "text/plain"
              ? "第一段内容\n第二段内容"
              : "",
        ),
      },
    });

    await waitFor(() => expect(editor.getJSON().content).toHaveLength(2));
    const paragraphs = editor.getJSON().content ?? [];
    expect(paragraphs.map((node) => node.attrs?.paragraphIndentMm)).toEqual([
      PATENT_FIRST_LINE_INDENT_MM,
      PATENT_FIRST_LINE_INDENT_MM,
    ]);
  });

  test("disables Markdown-style input rules in the patent editor", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("输入规则");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });

    render(
      <RichTextEditorCore
        editorId="input-rule-editor"
        title="输入规则"
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());

    expect(registeredEditor.current?.options.enableInputRules).toBe(false);
  });

  test("rejects editor content that cannot be converted instead of displaying it as saved", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithText("转换失败", "保留内容");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    const errors: string[] = [];
    const stopListening = onApplicationError((error) => errors.push(error.code));
    const onDocumentChange = vi.fn();
    render(
      <RichTextEditorCore
        editorId="conversion-failure-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    try {
      act(() => {
        editor.commands.setTextSelection(editor.state.doc.content.size);
        editor.view.dispatch(editor.state.tr.insertText("甲"));
      });
      expect(editor.getText()).toBe("保留内容甲");
      expect(onDocumentChange).toHaveBeenCalledOnce();

      act(() => {
        editor.commands.setTextSelection(editor.state.doc.content.size);
        editor.view.dispatch(editor.state.tr.insertText("字".repeat(MAX_TEXT_NODE_CODE_UNITS + 1)));
      });
      expect(editor.getText()).toBe("保留内容甲");
      expect(errors).toEqual(["INVALID_INPUT"]);
      expect(onDocumentChange).toHaveBeenCalledOnce();
      act(() => editor.commands.undo());
      expect(editor.getText()).toBe("保留内容");
      act(() => editor.commands.redo());
      expect(editor.getText()).toBe("保留内容甲");
    } finally {
      stopListening();
    }
  });

  test("keeps valid HTML paste formatting ahead of plain clipboard fallback", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithText("HTML 格式", "原文本");
    const onDocumentChange = vi.fn();
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="html-format-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");
    act(() => editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size }));
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 HTML 格式" }), {
      clipboardData: {
        files: [],
        getData: vi.fn((type: string) =>
          type === "text/html"
            ? '<p><span style="color:#123456;background-color:rgb(255,255,0)">HTML 格式文字</span></p>'
            : type === "text/plain"
              ? "不应采用纯文本"
              : "",
        ),
      },
    });
    await waitFor(() => expect(editor.getText()).toContain("HTML 格式文字"));
    expect(editor.getText()).not.toContain("不应采用纯文本");
    expect(editor.getHTML()).toContain("color: rgb(18, 52, 86)");
    expect(editor.getHTML()).toContain("background-color: rgb(255, 255, 0)");
    await waitFor(() => expect(onDocumentChange).toHaveBeenCalled());
    expect(JSON.stringify(onDocumentChange.mock.lastCall?.[0])).toContain("HTML 格式文字");
  });

  test("does not replace a selection for empty HTML without plain text", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithText("空 HTML", "保留原有文字");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="empty-html-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: false,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");
    const beforeText = editor.getText();
    act(() => editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size }));
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 空 HTML" }), {
      clipboardData: {
        files: [],
        getData: vi.fn((type: string) => (type === "text/html" ? "<script>alert(1)</script>" : "")),
      },
    });
    expect(editor.getText()).toBe(beforeText);
  });

  test("blocks command bus structures that disabled capabilities do not allow", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("受限编辑器");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });

    render(
      <RichTextEditorCore
        editorId="limited-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: false,
          lists: false,
          tables: false,
          formulas: false,
          chemistry: false,
          chemicalStructures: false,
          images: false,
          pageBreaks: false,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    expect(commandBus.execute("limited-core", "bullet-list")).toBe(false);
    expect(commandBus.execute("limited-core", "page-break")).toBe(false);
    expect(commandBus.setParagraphStyle("limited-core", 1)).toBe(false);
    expect(
      commandBus.insertTable("limited-core", {
        rows: 2,
        columns: 2,
        headerRowCount: 0,
        layoutMode: "fit-page",
      }),
    ).toBe(false);
    expect(
      commandBus.insertFigure("limited-core", {
        assetId: "00000000-0000-4000-8000-000000000340",
        kind: "image",
        originalName: "blocked.png",
        mediaType: "image/png",
        extension: "png",
        byteLength: 1,
        sha256: "A".repeat(64),
        widthPx: 1,
        heightPx: 1,
        previewByteLength: 1,
        previewSha256: "B".repeat(64),
      }),
    ).toBe(false);
    expect(commandBus.openFormulaEditor("limited-core")).toBe(false);
    expect(commandBus.openChemistryEditor("limited-core")).toBe(false);

    const textbox = screen.getByRole("textbox", { name: "编辑 受限编辑器" });
    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: vi
          .fn()
          .mockReturnValue(
            "<h1>标题</h1><ul><li>项目</li></ul><table><tr><td>单元格</td></tr></table>",
          ),
      },
    });
    await waitFor(() => expect(registeredEditor.current?.getText()).toContain("单元格"));
    expect(
      registeredEditor.current
        ?.getJSON()
        .content?.some((node) =>
          ["heading", "bulletList", "orderedList", "table"].includes(node.type ?? ""),
        ),
    ).toBe(false);

    fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });
    expect(
      registeredEditor.current?.getJSON().content?.some((node) => node.type === "pageBreak"),
    ).toBe(false);
  });

  test("opens one chemistry dialog for repeated active-editor requests", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("化学公式");

    render(
      <RichTextEditorCore
        editorId="chemistry-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: false,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(commandBus.has("chemistry-core")).toBe(true));
    act(() => {
      expect(commandBus.openChemistryEditor("chemistry-core")).toBe(true);
      expect(commandBus.openChemistryEditor("chemistry-core")).toBe(true);
    });

    expect(await screen.findAllByRole("dialog", { name: "插入化学方程式" })).toHaveLength(1);
    expect(screen.queryByRole("tab", { name: "化学结构式" })).toBeNull();
    expect(screen.getByText("当前书册暂不支持化学结构式。")).toBeDefined();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "编辑 化学公式" }), {
      key: "f",
      ctrlKey: true,
    });
    expect(screen.queryByRole("search", { name: "查找和替换" })).toBeNull();
  });

  test("keeps mathematical and chemical editors open together", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("科学公式并存");

    render(
      <RichTextEditorCore
        editorId="coexisting-scientific-editors"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(commandBus.has("coexisting-scientific-editors")).toBe(true));
    act(() => expect(commandBus.openFormulaEditor("coexisting-scientific-editors")).toBe(true));
    const mathField = (await screen.findByRole("textbox", {
      name: "可视公式编辑器",
    })) as HTMLElement & { value: string };
    mathField.value = "x^2";
    fireEvent.input(mathField);

    act(() => expect(commandBus.openChemistryEditor("coexisting-scientific-editors")).toBe(true));

    const mathDialog = mathField.closest<HTMLElement>('[role="dialog"]');
    expect(mathDialog?.parentElement?.hidden).toBe(false);
    const chemistryDialog = screen.getByRole("dialog", { name: "插入化学方程式" });
    expect(chemistryDialog).toBeDefined();
    expect(mathField.value).toBe("x^2");

    const cancelButton = Array.from(chemistryDialog.querySelectorAll("button")).find(
      (button) => button.textContent === "取消",
    );
    if (!cancelButton) throw new Error("缺少化学弹窗取消按钮");
    fireEvent.click(cancelButton);

    expect(mathDialog?.parentElement?.hidden).toBe(false);
    expect(mathField.value).toBe("x^2");
  });

  test.each(["table", "list"])(
    "keeps a %s intact when inserting a block structure",
    async (container) => {
      const bus = new EditorCommandBus();
      const document = createBlankDocument("结构式容器保护");
      const addImageAsset = vi.fn((current: CanonicalDocument, descriptor: AssetDescriptor) => ({
        ...current,
        assets: [...current.assets, descriptor],
      }));
      Object.defineProperty(window, "patentApi", {
        configurable: true,
        value: {
          chemistry: {
            rasterizePreview: vi.fn().mockResolvedValue({
              ok: true,
              value: { descriptor: previewDescriptor, preview: Uint8Array.from([137, 80, 78, 71]) },
            }),
          },
        },
      });
      render(
        <RichTextEditorCore
          editorId="structure-container"
          title={document.title}
          document={document}
          commandBus={bus}
          capabilities={{
            headings: true,
            lists: true,
            tables: true,
            formulas: true,
            chemistry: true,
            chemicalStructures: true,
            images: true,
            pageBreaks: true,
          }}
          addImageAsset={addImageAsset}
          toTiptap={canonicalToTiptap}
          fromTiptap={tiptapToCanonical}
          onDocumentChange={vi.fn()}
        />,
      );
      await waitFor(() => expect(bus.getEditor("structure-container")).toBeDefined());
      const editor = bus.getEditor("structure-container");
      if (!editor) throw new Error("Missing editor");
      act(() => {
        editor.commands.setContent(
          container === "table"
            ? "<table><tr><td><p>前后</p></td><td><p>保留</p></td></tr></table>"
            : "<ul><li><p>前后</p></li><li><p>保留</p></li></ul>",
        );
        editor.commands.setTextSelection(4);
        bus.openChemistryEditor("structure-container", "structure");
      });
      await screen.findByRole("tabpanel", { name: "化学结构式" });
      const before = editor.getJSON();
      const insert = await screen.findByRole("button", { name: "插入" });
      await waitFor(() => expect((insert as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(insert);
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("失败"));
      expect(editor.getJSON()).toEqual(before);
      expect(addImageAsset).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "插入化学结构式" })).toBeDefined();
    },
  );

  test("keeps chemical structures available when the editor has asset interfaces", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("普通文档化学公式");

    render(
      <RichTextEditorCore
        editorId="chemistry-with-assets"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        importImage={vi.fn()}
        addImageAsset={(current) => current}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(commandBus.has("chemistry-with-assets")).toBe(true));
    act(() => expect(commandBus.openChemistryEditor("chemistry-with-assets")).toBe(true));

    act(() =>
      expect(commandBus.openChemistryEditor("chemistry-with-assets", "structure")).toBe(true),
    );
    expect(await screen.findByRole("tabpanel", { name: "化学结构式" })).toBeDefined();
  });

  test("inserts a chemistry equation after StrictMode development probing", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("严格模式化学方程式");

    render(
      <StrictMode>
        <RichTextEditorCore
          editorId="strict-chemistry-equation"
          title={document.title}
          document={document}
          commandBus={commandBus}
          capabilities={{
            headings: true,
            lists: true,
            tables: true,
            formulas: true,
            chemistry: true,
            chemicalStructures: true,
            images: true,
            pageBreaks: true,
          }}
          toTiptap={canonicalToTiptap}
          fromTiptap={tiptapToCanonical}
          onDocumentChange={vi.fn()}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(commandBus.has("strict-chemistry-equation")).toBe(true));
    act(() => expect(commandBus.openChemistryEditor("strict-chemistry-equation")).toBe(true));
    const field = (await screen.findByRole("textbox", {
      name: "化学方程式编辑器",
    })) as HTMLElement & { value: string };
    field.value = "H2O";
    fireEvent.input(field);
    await userEvent.setup().click(screen.getByRole("button", { name: "插入" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "插入化学方程式" })).toBeNull();
      expect(
        screen
          .getByRole("textbox", { name: "编辑 严格模式化学方程式" })
          .querySelector("[data-type='inline-math'][data-latex='\\\\ce{H2O}']"),
      ).not.toBeNull();
    });
  });

  test("reopens an inserted chemical equation in the chemistry editor", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("化学方程式路由");
    const registered: { editor?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registered.editor = editor;
      return register(id, editor, ...rest);
    });

    render(
      <RichTextEditorCore
        editorId="chemistry-equation-route"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(commandBus.has("chemistry-equation-route")).toBe(true));
    act(() => expect(commandBus.openChemistryEditor("chemistry-equation-route")).toBe(true));
    const field = (await screen.findByRole("textbox", {
      name: "化学方程式编辑器",
    })) as HTMLElement & {
      value: string;
    };
    field.value = "H2 + O2 -> H2O";
    fireEvent.input(field);
    fireEvent.click(screen.getByRole("button", { name: "插入" }));

    const source = String.raw`\ce{H2 + O2 -> H2O}`;
    const chemistryFormula = await waitFor(() => {
      const node = Array.from(
        screen
          .getByRole("textbox", { name: "编辑 化学方程式路由" })
          .querySelectorAll("[data-type='inline-math']"),
      ).find((candidate) => candidate.getAttribute("data-latex") === source);
      if (!node) throw new Error("插入的化学方程式未渲染");
      return node;
    });
    expect(registered.editor?.getJSON()).toMatchObject({
      content: [{ content: [{ attrs: { formulaKind: "chemistry", latex: source } }] }],
    });

    fireEvent.doubleClick(chemistryFormula, { detail: 2 });
    expect(await screen.findByRole("dialog", { name: "编辑化学方程式" })).toBeDefined();
  });

  test.each([
    [
      "completes without switching",
      true,
      async (
        _bus: EditorCommandBus,
        _editorId: string,
        _user: ReturnType<typeof userEvent.setup>,
      ) => true,
    ],
    [
      "opens math formula",
      true,
      (bus: EditorCommandBus, editorId: string, _user: ReturnType<typeof userEvent.setup>) =>
        bus.openFormulaEditor(editorId),
    ],
    [
      "opens a new chemistry equation",
      false,
      (bus: EditorCommandBus, editorId: string, _user: ReturnType<typeof userEvent.setup>) =>
        bus.openChemistryEditor(editorId),
    ],
    [
      "switches to the chemistry equation tab",
      false,
      async (
        _bus: EditorCommandBus,
        _editorId: string,
        user: ReturnType<typeof userEvent.setup>,
      ) => {
        _bus.openChemistryEditor(_editorId, "equation");
        return true;
      },
    ],
    [
      "closes the chemistry dialog",
      false,
      async (
        _bus: EditorCommandBus,
        _editorId: string,
        user: ReturnType<typeof userEvent.setup>,
      ) => {
        await user.click(screen.getByRole("button", { name: "关闭" }));
        return true;
      },
    ],
  ])(
    "handles a slow structure preview confirmation when it %s",
    async (_actionName, shouldCommit, interrupt) => {
      const user = userEvent.setup();
      const commandBus = new EditorCommandBus();
      const document = createBlankDocument("慢速结构式");
      const pendingRasterize = deferred<{
        ok: true;
        value: { descriptor: typeof previewDescriptor; preview: Uint8Array };
      }>();
      const rasterizePreview = vi.fn(() => pendingRasterize.promise);
      const addImageAsset = vi.fn(
        (current: CanonicalDocument, descriptor: typeof previewDescriptor) => ({
          ...current,
          assets: [...current.assets, descriptor],
        }),
      );
      const onDocumentChange = vi.fn();
      const registered: { current?: Editor } = {};
      const register = commandBus.register.bind(commandBus);
      vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
        registered.current = editor;
        return register(id, editor, ...rest);
      });
      Object.defineProperty(window, "patentApi", {
        configurable: true,
        value: {
          chemistry: { rasterizePreview },
          assets: { getPreview: vi.fn().mockResolvedValue({ ok: false }) },
        },
      });

      render(
        <RichTextEditorCore
          editorId="slow-structure"
          title={document.title}
          document={document}
          commandBus={commandBus}
          capabilities={{
            headings: true,
            lists: true,
            tables: true,
            formulas: true,
            chemistry: true,
            chemicalStructures: true,
            images: true,
            pageBreaks: true,
          }}
          addImageAsset={addImageAsset}
          toTiptap={canonicalToTiptap}
          fromTiptap={tiptapToCanonical}
          onDocumentChange={onDocumentChange}
        />,
      );

      await waitFor(() => expect(commandBus.has("slow-structure")).toBe(true));
      act(() => expect(commandBus.openChemistryEditor("slow-structure", "structure")).toBe(true));
      await screen.findByRole("tabpanel", { name: "化学结构式" });
      const insert = screen.getByRole("button", { name: "插入" }) as HTMLButtonElement;
      await waitFor(() => expect(insert.disabled).toBe(false));
      await user.click(insert);
      await waitFor(() => expect(rasterizePreview).toHaveBeenCalledOnce());
      const registeredEditor = registered.current;
      if (!registeredEditor) throw new Error("编辑器未注册");
      const dispatch = vi.spyOn(registeredEditor.view, "dispatch");

      await act(async () => expect(await interrupt(commandBus, "slow-structure", user)).toBe(true));
      await act(async () => {
        pendingRasterize.resolve({
          ok: true,
          value: { descriptor: previewDescriptor, preview: Uint8Array.from([137, 80, 78, 71]) },
        });
        await pendingRasterize.promise;
      });

      if (shouldCommit) {
        expect(addImageAsset).toHaveBeenCalledWith(document, previewDescriptor);
        expect(dispatch).toHaveBeenCalled();
        await waitFor(() =>
          expect(
            onDocumentChange.mock.calls
              .at(-1)
              ?.at(0)
              .content.some((node: { type: string }) => node.type === "chemical-structure"),
          ).toBe(true),
        );
      } else {
        expect(addImageAsset).not.toHaveBeenCalled();
        // Closing now restores focus; it must still never insert the late preview.
        expect(dispatch.mock.calls.some(([transaction]) => transaction.docChanged)).toBe(false);
      }
    },
  );

  test("synchronizes an external document change without emitting an edit loop", async () => {
    const commandBus = new EditorCommandBus();
    const first = createBlankDocument("初始");
    const firstParagraph = first.content[0];
    if (firstParagraph?.type !== "paragraph") throw new Error("缺少初始段落");
    const second = {
      ...first,
      title: "同步后",
      content: [
        { ...firstParagraph, content: [{ type: "text" as const, text: "外部内容", marks: [] }] },
      ],
    };
    const onDocumentChange = vi.fn();
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    const { rerender } = render(
      <RichTextEditorCore
        editorId="core-test"
        title={first.title}
        document={first}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const registered = registeredEditor.current;
    if (!registered) throw new Error("编辑器未注册");
    const dispatch = vi.spyOn(registered.view, "dispatch");
    rerender(
      <RichTextEditorCore
        editorId="core-test"
        title={second.title}
        document={second}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(registeredEditor.current?.getText()).toBe("外部内容"));
    const replacement = dispatch.mock.calls[0]?.[0];
    expect(replacement?.getMeta("addToHistory")).toBe(false);
    expect(replacement?.getMeta("preventUpdate")).toBe(true);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(registered.commands.undo()).toBe(false);
    expect(registered.getText()).toBe("外部内容");
  });

  test("starts a new undo group after a prop-driven document replacement", async () => {
    const commandBus = new EditorCommandBus();
    const first = documentWithText("分组边界", "前");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    let latestDocument = first;
    const onDocumentChange = vi.fn((next: CanonicalDocument) => {
      latestDocument = next;
    });
    const capabilities = {
      headings: true,
      lists: true,
      tables: true,
      formulas: true,
      chemistry: true,
      chemicalStructures: true,
      images: true,
      pageBreaks: true,
    };
    const { rerender } = render(
      <RichTextEditorCore
        editorId="history-boundary-core"
        title={first.title}
        document={first}
        commandBus={commandBus}
        capabilities={capabilities}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size);
      editor.view.dispatch(editor.state.tr.insertText("甲"));
    });
    const paragraph = latestDocument.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("缺少正文段落");
    const external = {
      ...latestDocument,
      content: [
        {
          ...paragraph,
          content: [{ type: "text" as const, text: "前甲外", marks: [] }],
        },
      ],
    };
    rerender(
      <RichTextEditorCore
        editorId="history-boundary-core"
        title={external.title}
        document={external}
        commandBus={commandBus}
        capabilities={capabilities}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(editor.getText()).toBe("前甲外"));

    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size);
      editor.view.dispatch(editor.state.tr.insertText("乙"));
    });
    expect(editor.getText()).toBe("前甲外乙");
    act(() => expect(editor.commands.undo()).toBe(true));
    expect(editor.getText()).toBe("前甲外");
    act(() => expect(editor.commands.undo()).toBe(true));
    expect(editor.getText()).toBe("前外");
  });

  test("keeps the caret in place when a canonical local echo is rendered back", async () => {
    const commandBus = new EditorCommandBus();
    const first = documentWithText("光标测试", "前后");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    let latestDocument = first;
    const onDocumentChange = vi.fn((next: CanonicalDocument) => {
      latestDocument = next;
    });
    const { rerender } = render(
      <RichTextEditorCore
        editorId="caret-core"
        title={first.title}
        document={first}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");
    const dispatch = vi.spyOn(editor.view, "dispatch");

    act(() => {
      editor.commands.setTextSelection(2);
      editor.view.dispatch(editor.state.tr.insertText("甲"));
    });
    const dispatchCountBeforeEcho = dispatch.mock.calls.length;
    rerender(
      <RichTextEditorCore
        editorId="caret-core"
        title={latestDocument.title}
        document={latestDocument}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    expect(dispatch).toHaveBeenCalledTimes(dispatchCountBeforeEcho);
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText("乙"));
    });

    expect(editor.getText()).toBe("前甲乙后");
  });

  test("applies an external undo that returns to a previously emitted local document", async () => {
    const commandBus = new EditorCommandBus();
    const first = documentWithText("标号撤销", "箱体");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    let latestDocument = first;
    const onDocumentChange = vi.fn((next: CanonicalDocument) => {
      latestDocument = next;
    });
    const capabilities = {
      headings: true,
      lists: true,
      tables: true,
      formulas: true,
      chemistry: true,
      chemicalStructures: true,
      images: true,
      pageBreaks: true,
    };
    const { rerender } = render(
      <RichTextEditorCore
        editorId="reference-undo-core"
        title={first.title}
        document={first}
        commandBus={commandBus}
        capabilities={capabilities}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size);
      editor.view.dispatch(editor.state.tr.insertText("甲"));
    });
    const beforeReferenceNumber = structuredClone(latestDocument);
    rerender(
      <RichTextEditorCore
        editorId="reference-undo-core"
        title={beforeReferenceNumber.title}
        document={beforeReferenceNumber}
        commandBus={commandBus}
        capabilities={capabilities}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );

    const paragraph = beforeReferenceNumber.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("缺少正文段落");
    const numbered = {
      ...beforeReferenceNumber,
      content: [
        {
          ...paragraph,
          content: [
            {
              type: "text" as const,
              text: "箱体甲(1)",
              marks: [{ type: "background-color" as const, value: "#FFF1A8" }],
            },
          ],
        },
      ],
    };
    rerender(
      <RichTextEditorCore
        editorId="reference-undo-core"
        title={numbered.title}
        document={numbered}
        commandBus={commandBus}
        capabilities={capabilities}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );
    await waitFor(() => expect(editor.getText()).toBe("箱体甲(1)"));

    rerender(
      <RichTextEditorCore
        editorId="reference-undo-core"
        title={beforeReferenceNumber.title}
        document={beforeReferenceNumber}
        commandBus={commandBus}
        capabilities={capabilities}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={onDocumentChange}
      />,
    );

    await waitFor(() => expect(editor.getText()).toBe("箱体甲"));
  });

  test("keeps superscript and subscript active for text typed after toggling at the caret", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithText("上下标输入", "H");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });

    render(
      <RichTextEditorCore
        editorId="script-input-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    act(() => {
      editor.commands.setTextSelection(2);
      commandBus.execute("script-input-core", "superscript");
    });
    expect(commandBus.getFormatState("script-input-core").superscript).toBe(true);
    act(() => {
      editor.commands.insertContent("2");
      commandBus.execute("script-input-core", "superscript");
      editor.commands.insertContent("O");
      commandBus.execute("script-input-core", "subscript");
    });
    expect(commandBus.getFormatState("script-input-core").subscript).toBe(true);
    act(() => {
      editor.commands.insertContent("2");
    });

    const textNodes = editor.getJSON().content?.[0]?.content ?? [];
    expect(textNodes).toEqual([
      expect.objectContaining({ text: "H" }),
      expect.objectContaining({
        text: "2",
        marks: [expect.objectContaining({ type: "superscript" })],
      }),
      expect.objectContaining({ text: "O" }),
      expect.objectContaining({
        text: "2",
        marks: [expect.objectContaining({ type: "subscript" })],
      }),
    ]);
  });

  test("copies a continuous text-and-image selection with rendered image placeholders", async () => {
    const commandBus = new EditorCommandBus();
    const copyImages = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const assetId = "00000000-0000-4000-8000-000000000711";
    const descriptor = {
      assetId,
      kind: "image" as const,
      originalName: "夹具.png",
      mediaType: "image/png" as const,
      extension: "png" as const,
      byteLength: 4,
      sha256: "C".repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 4,
      previewSha256: "D".repeat(64),
    };
    const document = createBlankDocument("图文复制");
    const paragraph = document.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("缺少段落");
    document.assets = [descriptor];
    paragraph.content = [
      { type: "text", text: "前", marks: [] },
      {
        id: "00000000-0000-4000-8000-000000000712",
        type: "inline-figure",
        assetId,
        widthMm: 30,
        alignment: "center",
        rotationDeg: 90,
      },
      { type: "text", text: "后", marks: [] },
    ];
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          copyImages,
          getPreview: vi.fn().mockResolvedValue({ ok: true, value: Uint8Array.from([1]) }),
        },
      },
    });

    render(
      <RichTextEditorCore
        editorId="mixed-image-copy"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");
    act(() => editor.commands.selectAll());

    fireEvent.copy(screen.getByRole("textbox", { name: "编辑 图文复制" }), {
      clipboardData: {
        clearData: vi.fn(),
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(""),
      },
    });

    await waitFor(() => expect(copyImages).toHaveBeenCalledOnce());
    expect(copyImages).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "mixed-image-copy",
        images: [
          {
            assetId,
            rotationDeg: 90,
            layout: "inline",
            widthMm: 30,
            alignment: "center",
            label: "图片1",
          },
        ],
        htmlTemplate: expect.stringContaining("\uE020PIMG0\uE021"),
        text: "前后",
      }),
    );
  });

  test("copies and pastes a continuous selection containing a chemical structure and an image", async () => {
    const chemicalAssetId = "00000000-0000-4000-8000-000000000721";
    const imageAssetId = "00000000-0000-4000-8000-000000000722";
    const chemicalDescriptor = { ...previewDescriptor, assetId: chemicalAssetId };
    const imageDescriptor: AssetDescriptor = {
      assetId: imageAssetId,
      kind: "image",
      originalName: "普通图片.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: 4,
      sha256: "C".repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 4,
      previewSha256: "D".repeat(64),
    };
    const baseDocument = createBlankDocument("结构式与图片复制");
    const trailingParagraph = baseDocument.content[0];
    if (!trailingParagraph) throw new Error("缺少末尾段落");
    const document: CanonicalDocument = {
      ...baseDocument,
      assets: [chemicalDescriptor, imageDescriptor],
      content: [
        {
          id: "00000000-0000-4000-8000-000000000723",
          type: "chemical-structure",
          ketSource: "(ket) (atom C)",
          previewAssetId: chemicalAssetId,
          widthMm: 50,
          alignment: "center",
        },
        {
          id: "00000000-0000-4000-8000-000000000724",
          type: "figure",
          assetId: imageAssetId,
          widthMm: 40,
          alignment: "center",
          rotationDeg: 0,
        },
        trailingParagraph,
      ],
    };
    const commandBus = new EditorCommandBus();
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          copyImages: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
          getPreview: vi.fn().mockResolvedValue({ ok: true, value: Uint8Array.from([1]) }),
        },
      },
    });
    render(
      <RichTextEditorCore
        editorId="chemical-image-copy"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        addImageAsset={(current: CanonicalDocument, asset: AssetDescriptor) => ({
          ...current,
          assets: current.assets.some((item) => item.assetId === asset.assetId)
            ? current.assets
            : [...current.assets, asset],
        })}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    const editor = await waitFor(() => {
      const current = commandBus.getEditor("chemical-image-copy");
      expect(current).toBeDefined();
      return current as Editor;
    });
    const clipboard = new Map<string, string>();
    const clipboardData = {
      files: [],
      clearData: vi.fn(() => clipboard.clear()),
      setData: vi.fn((type: string, value: string) => clipboard.set(type, value)),
      getData: vi.fn((type: string) => clipboard.get(type) ?? ""),
    };
    const textbox = screen.getByRole("textbox", { name: "编辑 结构式与图片复制" });

    act(() => editor.commands.selectAll());
    fireEvent.copy(textbox, { clipboardData });
    expect(window.patentApi.assets.copyImages).toHaveBeenCalledWith(
      expect.objectContaining({
        images: expect.arrayContaining([
          expect.objectContaining({
            chemicalStructure: expect.objectContaining({ ketSource: "(ket) (atom C)" }),
          }),
        ]),
      }),
    );
    expectStructurePasteKeepsContainers(editor, textbox, clipboardData);
    act(() =>
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc))),
    );
    fireEvent.paste(textbox, { clipboardData });

    await waitFor(() => {
      const content = editor.getJSON().content ?? [];
      expect(content.filter((node) => node.type === "chemicalStructure")).toHaveLength(2);
      expect(content.filter((node) => node.type === "figure")).toHaveLength(2);
    });
  });

  test("blocks copying more than 100 selected images into the internal clipboard", async () => {
    const assetId = "00000000-0000-4000-8000-000000000725";
    const descriptor: AssetDescriptor = {
      assetId,
      kind: "image",
      originalName: "重复图片.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: 4,
      sha256: "E".repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 4,
      previewSha256: "F".repeat(64),
    };
    const baseDocument = createBlankDocument("超量图片复制");
    const document: CanonicalDocument = {
      ...baseDocument,
      assets: [descriptor],
      content: Array.from({ length: 101 }, () => ({
        id: crypto.randomUUID(),
        type: "figure" as const,
        assetId,
        widthMm: 40,
        alignment: "center" as const,
        rotationDeg: 0 as const,
      })),
    };
    const commandBus = new EditorCommandBus();
    const copyImages = vi.fn();
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          copyImages,
          getPreview: vi.fn().mockResolvedValue({ ok: true, value: Uint8Array.from([1]) }),
        },
      },
    });
    const errors: string[] = [];
    const stopListening = onApplicationError((error) => errors.push(error.code));

    try {
      render(
        <RichTextEditorCore
          editorId="image-count-copy"
          title={document.title}
          document={document}
          commandBus={commandBus}
          capabilities={{
            headings: true,
            lists: true,
            tables: true,
            formulas: true,
            chemistry: true,
            images: true,
            pageBreaks: true,
          }}
          toTiptap={canonicalToTiptap}
          fromTiptap={tiptapToCanonical}
          onDocumentChange={vi.fn()}
        />,
      );
      const editor = await waitFor(() => {
        const current = commandBus.getEditor("image-count-copy");
        expect(current).toBeDefined();
        return current as Editor;
      });
      act(() => editor.commands.selectAll());
      fireEvent.copy(screen.getByRole("textbox", { name: "编辑 超量图片复制" }), {
        clipboardData: { clearData: vi.fn(), setData: vi.fn() },
      });

      expect(errors).toContain("IMAGE_IMPORT_LIMIT");
      expect(copyImages).not.toHaveBeenCalled();
    } finally {
      stopListening();
    }
  });

  test("pastes an internal image selection before the asynchronous system clipboard write finishes", async () => {
    const commandBus = new EditorCommandBus();
    const copyImages = vi.fn(() => new Promise(() => undefined));
    const assetId = "00000000-0000-4000-8000-000000000713";
    const descriptor = {
      assetId,
      kind: "image" as const,
      originalName: "立即粘贴.png",
      mediaType: "image/png" as const,
      extension: "png" as const,
      byteLength: 4,
      sha256: "A".repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 4,
      previewSha256: "B".repeat(64),
    };
    const document = createBlankDocument("图片立即粘贴");
    const paragraph = document.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("缺少段落");
    document.assets = [descriptor];
    paragraph.content = [
      { type: "text", text: "前", marks: [] },
      {
        id: "00000000-0000-4000-8000-000000000714",
        type: "inline-figure",
        assetId,
        widthMm: 30,
        alignment: "center",
        rotationDeg: 90,
      },
      { type: "text", text: "后", marks: [] },
    ];
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          copyImages,
          getPreview: vi.fn().mockResolvedValue({ ok: true, value: Uint8Array.from([1]) }),
        },
      },
    });
    render(
      <RichTextEditorCore
        editorId="immediate-image-paste"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        addImageAsset={(current: CanonicalDocument, asset) => ({
          ...current,
          assets: current.assets.some(({ assetId: currentId }) => currentId === asset.assetId)
            ? current.assets
            : [...current.assets, asset],
        })}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");
    const clipboard = new Map<string, string>();
    const clipboardData = {
      files: [],
      clearData: vi.fn(() => clipboard.clear()),
      setData: vi.fn((type: string, value: string) => clipboard.set(type, value)),
      getData: vi.fn((type: string) => clipboard.get(type) ?? ""),
    };

    act(() => editor.commands.selectAll());
    fireEvent.copy(screen.getByRole("textbox", { name: "编辑 图片立即粘贴" }), {
      clipboardData,
    });
    act(() => editor.commands.setTextSelection(editor.state.doc.content.size));
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 图片立即粘贴" }), {
      clipboardData,
    });

    await waitFor(() => {
      const content = editor.getJSON().content?.[0]?.content ?? [];
      expect(content.filter((node) => node.type === "inlineFigure")).toHaveLength(2);
      expect(editor.getText()).toBe("前后前后");
    });
  });

  test("stages an internal image selection before pasting it into another patent session", async () => {
    const sourceSessionId = "00000000-0000-4000-8000-000000000715";
    const targetSessionId = "00000000-0000-4000-8000-000000000716";
    const assetId = "00000000-0000-4000-8000-000000000717";
    const descriptor = {
      assetId,
      kind: "image" as const,
      originalName: "跨专利复制.png",
      mediaType: "image/png" as const,
      extension: "png" as const,
      byteLength: 4,
      sha256: "C".repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 4,
      previewSha256: "D".repeat(64),
    };
    const sourceDocument = createBlankDocument("跨专利复制来源");
    const sourceParagraph = sourceDocument.content[0];
    if (sourceParagraph?.type !== "paragraph") throw new Error("缺少段落");
    sourceDocument.assets = [descriptor];
    sourceParagraph.content = [
      { type: "text", text: "前", marks: [] },
      {
        id: "00000000-0000-4000-8000-000000000718",
        type: "inline-figure",
        assetId,
        widthMm: 30,
        alignment: "center",
        rotationDeg: 0,
      },
      { type: "text", text: "后", marks: [] },
    ];
    const copyImages = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const stageReferences = vi.fn().mockResolvedValue({
      ok: true,
      value: [{ descriptor }],
    });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          copyImages,
          stageReferences,
          discardImports: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
          getPreview: vi.fn().mockResolvedValue({ ok: true, value: Uint8Array.from([1]) }),
        },
      },
    });
    const sourceBus = new EditorCommandBus();
    const clipboard = new Map<string, string>();
    const clipboardData = {
      files: [],
      clearData: vi.fn(() => clipboard.clear()),
      setData: vi.fn((type: string, value: string) => clipboard.set(type, value)),
      getData: vi.fn((type: string) => clipboard.get(type) ?? ""),
    };
    const source = render(
      <RichTextEditorCore
        editorId="cross-session-image-source"
        extensionSessionId={sourceSessionId}
        title={sourceDocument.title}
        document={sourceDocument}
        commandBus={sourceBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        addImageAsset={(current: CanonicalDocument, asset) => ({
          ...current,
          assets: [...current.assets, asset],
        })}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(sourceBus.getEditor("cross-session-image-source")).toBeDefined());
    const sourceEditor = sourceBus.getEditor("cross-session-image-source");
    if (!sourceEditor) throw new Error("来源编辑器未注册");
    act(() => sourceEditor.commands.selectAll());
    fireEvent.copy(screen.getByRole("textbox", { name: "编辑 跨专利复制来源" }), {
      clipboardData,
    });
    source.unmount();

    const targetDocument = createBlankDocument("跨专利复制目标");
    const targetBus = new EditorCommandBus();
    render(
      <RichTextEditorCore
        editorId="cross-session-image-target"
        extensionSessionId={targetSessionId}
        title={targetDocument.title}
        document={targetDocument}
        commandBus={targetBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        addImageAsset={(current: CanonicalDocument, asset) => ({
          ...current,
          assets: current.assets.some((currentAsset) => currentAsset.assetId === asset.assetId)
            ? current.assets
            : [...current.assets, asset],
        })}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(targetBus.getEditor("cross-session-image-target")).toBeDefined());
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 跨专利复制目标" }), {
      clipboardData,
    });

    await waitFor(() =>
      expect(
        targetBus
          .getEditor("cross-session-image-target")
          ?.getJSON()
          .content?.[0]?.content?.some((node) => node.type === "inlineFigure"),
      ).toBe(true),
    );
    expect(stageReferences).toHaveBeenCalledWith({
      sourceSessionId,
      targetSessionId,
      operationId: expect.any(String),
      assetIds: [assetId],
    });
  });

  test("imports mixed text and body images in one undoable paste transaction", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("图文粘贴");
    const assetId = "00000000-0000-4000-8000-000000000721";
    const descriptor = {
      assetId,
      kind: "image" as const,
      originalName: "粘贴.png",
      mediaType: "image/png" as const,
      extension: "png" as const,
      byteLength: 4,
      sha256: "E".repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 4,
      previewSha256: "F".repeat(64),
    };
    const importImages = vi.fn().mockResolvedValue({ ok: true, value: [{ descriptor }] } as const);
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });

    render(
      <RichTextEditorCore
        editorId="mixed-image-paste"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          images: true,
          pageBreaks: true,
        }}
        importImages={importImages}
        addImageAsset={(current: CanonicalDocument, asset) => ({
          ...current,
          assets: current.assets.some(({ assetId: currentId }) => currentId === asset.assetId)
            ? current.assets
            : [...current.assets, asset],
        })}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQMBgQlpWQAAAABJRU5ErkJggg==";
    const nativeClipboardImage = new File([Uint8Array.from([9, 8, 7])], "native-image.png", {
      type: "image/png",
    });

    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 图文粘贴" }), {
      clipboardData: {
        files: [nativeClipboardImage],
        getData: (type: string) =>
          type === "text/html"
            ? `<p>甲<img src="data:image/png;base64,${png}" data-patent-image-layout="inline" data-patent-image-width-mm="30" data-patent-image-alignment="right" data-patent-image-rotation-deg="0">乙</p>`
            : "甲乙",
      },
    });

    await waitFor(() =>
      expect(editor.getJSON().content?.[0]?.content).toEqual([
        expect.objectContaining({ type: "text", text: "甲" }),
        expect.objectContaining({
          type: "inlineFigure",
          attrs: expect.objectContaining({
            assetId,
            widthMm: 30,
            alignment: "right",
            rotationDeg: 0,
          }),
        }),
        expect.objectContaining({ type: "text", text: "乙" }),
      ]),
    );
    expect(importImages).toHaveBeenCalledOnce();
    expect(importImages).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          originalName: "clipboard-image-1.png",
          patentImage: expect.objectContaining({ layout: "inline" }),
        }),
      ],
      expect.any(String),
    );

    act(() => expect(editor.commands.undo()).toBe(true));
    expect(editor.getText()).toBe("");
    expect(editor.getJSON().content).toEqual([expect.objectContaining({ type: "paragraph" })]);
  });

  test("reports an image limit error instead of throwing when HTML contains more than 100 images", async () => {
    const commandBus = new EditorCommandBus();
    const document = createBlankDocument("超量图文粘贴");
    const importImages = vi.fn();
    const errors: string[] = [];
    const stopListening = onApplicationError((error) => errors.push(error.code));
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQMBgQlpWQAAAABJRU5ErkJggg==";
    const html = Array.from({ length: 101 }, () => `<img src="data:image/png;base64,${png}">`).join(
      "",
    );

    try {
      render(
        <RichTextEditorCore
          editorId="image-limit-paste"
          title={document.title}
          document={document}
          commandBus={commandBus}
          capabilities={{
            headings: true,
            lists: true,
            tables: true,
            formulas: true,
            chemistry: true,
            images: true,
            pageBreaks: true,
          }}
          importImages={importImages}
          addImageAsset={(current) => current}
          toTiptap={canonicalToTiptap}
          fromTiptap={tiptapToCanonical}
          onDocumentChange={vi.fn()}
        />,
      );

      expect(() =>
        fireEvent.paste(screen.getByRole("textbox", { name: "编辑 超量图文粘贴" }), {
          clipboardData: {
            files: [],
            getData: (type: string) => (type === "text/html" ? html : ""),
          },
        }),
      ).not.toThrow();
      expect(errors).toContain("IMAGE_IMPORT_LIMIT");
      expect(importImages).not.toHaveBeenCalled();
    } finally {
      stopListening();
    }
  });

  test.each(
    ["edit", "close", "destroy"].flatMap((action) =>
      ["html", "file"].map((source) => ({ action, source })),
    ),
  )(
    "discards staged $source images after $action before paste finishes",
    async ({ action, source }) => {
      const commandBus = new EditorCommandBus();
      const document = createBlankDocument("冲突图片回收");
      const descriptor = {
        assetId: "00000000-0000-4000-8000-000000000722",
        kind: "image" as const,
        originalName: "冲突.png",
        mediaType: "image/png" as const,
        extension: "png" as const,
        byteLength: 4,
        sha256: "1".repeat(64),
        widthPx: 120,
        heightPx: 80,
        previewByteLength: 4,
        previewSha256: "2".repeat(64),
      };
      let finishImport:
        | ((result: { ok: true; value: Array<{ descriptor: typeof descriptor }> }) => void)
        | undefined;
      const importImages = vi.fn(
        () =>
          new Promise<{ ok: true; value: Array<{ descriptor: typeof descriptor }> }>((resolve) => {
            finishImport = resolve;
          }),
      );
      const discardImports = vi.fn().mockResolvedValue({ ok: true, value: undefined });
      Object.defineProperty(window, "patentApi", {
        configurable: true,
        value: { assets: { discardImports } },
      });
      const registeredEditor: { current?: Editor } = {};
      const register = commandBus.register.bind(commandBus);
      vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
        registeredEditor.current = editor;
        return register(id, editor, ...rest);
      });
      const rendered = render(
        <RichTextEditorCore
          editorId="conflicted-image-paste"
          extensionSessionId="00000000-0000-4000-8000-000000000723"
          title={document.title}
          document={document}
          commandBus={commandBus}
          capabilities={{
            headings: true,
            lists: true,
            tables: true,
            formulas: true,
            chemistry: true,
            images: true,
            pageBreaks: true,
          }}
          importImages={importImages}
          addImageAsset={(current: CanonicalDocument, asset) => ({
            ...current,
            assets: [...current.assets, asset],
          })}
          toTiptap={canonicalToTiptap}
          fromTiptap={tiptapToCanonical}
          onDocumentChange={vi.fn()}
        />,
      );
      await waitFor(() => expect(registeredEditor.current).toBeDefined());
      const editor = registeredEditor.current;
      if (!editor) throw new Error("编辑器未注册");
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQMBgQlpWQAAAABJRU5ErkJggg==";
      fireEvent.paste(screen.getByRole("textbox", { name: "编辑 冲突图片回收" }), {
        clipboardData: {
          files:
            source === "file"
              ? [
                  {
                    name: "image.png",
                    type: "image/png",
                    size: 4,
                    arrayBuffer: async () => new ArrayBuffer(4),
                  },
                ]
              : [],
          getData: (type: string) =>
            source === "html" && type === "text/html"
              ? `<p><img src="data:image/png;base64,${png}"></p>`
              : "",
        },
      });
      await waitFor(() => expect(importImages).toHaveBeenCalledOnce());
      if (action === "edit") act(() => editor.commands.insertContent("文档已变化"));
      else {
        rendered.unmount();
        if (action === "destroy") editor.destroy();
      }
      finishImport?.({ ok: true, value: [{ descriptor }] });

      await waitFor(() =>
        expect(discardImports).toHaveBeenCalledWith({
          sessionId: "00000000-0000-4000-8000-000000000723",
          operationId: expect.any(String),
          assetIds: [descriptor.assetId],
        }),
      );
      if (action === "edit") expect(editor.getText()).toBe("文档已变化");
    },
  );

  test("keeps subscript and superscript mutually exclusive on the same text", async () => {
    const commandBus = new EditorCommandBus();
    const document = documentWithText("上下标互斥", "H");
    const registeredEditor: { current?: Editor } = {};
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      registeredEditor.current = editor;
      return register(id, editor, ...rest);
    });

    render(
      <RichTextEditorCore
        editorId="script-exclusive-core"
        title={document.title}
        document={document}
        commandBus={commandBus}
        capabilities={{
          headings: true,
          lists: true,
          tables: true,
          formulas: true,
          chemistry: true,
          chemicalStructures: true,
          images: true,
          pageBreaks: true,
        }}
        toTiptap={canonicalToTiptap}
        fromTiptap={tiptapToCanonical}
        onDocumentChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(registeredEditor.current).toBeDefined());
    const editor = registeredEditor.current;
    if (!editor) throw new Error("编辑器未注册");

    // 同一光标处先开下标再开上标：后开的应替换先开的，而不是叠加
    act(() => {
      editor.commands.setTextSelection(2);
      commandBus.execute("script-exclusive-core", "subscript");
    });
    expect(commandBus.getFormatState("script-exclusive-core").subscript).toBe(true);
    expect(commandBus.getFormatState("script-exclusive-core").superscript).toBe(false);
    act(() => {
      commandBus.execute("script-exclusive-core", "superscript");
      editor.commands.insertContent("2");
    });

    const textNodes = editor.getJSON().content?.[0]?.content ?? [];
    expect(textNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "2",
          marks: [expect.objectContaining({ type: "superscript" })],
        }),
      ]),
    );
    expect(textNodes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "2",
          marks: [expect.objectContaining({ type: "subscript" })],
        }),
      ]),
    );
  });
});

test.each([false, true])(
  "incompatible paste waits for confirmation (continue=%s)",
  async (proceed) => {
    const commandBus = new EditorCommandBus();
    const doc = createBlankDocument("混合粘贴确认");
    let activeEditor: Editor | undefined;
    const register = commandBus.register.bind(commandBus);
    vi.spyOn(commandBus, "register").mockImplementation((id, editor, ...rest) => {
      activeEditor = editor;
      return register(id, editor, ...rest);
    });
    render(
      <RichTextEditorCore
        editorId="mixed-paste"
        title={doc.title}
        document={doc}
        commandBus={commandBus}
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
    await waitFor(() => expect(activeEditor).toBeDefined());
    const editor = activeEditor;
    if (!editor) throw new Error("编辑器未注册");
    act(() => {
      editor.commands.setContent("<p>原有内容</p>");
      editor.commands.selectAll();
    });
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 混合粘贴确认" }), {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? '<p>可保留文字</p><object data="unsupported"></object>'
            : type === "text/plain"
              ? "可保留文字"
              : "",
      },
    });
    expect(editor.getText()).toBe("原有内容");
    expect(await screen.findByRole("dialog", { name: "部分内容无法粘贴" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: proceed ? "继续粘贴" : "取消" }));
    expect(editor.getText()).toBe(proceed ? "可保留文字" : "原有内容");
    if (proceed) {
      expect(screen.getByText("已粘贴可保留的内容，部分内容缺失，请核对原文。")).toBeDefined();
      act(() => {
        editor.commands.undo();
      });
      expect(editor.getText()).toBe("原有内容");
    }
  },
);
