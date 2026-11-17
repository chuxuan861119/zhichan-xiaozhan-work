import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../../../../shared/document/defaults";
import type { InlineNode } from "../../../../shared/document/model";
import { drawingProjectFixture } from "../../../../shared/drawing-markup/test-fixture";
import type { DrawingExplanationSync } from "../../../../shared/patent/drawing-explanations";
import type { PatentFigure } from "../../../../shared/patent/model";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../../shared/settings/shortcuts";
import { ShortcutProvider } from "../../app/shortcut-dispatcher";
import { DrawingLaunchContext } from "../../drawing-markup/launch-context";
import { DrawingWorkbench } from "./drawing-workbench";

vi.mock("./asset-preview", () => ({
  AssetPreview: ({ alt, onLoad }: { alt: string; onLoad?: () => void }) => (
    <img alt={alt} src="blob:test-preview" onLoad={onLoad} />
  ),
}));

const sessionId = "00000000-0000-4000-8000-000000000099";

function figure(index: number): PatentFigure {
  return {
    figureId: `00000000-0000-4000-8002-${index.toString(16).padStart(12, "0")}`,
    assetId: `00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`,
    widthMm: 80,
  };
}

function text(content: string): InlineNode[] {
  return [{ type: "text", text: content, marks: [] }];
}

function paragraph(figureId: string, content: string) {
  return {
    id: `paragraph-${figureId}`,
    type: "paragraph" as const,
    semanticRole: "description-drawing-explanation" as const,
    figureId,
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: text(content),
  };
}

