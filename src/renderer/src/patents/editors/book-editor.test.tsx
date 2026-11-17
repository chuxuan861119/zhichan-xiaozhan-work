import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../../../../shared/document/defaults";
import type { AssetDescriptor, PatentBookDocument } from "../../../../shared/document/model";
import type { OpenedPatent } from "../../../../shared/ipc/contract";
import { createBlankPatent } from "../../../../shared/patent/defaults";
import { classifyDescriptionChapterBlock } from "../../../../shared/patent/description";
import type { PatentFigure } from "../../../../shared/patent/model";
import type { ReferenceMarkMutationPlan } from "../../../../shared/patent/reference-mark-operations";
import { EditorCommandBus } from "../../app/command-bus";
import { patentBookEditorId } from "./patent-book-rich-text-editor";
import { matchesReferenceMarkPlanBase } from "../reference-marks/reference-mark-plan-guard";
import {
  type PatentFunctionRailController,
  PatentFunctionRailScope,
  usePatentFunctionRail,
} from "../function-rail/function-rail-context";
import { createPatentSession } from "../patent-reducer";
import { BookEditor } from "./book-editor";

function asset(index: number): AssetDescriptor {
  return {
    assetId: `00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`,
    kind: "image",
    originalName: `figure-${index}.png`,
    mediaType: "image/png",
    extension: "png",
    byteLength: 10 + index,
    sha256: index.toString(16).toUpperCase().padStart(64, "0"),
    widthPx: 100 + index,
    heightPx: 80 + index,
    previewByteLength: 5 + index,
    previewSha256: (100 + index).toString(16).toUpperCase().padStart(64, "0"),
  };
}

function figure(index: number, descriptor = asset(index)): PatentFigure {
  return {
    figureId: `00000000-0000-4000-8002-${index.toString(16).padStart(12, "0")}`,
    assetId: descriptor.assetId,
    widthMm: 80,
  };
}

function session(activeBookKind: OpenedPatent["patent"]["activeBookKind"]) {
  const patent = createBlankPatent({ patentType: "invention", name: "夹具专利" });
  patent.patentId = "00000000-0000-4000-8000-000000000101";
  patent.activeBookKind = activeBookKind;
  const opened: OpenedPatent = {
    patentId: patent.patentId,
    sessionId: "00000000-0000-4000-8000-000000000201",
    revision: 0,
    patent,
    saveState: "saved",
  };
  return createPatentSession(opened);
}

function installDrawingExplanations(state: ReturnType<typeof session>, count = 2) {
  const description = state.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("description book missing");
  description.document.content = [
    {
      id: "00000000-0000-4000-8000-000000000301",
      type: "heading",
      level: 1,
      semanticRole: "description-drawings",
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content: [{ type: "text", text: "附图说明", marks: [] }],
    },
    {
      id: "00000000-0000-4000-8000-000000000302",
      type: "paragraph",
      semanticRole: "description-drawing-explanation",
      figureId: figure(1).figureId,
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content: [{ type: "text", text: "图1为整体结构示意图。", marks: [] }],
    },
    ...(count >= 2
      ? [
          {
            id: "00000000-0000-4000-8000-000000000303",
            type: "paragraph" as const,
            semanticRole: "description-drawing-explanation" as const,
            figureId: figure(2).figureId,
            attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
            content: [{ type: "text" as const, text: "图2为局部放大示意图。", marks: [] }],
          },
        ]
      : []),
    {
      id: "00000000-0000-4000-8000-000000000304",
      type: "paragraph",
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content: [{ type: "text", text: "其中，1、箱体。", marks: [] }],
    },
  ];
  description.editorState = { unlinkedFigureExplanations: [] };
}

function installClaimParagraphs(state: ReturnType<typeof session>, paragraphs: readonly string[]) {
  const claims = state.patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("claims book missing");
  claims.document.content = paragraphs.map((text, index) => ({
    id: `00000000-0000-4000-8000-${(400 + index).toString(16).padStart(12, "0")}`,
    type: "paragraph",
    semanticRole: "claim",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text", text, marks: [] }],
  }));
}

function blockText(document: PatentBookDocument) {
  return document.content
    .filter((block) => block.type === "paragraph")
    .map((block) =>
      block.content.map((inline) => (inline.type === "text" ? inline.text : "")).join(""),
    );
}

function installFunctionRailMeasurementStubs() {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
}

function FunctionRailControllerCapture({
  onCapture,
}: {
  onCapture(controller: PatentFunctionRailController): void;
}) {
  onCapture(usePatentFunctionRail());
  return null;
}

