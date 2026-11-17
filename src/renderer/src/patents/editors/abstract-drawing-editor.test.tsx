import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PatentFigure } from "../../../../shared/patent/model";
import { AbstractDrawingEditor } from "./abstract-drawing-editor";

const sessionId = "00000000-0000-4000-8000-000000000099";

function figure(index: number): PatentFigure {
  return {
    figureId: `00000000-0000-4000-8002-${index.toString(16).padStart(12, "0")}`,
    assetId: `00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`,
    widthMm: 80,
  };
}

function installPreviewApi() {
  const getPreview = vi.fn().mockResolvedValue({
    ok: true,
    value: Uint8Array.from([137, 80, 78, 71]),
  });
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { assets: { getPreview } },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn().mockReturnValue("blob:abstract-figure"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  return getPreview;
}

describe("abstract drawing editor", () => {
  test("leaves horizontal placement to the scaled workspace grid", () => {
    render(<AbstractDrawingEditor sessionId={sessionId} figures={[]} selectedFigureId={null} />);

    const page = screen.getByRole("main", { name: "摘要附图编辑器" });
    expect(page.style.marginInline).toBe("0px");
    expect(page.classList.contains("patent-page-zoom-frame")).toBe(true);
  });

  test("image context menu copies only the chosen figure and closes outside", async () => {
    installPreviewApi();
    const copyImages = vi.fn().mockResolvedValue({ ok: true });
    Object.assign(window.patentApi.assets, { copyImages });
    const selected = figure(2);
    render(
      <AbstractDrawingEditor
        sessionId={sessionId}
        figures={[figure(1), selected]}
        selectedFigureId={selected.figureId}
      />,
    );
    fireEvent.contextMenu(await screen.findByRole("img", { name: "摘要附图 图2" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "复制图片" }));
    await waitFor(() =>
      expect(copyImages).toHaveBeenCalledWith({
        sessionId,
        images: [{ assetId: selected.assetId, rotationDeg: 0, label: "摘要附图" }],
      }),
    );
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(screen.getByRole("img", { name: "摘要附图 图2" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
  test("selects exactly one specification figure and displays only its decrypted preview", async () => {
    const first = figure(1);
    const second = figure(2);
    const getPreview = installPreviewApi();

    render(
      <AbstractDrawingEditor
        sessionId={sessionId}
        figures={[first, second]}
        selectedFigureId={second.figureId}
      />,
    );

    expect(await screen.findByRole("img", { name: "摘要附图 图2" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "图2" })).toBeNull();
    expect(screen.queryByText("图2")).toBeNull();
    expect(getPreview).toHaveBeenCalledWith(sessionId, second.assetId);
    expect(screen.queryByLabelText("选择说明书附图")).toBeNull();
    expect(screen.queryByRole("button", { name: "导入多张图片" })).toBeNull();
  });

  test("shows only the no-figure state when no specification drawing is available", () => {
    installPreviewApi();

    render(<AbstractDrawingEditor sessionId={sessionId} figures={[]} selectedFigureId={null} />);

    expect(screen.getByText("暂无可选的说明书附图")).toBeDefined();
    expect(screen.queryByText("尚未选择摘要附图")).toBeNull();
    expect(screen.queryByRole("button", { name: "导入多张图片" })).toBeNull();
  });

  test("shows the unselected state when specification drawings are available", () => {
    installPreviewApi();

    render(
      <AbstractDrawingEditor sessionId={sessionId} figures={[figure(1)]} selectedFigureId={null} />,
    );

    expect(screen.getByText("尚未选择摘要附图")).toBeDefined();
    expect(screen.queryByText("暂无可选的说明书附图")).toBeNull();
  });
});