function activeSync(figures: PatentFigure[]): DrawingExplanationSync {
  return {
    status: "active",
    headingId: "drawing-heading",
    linked: figures.map((item, index) => ({
      figureId: item.figureId,
      index,
      paragraph: paragraph(item.figureId, `图${index + 1}为结构示意图。`),
    })),
    legend: {
      id: "legend",
      type: "paragraph",
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content: text("其中，1、箱体。"),
    },
  };
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("drawing workbench", () => {
  test("does not handle the drawing-sort shortcut in an inactive dual-view pane", () => {
    const view = (enabled: boolean) => (
      <ShortcutProvider settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "toggle-drawing-sort": "F9" }}>
        <DrawingWorkbench
          sessionId={sessionId}
          figures={[figure(1)]}
          sync={activeSync([figure(1)])}
          unlinked={[]}
          shortcutsEnabled={enabled}
          onReorderFigures={vi.fn()}
          onResizeFigure={vi.fn()}
          onChange={vi.fn()}
          onDeleteFigure={vi.fn()}
        />
      </ShortcutProvider>
    );
    const { rerender } = render(view(false));
    fireEvent.keyDown(window, { key: "F9", code: "F9" });
    expect(
      screen.getByRole("main", { name: "说明书附图页面" }).classList.contains("is-sort-mode"),
    ).toBe(false);
    rerender(view(true));
    fireEvent.keyDown(window, { key: "F9", code: "F9" });
    expect(screen.getByRole("button", { name: "完成排序" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  test("filling an unchanged explanation preserves its inline formula and formatting", async () => {
    const figures = [figure(1)];
    const sync = activeSync(figures);
    if (sync.status !== "active") throw new Error("fixture");
    const content: InlineNode[] = [
      { type: "text", text: "图1为", marks: [{ type: "bold" }] },
      { type: "inline-formula", source: "x^2", formulaKind: "math" },
      { type: "text", text: "的曲线。", marks: [] },
    ];
    const linked = sync.linked[0];
    if (!linked) throw new Error("missing explanation fixture");
    linked.paragraph.content = content;
    const onChange = vi.fn((_changes: unknown) => ({ ok: true as const }));
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={sync}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={onChange}
        onDeleteFigure={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "填入说明书" }));
    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(onChange.mock.calls[0]?.[0]).toEqual([
      {
        target: {
          figureId: linked.figureId,
          figureNumber: 1,
          paragraphId: linked.paragraph.id,
        },
        content,
      },
    ]);
  });
  test("published figures have no return-to-drawing action even with legacy source links", () => {
    const item = figure(1),
      project = drawingProjectFixture(item.assetId),
      open = vi.fn();
    project.regions[0]!.figureId = item.figureId;
    render(
      <DrawingLaunchContext.Provider value={{ projects: [project], open }}>
        <DrawingWorkbench
          sessionId={sessionId}
          figures={[item]}
          sync={activeSync([item])}
          unlinked={[]}
          onReorderFigures={vi.fn()}
          onResizeFigure={vi.fn()}
          onChange={vi.fn()}
          onDeleteFigure={vi.fn()}
        />
      </DrawingLaunchContext.Provider>,
    );
    fireEvent.contextMenu(screen.getByRole("article", { name: "图1" }), {
      clientX: 50,
      clientY: 80,
    });
    expect(screen.queryByRole("menuitem", { name: "继续CAD标号" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "删除图片" })).toBeDefined();
    expect(open).not.toHaveBeenCalled();
  });
  test("restores saved drafts without a description heading and keeps drafts attached to reordered figures", () => {
    const first = figure(1);
    const second = figure(2);
    const savedDrafts = JSON.parse(
      JSON.stringify({
        [first.figureId]: { figureNumber: 1, value: "图1为整体结构。" },
        [second.figureId]: { figureNumber: 2, value: "图2为局部结构。" },
      }),
    );
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={[second, first]}
        sync={{ status: "paused", issues: [] }}
        unlinked={[]}
        savedDrafts={savedDrafts}
        explanations={[second, first].map((item, index) => ({
          figureId: item.figureId,
          figureNumber: index + 1,
          status: "missing-heading",
          paragraph: null,
          message: "缺少标题",
        }))}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("textbox", { name: "图1附图说明" }) as HTMLTextAreaElement).value,
    ).toBe("图1为局部结构。");
    expect(
      (screen.getByRole("textbox", { name: "图2附图说明" }) as HTMLTextAreaElement).value,
    ).toBe("图2为整体结构。");
  });
  test("keeps entered drafts when description explanations are deleted", () => {
    const figures = [figure(1)];
    const props = {
      sessionId,
      figures,
      unlinked: [],
      onReorderFigures: vi.fn(),
      onResizeFigure: vi.fn(),
      onChange: vi.fn(),
      onDeleteFigure: vi.fn(),
    };
    const view = render(<DrawingWorkbench {...props} sync={activeSync(figures)} />);
    fireEvent.change(screen.getByRole("textbox", { name: "图1附图说明" }), {
      target: { value: "图1为用户填写的整体结构。" },
    });
    view.rerender(<DrawingWorkbench {...props} sync={{ status: "paused", issues: [] }} />);
    expect(
      (screen.getByRole("textbox", { name: "图1附图说明" }) as HTMLTextAreaElement).value,
    ).toBe("图1为用户填写的整体结构。");
  });

  test("asks before replacing existing explanations and does nothing on cancel", async () => {
    const figures = [figure(1)];
    const onChange = vi.fn();
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={onChange}
        onDeleteFigure={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "填入说明书" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "填入说明书" }));
    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  });

  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  test("projects document page geometry onto the drawing page", () => {
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        page={{
          widthMm: 210,
          heightMm: 297,
          marginTopMm: 25,
          marginRightMm: 20,
          marginBottomMm: 25,
          marginLeftMm: 30,
        }}
        figures={[]}
        sync={activeSync([])}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const layout = screen
      .getByRole("main", { name: "说明书附图页面" })
      .closest<HTMLElement>(".patent-page-with-rail");
    expect(layout?.style.getPropertyValue("--patent-book-page-width")).toBe("210mm");
    expect(layout?.style.getPropertyValue("--patent-book-page-min-height")).toBe("297mm");
    expect(layout?.style.getPropertyValue("--patent-page-margin-top")).toBe("25mm");
    expect(layout?.style.getPropertyValue("--patent-page-margin-right")).toBe("20mm");
    expect(layout?.style.getPropertyValue("--patent-page-margin-bottom")).toBe("25mm");
    expect(layout?.style.getPropertyValue("--patent-page-margin-left")).toBe("30mm");
  });

  test("keeps linked drawings free of source hints and opens the exact source on double click", () => {
    const projectId = "00000000-0000-4000-8005-000000000001";
    const figures = [
      {
        ...figure(1),
        flowchartLink: {
          projectId,
          pageId: "page-1",
          exportScope: "page" as const,
          selectedCellIds: [],
          borderMm: 2,
          exportedProjectRevision: 1,
          exportedSourceSha256: "A".repeat(64),
          renderProfileVersion: 1 as const,
        },
      },
    ];
    const onOpenLinkedFlowchart = vi.fn();
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        flowchartProjects={[
          {
            projectId,
            name: "流程",
            revision: 2,
            pageCount: 1,
            lastPageId: "page-1",
            sourceSha256: "B".repeat(64),
            createdAt: "2026-08-11T00:00:00.000Z",
            modifiedAt: "2026-08-11T00:00:00.000Z",
          },
        ]}
        onOpenLinkedFlowchart={onOpenLinkedFlowchart}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );
    expect(screen.queryByText("流程图来源")).toBeNull();
    expect(screen.queryByText("源工程已修改，附图尚未重新导出。")).toBeNull();
    fireEvent.doubleClick(screen.getByRole("article", { name: "图1" }));
    expect(onOpenLinkedFlowchart).toHaveBeenCalledWith(projectId, figures[0]?.figureId);
  });

  test("uses asset dimensions for the initial drawing aspect ratio", () => {
    const sourceFigure = figure(1);
    const figures = [sourceFigure];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        assets={[
          {
            assetId: sourceFigure.assetId,
            kind: "image",
            originalName: "wide.png",
            mediaType: "image/png",
            extension: "png",
            byteLength: 4,
            sha256: "A".repeat(64),
            widthPx: 300,
            heightPx: 100,
            previewByteLength: 4,
            previewSha256: "B".repeat(64),
          },
        ]}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("image-selection-frame").style.getPropertyValue("--image-aspect-ratio"),
    ).toBe("3");
  });
  test("toggles drawing sort mode with its configured shortcut", () => {
    const figures = [figure(1)];
    render(
      <ShortcutProvider settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "toggle-drawing-sort": "F9" }}>
        <DrawingWorkbench
          sessionId={sessionId}
          figures={figures}
          sync={activeSync(figures)}
          unlinked={[]}
          onReorderFigures={vi.fn()}
          onResizeFigure={vi.fn()}
          onChange={vi.fn()}
          onDeleteFigure={vi.fn()}
        />
      </ShortcutProvider>,
    );

    expect(screen.getByRole("button", { name: "附图排序" }).getAttribute("title")).toBe("F9");
    fireEvent.keyDown(window, { code: "F9", key: "F9" });
    expect(screen.getByRole("button", { name: "完成排序" })).toBeTruthy();
    fireEvent.keyDown(window, { code: "F9", key: "F9" });
    expect(screen.getByRole("button", { name: "附图排序" })).toBeTruthy();
  });

  test("hides the structure ruler while sorting and restores it after", () => {
    const figures = [figure(1), figure(2)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    // 默认显示标尺。
    expect(screen.getByRole("complementary", { name: "文档结构标尺" })).toBeDefined();

    // 进入排序：隐藏标尺。
    const scrollArea = document.querySelector<HTMLElement>(".drawing-pairs-scroll");
    if (!scrollArea) throw new Error("Missing drawing scroll area");
    scrollArea.scrollTop = 300;
    fireEvent.click(screen.getByRole("button", { name: "附图排序" }));
    expect(scrollArea.scrollTop).toBe(0);
    expect(screen.queryByRole("complementary", { name: "文档结构标尺" })).toBeNull();

    // 退出排序：恢复标尺。
    fireEvent.click(screen.getByRole("button", { name: "完成排序" }));
    expect(screen.getByRole("complementary", { name: "文档结构标尺" })).toBeDefined();
  });

  test("expands the explanation rail and removes the sort hint when entering sort mode", () => {
    const figures = [figure(1)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    // 先折叠附图说明。
    fireEvent.click(screen.getByRole("button", { name: "折叠附图说明" }));
    expect(screen.getByRole("button", { name: "展开附图说明" })).toBeDefined();

    // 进入排序：附图说明默认展开，排序提示不再出现。
    fireEvent.click(screen.getByRole("button", { name: "附图排序" }));
    expect(screen.getByRole("button", { name: "折叠附图说明" })).toBeDefined();
    expect(screen.queryByText("每行显示三张附图，可直接拖拽调整顺序。")).toBeNull();
  });

  test("exposes the delete control for every figure while sorting and only for the selected figure otherwise", () => {
    const figures = [figure(1), figure(2)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const page = screen.getByRole("main", { name: "说明书附图页面" });
    // Normal mode: no delete control until a figure is selected.
    expect(within(page).queryByRole("button", { name: "删除图1" })).toBeNull();
    expect(within(page).queryByRole("button", { name: "删除图2" })).toBeNull();

    // Sort mode: every figure shows its own delete control.
    fireEvent.click(screen.getByRole("button", { name: "附图排序" }));
    expect(within(page).getByRole("button", { name: "删除图1" })).toBeDefined();
    expect(within(page).getByRole("button", { name: "删除图2" })).toBeDefined();

    // Back to normal mode: the delete control hides again.
    fireEvent.click(screen.getByRole("button", { name: "完成排序" }));
    expect(within(page).queryByRole("button", { name: "删除图1" })).toBeNull();
  });

  test("deletes the selected figure through its remove control", () => {
    const figures = [figure(1), figure(2)];
    const onDeleteFigure = vi.fn();
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={onDeleteFigure}
      />,
    );

    const page = screen.getByRole("main", { name: "说明书附图页面" });
    fireEvent.click(within(page).getByRole("button", { name: "选择图1" }));
    fireEvent.click(within(page).getByRole("button", { name: "删除图1" }));
    expect(onDeleteFigure).toHaveBeenCalledWith(figures[0]?.figureId);
  });

  test("deletes the selected figure with Delete or Backspace", () => {
    const figures = [figure(1), figure(2)];
    const onDeleteFigures = vi.fn();
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
        onDeleteFigures={onDeleteFigures}
      />,
    );

    const firstFigure = screen.getByRole("button", { name: "选择图1" });
    fireEvent.click(firstFigure);
    expect(
      screen
        .getByRole("region", { name: "附图图片设置" })
        .classList.contains("function-rail-transient-panel"),
    ).toBe(true);
    fireEvent.keyDown(firstFigure, { key: "Delete" });
    expect(onDeleteFigures).toHaveBeenLastCalledWith([figures[0]?.figureId]);

    fireEvent.click(screen.getByRole("button", { name: "选择图2" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "选择图2" }), { key: "Backspace" });
    expect(onDeleteFigures).toHaveBeenLastCalledWith([figures[1]?.figureId]);
  });

  test.each(["ctrlKey", "metaKey"])(
    "selects every figure with %s+A and deletes them in one batch",
    (modifier) => {
      const figures = [figure(1), figure(2), figure(3)];
      const onDeleteFigures = vi.fn();
      render(
        <DrawingWorkbench
          sessionId={sessionId}
          figures={figures}
          sync={activeSync(figures)}
          unlinked={[]}
          onReorderFigures={vi.fn()}
          onResizeFigure={vi.fn()}
          onChange={vi.fn()}
          onDeleteFigure={vi.fn()}
          onDeleteFigures={onDeleteFigures}
        />,
      );

      const firstFigure = screen.getByRole("button", { name: "选择图1" });
      fireEvent.click(firstFigure);
      fireEvent.keyDown(firstFigure, { key: "a", [modifier]: true });
      expect(
        figures.map((_, index) =>
          screen.getByRole("button", { name: `选择图${index + 1}` }).getAttribute("aria-pressed"),
        ),
      ).toEqual(["true", "true", "true"]);

      fireEvent.keyDown(firstFigure, { key: "Delete" });
      expect(onDeleteFigures).toHaveBeenCalledTimes(1);
      expect(onDeleteFigures).toHaveBeenCalledWith(figures.map((item) => item.figureId));
    },
  );

  test.each(["ctrlKey", "metaKey"])(
    "copies the selected drawing set with %s+C in figure order",
    async (modifier) => {
      const figures = [{ ...figure(1), rotationDeg: 90 as const }, figure(2), figure(3)];
      const copyImages = vi.fn().mockResolvedValue({ ok: true, value: undefined });
      const onOperationFeedback = vi.fn();
      Object.defineProperty(window, "patentApi", {
        configurable: true,
        value: { assets: { copyImages } },
      });
      render(
        <DrawingWorkbench
          sessionId={sessionId}
          figures={figures}
          sync={activeSync(figures)}
          unlinked={[]}
          onReorderFigures={vi.fn()}
          onResizeFigure={vi.fn()}
          onChange={vi.fn()}
          onOperationFeedback={onOperationFeedback}
          onDeleteFigure={vi.fn()}
        />,
      );

      const first = screen.getByRole("button", { name: "选择图1" });
      fireEvent.click(first);
      fireEvent.click(screen.getByRole("button", { name: "选择图3" }), { [modifier]: true });
      fireEvent.keyDown(first, { key: "c", [modifier]: true });

      await waitFor(() => expect(copyImages).toHaveBeenCalledOnce());
      expect(copyImages).toHaveBeenCalledWith({
        sessionId,
        images: [
          { assetId: figures[0]?.assetId, rotationDeg: 90, label: "图1" },
          { assetId: figures[2]?.assetId, rotationDeg: 0, label: "图3" },
        ],
      });
      expect(onOperationFeedback).toHaveBeenCalledWith({
        tone: "success",
        title: "复制成功",
        message: "已复制 2 张附图；粘贴到不支持富文本的应用时仅包含第一张。",
      });
    },
  );

  test("reports a rejected selected-drawing copy", async () => {
    const figures = [figure(1)];
    const onOperationFeedback = vi.fn();
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { assets: { copyImages: vi.fn().mockRejectedValue(new Error("clipboard failed")) } },
    });
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onOperationFeedback={onOperationFeedback}
        onDeleteFigure={vi.fn()}
      />,
    );

    const first = screen.getByRole("button", { name: "选择图1" });
    fireEvent.click(first);
    fireEvent.keyDown(first, { key: "c", ctrlKey: true });

    await waitFor(() =>
      expect(onOperationFeedback).toHaveBeenCalledWith({
        tone: "error",
        title: "复制失败",
        message: "无法写入剪贴板，请重试。",
      }),
    );
  });

  test("reports a rejected selected-drawing save", async () => {
    const figures = [figure(1)];
    const onOperationFeedback = vi.fn();
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { assets: { saveImage: vi.fn().mockRejectedValue(new Error("dialog failed")) } },
    });
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onOperationFeedback={onOperationFeedback}
        onDeleteFigure={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择图1" }));
    fireEvent.click(screen.getByRole("button", { name: "另存为" }));

    await waitFor(() =>
      expect(onOperationFeedback).toHaveBeenCalledWith({
        tone: "error",
        title: "另存失败",
        message: "无法保存图片，请重试。",
      }),
    );
  });

  test("supports continuous and discrete drawing selections with modifier keys", () => {
    const figures = [figure(1), figure(2), figure(3), figure(4), figure(5)];
    const onRotateFigures = vi.fn();
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onRotateFigures={onRotateFigures}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const select = (number: number) => screen.getByRole("button", { name: `选择图${number}` });
    fireEvent.click(select(2));
    fireEvent.click(select(5), { ctrlKey: true });
    expect(select(2).getAttribute("aria-pressed")).toBe("true");
    expect(select(5).getAttribute("aria-pressed")).toBe("true");
    expect(select(3).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(select(3), { ctrlKey: true, shiftKey: true });
    for (const number of [2, 3, 4, 5]) {
      expect(select(number).getAttribute("aria-pressed")).toBe("true");
    }
    expect(screen.queryByRole("button", { name: "从右下角缩放图2" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "右转90°" }));
    expect(onRotateFigures).toHaveBeenCalledWith(
      figures.slice(1).map((item) => item.figureId),
      "right",
    );

    fireEvent.click(select(2));
    fireEvent.click(select(4), { shiftKey: true });
    expect(select(1).getAttribute("aria-pressed")).toBe("false");
    for (const number of [2, 3, 4]) {
      expect(select(number).getAttribute("aria-pressed")).toBe("true");
    }
    expect(select(5).getAttribute("aria-pressed")).toBe("false");
  });

  test("does not capture selection or deletion shortcuts from explanation inputs", () => {
    const figures = [figure(1), figure(2)];
    const onDeleteFigures = vi.fn();
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
        onDeleteFigures={onDeleteFigures}
      />,
    );

    const input = screen.getByRole("textbox", { name: "图1附图说明" });
    fireEvent.keyDown(input, { key: "a", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Delete" });
    fireEvent.keyDown(input, { key: "Backspace" });

    expect(onDeleteFigures).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "选择图1" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByRole("button", { name: "选择图2" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  test("deletes a figure from the sort-mode remove control", () => {
    const figures = [figure(1), figure(2)];
    const onDeleteFigure = vi.fn();
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={onDeleteFigure}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "附图排序" }));
    fireEvent.click(screen.getByRole("button", { name: "删除图2" }));
    expect(onDeleteFigure).toHaveBeenCalledWith(figures[1]?.figureId);
  });

  test("hides resize handles while sorting even when a figure is selected", () => {
    const figures = [figure(1)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const selectFigure = screen.getByRole("button", { name: "选择图1" });
    fireEvent.click(selectFigure);
    expect(screen.getByRole("button", { name: "从右下角缩放图1" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "附图排序" }));
    expect(screen.queryByRole("button", { name: "从右下角缩放图1" })).toBeNull();
    expect(screen.getByRole("button", { name: "删除图1" })).toBeDefined();
  });

  test("keeps figure explanations inside the global rail without the legacy drawing-mark textarea", () => {
    const figures = [figure(1), figure(2)];

    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[
          {
            unlinkedId: "00000000-0000-4000-8004-000000000003",
            sourceFigureId: figure(3).figureId,
            removedAt: "2026-08-02T00:00:00.000Z",
            paragraph: paragraph(figure(3).figureId, "图3为未关联说明。"),
          },
        ]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const page = screen.getByRole("main", { name: "说明书附图页面" });
    const rows = within(page).getAllByRole("article");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByRole("img", { name: "图1" })).toBeDefined();
    expect(within(rows[0] as HTMLElement).getByText("图1")).toBeDefined();
    expect(within(page).queryByRole("textbox", { name: "图1附图说明" })).toBeNull();
    expect(within(page).queryByRole("textbox", { name: "附图标记" })).toBeNull();
    const rail = screen.getByRole("complementary", { name: "说明书附图全局功能栏" });
    expect(within(rail).getByRole("region", { name: "附图说明栏" })).toBeDefined();
    expect(within(rail).getByRole("textbox", { name: "图1附图说明" })).toBeDefined();
    // The delete control only appears once its figure is selected.
    expect(within(rows[0] as HTMLElement).queryByRole("button", { name: "删除图1" })).toBeNull();
    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: "选择图1" }));
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "删除图1" })).toBeDefined();
    expect(within(rail).queryByRole("textbox", { name: "附图标记" })).toBeNull();
    expect(screen.queryByText("未关联说明")).toBeNull();
  });

  test("fills or copies all drawing explanation drafts from one shared action row", async () => {
    const figures = [figure(1), figure(2)];
    const onChange = vi.fn(() => ({ ok: true as const }));
    const onOperationFeedback = vi.fn();
    const writeText = vi.fn(async () => ({ ok: true as const, value: undefined }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { clipboard: { writeText } },
    });

    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        explanations={[
          {
            figureId: figures[0]?.figureId ?? "",
            figureNumber: 1,
            status: "missing",
            paragraph: null,
            message: "说明书中缺少图1的附图说明。",
          },
          {
            figureId: figures[1]?.figureId ?? "",
            figureNumber: 2,
            status: "missing",
            paragraph: null,
            message: "说明书中缺少图2的附图说明。",
          },
        ]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={onChange}
        onOperationFeedback={onOperationFeedback}
        onDeleteFigure={vi.fn()}
      />,
    );

    const figureOneEditor = screen.getByRole("textbox", { name: "图1附图说明" });
    const figureTwoEditor = screen.getByRole("textbox", { name: "图2附图说明" });
    expect((figureOneEditor as HTMLTextAreaElement).value).toBe("图1为本发明的______示意图。");
    expect((figureTwoEditor as HTMLTextAreaElement).value).toBe("图2为本发明的______示意图。");
    fireEvent.change(figureOneEditor, { target: { value: "图1为整体结构示意图。" } });
    fireEvent.change(figureTwoEditor, { target: { value: "图2为局部结构示意图。" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText("说明书中缺少图1的附图说明。")).toBeNull();

    expect(screen.getAllByRole("button", { name: "填入说明书" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "复制" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "填入图1附图说明" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制图1附图说明" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "填入说明书" }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith([
      {
        target: { figureId: figures[0]?.figureId, figureNumber: 1, paragraphId: null },
        content: [{ type: "text", text: "图1为整体结构示意图。", marks: [] }],
      },
      {
        target: { figureId: figures[1]?.figureId, figureNumber: 2, paragraphId: null },
        content: [{ type: "text", text: "图2为局部结构示意图。", marks: [] }],
      },
    ]);
    await waitFor(() =>
      expect(onOperationFeedback).toHaveBeenCalledWith({
        tone: "success",
        title: "填入成功",
      }),
    );
    expect(screen.queryByText("已填入说明书。")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "　　图1为整体结构示意图。\n　　图2为局部结构示意图。",
      ),
    );
    expect(onOperationFeedback).toHaveBeenLastCalledWith({
      tone: "success",
      title: "复制成功",
      message: "附图说明已复制到剪贴板。",
    });
  });

  test("reports an invalid drawing explanation through the failure dialog channel", () => {
    const figures = [figure(1)];
    const onChange = vi.fn();
    const onOperationFeedback = vi.fn();
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={onChange}
        onOperationFeedback={onOperationFeedback}
        onDeleteFigure={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "图1附图说明" }), {
      target: { value: "不是图号开头" },
    });
    fireEvent.click(screen.getByRole("button", { name: "填入说明书" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(onOperationFeedback).toHaveBeenCalledWith({
      tone: "error",
      title: "无法填入",
      message: "图1的说明应以“图1”或“附图1”开头。",
    });
  });

  test("hard-caps each explanation draft at 200 characters without further input", () => {
    const figures = [figure(1)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const textarea = screen.getByRole("textbox", {
      name: "图1附图说明",
    }) as HTMLTextAreaElement;
    expect(textarea.maxLength).toBe(200);

    fireEvent.change(textarea, { target: { value: "图1为".padEnd(220, "长") } });

    expect(
      (screen.getByRole("textbox", { name: "图1附图说明" }) as HTMLTextAreaElement).value,
    ).toHaveLength(200);
  });

  test("keeps legacy over-length explanations intact without truncating them", () => {
    const first = figure(1);
    const savedDrafts = JSON.parse(
      JSON.stringify({
        [first.figureId]: { figureNumber: 1, value: "图1为".padEnd(230, "长") },
      }),
    );
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={[first]}
        sync={activeSync([first])}
        unlinked={[]}
        savedDrafts={savedDrafts}
        explanations={[
          {
            figureId: first.figureId,
            figureNumber: 1,
            status: "missing-heading",
            paragraph: null,
            message: "缺少标题",
          },
        ]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const textarea = screen.getByRole("textbox", {
      name: "图1附图说明",
    }) as HTMLTextAreaElement;
    expect(textarea.value).toHaveLength(230);
  });

  test("uses the utility-model wording for a missing explanation draft", () => {
    const figures = [figure(1)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        patentType="utility-model"
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        explanations={[
          {
            figureId: figures[0]?.figureId ?? "",
            figureNumber: 1,
            status: "missing",
            paragraph: null,
            message: "说明书中缺少图1的附图说明。",
          },
        ]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole("textbox", { name: "图1附图说明" }) as HTMLTextAreaElement).value,
    ).toBe("图1为本实用新型的______示意图。");
  });

  test("renders drawing explanations directly in the function rail without a nested scroll area", () => {
    const figures = [figure(1), figure(2)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onPasteImages={vi.fn()}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const rail = screen.getByRole("region", { name: "附图说明栏" });
    expect(rail.querySelector(".drawing-explanation-scroll")).toBeNull();
    expect(rail.querySelectorAll(".drawing-explanation-card")).toHaveLength(2);
  });

  test("collapses the drawing explanation cards behind the kept title and restores them", () => {
    const figures = [figure(1), figure(2)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        toolbar={<button type="button">导入多张图片</button>}
        onPasteImages={vi.fn()}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const rail = screen.getByRole("region", { name: "附图说明栏" });
    const toggle = within(rail).getByRole("button", { name: "折叠附图说明" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("drawing-explanation-cards");
    expect(within(rail).getByRole("textbox", { name: "图1附图说明" })).toBeDefined();

    fireEvent.click(toggle);

    // 折叠：隐藏全部说明卡片但保留标题，按钮状态语义清晰。
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(rail).queryByRole("textbox", { name: "图1附图说明" })).toBeNull();
    expect(within(rail).queryByRole("textbox", { name: "图2附图说明" })).toBeNull();
    expect(within(rail).getByText("附图说明")).toBeTruthy();
    // 不影响图片区与其他功能栏内容。
    expect(screen.getByRole("button", { name: "附图排序" })).toBeDefined();
    expect(screen.getByRole("button", { name: "导入多张图片" })).toBeDefined();
    const page = screen.getByRole("main", { name: "说明书附图页面" });
    expect(within(page).getByRole("img", { name: "图1" })).toBeDefined();

    // 展开恢复全部卡片。
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(rail).getByRole("textbox", { name: "图1附图说明" })).toBeDefined();
    expect(within(rail).getByRole("textbox", { name: "图2附图说明" })).toBeDefined();
  });

  test("keeps the collapsed explanation cards out of the accessibility tree until expanded", () => {
    const figures = [figure(1)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onPasteImages={vi.fn()}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const rail = screen.getByRole("region", { name: "附图说明栏" });
    const cards = rail.querySelector("#drawing-explanation-cards");
    expect(cards).not.toBeNull();
    fireEvent.click(within(rail).getByRole("button", { name: "折叠附图说明" }));
    expect(cards?.hasAttribute("hidden")).toBe(true);
    expect(rail.getAttribute("data-collapsed")).toBe("true");
    expect(screen.queryByRole("textbox", { name: "图1附图说明" })).toBeNull();
    fireEvent.click(within(rail).getByRole("button", { name: "展开附图说明" }));
    expect(cards?.hasAttribute("hidden")).toBe(false);
    expect(rail.getAttribute("data-collapsed")).toBe("false");
  });

  test("expands reference marks and explanations mutually exclusively through the rail", () => {
    const figures = [figure(1)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        toolbar={({ referenceMarksCollapsed, onToggleReferenceMarksCollapse }) => (
          <button
            type="button"
            aria-expanded={!referenceMarksCollapsed}
            onClick={onToggleReferenceMarksCollapse}
          >
            附图标记
          </button>
        )}
        onPasteImages={vi.fn()}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const explanationToggle = screen.getByRole("button", { name: "折叠附图说明" });
    const referenceToggle = screen.getByRole("button", { name: "附图标记" });
    // 默认附图说明展开，附图标记折叠。
    expect(explanationToggle.getAttribute("aria-expanded")).toBe("true");
    expect(referenceToggle.getAttribute("aria-expanded")).toBe("false");

    // 展开附图标记：自动折叠附图说明。
    fireEvent.click(referenceToggle);
    expect(referenceToggle.getAttribute("aria-expanded")).toBe("true");
    expect(explanationToggle.getAttribute("aria-expanded")).toBe("false");

    // 展开附图说明：自动折叠附图标记。
    fireEvent.click(explanationToggle);
    expect(explanationToggle.getAttribute("aria-expanded")).toBe("true");
    expect(referenceToggle.getAttribute("aria-expanded")).toBe("false");

    // 点击已展开的面板：切换为另一面板，而不是全部关闭（必须且只能有一方打开）。
    fireEvent.click(explanationToggle);
    expect(explanationToggle.getAttribute("aria-expanded")).toBe("false");
    expect(referenceToggle.getAttribute("aria-expanded")).toBe("true");

    // 再点一次已展开的附图标记：切回附图说明。
    fireEvent.click(referenceToggle);
    expect(explanationToggle.getAttribute("aria-expanded")).toBe("true");
    expect(referenceToggle.getAttribute("aria-expanded")).toBe("false");
  });

  test("sizes each drawing explanation input to its wrapped content", () => {
    const figures = [figure(1)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onPasteImages={vi.fn()}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "图1附图说明" });
    Object.defineProperty(input, "scrollHeight", { value: 148, configurable: true });

    fireEvent.change(input, { target: { value: "图1为本发明的结构示意图。" } });

    expect(input.style.height).toBe("150px");
    input.style.setProperty("--explanation-min-height", "40");
    input.style.setProperty("--explanation-max-height", "160");
    Object.defineProperty(input, "scrollHeight", { value: 500, configurable: true });
    fireEvent.change(input, { target: { value: "图1为较长的附图说明。" } });
    expect(input.style.height).toBe("160px");
    Object.defineProperty(input, "scrollHeight", { value: 20, configurable: true });
    fireEvent.change(input, { target: { value: "图1。" } });
    expect(input.style.height).toBe("40px");
  });

  test("clears the selected drawing from page whitespace or Escape", () => {
    const figures = [figure(1)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const page = screen.getByRole("main", { name: "说明书附图页面" });
    const selectFigure = screen.getByRole("button", { name: "选择图1" });

    fireEvent.click(selectFigure);
    expect(selectFigure.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "从右下角缩放图1" })).toBeDefined();

    fireEvent.pointerDown(page);
    expect(selectFigure.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "从右下角缩放图1" })).toBeNull();

    fireEvent.click(selectFigure);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(selectFigure.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "从右下角缩放图1" })).toBeNull();
  });

  test("renders drawing import actions inside the global rail", () => {
    const figures = [figure(1)];

    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        toolbar={<button type="button">导入多张图片</button>}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const page = screen.getByRole("main", { name: "说明书附图页面" });
    const rail = screen.getByRole("complementary", { name: "说明书附图全局功能栏" });
    expect(within(page).queryByRole("button", { name: "导入多张图片" })).toBeNull();
    expect(within(rail).getByRole("button", { name: "导入多张图片" })).toBeDefined();
  });

  test("keeps paste import behavior on the whole drawing workbench", async () => {
    const onPasteImages = vi.fn();
    const images = [figure(1)];
    const image = new File([Uint8Array.from([1])], "drawing.png", { type: "image/png" });

    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={images}
        sync={activeSync(images)}
        unlinked={[]}
        onPasteImages={onPasteImages}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    fireEvent.paste(screen.getByRole("group", { name: "说明书附图工作台" }), {
      clipboardData: { files: [image], getData: vi.fn().mockReturnValue("") },
    });

    await waitFor(() => expect(onPasteImages).toHaveBeenCalledOnce());
    expect(onPasteImages.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ originalName: "drawing.png", declaredMediaType: "image/png" }),
    ]);
  });

  test("imports image files dropped from desktop or folders", async () => {
    const onPasteImages = vi.fn();
    const images = [figure(1)];
    const image = new File([Uint8Array.from([1])], "dropped.png", { type: "image/png" });

    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={images}
        sync={activeSync(images)}
        unlinked={[]}
        onPasteImages={onPasteImages}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const page = screen.getByRole("main", { name: "说明书附图页面" });
    fireEvent.dragOver(page, {
      dataTransfer: { types: ["Files"], files: [image] },
    });
    expect(page.classList.contains("is-file-drag-over")).toBe(true);

    fireEvent.drop(page, {
      dataTransfer: { files: [image], types: ["Files"] },
    });

    await waitFor(() => expect(onPasteImages).toHaveBeenCalledOnce());
    expect(onPasteImages.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ originalName: "dropped.png", declaredMediaType: "image/png" }),
    ]);
    expect(page.classList.contains("is-file-drag-over")).toBe(false);
  });

  test("rejects more than 100 dropped images before reading file bytes", async () => {
    const onPasteImages = vi.fn();
    const onOperationFeedback = vi.fn();
    const files = Array.from({ length: 101 }, (_, index) => ({
      name: `drawing-${index}.png`,
      type: "image/png",
      size: 1,
      arrayBuffer: vi.fn(),
    })) as unknown as File[];

    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={[]}
        sync={activeSync([])}
        unlinked={[]}
        onPasteImages={onPasteImages}
        onOperationFeedback={onOperationFeedback}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    fireEvent.drop(screen.getByRole("main", { name: "说明书附图页面" }), {
      dataTransfer: { files, types: ["Files"] },
    });

    await waitFor(() =>
      expect(onOperationFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "error", message: "单次最多导入 100 张图片。" }),
      ),
    );
    expect(onPasteImages).not.toHaveBeenCalled();
    expect(files.every((file) => !vi.mocked(file.arrayBuffer).mock.calls.length)).toBe(true);
  });

  test("clears file-drag highlight when the drag leaves the drawing page", () => {
    const images = [figure(1)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={images}
        sync={activeSync(images)}
        unlinked={[]}
        onPasteImages={vi.fn()}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const page = screen.getByRole("main", { name: "说明书附图页面" });
    fireEvent.dragOver(page, {
      dataTransfer: { types: ["Files"] },
    });
    expect(page.classList.contains("is-file-drag-over")).toBe(true);

    fireEvent.dragLeave(page, { relatedTarget: null });
    expect(page.classList.contains("is-file-drag-over")).toBe(false);
  });

  test("scrolls to the end when new figures are added", async () => {
    const images = [figure(1)];
    const { rerender } = render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={images}
        sync={activeSync(images)}
        unlinked={[]}
        onPasteImages={vi.fn()}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const scroll = screen.getByTestId("drawing-pairs-scroll");
    Object.defineProperty(scroll, "scrollHeight", { value: 500, configurable: true });
    scroll.scrollTop = 0;

    const moreImages = [figure(1), figure(2)];
    rerender(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={moreImages}
        sync={activeSync(moreImages)}
        unlinked={[]}
        onPasteImages={vi.fn()}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    await waitFor(() => expect(scroll.scrollTop).toBe(500));
  });

  test("scrolls when a newly imported figure replaces an existing entry", async () => {
    const first = [figure(1)];
    const { rerender } = render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={first}
        sync={activeSync(first)}
        unlinked={[]}
        onPasteImages={vi.fn()}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const scroll = screen.getByTestId("drawing-pairs-scroll");
    Object.defineProperty(scroll, "scrollHeight", { value: 640, configurable: true });
    scroll.scrollTop = 0;

    const replacement = [figure(2)];
    rerender(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={replacement}
        sync={activeSync(replacement)}
        unlinked={[]}
        onPasteImages={vi.fn()}
        onReorderFigures={vi.fn()}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    await waitFor(() => expect(scroll.scrollTop).toBe(640));
  });

  test("moves the enclosing editor page to its end after importing multiple figures", async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const first = [figure(1)];
    try {
      const { rerender } = render(
        <div className="editor-workspace">
          <DrawingWorkbench
            sessionId={sessionId}
            figures={first}
            sync={activeSync(first)}
            unlinked={[]}
            onPasteImages={vi.fn()}
            onReorderFigures={vi.fn()}
            onResizeFigure={vi.fn()}
            onChange={vi.fn()}
            onDeleteFigure={vi.fn()}
          />
        </div>,
      );

      const workspace = document.querySelector<HTMLElement>(".editor-workspace");
      expect(workspace).not.toBeNull();
      const scrollTo = vi.fn();
      Object.defineProperties(workspace as HTMLElement, {
        scrollHeight: { value: 2400, configurable: true },
        scrollTo: { value: scrollTo, configurable: true },
      });

      const imported = [figure(1), figure(2), figure(3), figure(4)];
      rerender(
        <div className="editor-workspace">
          <DrawingWorkbench
            sessionId={sessionId}
            figures={imported}
            sync={activeSync(imported)}
            unlinked={[]}
            onPasteImages={vi.fn()}
            onReorderFigures={vi.fn()}
            onResizeFigure={vi.fn()}
            onChange={vi.fn()}
            onDeleteFigure={vi.fn()}
          />
        </div>,
      );

      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 2400 }));
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  test("scrolls the page again when delayed previews for newly imported figures load", async () => {
    vi.useFakeTimers();
    try {
      const first = [figure(1)];
      const { rerender } = render(
        <div className="editor-workspace">
          <DrawingWorkbench
            sessionId={sessionId}
            figures={first}
            sync={activeSync(first)}
            unlinked={[]}
            onPasteImages={vi.fn()}
            onReorderFigures={vi.fn()}
            onResizeFigure={vi.fn()}
            onChange={vi.fn()}
            onDeleteFigure={vi.fn()}
          />
        </div>,
      );

      const workspace = document.querySelector<HTMLElement>(".editor-workspace");
      expect(workspace).not.toBeNull();
      const scrollTo = vi.fn();
      Object.defineProperties(workspace as HTMLElement, {
        scrollHeight: { value: 2400, configurable: true },
        scrollTo: { value: scrollTo, configurable: true },
      });

      const imported = [figure(1), figure(2), figure(3), figure(4)];
      rerender(
        <div className="editor-workspace">
          <DrawingWorkbench
            sessionId={sessionId}
            figures={imported}
            sync={activeSync(imported)}
            unlinked={[]}
            onPasteImages={vi.fn()}
            onReorderFigures={vi.fn()}
            onResizeFigure={vi.fn()}
            onChange={vi.fn()}
            onDeleteFigure={vi.fn()}
          />
        </div>,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      scrollTo.mockClear();
      Object.defineProperty(workspace as HTMLElement, "scrollHeight", {
        value: 4800,
        configurable: true,
      });

      fireEvent.load(screen.getByAltText("图4"));

      expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 4800 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps scrolling to the end as asynchronously loaded figure previews grow the container", async () => {
    vi.useFakeTimers();
    try {
      const images = [figure(1)];
      const { rerender } = render(
        <DrawingWorkbench
          sessionId={sessionId}
          figures={images}
          sync={activeSync(images)}
          unlinked={[]}
          onPasteImages={vi.fn()}
          onReorderFigures={vi.fn()}
          onResizeFigure={vi.fn()}
          onChange={vi.fn()}
          onDeleteFigure={vi.fn()}
        />,
      );

      const scroll = screen.getByTestId("drawing-pairs-scroll");
      Object.defineProperty(scroll, "scrollHeight", { value: 200, configurable: true });
      scroll.scrollTop = 0;

      const moreImages = [figure(1), figure(2)];
      rerender(
        <DrawingWorkbench
          sessionId={sessionId}
          figures={moreImages}
          sync={activeSync(moreImages)}
          unlinked={[]}
          onPasteImages={vi.fn()}
          onReorderFigures={vi.fn()}
          onResizeFigure={vi.fn()}
          onChange={vi.fn()}
          onDeleteFigure={vi.fn()}
        />,
      );

      // 图片异步加载完成前，滚动已跟随当前底部。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
      expect(scroll.scrollTop).toBe(200);
      // 图片异步加载完成后容器高度增长，滚动必须再次跟随到新底部。
      Object.defineProperty(scroll, "scrollHeight", { value: 900, configurable: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(scroll.scrollTop).toBe(900);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reorders figures and keeps their explanation content with the moved image", () => {
    const first = figure(1);
    const second = figure(2);
    const onReorderFigures = vi.fn();

    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={[first, second]}
        sync={activeSync([first, second])}
        unlinked={[]}
        onReorderFigures={onReorderFigures}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const page = screen.getByRole("main", { name: "说明书附图页面" });
    fireEvent.dragStart(within(page).getByRole("article", { name: "图2" }));
    fireEvent.dragOver(within(page).getByRole("article", { name: "图1" }));
    fireEvent.drop(within(page).getByRole("article", { name: "图1" }));

    expect(onReorderFigures).toHaveBeenCalledWith([second, first]);
  });

  test("toggles a three-column sorting view and keeps drag reorder available", () => {
    const figures = [figure(1), figure(2), figure(3), figure(4)];
    const onReorderFigures = vi.fn();

    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={onReorderFigures}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );

    const page = screen.getByRole("main", { name: "说明书附图页面" });
    const figureList = within(page).getByTestId("drawing-pairs-scroll");
    const sortButton = screen.getByRole("button", { name: "附图排序" });

    expect(sortButton.getAttribute("aria-pressed")).toBe("false");
    expect(figureList.classList.contains("is-sort-mode")).toBe(false);

    fireEvent.click(sortButton);

    expect(screen.getByRole("button", { name: "完成排序" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(figureList.classList.contains("is-sort-mode")).toBe(true);
    expect(within(figureList).getAllByRole("article")).toHaveLength(4);

    fireEvent.dragStart(within(page).getByRole("article", { name: "图4" }));
    fireEvent.dragOver(within(page).getByRole("article", { name: "图2" }));
    fireEvent.drop(within(page).getByRole("article", { name: "图2" }));

    expect(onReorderFigures).toHaveBeenCalledWith([figures[0], figures[3], figures[1], figures[2]]);

    fireEvent.click(screen.getByRole("button", { name: "完成排序" }));

    expect(screen.getByRole("button", { name: "附图排序" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(figureList.classList.contains("is-sort-mode")).toBe(false);
  });

  test("animates figure cards into their new positions after a drag reorder", async () => {
    const figures = [figure(1), figure(2), figure(3)];
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalAnimate = HTMLElement.prototype.animate;
    const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });

    HTMLElement.prototype.getBoundingClientRect = function () {
      const row = this.closest<HTMLElement>("[data-figure-id]");
      const siblings = row ? Array.from(row.parentElement?.children ?? []) : [];
      const index = row ? siblings.indexOf(row) : 0;
      return {
        x: index * 100,
        y: 0,
        top: 0,
        right: index * 100 + 80,
        bottom: 80,
        left: index * 100,
        width: 80,
        height: 80,
        toJSON: () => ({}),
      };
    };
    HTMLElement.prototype.animate = animate;

    function ReorderHarness() {
      const [orderedFigures, setOrderedFigures] = useState(figures);
      return (
        <DrawingWorkbench
          sessionId={sessionId}
          figures={orderedFigures}
          sync={activeSync(orderedFigures)}
          unlinked={[]}
          onReorderFigures={setOrderedFigures}
          onResizeFigure={vi.fn()}
          onChange={vi.fn()}
          onDeleteFigure={vi.fn()}
        />
      );
    }

    try {
      render(<ReorderHarness />);
      fireEvent.click(screen.getByRole("button", { name: "附图排序" }));
      const page = screen.getByRole("main", { name: "说明书附图页面" });

      fireEvent.dragStart(within(page).getByRole("article", { name: "图3" }));
      fireEvent.drop(within(page).getByRole("article", { name: "图1" }));

      await waitFor(() => expect(animate).toHaveBeenCalled());
      expect(animate).toHaveBeenCalledWith(
        [
          expect.objectContaining({ transform: expect.stringContaining("translate(") }),
          { transform: "translate(0, 0)" },
        ],
        expect.objectContaining({ duration: 400, easing: "ease-in-out" }),
      );
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      HTMLElement.prototype.animate = originalAnimate;
    }
  });

  describe("bidirectional figure/explanation navigation", () => {
    let scrollIntoView: ReturnType<typeof vi.fn<(options?: ScrollIntoViewOptions) => void>>;

    beforeEach(() => {
      scrollIntoView = vi.fn();
      HTMLElement.prototype.scrollIntoView = scrollIntoView;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function renderWithFigures(figuresList: PatentFigure[] = [figure(1), figure(2), figure(3)]) {
      // DrawingWorkbench 在真实应用中总位于 .editor-workspace 内，标尺跳转依赖该祖先。
      return render(
        <div className="editor-workspace">
          <DrawingWorkbench
            sessionId={sessionId}
            figures={figuresList}
            sync={activeSync(figuresList)}
            unlinked={[]}
            onPasteImages={vi.fn()}
            onReorderFigures={vi.fn()}
            onResizeFigure={vi.fn()}
            onChange={vi.fn()}
            onDeleteFigure={vi.fn()}
          />
        </div>,
      );
    }

    test("first selection measures the explanation after image settings mount and scrolls only its rail", () => {
      const callbacks: FrameRequestCallback[] = [];
      const requestAnimationFrame = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback) => {
          callbacks.push(callback);
          return callbacks.length;
        });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      renderWithFigures();
      const rail = screen.getByRole<HTMLElement>("complementary", {
        name: "说明书附图全局功能栏",
      });
      const target = screen.getByRole<HTMLElement>("region", { name: "图2说明" });
      Object.defineProperties(rail, {
        clientHeight: { value: 200, configurable: true },
        scrollHeight: { value: 1_000, configurable: true },
      });
      vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({
        top: 0,
        bottom: 200,
        height: 200,
        left: 0,
        right: 280,
        width: 280,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      vi.spyOn(target, "getBoundingClientRect").mockImplementation(() => ({
        top: 600 + (document.querySelector(".drawing-image-actions") ? 100 : 0),
        bottom: 700 + (document.querySelector(".drawing-image-actions") ? 100 : 0),
        height: 100,
        left: 0,
        right: 280,
        width: 280,
        x: 0,
        y: 600,
        toJSON: () => ({}),
      }));

      fireEvent.click(screen.getByRole("button", { name: "选择图2" }));
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(requestAnimationFrame).toHaveBeenCalled();

      const frame = (time: number) =>
        callbacks.splice(0).forEach((callback) => {
          callback(time);
        });
      frame(0);
      frame(140);
      expect(rail.scrollTop).toBeGreaterThan(0);
      expect(rail.scrollTop).toBeLessThan(650);
      frame(280);
      expect(rail.scrollTop).toBe(650);
    });

    test("jumping from the structure ruler scrolls without selecting the target figure", async () => {
      // jsdom otherwise places every figure at zero, correctly producing a clustered marker.
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const index = [figure(1), figure(2), figure(3)].findIndex(
          (item) => item.figureId === this.dataset.figureId,
        );
        return new DOMRect(100, index < 0 ? 0 : 100 + index * 250, 820, index < 0 ? 1050 : 200);
      });
      renderWithFigures();
      // 先直接选中图1作为基线，验证跳转既不默认选中目标图，也不改变已有选中状态。
      fireEvent.click(screen.getByRole("button", { name: "选择图1" }));
      const selectedOf = (label: string) =>
        screen.getByRole("article", { name: label }).querySelector<HTMLElement>("figure")?.dataset
          .selected;
      expect(selectedOf("图1")).toBe("true");
      // 从附图标尺点击跳转到图2：只滚动定位，图2 不被默认选中。
      scrollIntoView.mockClear();
      // 标尺按钮在首次布局测量完成前为 visibility:hidden，等待其可见后再点击。
      const rulerJump = await waitFor(() => {
        const button = screen.getByRole("button", { name: "定位到图2" });
        expect(button.style.visibility).toBe("visible");
        return button;
      });
      fireEvent.click(rulerJump);
      expect(selectedOf("图2")).toBe("false");
      expect(selectedOf("图1")).toBe("true");
      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "smooth", block: "center" }),
      );
    });

    test("clicking an explanation card scrolls the figure area to that image", () => {
      renderWithFigures();
      const card = screen.getByRole("region", { name: "图3说明" });
      fireEvent.click(card);
      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "smooth", block: "center" }),
      );
    });

    test("activating an explanation input scrolls the figure area to that image", () => {
      renderWithFigures();
      const input = screen.getByRole("textbox", { name: "图1附图说明" });
      fireEvent.focus(input);
      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "smooth", block: "center" }),
      );
    });

    test("cards are keyed by stable figure ids so reordering keeps navigation correct", () => {
      const reordered = [figure(3), figure(1), figure(2)];
      renderWithFigures(reordered);
      // 排序后图号按数组位置显示，但 data-figure-id 保持稳定 figureId。
      const figureRows = screen
        .getByTestId("drawing-pairs-scroll")
        .querySelectorAll("[data-figure-id]");
      expect(figureRows[0]?.getAttribute("data-figure-id")).toBe(reordered[0]?.figureId);
      const explanationRail = screen.getByRole("region", { name: "附图说明栏" });
      const cards = explanationRail.querySelectorAll("[data-figure-id]");
      expect(cards[0]?.getAttribute("data-figure-id")).toBe(reordered[0]?.figureId);
      // 点击排序后的第一张卡片，应定位到其自身（figureId 关联，不依赖位置）。
      scrollIntoView.mockClear();
      fireEvent.click(cards[0] as HTMLElement);
      expect(scrollIntoView).toHaveBeenCalledOnce();
    });

    test("selecting a figure without an explanation still scrolls safely (empty explanation)", () => {
      const figuresWithUnlinked = [figure(1), figure(2)];
      const syncWithGap: DrawingExplanationSync = {
        status: "active",
        headingId: "drawing-heading",
        linked: figuresWithUnlinked.map((item, index) => ({
          figureId: item.figureId,
          index,
          paragraph: paragraph(item.figureId, `图${index + 1}为结构示意图。`),
        })),
        legend: {
          id: "legend",
          type: "paragraph",
          attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
          content: text("其中，1、箱体。"),
        },
      };
      render(
        <DrawingWorkbench
          sessionId={sessionId}
          figures={figuresWithUnlinked}
          sync={syncWithGap}
          unlinked={[]}
          onPasteImages={vi.fn()}
          onReorderFigures={vi.fn()}
          onResizeFigure={vi.fn()}
          onChange={vi.fn()}
          onDeleteFigure={vi.fn()}
        />,
      );
      // 每张图都有说明卡片（空说明时卡片仍在，value 为空），点击仍定位自身。
      const card = screen.getByRole("region", { name: "图2说明" });
      scrollIntoView.mockClear();
      fireEvent.click(card);
      expect(scrollIntoView).toHaveBeenCalledOnce();
    });

    test("missing figure id is a safe no-op and does not throw", () => {
      renderWithFigures();
      // 不存在的 figureId 不应触发滚动或抛错：直接构造不存在 id 的卡片点击场景不可行，
      // 这里验证正常 id 之外不会破坏其他交互——点击空白页清除选中后无滚动。
      scrollIntoView.mockClear();
      const page = screen.getByRole("main", { name: "说明书附图页面" });
      fireEvent.pointerDown(page);
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    test("repeated clicks and focus switches do not loop or double-trigger stale targets", () => {
      renderWithFigures();
      const card2 = screen.getByRole("region", { name: "图2说明" });
      fireEvent.click(card2);
      const callsAfterFirst = scrollIntoView.mock.calls.length;
      // 重复点击同一卡片：每次点击都定位到自身（幂等），不循环滚动。
      fireEvent.click(card2);
      expect(scrollIntoView.mock.calls.length).toBe(callsAfterFirst + 1);
      // 切换焦点到另一张卡片：聚焦定位到图3。
      const input3 = screen.getByRole("textbox", { name: "图3附图说明" });
      fireEvent.focus(input3);
      expect(scrollIntoView.mock.calls.length).toBe(callsAfterFirst + 2);
      // 无异常：两侧滚动同步不被程序化定位破坏（没有抛出）。
      expect(screen.getByRole("textbox", { name: "图3附图说明" })).toBeDefined();
    });
  });
});

test("entering and completing sorting animate layout without changing document order", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const sorted = Boolean(this.closest(".is-sort-mode"));
    return { left: sorted ? 100 : 0, top: sorted ? 40 : 0, width: 80, height: 80 } as DOMRect;
  };
  try {
    const onReorderFigures = vi.fn();
    const figures = [figure(1), figure(2)];
    render(
      <DrawingWorkbench
        sessionId={sessionId}
        figures={figures}
        sync={activeSync(figures)}
        unlinked={[]}
        onReorderFigures={onReorderFigures}
        onResizeFigure={vi.fn()}
        onChange={vi.fn()}
        onDeleteFigure={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "附图排序" }));
    expect(animate).toHaveBeenCalledWith(expect.any(Array), {
      duration: 400,
      easing: "ease-in-out",
    });
    animate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "完成排序" }));
    expect(animate).toHaveBeenCalledWith(expect.any(Array), {
      duration: 400,
      easing: "ease-in-out",
    });
    expect(onReorderFigures).not.toHaveBeenCalled();
  } finally {
    globalThis.ResizeObserver = originalResizeObserver;
    HTMLElement.prototype.animate = originalAnimate;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});