describe("book editor routing", () => {
  test.each(["sequential", "custom", "outside", "stale"])(
    "description numbering routes safely: %s",
    async (entry) => {
      installFunctionRailMeasurementStubs();
      const state = session("description");
      const description = state.patent.books.find((book) => book.kind === "description")!.document;
      const heading = description.content.findIndex(
        (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
      );
      const index = entry === "outside" ? heading - 1 : heading + 1;
      const block = description.content[index]!;
      if (block.type !== "paragraph") throw new Error("fixture");
      block.content = [{ type: "text", text: "支架与支架相连接。", marks: [] }];
      const commandBus = new EditorCommandBus();
      const apply = vi.fn((plan: ReferenceMarkMutationPlan) => {
        expect(matchesReferenceMarkPlanBase(state.patent, plan.before)).toBe(true);
        return true;
      });
      const latest = structuredClone(state.patent);
      const latestBlock = latest.books.find((book) => book.kind === "description")!.document
        .content[index]!;
      if (latestBlock.type !== "paragraph") throw new Error("fixture");
      latestBlock.content = [{ type: "text", text: "支架与另一处最新内容。", marks: [] }];
      const feedback = vi.fn();
      render(
        <BookEditor
          session={state}
          commandBus={commandBus}
          onBookDocumentChange={vi.fn()}
          onApplyReferenceMarkPlan={apply}
          {...(entry === "stale" ? { getReferenceMarkPatentSnapshot: () => latest } : {})}
          onOperationFeedback={feedback}
        />,
      );
      const editorId = patentBookEditorId(state.sessionId, "description");
      await waitFor(() => expect(commandBus.getEditor(editorId)).toBeDefined());
      const editor = commandBus.getEditor(editorId)!;
      let from = 0;
      editor.state.doc.forEach((_node, position, blockIndex) => {
        if (blockIndex === index) from = position + 1;
      });
      act(() => {
        editor.commands.setTextSelection({ from, to: from + 2 });
      });
      const rail = screen.getByRole("complementary", { name: "说明书全局功能栏" });
      if (entry === "custom") {
        fireEvent.click(within(rail).getByRole("button", { name: "自定义编号" }));
        fireEvent.change(screen.getByLabelText("自定义编号数字"), { target: { value: "12" } });
        fireEvent.click(screen.getByRole("button", { name: "确认自定义编号" }));
      } else fireEvent.click(within(rail).getByRole("button", { name: "顺序编号" }));
      if (entry === "outside" || entry === "stale") {
        expect(apply).not.toHaveBeenCalled();
        expect(feedback).toHaveBeenCalledWith(
          expect.objectContaining({
            tone: "error",
            message: expect.stringContaining(entry === "outside" ? "具体实施方式" : "重试"),
          }),
        );
      } else {
        expect(apply).toHaveBeenCalledOnce();
        expect(apply.mock.calls[0]![0]).toMatchObject({
          affectedBookKinds: ["description"],
          historyBookKind: "description",
          after: {
            referenceMarks: [
              expect.objectContaining({ keyword: "支架", number: entry === "custom" ? 12 : 1 }),
            ],
          },
        });
      }
    },
  );

  test("shows contextual image settings in the function rail for a selected book figure", async () => {
    installFunctionRailMeasurementStubs();
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        assets: {
          getPreview: vi.fn(() => new Promise(() => undefined)),
        },
      },
    });
    const state = session("claims");
    const descriptor = asset(9);
    state.patent.assets = [descriptor];
    const claims = state.patent.books.find((book) => book.kind === "claims");
    if (!claims) throw new Error("claims book missing");
    claims.document.content = [
      {
        id: "00000000-0000-4000-8000-000000000908",
        type: "paragraph",
        semanticRole: "claim",
        attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
        content: [{ type: "text", text: "1. 测试权利要求。", marks: [] }],
      },
      {
        id: "00000000-0000-4000-8000-000000000909",
        type: "figure",
        assetId: descriptor.assetId,
        widthMm: 80,
        alignment: "center",
        rotationDeg: 0,
      },
    ];
    const commandBus = new EditorCommandBus();
    const onBookDocumentChange = vi.fn();
    const { container } = render(
      <BookEditor
        session={state}
        commandBus={commandBus}
        onBookDocumentChange={onBookDocumentChange}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    expect(within(rail).queryByRole("region", { name: "图片设置" })).toBeNull();

    await waitFor(() => expect(container.querySelector(".patent-figure")).not.toBeNull());
    const figure = container.querySelector<HTMLElement>(".patent-figure");
    if (!figure) throw new Error("book figure missing");
    fireEvent.click(figure);

    const panel = await within(rail).findByRole("region", { name: "图片设置" });
    expect(rail.querySelector(".patent-global-function-rail__body")?.firstElementChild).toBe(
      panel.closest(".function-rail-transient-slot"),
    );
    expect(within(panel).getByRole("slider", { name: "图片宽度" })).toBeDefined();
    expect(within(panel).getByRole("button", { name: "左对齐" })).toBeDefined();
    expect(within(panel).getByRole("button", { name: "居中" })).toBeDefined();
    expect(within(panel).getByRole("button", { name: "右对齐" })).toBeDefined();
    expect(within(panel).queryByRole("textbox", { name: "图片题注" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "嵌入型" })).toBeDefined();
    expect(within(panel).getByRole("button", { name: "向右旋转90°" })).toBeDefined();

    fireEvent.change(within(panel).getByRole("slider", { name: "图片宽度" }), {
      target: { value: "96" },
    });
    await waitFor(() =>
      expect(onBookDocumentChange).toHaveBeenCalledWith(
        "claims",
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ type: "figure", widthMm: 96 }),
          ]),
        }),
        undefined,
        expect.any(Array),
      ),
    );

    fireEvent.click(within(panel).getByRole("button", { name: "右对齐" }));
    await waitFor(() =>
      expect(onBookDocumentChange).toHaveBeenCalledWith(
        "claims",
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ type: "figure", alignment: "right" }),
          ]),
        }),
        undefined,
        expect.any(Array),
      ),
    );

    fireEvent.click(within(panel).getByRole("button", { name: "向右旋转90°" }));
    await waitFor(() =>
      expect(onBookDocumentChange).toHaveBeenCalledWith(
        "claims",
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ type: "figure", rotationDeg: 90 }),
          ]),
        }),
        undefined,
        expect.any(Array),
      ),
    );

    const editor = commandBus.getEditor(`${state.sessionId}:claims`);
    if (!editor) throw new Error("claims editor missing");
    act(() => editor.commands.setTextSelection(1));
    await waitFor(() =>
      expect(within(rail).queryByRole("region", { name: "图片设置" })).toBeNull(),
    );
  });

  test("reports clear-formatting details through the application feedback channel", async () => {
    installFunctionRailMeasurementStubs();
    const user = userEvent.setup();
    const state = session("claims");
    const commandBus = new EditorCommandBus();
    vi.spyOn(commandBus, "clearExtraFormatting").mockReturnValue({
      ok: true,
      message: "已清除 2 处格式并整理 1 处多余空格。",
    });
    const onOperationFeedback = vi.fn();
    render(
      <BookEditor
        session={state}
        commandBus={commandBus}
        onBookDocumentChange={vi.fn()}
        onOperationFeedback={onOperationFeedback}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    await user.click(within(rail).getByRole("button", { name: "清除多余格式" }));

    expect(onOperationFeedback).toHaveBeenCalledWith({
      tone: "success",
      title: "格式清理完成",
      message: "已清除 2 处格式并整理 1 处多余空格。",
    });
    expect(within(rail).queryByText("已清除 2 处格式并整理 1 处多余空格。")).toBeNull();
  });

  test.each(["claims", "description", "abstract"] as const)(
    "places find and replace first in the %s function rail",
    (bookKind) => {
      installFunctionRailMeasurementStubs();
      const editorSession = session(bookKind);
      const editorId = `${editorSession.sessionId}:${bookKind}`;
      render(
        <PatentFunctionRailScope scopeKey="book-editor-find-position-test" initialSpace="fits">
          <BookEditor
            session={editorSession}
            commandBus={new EditorCommandBus()}
            onBookDocumentChange={vi.fn()}
            findSession={{
              mode: "find",
              scope: "single",
              target: { patentId: editorSession.patentId, kind: "book", bookKind },
              editorId,
              bookmark: null,
            }}
            findQuery="夹具"
          />
        </PatentFunctionRailScope>,
      );

      const findPanel = screen.getByRole("search", { name: "查找和替换" });
      expect(findPanel.closest(".patent-global-function-rail__body")?.firstElementChild).toBe(
        findPanel.closest(".function-rail-transient-slot"),
      );
    },
  );

  test("marks the passive workspace as the active editor text projection surface", async () => {
    installFunctionRailMeasurementStubs();
    const editorSession = session("claims");
    const { container } = render(
      <PatentFunctionRailScope scopeKey="book-editor-selection-boundary-test">
        <BookEditor
          session={editorSession}
          commandBus={new EditorCommandBus()}
          onBookDocumentChange={vi.fn()}
        />
      </PatentFunctionRailScope>,
    );

    const workspace = container.querySelector<HTMLElement>(".patent-book-editor-layout");
    if (!workspace) throw new Error("missing patent editor layout");

    expect(workspace.getAttribute("data-patent-text-projection")).toBe(
      `${editorSession.sessionId}:claims`,
    );
    expect(fireEvent.pointerDown(workspace)).toBe(true);
  });

  test("collapses controlled function rail tools out of the tab order", async () => {
    installFunctionRailMeasurementStubs();
    const user = userEvent.setup();
    render(
      <PatentFunctionRailScope scopeKey="book-editor-test">
        <BookEditor
          session={session("claims")}
          commandBus={new EditorCommandBus()}
          onBookDocumentChange={vi.fn()}
        />
      </PatentFunctionRailScope>,
    );

    const expandButton = screen.getByRole("button", { name: "展开功能栏" });
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");

    await user.click(expandButton);
    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    expect(within(rail).queryByText("权利要求书功能")).toBeNull();
    expect(within(rail).getByRole("button", { name: "固定" })).toBeDefined();
    expect(within(rail).getByRole("button", { name: "收起功能栏" })).toBeDefined();

    await user.click(within(rail).getByRole("button", { name: "收起功能栏" }));
    expect(screen.getByRole("button", { name: "展开功能栏" })).toBeDefined();
  });

  test("moves a fitted collapsed rail to the scope edge and opens it leftward without page layout", async () => {
    installFunctionRailMeasurementStubs();
    const user = userEvent.setup();
    let controller!: PatentFunctionRailController;
    const { container } = render(
      <PatentFunctionRailScope scopeKey="book-editor-edge-test" initialSpace="fits">
        <FunctionRailControllerCapture onCapture={(value) => (controller = value)} />
        <BookEditor
          session={session("claims")}
          commandBus={new EditorCommandBus()}
          onBookDocumentChange={vi.fn()}
        />
      </PatentFunctionRailScope>,
    );

    const pageLayout = container.querySelector<HTMLElement>(".patent-page-with-rail");
    const edgeHost = container.querySelector<HTMLElement>("[data-function-rail-edge-host]");
    const dockedRail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    expect(pageLayout?.contains(dockedRail)).toBe(true);
    expect(within(dockedRail).queryByRole("button", { name: "固定" })).toBeNull();
    expect(within(dockedRail).queryByRole("button", { name: "收起功能栏" })).toBeNull();

    act(() => controller.collapse());
    const expandButton = screen.getByRole("button", { name: "展开功能栏" });
    expect(edgeHost?.contains(expandButton)).toBe(true);
    expect(pageLayout?.contains(expandButton)).toBe(false);

    await user.click(expandButton);
    const edgeRail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    expect(edgeHost?.contains(edgeRail)).toBe(true);
    expect(pageLayout?.contains(edgeRail)).toBe(false);
    expect(
      within(edgeRail).getByRole("button", { name: "固定" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      within(edgeRail)
        .getByRole("button", { name: "收起功能栏" })
        .classList.contains("patent-global-function-rail__header-action"),
    ).toBe(true);

    await user.click(within(edgeRail).getByRole("button", { name: "固定" }));
    // A pinned rail docks when space fits; overlay-only controls leave with the overlay.
    const restoredRail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    expect(pageLayout?.contains(restoredRail)).toBe(true);
    expect(within(restoredRail).queryByRole("button", { name: "固定" })).toBeNull();
    expect(within(restoredRail).queryByRole("button", { name: "收起功能栏" })).toBeNull();
  });

  test("opens after hover delay and stays open when pinned after pointer leave", () => {
    installFunctionRailMeasurementStubs();
    vi.useFakeTimers();
    let unmount: () => void = () => undefined;
    try {
      const rendered = render(
        <PatentFunctionRailScope scopeKey="book-editor-hover-test">
          <BookEditor
            session={session("claims")}
            commandBus={new EditorCommandBus()}
            onBookDocumentChange={vi.fn()}
          />
        </PatentFunctionRailScope>,
      );
      unmount = rendered.unmount;
      const { container } = rendered;
      const slot = container.querySelector<HTMLElement>(".patent-global-function-rail-slot");
      if (!slot) throw new Error("function rail slot missing");

      fireEvent.pointerEnter(slot);
      act(() => vi.advanceTimersByTime(149));
      expect(screen.queryByRole("complementary", { name: "权利要求书全局功能栏" })).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole("complementary", { name: "权利要求书全局功能栏" })).toBeDefined();

      const pinButton = screen.getByRole("button", { name: "固定" });
      expect(pinButton.querySelector("svg")?.getAttribute("data-pin-state")).toBe("unpinned");
      fireEvent.click(pinButton);
      expect(
        screen
          .getByRole("button", { name: "取消固定" })
          .querySelector("svg")
          ?.getAttribute("data-pin-state"),
      ).toBe("pinned");
      fireEvent.blur(pinButton, { relatedTarget: null });
      fireEvent.pointerLeave(slot);
      act(() => vi.advanceTimersByTime(250));
      expect(screen.getByRole("complementary", { name: "权利要求书全局功能栏" })).toBeDefined();
      expect(slot.dataset.reason).toBe("pinned");
    } finally {
      unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("opens a collapsed edge rail temporarily on click and closes after pointer leave", () => {
    installFunctionRailMeasurementStubs();
    vi.useFakeTimers();
    let unmount: () => void = () => undefined;
    try {
      const rendered = render(
        <PatentFunctionRailScope scopeKey="book-editor-click-test">
          <BookEditor
            session={session("claims")}
            commandBus={new EditorCommandBus()}
            onBookDocumentChange={vi.fn()}
          />
        </PatentFunctionRailScope>,
      );
      unmount = rendered.unmount;
      const slot = rendered.container.querySelector<HTMLElement>(
        ".patent-global-function-rail-slot",
      );
      if (!slot) throw new Error("function rail slot missing");

      fireEvent.click(screen.getByRole("button", { name: "展开功能栏" }));
      expect(screen.getByRole("complementary", { name: "权利要求书全局功能栏" })).toBeDefined();
      expect(screen.getByRole("button", { name: "固定" })).toBeDefined();
      expect(slot.dataset.reason).toBe("hover");

      fireEvent.pointerLeave(slot);
      act(() => vi.advanceTimersByTime(249));
      expect(screen.getByRole("complementary", { name: "权利要求书全局功能栏" })).toBeDefined();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByRole("complementary", { name: "权利要求书全局功能栏" })).toBeNull();
    } finally {
      unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("keeps the edge target and panel open under a stationary pointer until it leaves", () => {
    installFunctionRailMeasurementStubs();
    vi.useFakeTimers();
    let unmount: () => void = () => undefined;
    try {
      const rendered = render(
        <PatentFunctionRailScope scopeKey="book-editor-hover-timeout-test">
          <BookEditor
            session={session("claims")}
            commandBus={new EditorCommandBus()}
            onBookDocumentChange={vi.fn()}
          />
        </PatentFunctionRailScope>,
      );
      unmount = rendered.unmount;
      const slot = rendered.container.querySelector<HTMLElement>(
        ".patent-global-function-rail-slot",
      );
      if (!slot) throw new Error("function rail slot missing");

      fireEvent.pointerEnter(slot);
      act(() => vi.advanceTimersByTime(150));
      expect(screen.getByRole("complementary", { name: "权利要求书全局功能栏" })).toBeDefined();

      const edge = screen.getByRole("button", { name: "展开功能栏" });
      act(() => vi.advanceTimersByTime(2000));
      expect(screen.getByRole("complementary", { name: "权利要求书全局功能栏" })).toBeDefined();
      expect(edge.isConnected).toBe(true);
      fireEvent.pointerLeave(slot);
      act(() => vi.advanceTimersByTime(250));
      expect(screen.queryByRole("complementary", { name: "权利要求书全局功能栏" })).toBeNull();
    } finally {
      unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("closes an unpinned rail at 250ms even when it rerenders during the leave delay", () => {
    installFunctionRailMeasurementStubs();
    vi.useFakeTimers();
    let unmount: () => void = () => undefined;
    try {
      const renderTree = () => (
        <PatentFunctionRailScope scopeKey="book-editor-rerender-test">
          <BookEditor
            session={session("claims")}
            commandBus={new EditorCommandBus()}
            onBookDocumentChange={vi.fn()}
          />
        </PatentFunctionRailScope>
      );
      const rendered = render(renderTree());
      unmount = rendered.unmount;
      const slot = rendered.container.querySelector<HTMLElement>(
        ".patent-global-function-rail-slot",
      );
      if (!slot) throw new Error("function rail slot missing");

      fireEvent.pointerEnter(slot);
      act(() => vi.advanceTimersByTime(150));
      expect(screen.getByRole("complementary", { name: "权利要求书全局功能栏" })).toBeDefined();

      fireEvent.pointerLeave(slot);
      act(() => vi.advanceTimersByTime(100));
      rendered.rerender(renderTree());
      act(() => vi.advanceTimersByTime(149));
      expect(screen.getByRole("complementary", { name: "权利要求书全局功能栏" })).toBeDefined();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByRole("complementary", { name: "权利要求书全局功能栏" })).toBeNull();
    } finally {
      unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("releases interaction when focus moves from the rail to the document body", () => {
    installFunctionRailMeasurementStubs();
    vi.useFakeTimers();
    let unmount: () => void = () => undefined;
    try {
      const rendered = render(
        <PatentFunctionRailScope scopeKey="book-editor-focus-test">
          <BookEditor
            session={session("claims")}
            commandBus={new EditorCommandBus()}
            onBookDocumentChange={vi.fn()}
          />
        </PatentFunctionRailScope>,
      );
      unmount = rendered.unmount;
      const slot = rendered.container.querySelector<HTMLElement>(
        ".patent-global-function-rail-slot",
      );
      if (!slot) throw new Error("function rail slot missing");

      fireEvent.pointerEnter(slot);
      act(() => vi.advanceTimersByTime(150));
      const pinButton = screen.getByRole("button", { name: "固定" });
      fireEvent.focus(pinButton);
      fireEvent.pointerLeave(slot);
      act(() => vi.advanceTimersByTime(250));
      expect(slot.dataset.reason).toBe("interaction");

      const collapseButton = screen.getByRole("button", { name: "收起功能栏" });
      fireEvent.blur(pinButton, { relatedTarget: collapseButton });
      expect(slot.dataset.reason).toBe("interaction");

      fireEvent.blur(collapseButton, {
        relatedTarget: screen.getByRole("textbox", { name: "编辑 权利要求书" }),
      });
      expect(screen.queryByRole("complementary", { name: "权利要求书全局功能栏" })).toBeNull();
    } finally {
      unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("clears a pending hover update when the controlled rail unmounts", () => {
    installFunctionRailMeasurementStubs();
    vi.useFakeTimers();
    try {
      let capturedController: PatentFunctionRailController | null = null;
      const rendered = render(
        <PatentFunctionRailScope scopeKey="book-editor-unmount-test">
          <FunctionRailControllerCapture
            onCapture={(controller) => {
              capturedController = controller;
            }}
          />
          <BookEditor
            session={session("claims")}
            commandBus={new EditorCommandBus()}
            onBookDocumentChange={vi.fn()}
          />
        </PatentFunctionRailScope>,
      );
      const slot = rendered.container.querySelector<HTMLElement>(
        ".patent-global-function-rail-slot",
      );
      if (!slot || !capturedController) throw new Error("controlled function rail missing");
      const setHovered = vi.spyOn(capturedController as PatentFunctionRailController, "setHovered");

      fireEvent.pointerEnter(slot);
      rendered.unmount();
      act(() => vi.advanceTimersByTime(150));
      expect(setHovered).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("routes description books to the rich text page editor", async () => {
    render(
      <BookEditor
        session={session("description")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "编辑 说明书" });
    expect(editor).toBeDefined();
    expect(within(editor).getByText("有益效果")).toBeDefined();
  });

  test("renders table controls inside the shared description function rail", async () => {
    const commandBus = new EditorCommandBus();
    const state = session("description");
    render(<BookEditor session={state} commandBus={commandBus} onBookDocumentChange={vi.fn()} />);

    const editorId = `${state.sessionId}:description`;
    await waitFor(() =>
      expect(
        commandBus.insertTable(editorId, {
          rows: 1,
          columns: 1,
          headerRowCount: 0,
          layoutMode: "fit-page",
        }),
      ).toBe(true),
    );

    const rail = screen.getByRole("complementary", { name: "说明书全局功能栏" });
    const tablePanel = await within(rail).findByRole("region", { name: "表格功能" });
    expect(rail.querySelector(".patent-global-function-rail__body")?.firstElementChild).toBe(
      tablePanel.closest(".function-rail-transient-slot"),
    );
    expect(document.querySelector(".table-tools")).toBeNull();
  });

  test("routes claims books to the rich text page editor", async () => {
    render(
      <BookEditor
        session={session("claims")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("textbox", { name: "编辑 权利要求书" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "新增独立权利要求" })).toBeNull();
    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    expect(within(rail).getByRole("group", { name: "权利要求书工具" })).toBeDefined();
    expect(rail.closest(".patent-page-with-rail")).toBeDefined();
  });

  test("keeps the function rail outside the scaled page while reserving its scaled width", async () => {
    render(
      <BookEditor
        session={session("claims")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        zoomPercent={150}
      />,
    );

    const layout = document.querySelector<HTMLElement>(".patent-page-with-rail");
    const pageFrame = document.querySelector<HTMLElement>(".patent-page-zoom-frame");
    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });

    expect(layout?.style.getPropertyValue("--patent-page-zoom")).toBe("1.5");
    expect(pageFrame?.contains(rail)).toBe(false);
    expect(pageFrame?.querySelector(".patent-book-rich-text")).not.toBeNull();
  });

  test("renders an unscaled structure ruler beside claims and description pages only", () => {
    installFunctionRailMeasurementStubs();
    const claimsRender = render(
      <BookEditor
        session={session("claims")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        zoomPercent={150}
      />,
    );
    const claimsRuler = screen.getByRole("complementary", { name: "文档结构标尺" });
    const claimsLayout = claimsRuler.closest<HTMLElement>(".patent-page-with-rail");
    const claimsPage = claimsLayout?.querySelector<HTMLElement>(".patent-page-zoom-frame");
    expect(claimsLayout?.dataset.structureRuler).toBe("true");
    expect(claimsPage?.contains(claimsRuler)).toBe(false);
    expect(claimsRuler.nextElementSibling).toBe(claimsPage);
    claimsRender.unmount();

    const descriptionRender = render(
      <BookEditor
        session={session("description")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("complementary", { name: "文档结构标尺" })).toBeDefined();
    descriptionRender.unmount();

    render(
      <BookEditor
        session={session("abstract")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("complementary", { name: "文档结构标尺" })).toBeNull();
  });

  test("injects --patent-page-margin-* mm variables from the active book document.page", async () => {
    const state = session("claims");
    const claims = state.patent.books.find((book) => book.kind === "claims");
    if (!claims) throw new Error("claims book missing");
    claims.document.page = {
      widthMm: 210,
      heightMm: 297,
      marginTopMm: 30,
      marginRightMm: 20,
      marginBottomMm: 30,
      marginLeftMm: 20,
    };

    render(
      <BookEditor
        session={state}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        zoomPercent={100}
      />,
    );

    const layout = document.querySelector<HTMLElement>(".patent-page-with-rail");
    expect(layout?.style.getPropertyValue("--patent-book-page-width")).toBe("210mm");
    expect(layout?.style.getPropertyValue("--patent-book-page-min-height")).toBe("297mm");
    expect(layout?.style.getPropertyValue("--patent-page-margin-top")).toBe("30mm");
    expect(layout?.style.getPropertyValue("--patent-page-margin-right")).toBe("20mm");
    expect(layout?.style.getPropertyValue("--patent-page-margin-bottom")).toBe("30mm");
    expect(layout?.style.getPropertyValue("--patent-page-margin-left")).toBe("20mm");
  });

  test("claim tools insert editable independent and dependent claim text", async () => {
    const user = userEvent.setup();
    const state = session("claims");
    installClaimParagraphs(state, ["1. 夹具专利，其特征在于："]);
    const onBookDocumentChange = vi.fn();

    render(
      <BookEditor
        session={state}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={onBookDocumentChange}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    await user.click(within(rail).getByRole("button", { name: "插入从权" }));
    expect(onBookDocumentChange).toHaveBeenCalledTimes(1);
    expect(blockText(onBookDocumentChange.mock.calls.at(-1)?.[1])).toContain(
      "2. 根据权利要求 1 所述的夹具专利，其特征在于：",
    );
  });

  test("uses one global function rail shape for text and drawing books", async () => {
    const { unmount } = render(
      <BookEditor
        session={session("claims")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
      />,
    );

    const claimsRail = await screen.findByRole("complementary", {
      name: "权利要求书全局功能栏",
    });
    expect(claimsRail.className).toBe("patent-global-function-rail");
    expect(
      (claimsRail.closest(".patent-global-function-rail-slot") as HTMLElement | null)?.dataset
        .bookKind,
    ).toBe("claims");
    unmount();

    render(
      <BookEditor
        session={session("description-drawings")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
      />,
    );

    const drawingRail = screen.getByRole("complementary", { name: "说明书附图全局功能栏" });
    expect(drawingRail.className).toBe("patent-global-function-rail");
    expect(
      (drawingRail.closest(".patent-global-function-rail-slot") as HTMLElement | null)?.dataset
        .bookKind,
    ).toBe("description-drawings");
  });

  test("routes abstract books to the rich text page editor", async () => {
    render(
      <BookEditor
        session={session("abstract")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
      />,
    );

    const abstractEditor = await screen.findByRole("textbox", { name: "编辑 说明书摘要" });
    expect(abstractEditor).toBeDefined();
    expect(
      abstractEditor.closest(".patent-page-with-rail")?.getAttribute("data-structure-ruler-offset"),
    ).toBe("true");
    expect(screen.queryByLabelText("摘要正文")).toBeNull();
  });

  test("routes drawing books to the drawings editor", () => {
    render(
      <BookEditor
        session={session("description-drawings")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("group", { name: "说明书附图工作台" })).toBeDefined();
    const page = screen.getByRole("main", { name: "说明书附图页面" });
    const rail = screen.getByRole("complementary", { name: "说明书附图全局功能栏" });
    expect(page).toBeDefined();
    expect(within(page).queryByRole("button", { name: "导入多张图片" })).toBeNull();
    expect(within(rail).getByRole("button", { name: "导入图片" })).toBeDefined();
  });

  test("scales the description drawings page without scaling its ruler or function rail", () => {
    render(
      <BookEditor
        session={session("description-drawings")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        zoomPercent={150}
      />,
    );

    const page = screen.getByRole("main", { name: "说明书附图页面" });
    const pageFrame = page.closest<HTMLElement>(".patent-page-zoom-frame");
    const layout = pageFrame?.closest<HTMLElement>(".patent-page-with-rail");
    const ruler = screen.getByRole("complementary", { name: "文档结构标尺" });
    const rail = screen.getByRole("complementary", { name: "说明书附图全局功能栏" });

    expect(layout?.style.getPropertyValue("--patent-page-zoom")).toBe("1.5");
    expect(pageFrame?.contains(ruler)).toBe(false);
    expect(pageFrame?.contains(rail)).toBe(false);
  });

  test("forwards ordered pasted drawing images to the patent import workflow", async () => {
    const onPasteDrawingImages = vi.fn();
    render(
      <BookEditor
        session={session("description-drawings")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        onPasteDrawingImages={onPasteDrawingImages}
      />,
    );
    const image = new File([Uint8Array.from([1])], "drawing.png", { type: "image/png" });

    fireEvent.paste(screen.getByRole("group", { name: "说明书附图工作台" }), {
      clipboardData: { files: [image], getData: vi.fn().mockReturnValue("") },
    });

    await waitFor(() => expect(onPasteDrawingImages).toHaveBeenCalledOnce());
    expect(onPasteDrawingImages.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ originalName: "drawing.png", declaredMediaType: "image/png" }),
    ]);
  });

  test("routes abstract drawing books to the dedicated single-figure selector", () => {
    render(
      <BookEditor
        session={session("abstract-drawing")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
      />,
    );

    const abstractDrawingEditor = screen.getByRole("main", { name: "摘要附图编辑器" });
    expect(abstractDrawingEditor).toBeDefined();
    expect(
      abstractDrawingEditor
        .closest(".patent-page-with-rail")
        ?.getAttribute("data-structure-ruler-offset"),
    ).toBe("true");
    const rail = screen.getByRole("complementary", { name: "摘要附图全局功能栏" });
    expect(within(rail).getByLabelText("摘要附图")).toBeDefined();
    expect(screen.queryByRole("button", { name: "导入多张图片" })).toBeNull();
  });

  test("scales the abstract drawing page without scaling its function rail", () => {
    render(
      <BookEditor
        session={session("abstract-drawing")}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        zoomPercent={150}
      />,
    );

    const page = screen.getByRole("main", { name: "摘要附图编辑器" });
    const pageFrame = page.closest<HTMLElement>(".patent-page-zoom-frame");
    const layout = pageFrame?.closest<HTMLElement>(".patent-page-with-rail");
    const rail = screen.getByRole("complementary", { name: "摘要附图全局功能栏" });

    expect(layout?.style.getPropertyValue("--patent-page-zoom")).toBe("1.5");
    expect(pageFrame?.contains(rail)).toBe(false);
  });

  test("keeps claims-only numbering available when the manual description legend is damaged", () => {
    const state = session("claims");
    installClaimParagraphs(state, ["箱体(1)"]);
    state.patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000000501", number: 1, keyword: "箱体" },
    ];
    state.patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    state.patent.referenceMarkSettings.pendingReview = {
      referenceMarkId: "00000000-0000-4000-8000-000000000501",
      ownerBookKind: "claims",
      previousNumber: 1,
      previousKeyword: "旧箱体",
      number: 1,
      keyword: "箱体",
      counts: { claims: 1, description: 1, abstract: 1 },
      createdAt: "2026-09-02T00:00:00.000Z",
    };
    const description = state.patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    description.document.content = [
      {
        id: "00000000-0000-4000-8000-000000000502",
        type: "paragraph",
        attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
        content: [{ type: "text", text: "损坏的图例", marks: [] }],
      },
    ];
    const onApplyReferenceMarkPlan = vi.fn(() => true);
    render(
      <BookEditor
        session={state}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        onApplyReferenceMarkPlan={onApplyReferenceMarkPlan}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    expect(within(rail).queryByRole("alert")).toBeNull();
    expect(within(rail).getByText("箱体")).toBeTruthy();
    expect(
      (within(rail).getByRole("button", { name: "编辑箱体" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(within(rail).getByRole("button", { name: "顺序编号" })).toBeTruthy();
    expect(within(rail).queryByRole("button", { name: "前往说明书修复" })).toBeNull();
    expect(document.querySelectorAll(".reference-mark-review-match")).toHaveLength(0);
  });

  test.each(["all", "single"])(
    "supplements claims through the %s entry using the latest snapshot",
    async (entry) => {
      installFunctionRailMeasurementStubs();
      const state = session("claims");
      const mark = { referenceMarkId: crypto.randomUUID(), keyword: "箱体", number: 1 };
      state.patent.referenceMarks = [
        mark,
        { referenceMarkId: crypto.randomUUID(), keyword: "底座", number: 2 },
      ];
      const claims = state.patent.books.find((book) => book.kind === "claims")!;
      const body = claims.document.content.find((block) => block.type === "paragraph")!;
      if (body.type !== "paragraph") throw new Error("fixture");
      body.content = [{ type: "text", text: "箱体和底座", marks: [] }];
      const latest = structuredClone(state.patent);
      const latestBody = latest.books
        .find((book) => book.kind === "claims")!
        .document.content.find((block) => block.type === "paragraph")!;
      if (latestBody.type !== "paragraph") throw new Error("fixture");
      latestBody.content = [{ type: "text", text: "箱体和底座及箱体", marks: [] }];
      const apply = vi.fn((_plan: ReferenceMarkMutationPlan) => true);
      const feedback = vi.fn();
      render(
        <BookEditor
          session={state}
          commandBus={new EditorCommandBus()}
          onBookDocumentChange={vi.fn()}
          onApplyReferenceMarkPlan={apply}
          getReferenceMarkPatentSnapshot={() => latest}
          onOperationFeedback={feedback}
        />,
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: entry === "all" ? "增补编号" : "增补编号：箱体",
        }),
      );
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls[0]?.[0]).toMatchObject({
        historyBookKind: "claims",
        affectedBookKinds: ["claims"],
        counts: { claims: entry === "all" ? 3 : 2 },
      });
      expect(feedback).toHaveBeenCalledWith({
        tone: "success",
        title: `增补成功，共补充 ${entry === "all" ? 3 : 2} 处编号。`,
      });
    },
  );

  test.each([false, true])(
    "reports whether description numbers were supplemented (%s)",
    (alreadyNumbered) => {
      installFunctionRailMeasurementStubs();
      const state = session("description");
      state.patent.referenceMarks = [
        { referenceMarkId: crypto.randomUUID(), keyword: "箱体", number: 1 },
      ];
      const description = state.patent.books.find((book) => book.kind === "description");
      if (!description) throw new Error("fixture");
      const heading = description.document.content.findIndex(
        (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
      );
      const body = description.document.content
        .slice(heading + 1)
        .find((block) => block.type === "paragraph");
      if (body?.type !== "paragraph") throw new Error("fixture");
      body.content = [{ type: "text", text: alreadyNumbered ? "箱体1" : "箱体", marks: [] }];
      const latestPatent = structuredClone(state.patent);
      // The save queue has the latest keystroke before the React session catches up.
      body.content = [{ type: "text", text: "旧内容", marks: [] }];
      const onApplyReferenceMarkPlan = vi.fn((_plan: ReferenceMarkMutationPlan) => true);
      const onOperationFeedback = vi.fn();
      render(
        <BookEditor
          session={state}
          commandBus={new EditorCommandBus()}
          onBookDocumentChange={vi.fn()}
          onApplyReferenceMarkPlan={onApplyReferenceMarkPlan}
          getReferenceMarkPatentSnapshot={() => latestPatent}
          onOperationFeedback={onOperationFeedback}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "增补编号" }));
      expect(onOperationFeedback).toHaveBeenCalledWith({
        tone: "success",
        title: alreadyNumbered ? "无需增补编号。" : "增补成功，共补充 1 处编号。",
      });
      expect(onApplyReferenceMarkPlan).toHaveBeenCalledTimes(alreadyNumbered ? 0 : 1);
      if (!alreadyNumbered)
        expect(onApplyReferenceMarkPlan.mock.calls[0]?.[0]).toMatchObject({
          historyBookKind: "description",
          affectedBookKinds: ["description"],
        });
    },
  );

  test("smooth-scrolls the description editor to the filled legend after filling", async () => {
    installFunctionRailMeasurementStubs();
    const user = userEvent.setup();
    const state = session("description");
    const legendId = "00000000-0000-4000-8000-000000000901";
    state.patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000000902", number: 1, keyword: "箱体" },
    ];
    const description = state.patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const embodimentsIndex = description.document.content.findIndex(
      (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
    );
    // 预置一个与面板不一致的图例段（填入走“替换”，段 id 保留），保证编辑器 DOM 中可定位。
    description.document.content.splice(embodimentsIndex, 0, {
      id: legendId,
      type: "paragraph",
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content: [{ type: "text", text: "其中：9、旧部件。", marks: [] }],
    });

    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const originalCheckVisibility = HTMLElement.prototype.checkVisibility;
    let targetVisible = false;
    HTMLElement.prototype.checkVisibility = () => targetVisible;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const onApplyReferenceMarkPlan = vi.fn(() => true);
      const onActivateBook = vi.fn();
      render(
        <BookEditor
          session={state}
          commandBus={new EditorCommandBus()}
          onBookDocumentChange={vi.fn()}
          onApplyReferenceMarkPlan={onApplyReferenceMarkPlan}
          onActivateBook={onActivateBook}
        />,
      );
      await user.click(screen.getByRole("button", { name: "填入说明书" }));
      // 图例与面板不一致：先确认覆盖，再执行填入。
      await user.click(screen.getByRole("button", { name: "确认覆盖" }));
      expect(onApplyReferenceMarkPlan).toHaveBeenCalledOnce();
      expect(onActivateBook).toHaveBeenCalledWith("description");
      expect(scrollIntoView).not.toHaveBeenCalled();
      targetVisible = true;
      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith(
          expect.objectContaining({ behavior: "smooth", block: "center" }),
        ),
      );
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      HTMLElement.prototype.checkVisibility = originalCheckVisibility;
    }
  });

  test("locates all proven reference-mark issues and navigates into the next book", async () => {
    installFunctionRailMeasurementStubs();
    const user = userEvent.setup();
    const state = session("claims");
    const referenceMarkId = "00000000-0000-4000-8000-000000009990";
    state.patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "电池包" }];
    installClaimParagraphs(state, ["电池包(2)。"]);
    const description = state.patent.books.find((book) => book.kind === "description");
    const abstractBook = state.patent.books.find((book) => book.kind === "abstract");
    if (!description || !abstractBook) throw new Error("fixture");
    const embodimentsIndex = description.document.content.findIndex(
      (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
    );
    const descriptionBody = description.document.content
      .slice(embodimentsIndex + 1)
      .find((block) => block.type === "paragraph");
    const abstractBody = abstractBook.document.content.find((block) => block.type === "paragraph");
    if (descriptionBody?.type !== "paragraph" || abstractBody?.type !== "paragraph") {
      throw new Error("fixture");
    }
    descriptionBody.content = [{ type: "text", text: "电池包(3)。", marks: [] }];
    abstractBody.content = [{ type: "text", text: "电池包(4)。", marks: [] }];
    const onActivateBook = vi.fn();

    render(
      <BookEditor
        session={state}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        onActivateBook={onActivateBook}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "定位问题" }));
    const locator = screen.getByRole("group", { name: "定位电池包的问题" });
    expect(locator.textContent).toContain("共定位 3 处");
    const visibleIssueIds = new Set(
      Array.from(document.querySelectorAll(".reference-mark-issue-match")).map((element) =>
        element.getAttribute("data-reference-mark-issue-location"),
      ),
    );
    expect(visibleIssueIds.size).toBe(1);

    await user.click(within(locator).getByRole("button", { name: "下一处" }));
    expect(onActivateBook).toHaveBeenLastCalledWith("description");
  });

  test("numbering reports scoped guidance progress only when its mutation succeeds", async () => {
    installFunctionRailMeasurementStubs();
    const state = session("claims");
    installClaimParagraphs(state, ["1. 一种装置，包括底座。"]);
    const commandBus = new EditorCommandBus();
    vi.spyOn(commandBus, "getPlainTextSelection").mockReturnValue({ ok: true, text: "底座" });
    const apply = vi.fn(() => false);
    const progress = vi.fn();
    window.addEventListener("patent-workbench:guidance-progress", progress);
    try {
      render(
        <div data-function-rail-scope="single">
          <BookEditor
            session={state}
            commandBus={commandBus}
            onBookDocumentChange={vi.fn()}
            onApplyReferenceMarkPlan={apply}
            onOperationFeedback={vi.fn()}
          />
        </div>,
      );
      const button = screen.getByRole("button", { name: "顺序编号" });
      fireEvent.click(button);
      expect(progress).not.toHaveBeenCalled();
      apply.mockReturnValue(true);
      fireEvent.click(button);
      expect(progress).toHaveBeenCalledTimes(1);
      expect(progress.mock.calls[0]?.[0].detail).toEqual({
        scope: "single",
        kind: "numbered",
        label: "底座—1",
      });
    } finally {
      window.removeEventListener("patent-workbench:guidance-progress", progress);
    }
  });

  test("prompts a dialog when numbering without a selection", async () => {
    const user = userEvent.setup();
    const state = session("claims");
    const description = state.patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    description.document.content.push({
      id: "00000000-0000-4000-8000-000000000601",
      type: "paragraph",
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content: [{ type: "text", text: "其中：1、箱体。", marks: [] }],
    });
    const onOperationFeedback = vi.fn();
    render(
      <BookEditor
        session={state}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        onOperationFeedback={onOperationFeedback}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    await user.click(within(rail).getByRole("button", { name: "顺序编号" }));

    expect(onOperationFeedback).toHaveBeenCalledWith({
      tone: "error",
      title: "无法编号",
      message: expect.stringContaining("请先选择"),
    });
  });

  test("numbers the selected keyword when Electron does not expose crypto.randomUUID", async () => {
    installFunctionRailMeasurementStubs();
    const user = userEvent.setup();
    const state = session("claims");
    installClaimParagraphs(state, ["1. 一种电池包，包括电池包主体。"]);
    const commandBus = new EditorCommandBus();
    vi.spyOn(commandBus, "getPlainTextSelection").mockReturnValue({
      ok: true,
      text: "电池包主体",
    });
    const focusEditor = vi.spyOn(commandBus, "focus");
    const onApplyReferenceMarkPlan = vi.fn((_plan: ReferenceMarkMutationPlan) => true);
    const onRecentReferenceMarkChange = vi.fn();
    const originalRandomUuid = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });

    try {
      render(
        <BookEditor
          session={state}
          commandBus={commandBus}
          onBookDocumentChange={vi.fn()}
          onApplyReferenceMarkPlan={onApplyReferenceMarkPlan}
          onRecentReferenceMarkChange={onRecentReferenceMarkChange}
        />,
      );

      const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
      await user.click(within(rail).getByRole("button", { name: "顺序编号" }));

      expect(onApplyReferenceMarkPlan).toHaveBeenCalledOnce();
      expect(onApplyReferenceMarkPlan.mock.calls[0]?.[0].after.referenceMarks).toEqual([
        expect.objectContaining({
          keyword: "电池包主体",
          number: 1,
          referenceMarkId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          ),
        }),
      ]);
      expect(onRecentReferenceMarkChange).toHaveBeenCalledWith(
        onApplyReferenceMarkPlan.mock.calls[0]?.[0].after.referenceMarks[0]?.referenceMarkId,
      );
      expect(focusEditor).toHaveBeenCalledWith(expect.stringContaining(":claims"), {
        collapseSelection: true,
      });
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: originalRandomUuid,
      });
    }
  });

  test("requires explicit confirmation before reusing a number found elsewhere in claims", async () => {
    const user = userEvent.setup();
    const state = session("claims");
    installClaimParagraphs(state, ["底座(1)与把手"]);
    const commandBus = new EditorCommandBus();
    vi.spyOn(commandBus, "getPlainTextSelection").mockReturnValue({ ok: true, text: "把手" });
    const onApplyReferenceMarkPlan = vi.fn(() => true);
    const onOperationFeedback = vi.fn();
    render(
      <BookEditor
        session={state}
        commandBus={commandBus}
        onBookDocumentChange={vi.fn()}
        onApplyReferenceMarkPlan={onApplyReferenceMarkPlan}
        onOperationFeedback={onOperationFeedback}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    await user.click(within(rail).getByRole("button", { name: "顺序编号" }));

    const dialog = screen.getByRole("dialog", { name: "序号已在正文中出现" });
    expect(within(dialog).getByText(/底座\(1\)与把手/u)).toBeTruthy();
    expect(onApplyReferenceMarkPlan).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "仍使用序号 1" }));

    expect(onApplyReferenceMarkPlan).toHaveBeenCalledOnce();
    expect(onOperationFeedback).toHaveBeenCalledWith({
      tone: "success",
      title: "编号完成",
      message: "编号完成。",
    });
    expect(screen.queryByRole("dialog", { name: "序号已在正文中出现" })).toBeNull();
    expect(
      document.querySelector('.standard-dialog-overlay[data-motion="exit"][inert]'),
    ).not.toBeNull();
  });

  test("reports success after confirming a custom number found elsewhere in claims", async () => {
    const user = userEvent.setup();
    const state = session("claims");
    installClaimParagraphs(state, ["底座(7)与把手"]);
    const commandBus = new EditorCommandBus();
    vi.spyOn(commandBus, "getPlainTextSelection").mockReturnValue({ ok: true, text: "把手" });
    const onApplyReferenceMarkPlan = vi.fn(() => true);
    const onOperationFeedback = vi.fn();
    render(
      <BookEditor
        session={state}
        commandBus={commandBus}
        onBookDocumentChange={vi.fn()}
        onApplyReferenceMarkPlan={onApplyReferenceMarkPlan}
        onOperationFeedback={onOperationFeedback}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    await user.click(within(rail).getByRole("button", { name: "自定义编号" }));
    await user.type(within(rail).getByLabelText("自定义编号数字"), "7");
    await user.click(within(rail).getByRole("button", { name: "确认自定义编号" }));
    const dialog = screen.getByRole("dialog", { name: "序号已在正文中出现" });

    await user.click(within(dialog).getByRole("button", { name: "仍使用序号 7" }));

    expect(onApplyReferenceMarkPlan).toHaveBeenCalledOnce();
    expect(onOperationFeedback).toHaveBeenCalledWith({
      tone: "success",
      title: "编号完成",
      message: "编号完成。",
    });
  });

  test("prompts when sequential numbering reuses an existing keyword", async () => {
    installFunctionRailMeasurementStubs();
    const user = userEvent.setup();
    const state = session("claims");
    state.patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000000602", number: 2, keyword: "箱体" },
    ];
    installClaimParagraphs(state, ["一种箱体结构。"]);
    const description = state.patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    description.document.content.push({
      id: "00000000-0000-4000-8000-000000000603",
      type: "paragraph",
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content: [{ type: "text", text: "其中：2、箱体。", marks: [] }],
    });
    const commandBus = new EditorCommandBus();
    vi.spyOn(commandBus, "getPlainTextSelection").mockReturnValue({ ok: true, text: "箱体" });
    const onOperationFeedback = vi.fn();
    const onApplyReferenceMarkPlan = vi.fn(() => true);
    render(
      <BookEditor
        session={state}
        commandBus={commandBus}
        onBookDocumentChange={vi.fn()}
        onApplyReferenceMarkPlan={onApplyReferenceMarkPlan}
        onOperationFeedback={onOperationFeedback}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    await user.click(within(rail).getByRole("button", { name: "顺序编号" }));

    expect(onApplyReferenceMarkPlan).toHaveBeenCalledOnce();
    expect(onOperationFeedback).toHaveBeenCalledWith({
      tone: "success",
      title: "“箱体”已编号为 2，沿用原序号",
      message: "“箱体”已编号为 2，本次已沿用原序号。",
    });
  });

  test("lets the user keep interrupted occurrences unchanged when numbering a longer keyword", async () => {
    const user = userEvent.setup();
    const state = session("claims");
    state.patent.referenceMarks = [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000000604",
        number: 1,
        keyword: "自行车",
      },
    ];
    installClaimParagraphs(state, ["自行车(1)把手与后来加入的自行车把手"]);
    const commandBus = new EditorCommandBus();
    vi.spyOn(commandBus, "getPlainTextSelection").mockReturnValue({
      ok: true,
      text: "自行车把手",
    });
    const onApplyReferenceMarkPlan = vi.fn((_plan: ReferenceMarkMutationPlan) => true);
    render(
      <BookEditor
        session={state}
        commandBus={commandBus}
        onBookDocumentChange={vi.fn()}
        onApplyReferenceMarkPlan={onApplyReferenceMarkPlan}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    await user.click(within(rail).getByRole("button", { name: "顺序编号" }));

    const dialog = screen.getByRole("dialog", { name: "检查相似附图标记" });
    expect(dialog.textContent).toContain("另有 1 处");
    expect(dialog.textContent).toContain("自行车(1)把手");
    expect(dialog.textContent).toContain("位置 1");
    expect(dialog.textContent).toContain("后来加入的自行车把手");
    expect(onApplyReferenceMarkPlan).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "仅编号当前关键词" }));
    expect(onApplyReferenceMarkPlan).toHaveBeenCalledOnce();
    const plan = onApplyReferenceMarkPlan.mock.calls[0]?.[0];
    if (!plan) throw new Error("missing plan");
    const claims = plan.after.books.find((book) => book.kind === "claims");
    if (!claims) throw new Error("claims missing");
    expect(blockText(claims.document)).toEqual(["自行车(1)把手与后来加入的自行车把手(2)"]);
  });

  test("repairs interrupted occurrences after custom numbering confirmation", async () => {
    const user = userEvent.setup();
    const state = session("claims");
    state.patent.referenceMarks = [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000000605",
        number: 1,
        keyword: "自行车",
      },
    ];
    installClaimParagraphs(state, ["自行车（1）把手与后来加入的自行车把手"]);
    const commandBus = new EditorCommandBus();
    vi.spyOn(commandBus, "getPlainTextSelection").mockReturnValue({
      ok: true,
      text: "自行车把手",
    });
    const onApplyReferenceMarkPlan = vi.fn((_plan: ReferenceMarkMutationPlan) => true);
    render(
      <BookEditor
        session={state}
        commandBus={commandBus}
        onBookDocumentChange={vi.fn()}
        onApplyReferenceMarkPlan={onApplyReferenceMarkPlan}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "权利要求书全局功能栏" });
    await user.click(within(rail).getByRole("button", { name: "自定义编号" }));
    await user.type(within(rail).getByRole("textbox", { name: "自定义编号数字" }), "9{Enter}");

    const dialog = screen.getByRole("dialog", { name: "检查相似附图标记" });
    expect(within(rail).queryByRole("textbox", { name: "自定义编号数字" })).toBeNull();
    expect(onApplyReferenceMarkPlan).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "同时修复 1 处" }));

    expect(onApplyReferenceMarkPlan).toHaveBeenCalledOnce();
    const plan = onApplyReferenceMarkPlan.mock.calls[0]?.[0];
    if (!plan) throw new Error("missing plan");
    const claims = plan.after.books.find((book) => book.kind === "claims");
    if (!claims) throw new Error("claims missing");
    expect(blockText(claims.document)).toEqual(["自行车把手(9)与后来加入的自行车把手(9)"]);
  });

  test("does not expose the parked cross-document repair action", () => {
    const state = session("claims");
    state.patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000000701", number: 1, keyword: "箱体" },
    ];
    state.patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    const description = state.patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    description.document.content = [
      {
        id: "00000000-0000-4000-8000-000000000702",
        type: "paragraph",
        attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
        content: [{ type: "text", text: "损坏的图例", marks: [] }],
      },
    ];
    const onRequestReferenceMarkRepair = vi.fn();
    render(
      <BookEditor
        session={state}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        onRequestReferenceMarkRepair={onRequestReferenceMarkRepair}
      />,
    );

    expect(screen.queryByRole("button", { name: "前往说明书修复" })).toBeNull();
    expect(onRequestReferenceMarkRepair).not.toHaveBeenCalled();
  });

  test("forwards drawing reorder changes as patent figure state", async () => {
    const firstAsset = asset(1);
    const secondAsset = asset(2);
    const state = session("description-drawings");
    state.patent.assets = [firstAsset, secondAsset];
    state.patent.figures = [figure(1, firstAsset), figure(2, secondAsset)];
    installDrawingExplanations(state);
    const onPatentFiguresChange = vi.fn();

    render(
      <BookEditor
        session={state}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        onPatentFiguresChange={onPatentFiguresChange}
      />,
    );

    fireEvent.dragStart(screen.getByRole("article", { name: "图2" }));
    fireEvent.dragOver(screen.getByRole("article", { name: "图1" }));
    fireEvent.drop(screen.getByRole("article", { name: "图1" }));

    expect(onPatentFiguresChange).toHaveBeenCalledWith(
      [figure(2, secondAsset), figure(1, firstAsset)],
      null,
      [firstAsset, secondAsset],
      { ownerBookKind: "description-drawings", label: "调整附图顺序" },
    );
  });

  test("deletes all selected drawings as one composite patent edit", () => {
    const firstAsset = asset(1);
    const secondAsset = asset(2);
    const state = session("description-drawings");
    state.patent.assets = [firstAsset, secondAsset];
    state.patent.figures = [figure(1, firstAsset), figure(2, secondAsset)];
    state.patent.abstractDrawingFigureId = figure(2).figureId;
    installDrawingExplanations(state);
    const onPatentFiguresChange = vi.fn();

    render(
      <BookEditor
        session={state}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        onPatentFiguresChange={onPatentFiguresChange}
      />,
    );

    const firstFigure = screen.getByRole("button", { name: "选择图1" });
    fireEvent.click(firstFigure);
    fireEvent.keyDown(firstFigure, { key: "a", ctrlKey: true });
    fireEvent.keyDown(firstFigure, { key: "Delete" });

    expect(onPatentFiguresChange).toHaveBeenCalledTimes(1);
    expect(onPatentFiguresChange).toHaveBeenCalledWith([], null, [firstAsset, secondAsset], {
      ownerBookKind: "description-drawings",
      label: "批量删除附图",
    });
  });

  test("edits an existing drawing explanation as an explicit description-book edit", async () => {
    const firstAsset = asset(1);
    const state = session("description-drawings");
    state.patent.assets = [firstAsset];
    state.patent.figures = [figure(1, firstAsset)];
    installDrawingExplanations(state, 1);
    const onPatentFiguresChange = vi.fn();
    const onBookDocumentChange = vi.fn();
    const onActivateBook = vi.fn();
    const onOperationFeedback = vi.fn();
    const commandBus = new EditorCommandBus();
    const replaceDocumentWithHistory = vi
      .spyOn(commandBus, "replaceDocumentWithHistory")
      .mockReturnValue(true);

    function Harness() {
      const [current, setCurrent] = useState(state);
      return (
        <BookEditor
          session={current}
          commandBus={commandBus}
          onBookDocumentChange={(kind, document, editorState) => {
            onBookDocumentChange(kind, document, editorState);
            setCurrent((previous) => ({
              ...previous,
              patent: {
                ...previous.patent,
                books: previous.patent.books.map((book) =>
                  book.kind === kind
                    ? { ...book, document, editorState: editorState ?? book.editorState }
                    : book,
                ),
              },
            }));
          }}
          onPatentFiguresChange={onPatentFiguresChange}
          onActivateBook={onActivateBook}
          onOperationFeedback={onOperationFeedback}
        />
      );
    }
    render(<Harness />);

    const rail = screen.getByRole("complementary", { name: "说明书附图全局功能栏" });
    const railEditor = within(rail).getByRole("textbox", { name: "图1附图说明" });
    fireEvent.change(railEditor, { target: { value: "图1为本发明的整体结构示意图。" } });

    expect(onPatentFiguresChange).not.toHaveBeenCalled();
    expect(onBookDocumentChange).toHaveBeenLastCalledWith(
      "description-drawings",
      expect.anything(),
      {
        drawingExplanationDrafts: {
          [figure(1, firstAsset).figureId]: {
            figureNumber: 1,
            value: "图1为本发明的整体结构示意图。",
          },
        },
      },
    );
    fireEvent.click(within(rail).getByRole("button", { name: "填入说明书" }));
    expect(replaceDocumentWithHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    await waitFor(() => expect(replaceDocumentWithHistory).toHaveBeenCalledOnce());
    expect(replaceDocumentWithHistory).toHaveBeenCalledWith(
      expect.stringContaining(":description"),
      expect.objectContaining({
        type: "doc",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "paragraph",
            attrs: expect.objectContaining({ paragraphIndentMm: 9.88 }),
            content: [
              expect.objectContaining({
                type: "text",
                text: "图1为本发明的整体结构示意图。",
                marks: [
                  expect.objectContaining({
                    type: "textStyle",
                    attrs: expect.objectContaining({ color: "#D92D20" }),
                  }),
                ],
              }),
            ],
          }),
        ]),
      }),
    );
    expect(onBookDocumentChange.mock.calls.every(([kind]) => kind === "description-drawings")).toBe(
      true,
    );
    expect(onActivateBook).toHaveBeenCalledWith("description");
    await waitFor(() =>
      expect(onOperationFeedback).toHaveBeenCalledWith({
        tone: "success",
        title: "填入成功",
      }),
    );
  });

  test("forwards abstract drawing selection as patent figure state", async () => {
    const user = userEvent.setup();
    const firstAsset = asset(1);
    const drawing = figure(1, firstAsset);
    const state = session("abstract-drawing");
    state.patent.assets = [firstAsset];
    state.patent.figures = [drawing];
    const onPatentFiguresChange = vi.fn();

    render(
      <BookEditor
        session={state}
        commandBus={new EditorCommandBus()}
        onBookDocumentChange={vi.fn()}
        onPatentFiguresChange={onPatentFiguresChange}
      />,
    );

    await user.selectOptions(screen.getByLabelText("摘要附图"), drawing.figureId);

    expect(onPatentFiguresChange).toHaveBeenCalledWith([drawing], drawing.figureId, [firstAsset], {
      ownerBookKind: "description-drawings",
      label: "选择摘要附图",
    });
  });
});
