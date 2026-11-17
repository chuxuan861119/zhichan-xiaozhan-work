import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createBlankDocument } from "../../../../shared/document/defaults";
import type { AssetDescriptor } from "../../../../shared/document/model";
import { canonicalToTiptap, tiptapToCanonical } from "../model-adapter";
import { clampFigureWidth, FigureNodeView } from "./figure-node";

describe("patent figure editing", () => {
  test("uses stored image geometry before the preview image reports its dimensions", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn().mockReturnValue("blob:figure-geometry"),
      revokeObjectURL: vi.fn(),
    });
    render(
      <FigureNodeView
        node={
          {
            attrs: {
              assetId: "00000000-0000-4000-8000-000000000099",
              widthMm: 80,
              alignment: "center",
              rotationDeg: 90,
              sourceAspectRatio: 1.5,
            },
          } as never
        }
        editor={{ commands: { setNodeSelection: vi.fn() } } as never}
        selected
        updateAttributes={vi.fn()}
        deleteNode={vi.fn()}
        getPos={() => 0}
        sessionId="normal-session"
        loadAssetPreview={vi
          .fn()
          .mockResolvedValue({ ok: true, value: Uint8Array.from([1, 2, 3]) })}
        decorations={[]}
        extension={{} as never}
        HTMLAttributes={{}}
        view={{} as never}
        innerDecorations={{} as never}
      />,
    );

    const image = await screen.findByRole("img", { name: "专利图片" });
    expect(image.style.width).toBe("150%");
    const handle = screen.getByRole("button", { name: "从右下角缩放图片" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 138 });
    expect(screen.getByTestId("image-selection-frame").style.width).toBe("90.05mm");
    expect(image.style.width).toBe("150%");
    expect(Number.parseFloat(image.style.height)).toBeCloseTo(100 / 1.5);
    fireEvent.pointerCancel(handle, { pointerId: 1 });
  });

  test("shows an inline retry action when a preview fails without opening a global dialog", async () => {
    render(
      <FigureNodeView
        node={
          {
            attrs: {
              assetId: "00000000-0000-4000-8000-000000000099",
              widthMm: 80,
              alignment: "center",
              rotationDeg: 0,
              sourceAspectRatio: 1.5,
            },
          } as never
        }
        editor={{ commands: { setNodeSelection: vi.fn() } } as never}
        selected={false}
        updateAttributes={vi.fn()}
        deleteNode={vi.fn()}
        getPos={() => 0}
        sessionId="normal-session"
        loadAssetPreview={vi
          .fn()
          .mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "missing" } })}
        decorations={[]}
        extension={{} as never}
        HTMLAttributes={{}}
        view={{} as never}
        innerDecorations={{} as never}
      />,
    );

    expect(await screen.findByText("图片预览加载失败。")).toBeDefined();
    expect(screen.getByRole("button", { name: "重试加载图片预览" })).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("uses an injected snapshot loader without falling back and revokes the object URL", async () => {
    const assetId = "00000000-0000-4000-8000-000000000099";
    const getPreview = vi.fn();
    const loadAssetPreview = vi
      .fn()
      .mockResolvedValue({ ok: true, value: Uint8Array.from([1, 2, 3]) });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { assets: { getPreview } },
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn().mockReturnValue("blob:snapshot-figure"),
      revokeObjectURL,
    });
    const { unmount } = render(
      <FigureNodeView
        node={
          {
            attrs: {
              assetId,
              widthMm: 80,
              alignment: "center",
              rotationDeg: 90,
              snapshotSourceRevision: 3,
            },
          } as never
        }
        editor={{ commands: { setNodeSelection: vi.fn() } } as never}
        selected={false}
        updateAttributes={vi.fn()}
        deleteNode={vi.fn()}
        getPos={() => 0}
        sessionId="normal-session"
        loadAssetPreview={loadAssetPreview}
        decorations={[]}
        extension={{} as never}
        HTMLAttributes={{}}
        view={{} as never}
        innerDecorations={{} as never}
      />,
    );
    expect((await screen.findByRole("img", { name: "专利图片" })).getAttribute("src")).toBe(
      "blob:snapshot-figure",
    );
    expect(loadAssetPreview).toHaveBeenCalledWith(assetId, 3);
    expect(getPreview).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:snapshot-figure"));
  });

  test("round-trips a figure as an asset reference without embedding bytes", () => {
    const base = createBlankDocument("附图测试");
    const descriptor: AssetDescriptor = {
      assetId: "00000000-0000-4000-8000-000000000011",
      kind: "image",
      originalName: "drawing.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: 3,
      sha256: "A".repeat(64),
      widthPx: 120,
      heightPx: 80,
      previewByteLength: 3,
      previewSha256: "B".repeat(64),
    };
    const document = {
      ...base,
      assets: [descriptor],
      content: [
        {
          id: "00000000-0000-4000-8000-000000000012",
          type: "figure" as const,
          assetId: descriptor.assetId,
          widthMm: 80,
          alignment: "center" as const,
          rotationDeg: 90 as const,
        },
      ],
    };

    const editorJson = canonicalToTiptap(document);
    expect(JSON.stringify(editorJson)).not.toContain("137,80,78,71");
    expect(editorJson.content?.[0]?.attrs?.sourceAspectRatio).toBe(1.5);
    const result = tiptapToCanonical(editorJson, document);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toEqual(document.content);
  });

  test("constrains figure width to the printable range", () => {
    expect(clampFigureWidth(2)).toBe(10);
    expect(clampFigureWidth(80)).toBe(80);
    expect(clampFigureWidth(200)).toBe(165);
  });

  test("uses drawing-style corner handles and a direct delete button for a selected figure", () => {
    const updateAttributes = vi.fn();
    const deleteNode = vi.fn();
    render(
      <FigureNodeView
        node={
          {
            attrs: {
              assetId: "00000000-0000-4000-8000-000000000099",
              widthMm: 80,
              alignment: "center",
              rotationDeg: 0,
            },
          } as never
        }
        editor={{ commands: { setNodeSelection: vi.fn() } } as never}
        selected
        updateAttributes={updateAttributes}
        deleteNode={deleteNode}
        getPos={() => 0}
        sessionId="normal-session"
        loadAssetPreview={vi.fn(() => new Promise<never>(() => undefined))}
        decorations={[]}
        extension={{} as never}
        HTMLAttributes={{}}
        view={{} as never}
        innerDecorations={{} as never}
      />,
    );

    for (const corner of ["左上角", "左下角", "右下角"]) {
      expect(screen.getByRole("button", { name: `从${corner}缩放图片` })).toBeDefined();
    }
    expect(screen.queryByRole("button", { name: "从右上角缩放图片" })).toBeNull();
    expect(screen.queryByRole("group", { name: "图片工具" })).toBeNull();

    const resize = screen.getByRole("button", { name: "从右下角缩放图片" });
    fireEvent.pointerDown(resize, { pointerId: 7, clientX: 100 });
    fireEvent.pointerMove(resize, { pointerId: 7, clientX: 138 });
    expect(updateAttributes).not.toHaveBeenCalled();
    fireEvent.pointerUp(resize, { pointerId: 7, clientX: 138 });
    expect(updateAttributes).toHaveBeenCalledWith({ widthMm: 90.05 });

    const leftResize = screen.getByRole("button", { name: "从左上角缩放图片" });
    fireEvent.pointerDown(leftResize, { pointerId: 8, clientX: 100 });
    fireEvent.pointerUp(leftResize, { pointerId: 8, clientX: 62 });
    expect(updateAttributes).toHaveBeenLastCalledWith({ widthMm: 90.05 });

    fireEvent.click(screen.getByRole("button", { name: "删除图片" }));
    expect(deleteNode).toHaveBeenCalledOnce();
  });

  test.each([false, true])("only shows image controls while selected (inline: %s)", (inline) => {
    const figure = (selected: boolean) => (
      <FigureNodeView
        node={
          {
            attrs: {
              assetId: "00000000-0000-4000-8000-000000000099",
              widthMm: 80,
              alignment: "center",
              rotationDeg: 0,
            },
          } as never
        }
        editor={{ commands: { setNodeSelection: vi.fn() } } as never}
        selected={selected}
        inline={inline}
        updateAttributes={vi.fn()}
        deleteNode={vi.fn()}
        getPos={() => 0}
        sessionId="normal-session"
        loadAssetPreview={vi.fn(() => new Promise<never>(() => undefined))}
        decorations={[]}
        extension={{} as never}
        HTMLAttributes={{}}
        view={{} as never}
        innerDecorations={{} as never}
      />
    );
    const { rerender } = render(figure(false));

    expect(screen.queryByRole("button", { name: "删除图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: /缩放图片/u })).toBeNull();

    rerender(figure(true));
    expect(screen.getByRole("button", { name: "删除图片" })).toBeDefined();
    expect(screen.getAllByRole("button", { name: /缩放图片/u })).toHaveLength(3);
    expect(screen.getByTestId("image-selection-frame").classList.contains("is-selected")).toBe(true);

    rerender(figure(false));
    expect(screen.queryByRole("button", { name: "删除图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: /缩放图片/u })).toBeNull();
  });
});
