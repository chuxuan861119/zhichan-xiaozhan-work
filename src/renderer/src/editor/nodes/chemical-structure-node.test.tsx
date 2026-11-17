import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { createBlankDocument } from "../../../../shared/document/defaults";
import { createPatentExtensions } from "../extensions";
import { tiptapToCanonical } from "../model-adapter";
import { ChemicalStructureNodeView } from "./chemical-structure-node";

describe("chemical structure node", () => {
  const assetId = "00000000-0000-4000-8000-000000000801";
  const nodeId = "00000000-0000-4000-8000-000000000802";

  test("loads a PNG preview, requests edit on double click, and revokes its object URL", async () => {
    const getPreview = vi
      .fn()
      .mockResolvedValue({ ok: true, value: Uint8Array.from([137, 80, 78, 71]) });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { assets: { getPreview } },
    });
    const createObjectURL = vi.fn().mockReturnValue("blob:structure-preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const onEdit = vi.fn();
    const setNodeSelection = vi.fn();
    const { unmount } = render(
      <ChemicalStructureNodeView
        node={
          {
            attrs: {
              nodeId,
              ketSource: "(ket) (atom C)",
              previewAssetId: assetId,
              widthMm: 80,
              alignment: "center",
            },
          } as never
        }
        editor={{ commands: { setNodeSelection } } as never}
        selected={false}
        updateAttributes={vi.fn()}
        deleteNode={vi.fn()}
        getPos={() => 0}
        sessionId="structure-session"
        onEdit={onEdit}
        decorations={[]}
        extension={{} as never}
        HTMLAttributes={{}}
        view={{} as never}
        innerDecorations={{} as never}
      />,
    );

    const preview = await screen.findByRole("img", { name: "化学结构式" });
    expect(preview.getAttribute("src")).toBe("blob:structure-preview");
    fireEvent.doubleClick(preview);
    expect(onEdit).toHaveBeenCalledWith({
      nodeId,
      ketSource: "(ket) (atom C)",
      editorMode: "molecule",
      position: 0,
    });

    unmount();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:structure-preview"));
  });

  test("shows a recoverable error when the PNG preview cannot be loaded", async () => {
    const getPreview = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: "NOT_FOUND", message: "missing" } })
      .mockResolvedValueOnce({ ok: true, value: Uint8Array.from([137, 80, 78, 71]) });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { assets: { getPreview } },
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn().mockReturnValue("blob:retried-structure-preview"),
      revokeObjectURL: vi.fn(),
    });

    render(
      <ChemicalStructureNodeView
        node={
          {
            attrs: {
              nodeId,
              ketSource: "(ket) (atom C)",
              previewAssetId: assetId,
              widthMm: 80,
              alignment: "center",
            },
          } as never
        }
        editor={{ commands: { setNodeSelection: vi.fn() } } as never}
        selected={false}
        updateAttributes={vi.fn()}
        deleteNode={vi.fn()}
        getPos={() => 0}
        sessionId="structure-session"
        onEdit={vi.fn()}
        decorations={[]}
        extension={{} as never}
        HTMLAttributes={{}}
        view={{} as never}
        innerDecorations={{} as never}
      />,
    );

    expect(await screen.findByText("结构式预览加载失败。")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("img", { name: "化学结构式" })).toBeDefined();
    expect(getPreview).toHaveBeenCalledTimes(2);
  });

  test("uses only an injected snapshot loader, including retry and source revision", async () => {
    const getPreview = vi.fn();
    const loadAssetPreview = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: "NOT_FOUND", message: "missing" } })
      .mockResolvedValueOnce({ ok: true, value: Uint8Array.from([1, 2, 3]) });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { assets: { getPreview } },
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn().mockReturnValue("blob:snapshot-structure"),
      revokeObjectURL,
    });
    const { unmount } = render(
      <ChemicalStructureNodeView
        node={
          {
            attrs: {
              nodeId,
              ketSource: "(ket)",
              previewAssetId: assetId,
              widthMm: 80,
              alignment: "center",
              snapshotSourceRevision: 4,
            },
          } as never
        }
        editor={{ commands: { setNodeSelection: vi.fn() } } as never}
        selected={false}
        updateAttributes={vi.fn()}
        deleteNode={vi.fn()}
        getPos={() => 0}
        sessionId="normal-session"
        onEdit={undefined}
        loadAssetPreview={loadAssetPreview}
        decorations={[]}
        extension={{} as never}
        HTMLAttributes={{}}
        view={{} as never}
        innerDecorations={{} as never}
      />,
    );
    expect(await screen.findByText("结构式预览加载失败。")).toBeDefined();
    expect(getPreview).not.toHaveBeenCalled();
    expect(loadAssetPreview).toHaveBeenCalledWith(assetId, 4);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect((await screen.findByRole("img", { name: "化学结构式" })).getAttribute("src")).toBe(
      "blob:snapshot-structure",
    );
    unmount();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:snapshot-structure"));
    expect(getPreview).not.toHaveBeenCalled();
  });

  test("keeps KET out of the DOM while preserving atom copy, delete, undo, and redo behavior", () => {
    const ketSource = "(ket) (atom N)";
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "chemicalStructure",
            attrs: { nodeId, ketSource, previewAssetId: assetId, widthMm: 80, alignment: "center" },
          },
        ],
      },
    });

    expect(editor.getHTML()).not.toContain(ketSource);
    expect(editor.state.doc.slice(0, editor.state.doc.firstChild?.nodeSize).toJSON()).toMatchObject(
      {
        content: [{ type: "chemicalStructure", attrs: { ketSource, previewAssetId: assetId } }],
      },
    );
    editor.commands.setNodeSelection(0);
    expect(editor.commands.deleteSelection()).toBe(true);
    expect(editor.getJSON().content?.some((node) => node.type === "chemicalStructure")).toBe(false);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON().content?.[0]?.attrs?.ketSource).toBe(ketSource);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON().content?.some((node) => node.type === "chemicalStructure")).toBe(false);
    editor.destroy();
  });

  test("serializes safe preview attributes but does not create a structure from external HTML", () => {
    const ketSource = "(ket) (atom O)";
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "chemicalStructure",
            attrs: {
              nodeId,
              ketSource,
              previewAssetId: assetId,
              widthMm: 72,
              alignment: "right",
            },
          },
        ],
      },
    });
    const html = editor.getHTML();
    const restored = new Editor({ extensions: createPatentExtensions(), content: html });

    expect(html).toContain(`data-chemical-structure-preview-id="${assetId}"`);
    expect(html).not.toContain(ketSource);
    expect(html).not.toContain("ketsource");
    expect(restored.getJSON().content?.some((node) => node.type === "chemicalStructure")).toBe(
      false,
    );

    restored.destroy();
    editor.destroy();
  });

  test("preserves the full chemical structure in a ProseMirror clipboard slice", () => {
    const ketSource = "(ket) (atom S)";
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "chemicalStructure",
            attrs: {
              nodeId,
              ketSource,
              previewAssetId: assetId,
              widthMm: 72,
              alignment: "right",
            },
          },
        ],
      },
    });
    const slice = editor.state.doc.slice(0, editor.state.doc.content.size);
    expect(slice.content.firstChild?.type.name).toBe("chemicalStructure");
    editor.view.dispatch(editor.state.tr.replace(0, editor.state.doc.content.size, slice));
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "chemicalStructure",
      attrs: { ketSource, previewAssetId: assetId },
    });
    const document = createBlankDocument("结构式剪贴板");

    const result = tiptapToCanonical(editor.getJSON(), {
      ...document,
      assets: [
        {
          assetId,
          kind: "image",
          originalName: "chemical-structure.png",
          mediaType: "image/png",
          extension: "png",
          byteLength: 4,
          sha256: "A".repeat(64),
          widthPx: 72,
          heightPx: 72,
          previewByteLength: 4,
          previewSha256: "B".repeat(64),
        },
      ],
    });

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.content[0]).toMatchObject({
      type: "chemical-structure",
      ketSource,
      previewAssetId: assetId,
      widthMm: 72,
      alignment: "right",
    });
    editor.destroy();
  });
});
