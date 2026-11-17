import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PatentFigure } from "../../../../shared/patent/model";
import { DrawingsEditor } from "./drawings-editor";

function figure(index: number, widthMm = 80): PatentFigure {
  return {
    figureId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    assetId: `00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`,
    widthMm,
  };
}

describe("drawings editor", () => {
  const sessionId = "00000000-0000-4000-8000-000000000099";

  test("renders each figure centered on its own row with automatic figure numbers", () => {
    render(
      <DrawingsEditor
        sessionId={sessionId}
        title="说明书附图"
        figures={[figure(1), figure(2)]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
      />,
    );

    const first = screen.getByRole("article", { name: "图1" });
    const second = screen.getByRole("article", { name: "图2" });
    expect(within(first).getByText("图1")).toBeDefined();
    expect(within(second).getByText("图2")).toBeDefined();
    expect(first.className).toContain("is-centered");
    expect(screen.queryByRole("button", { name: "导入多张图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: "上移图2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "放大图1" })).toBeNull();
  });

  test("reorders figures by dragging one figure onto another row", () => {
    const onReorderFigures = vi.fn();
    render(
      <DrawingsEditor
        sessionId={sessionId}
        title="说明书附图"
        figures={[figure(1), figure(2)]}
        onReorderFigures={onReorderFigures}
        onResizeFigure={vi.fn()}
      />,
    );

    fireEvent.dragStart(screen.getByRole("article", { name: "图2" }));
    fireEvent.dragOver(screen.getByRole("article", { name: "图1" }));
    fireEvent.drop(screen.getByRole("article", { name: "图1" }));

    expect(onReorderFigures).toHaveBeenCalledWith([
      expect.objectContaining({ figureId: figure(2).figureId }),
      expect.objectContaining({ figureId: figure(1).figureId }),
    ]);
  });

  test("resizes a selected figure by dragging its proportional resize handle", () => {
    const onResizeFigure = vi.fn();
    render(
      <DrawingsEditor
        sessionId={sessionId}
        title="说明书附图"
        figures={[figure(1, 80)]}
        onReorderFigures={vi.fn()}
        onResizeFigure={onResizeFigure}
      />,
    );

    const handle = screen.getByRole("slider", { name: "拖拽缩放图1" });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(handle, { setPointerCapture, releasePointerCapture });
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 7 });
    fireEvent.pointerMove(handle, { clientX: 140, pointerId: 7 });
    fireEvent.pointerUp(handle, { pointerId: 7 });

    expect(onResizeFigure).toHaveBeenCalledWith(figure(1).figureId, 90);
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  test("pastes multiple clipboard image files in their source order", async () => {
    const onPasteImages = vi.fn();
    render(
      <DrawingsEditor
        sessionId={sessionId}
        title="说明书附图"
        figures={[]}
        onPasteImages={onPasteImages}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
      />,
    );
    const first = new File([Uint8Array.from([1])], "first.png", { type: "image/png" });
    const second = new File([Uint8Array.from([2])], "second.jpg", { type: "image/jpeg" });

    fireEvent.paste(screen.getByRole("main", { name: "附图编辑器" }), {
      clipboardData: {
        files: [first, second],
        getData: vi.fn().mockReturnValue(""),
      },
    });

    await waitFor(() => expect(onPasteImages).toHaveBeenCalledOnce());
    expect(onPasteImages.mock.calls[0]?.[0]).toEqual([
      {
        originalName: "first.png",
        declaredMediaType: "image/png",
        bytes: Uint8Array.from([1]),
      },
      {
        originalName: "second.jpg",
        declaredMediaType: "image/jpeg",
        bytes: Uint8Array.from([2]),
      },
    ]);
  });

  test("pastes every supported data image from rich text in document order", async () => {
    const onPasteImages = vi.fn();
    render(
      <DrawingsEditor
        sessionId={sessionId}
        title="说明书附图"
        figures={[]}
        onPasteImages={onPasteImages}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
      />,
    );
    const html = [
      '<p><img src="data:image/png;base64,AQ=="></p>',
      '<p><img src="data:image/jpeg;base64,Ag=="></p>',
    ].join("");

    fireEvent.paste(screen.getByRole("main", { name: "附图编辑器" }), {
      clipboardData: { files: [], getData: vi.fn().mockReturnValue(html) },
    });

    await waitFor(() => expect(onPasteImages).toHaveBeenCalledOnce());
    expect(onPasteImages.mock.calls[0]?.[0]).toEqual([
      {
        originalName: "clipboard-image-1.png",
        declaredMediaType: "image/png",
        bytes: Uint8Array.from([1]),
      },
      {
        originalName: "clipboard-image-2.jpg",
        declaredMediaType: "image/jpeg",
        bytes: Uint8Array.from([2]),
      },
    ]);
  });

  test("loads and displays the decrypted preview for each specification figure", async () => {
    const drawing = figure(1);
    const getPreview = vi.fn().mockResolvedValue({
      ok: true,
      value: Uint8Array.from([137, 80, 78, 71]),
    });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { assets: { getPreview } },
    });
    const createObjectURL = vi.fn().mockReturnValue("blob:specification-figure-1");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <DrawingsEditor
        sessionId={sessionId}
        title="说明书附图"
        figures={[drawing]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
      />,
    );

    const image = await screen.findByRole("img", { name: "图1" });
    expect(image.getAttribute("src")).toBe("blob:specification-figure-1");
    expect(getPreview).toHaveBeenCalledWith(sessionId, drawing.assetId);
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  test("revokes each decrypted preview URL when the asset changes or unmounts", async () => {
    const first = figure(1);
    const second = figure(2);
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          getPreview: vi.fn().mockResolvedValue({
            ok: true,
            value: Uint8Array.from([137, 80, 78, 71]),
          }),
        },
      },
    });
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce("blob:first-preview")
      .mockReturnValueOnce("blob:second-preview");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });

    const view = render(
      <DrawingsEditor
        sessionId={sessionId}
        title="说明书附图"
        figures={[first]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
      />,
    );
    await screen.findByRole("img", { name: "图1" });

    view.rerender(
      <DrawingsEditor
        sessionId={sessionId}
        title="说明书附图"
        figures={[{ ...first, assetId: second.assetId }]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "图1" }).getAttribute("src")).toBe(
        "blob:second-preview",
      ),
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-preview");

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second-preview");
  });
});
