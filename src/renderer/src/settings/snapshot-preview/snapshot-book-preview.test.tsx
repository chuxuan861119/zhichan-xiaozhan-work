import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { createBlankBookDocument } from "../../../../shared/document/defaults";
import type { SnapshotBookDiff } from "./snapshot-book-diff";
import { SnapshotBookPreview } from "./snapshot-book-preview";

describe("SnapshotBookPreview", () => {
  const documentId = "00000000-0000-4000-8000-000000000901";
  const currentRevision = 8;
  const baselineRevision = 7;
  const deletedAssetId = "00000000-0000-4000-8000-000000000902";
  const currentAssetId = "00000000-0000-4000-8000-000000000903";

  function diff(): SnapshotBookDiff {
    const currentDocument = {
      ...createBlankBookDocument("权利要求书"),
      page: {
        widthMm: 210,
        heightMm: 297,
        marginTopMm: 25,
        marginRightMm: 20,
        marginBottomMm: 25,
        marginLeftMm: 30,
      },
    };
    return {
      bookKind: "claims",
      currentDocument,
      previewContent: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: {
              nodeId: "00000000-0000-4000-8000-000000000910",
              snapshotChangeId: "structure-1",
              snapshotChangeKind: "structure",
              snapshotChangeLabel: "段落缩进：0 → 7.4",
              snapshotSourceRevision: currentRevision,
            },
            content: [
              {
                type: "text",
                text: "新增",
                marks: [
                  {
                    type: "snapshotInsertion",
                    attrs: {
                      snapshotChangeId: "insert-1",
                      snapshotChangeKind: "insert",
                      snapshotChangeLabel: "新增文字",
                      snapshotSourceRevision: currentRevision,
                    },
                  },
                ],
              },
              {
                type: "text",
                text: "删除",
                marks: [
                  {
                    type: "snapshotDeletion",
                    attrs: {
                      snapshotChangeId: "delete-1",
                      snapshotChangeKind: "delete",
                      snapshotChangeLabel: "删除文字",
                      snapshotSourceRevision: baselineRevision,
                    },
                  },
                ],
              },
              {
                type: "text",
                text: "格式",
                marks: [
                  {
                    type: "snapshotFormatChange",
                    attrs: {
                      snapshotChangeId: "format-1",
                      snapshotChangeKind: "format",
                      snapshotChangeLabel: "字号：12 → 14",
                      snapshotSourceRevision: currentRevision,
                    },
                  },
                ],
              },
            ],
          },
          {
            type: "figure",
            attrs: {
              nodeId: "deleted-figure",
              assetId: deletedAssetId,
              widthMm: 80,
              alignment: "center",
              snapshotChangeId: "figure-delete",
              snapshotChangeKind: "delete",
              snapshotChangeLabel: "删除附图",
              snapshotSourceRevision: baselineRevision,
            },
          },
          {
            type: "chemicalStructure",
            attrs: {
              nodeId: "current-structure",
              previewAssetId: currentAssetId,
              ketSource: "(ket)",
              editorMode: "molecule",
              widthMm: 80,
              alignment: "center",
              snapshotChangeId: "chemical-insert",
              snapshotChangeKind: "insert",
              snapshotChangeLabel: "新增化学结构式",
              snapshotSourceRevision: currentRevision,
            },
          },
          {
            type: "blockMath",
            attrs: {
              latex: "x+1",
              formulaKind: "math",
              alignment: "center",
              snapshotChangeId: "formula-delete",
              snapshotChangeKind: "delete",
              snapshotChangeLabel: "删除公式",
              snapshotSourceRevision: baselineRevision,
            },
          },
        ],
      },
      changes: [
        {
          id: "insert-1",
          kind: "insert",
          bookKind: "claims",
          blockId: "p",
          locationLabel: "权利要求1",
          summary: "新增",
          details: [],
          nodeType: null,
        },
        {
          id: "delete-1",
          kind: "delete",
          bookKind: "claims",
          blockId: "p",
          locationLabel: "权利要求1",
          summary: "删除",
          details: [],
          nodeType: null,
        },
        {
          id: "format-1",
          kind: "format",
          bookKind: "claims",
          blockId: "p",
          locationLabel: "权利要求1",
          summary: "格式",
          details: [],
          nodeType: null,
        },
        {
          id: "structure-1",
          kind: "structure",
          bookKind: "claims",
          blockId: "p",
          locationLabel: "权利要求1",
          summary: "结构",
          details: [],
          nodeType: "paragraph",
        },
      ],
    };
  }

  test("renders every annotation read-only and loads assets from their source revisions", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previewAsset = vi.fn().mockResolvedValue({ ok: true, value: Uint8Array.from([1, 2, 3]) });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { snapshot: { previewAsset }, assets: { getPreview: vi.fn() } },
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn().mockReturnValue("blob:preview"),
      revokeObjectURL: vi.fn(),
    });
    const onChangeSelected = vi.fn();
    const { container } = render(
      <SnapshotBookPreview
        diff={diff()}
        documentId={documentId}
        currentRevision={currentRevision}
        onChangeSelected={onChangeSelected}
      />,
    );

    const editor = await screen.findByRole("document", { name: "权利要求书快照内容" });
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(container.querySelector('[data-snapshot-change-kind="insert"]')).not.toBeNull();
    expect(container.querySelector('[data-snapshot-change-kind="delete"]')).not.toBeNull();
    expect(container.querySelector('[data-snapshot-change-kind="format"]')).not.toBeNull();
    expect(container.querySelector('[data-snapshot-change-kind="structure"]')).not.toBeNull();
    expect(container.querySelector('[data-snapshot-change-id="figure-delete"]')).not.toBeNull();
    expect(container.querySelector('[data-snapshot-change-id="chemical-insert"]')).not.toBeNull();
    const formula = container.querySelector<HTMLElement>(
      '[data-snapshot-change-id="formula-delete"]',
    );
    if (!formula) throw new Error("Annotated formula is missing");
    expect(formula.dataset.snapshotChangeId).toBe("formula-delete");
    expect(formula.dataset.snapshotChangeKind).toBe("delete");
    expect(formula.getAttribute("aria-label")).toBe("删除公式");
    expect(formula.tabIndex).toBe(0);
    const figure = container.querySelector<HTMLElement>(
      '[data-snapshot-change-id="figure-delete"]',
    );
    const structure = container.querySelector<HTMLElement>(
      '[data-snapshot-change-id="chemical-insert"]',
    );
    for (const atomic of [figure, structure]) {
      if (!atomic) throw new Error("Snapshot atomic node is missing");
      expect(atomic.getAttribute("nodeid")).toBeNull();
      expect(atomic.getAttribute("assetid")).toBeNull();
      expect(atomic.getAttribute("widthmm")).toBeNull();
      expect(atomic.getAttribute("semanticrole")).toBeNull();
      expect(atomic.getAttribute("data-nodeid")).toBeNull();
      expect(atomic.getAttribute("data-snapshot-change-kind")).not.toBeNull();
      expect(atomic.getAttribute("data-snapshot-source-revision")).toBeNull();
      expect(atomic.getAttribute("aria-label")).not.toBeNull();
      expect(atomic.tabIndex).toBe(0);
    }
    expect(
      container.querySelector('[data-snapshot-change-id="insert-1"]')?.getAttribute("tabindex"),
    ).toBe("0");
    expect(
      container.querySelector('[data-snapshot-change-id="insert-1"]')?.getAttribute("aria-label"),
    ).toBe("新增文字");
    expect(onChangeSelected).not.toHaveBeenCalled();
    const page = editor.closest<HTMLElement>(".patent-page-with-rail");
    if (!page) throw new Error("Snapshot preview page is missing");
    expect(page.style.getPropertyValue("--patent-book-page-width")).toBe("210mm");
    expect(page.style.getPropertyValue("--patent-book-page-min-height")).toBe("297mm");
    expect(page.style.getPropertyValue("--patent-page-margin-top")).toBe("25mm");
    expect(page.style.getPropertyValue("--patent-page-margin-right")).toBe("20mm");
    expect(page.style.getPropertyValue("--patent-page-margin-bottom")).toBe("25mm");
    expect(page.style.getPropertyValue("--patent-page-margin-left")).toBe("30mm");

    await waitFor(() => expect(previewAsset).toHaveBeenCalledTimes(2));
    expect(previewAsset).toHaveBeenCalledWith({
      documentType: "patent",
      documentId,
      revision: baselineRevision,
      assetId: deletedAssetId,
    });
    expect(previewAsset).toHaveBeenCalledWith({
      documentType: "patent",
      documentId,
      revision: currentRevision,
      assetId: currentAssetId,
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test("keeps JSON and changes immutable under edit input while allowing selection and change navigation", async () => {
    const previewAsset = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "missing" } });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        snapshot: {
          previewAsset,
        },
        assets: { getPreview: vi.fn() },
      },
    });
    const value = diff();
    const before = structuredClone(value.previewContent);
    const onChangeSelected = vi.fn();
    let previewEditor: Editor | null = null;
    const { container } = render(
      <SnapshotBookPreview
        diff={value}
        documentId={documentId}
        currentRevision={currentRevision}
        onChangeSelected={onChangeSelected}
        onEditorReady={(editor) => {
          previewEditor = editor;
        }}
      />,
    );
    const editor = await screen.findByRole("document", { name: "权利要求书快照内容" });
    await waitFor(() => expect(previewEditor).not.toBeNull());
    const retry = await screen.findByRole("button", { name: "重试" });
    const user = userEvent.setup();
    retry.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(previewAsset).toHaveBeenCalledTimes(3));
    const retryAfterEnter = screen.getByRole("button", { name: "重试" });
    retryAfterEnter.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(previewAsset).toHaveBeenCalledTimes(4));
    expect(onChangeSelected).not.toHaveBeenCalled();
    const target = container.querySelector<HTMLElement>('[data-snapshot-change-id="insert-1"]');
    if (!target) throw new Error("Snapshot change target is missing");
    const beforeJson = (previewEditor as unknown as Editor).getJSON();
    const beforeHtml = editor.innerHTML;

    const textNode = target.firstChild;
    if (!textNode) throw new Error("Snapshot text node is missing");
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 2);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.isCollapsed).toBe(false);
    expect(selection?.toString()).toBe("新增");

    editor.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "X" }),
    );
    fireEvent.paste(editor, { clipboardData: { getData: () => "X" } });
    fireEvent.keyDown(editor, { key: "Backspace" });
    fireEvent.copy(editor, {
      clipboardData: { clearData: vi.fn(), getData: vi.fn(), setData: vi.fn() },
    });
    expect(value.previewContent).toEqual(before);
    expect(value.changes).toHaveLength(4);
    expect((previewEditor as unknown as Editor).getJSON()).toEqual(beforeJson);
    expect(editor.innerHTML).toBe(beforeHtml);

    fireEvent.click(target);
    fireEvent.keyDown(target, { key: "Enter" });
    fireEvent.keyDown(target, { key: " " });
    expect(onChangeSelected).toHaveBeenNthCalledWith(1, "insert-1");
    expect(onChangeSelected).toHaveBeenNthCalledWith(2, "insert-1");
    expect(onChangeSelected).toHaveBeenNthCalledWith(3, "insert-1");

    const atomic = container.querySelector<HTMLElement>(
      '[data-snapshot-change-id="figure-delete"]',
    );
    if (!atomic) throw new Error("Annotated figure is missing");
    const beforeAtomicJson = (previewEditor as unknown as Editor).getJSON();
    const beforeAtomicHtml = editor.innerHTML;
    fireEvent.click(atomic);
    expect(onChangeSelected).toHaveBeenLastCalledWith("figure-delete");
    expect((previewEditor as unknown as Editor).getJSON()).toEqual(beforeAtomicJson);
    expect(editor.innerHTML).toBe(beforeAtomicHtml);
    expect(screen.queryByRole("button", { name: "删除图片" })).toBeNull();

    const formula = container.querySelector<HTMLElement>(
      '[data-snapshot-change-id="formula-delete"]',
    );
    if (!formula) throw new Error("Annotated formula is missing");
    const beforeFormulaJson = (previewEditor as unknown as Editor).getJSON();
    const beforeFormulaHtml = editor.innerHTML;
    fireEvent.click(formula);
    fireEvent.keyDown(formula, { key: "Enter" });
    fireEvent.keyDown(formula, { key: " " });
    expect(onChangeSelected).toHaveBeenNthCalledWith(5, "formula-delete");
    expect(onChangeSelected).toHaveBeenNthCalledWith(6, "formula-delete");
    expect(onChangeSelected).toHaveBeenNthCalledWith(7, "formula-delete");
    expect((previewEditor as unknown as Editor).getJSON()).toEqual(beforeFormulaJson);
    expect(editor.innerHTML).toBe(beforeFormulaHtml);
    expect(screen.queryByRole("button", { name: "编辑结构式" })).toBeNull();
  });

  test("omits table mutation plugins and keeps a preview table unchanged under pointer input", async () => {
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        snapshot: {
          previewAsset: vi
            .fn()
            .mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }),
        },
        assets: { getPreview: vi.fn() },
      },
    });
    const value = diff();
    value.previewContent.content = [
      {
        type: "table",
        attrs: { nodeId: "table-1" },
        content: [
          {
            type: "tableRow",
            attrs: { nodeId: "row-1" },
            content: [
              {
                type: "tableCell",
                attrs: { nodeId: "cell-1", colspan: 1, rowspan: 1, colwidth: null },
                content: [
                  {
                    type: "paragraph",
                    attrs: { nodeId: "table-paragraph" },
                    content: [{ type: "text", text: "表格内容" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    let previewEditor: Editor | null = null;
    const { container } = render(
      <SnapshotBookPreview
        diff={value}
        documentId={documentId}
        currentRevision={currentRevision}
        onChangeSelected={vi.fn()}
        onEditorReady={(editor) => {
          previewEditor = editor;
        }}
      />,
    );
    expect(await screen.findByText("表格内容")).toBeDefined();
    await waitFor(() => expect(previewEditor).not.toBeNull());
    const currentEditor = previewEditor as unknown as Editor;
    expect(currentEditor.extensionManager.extensions.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["tableColumnWidthSync", "tableSelectionControls", "tableRowResize"]),
    );
    expect(container.querySelector(".column-resize-handle")).toBeNull();
    expect(container.querySelector("[data-table-selection-cell]")).toBeNull();
    expect(container.querySelector("[data-table-selection-row]")).toBeNull();
    expect(container.querySelector("[data-table-selection-column]")).toBeNull();
    const table = container.querySelector("table");
    if (!table) throw new Error("Snapshot preview table is missing");
    const before = currentEditor.getJSON();
    fireEvent.click(table);
    expect(currentEditor.getJSON()).toEqual(before);
  });

  test("synchronizes a rerendered diff and current asset revision in the same viewer", async () => {
    const previewAsset = vi.fn().mockResolvedValue({ ok: true, value: Uint8Array.from([1, 2, 3]) });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { snapshot: { previewAsset }, assets: { getPreview: vi.fn() } },
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn().mockReturnValue("blob:preview"),
      revokeObjectURL: vi.fn(),
    });
    const first = diff();
    const second = structuredClone(first);
    const replacementText = second.previewContent.content?.[0]?.content?.[0];
    const replacementFigure = second.previewContent.content?.[1];
    if (!replacementText || !replacementFigure) throw new Error("Snapshot fixture is incomplete");
    replacementText.text = "替换后";
    replacementFigure.attrs = {
      ...replacementFigure.attrs,
      assetId: "00000000-0000-4000-8000-000000000904",
      snapshotSourceRevision: 9,
    };
    const { rerender } = render(
      <SnapshotBookPreview
        diff={first}
        documentId={documentId}
        currentRevision={currentRevision}
        onChangeSelected={vi.fn()}
      />,
    );
    expect(await screen.findByText("新增")).toBeDefined();

    rerender(
      <SnapshotBookPreview
        diff={second}
        documentId={documentId}
        currentRevision={9}
        onChangeSelected={vi.fn()}
      />,
    );
    expect(await screen.findByText("替换后")).toBeDefined();
    expect(screen.queryByText("新增")).toBeNull();
    await waitFor(() =>
      expect(previewAsset).toHaveBeenCalledWith({
        documentType: "patent",
        documentId,
        revision: 9,
        assetId: "00000000-0000-4000-8000-000000000904",
      }),
    );
  });
});
