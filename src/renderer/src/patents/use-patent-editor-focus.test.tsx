import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { EditorCommandBus } from "../app/command-bus";
import { usePatentEditorFocus } from "./use-patent-editor-focus";

function commandBus() {
  return {
    focus: vi.fn(() => true),
    setSelectionFromCoordinates: vi.fn(() => true),
  } as unknown as EditorCommandBus;
}

function Harness({
  activeEditorId = "session-1:description",
  enabled = true,
  backgroundEditorId,
  showDialog = false,
  showMenu = false,
  assistantPanel,
  bus,
}: {
  activeEditorId?: string;
  enabled?: boolean;
  backgroundEditorId?: string;
  showDialog?: boolean;
  showMenu?: boolean;
  assistantPanel?: "AI 纠错" | "小栈AI助手";
  bus: EditorCommandBus;
}) {
  const preserveSelectionForPointer = usePatentEditorFocus({
    activeEditorId,
    enabled,
    commandBus: bus,
  });
  return (
    <div data-patent-text-projection={activeEditorId} data-testid="灰色工作区">
      {backgroundEditorId ? (
        <div
          contentEditable
          data-patent-editor-id={backgroundEditorId}
          data-testid="后台编辑器"
          suppressContentEditableWarning
        >
          后台选区
        </div>
      ) : null}
      <div className="patent-book-rich-text">
        <div data-testid="右侧页边距" />
        <div data-testid="文字选择栏" data-patent-selection-gutter={activeEditorId} />
        <div data-patent-editor-id={activeEditorId} tabIndex={-1}>
          <button type="button">正文内部按钮</button>
        </div>
      </div>
      <aside className="document-structure-ruler" data-testid="文档结构标尺" />
      <aside className="patent-global-function-rail-slot" data-testid="功能栏">
        <button type="button">功能栏按钮</button>
        <input aria-label="功能栏输入" />
        <div data-selectable-tool-text tabIndex={-1}>
          电池包主体
        </div>
      </aside>
      <div
        className="tool-bar"
        role="toolbar"
        aria-label="常用工具"
        onPointerDown={(event) => event.preventDefault()}
      >
        <button type="button">加粗</button>
      </div>
      <footer className="status-bar" data-testid="状态栏">
        <span>专利库</span>
        <span>已保存</span>
      </footer>
      <form className="find-replace-panel">
        <button type="button">下一个匹配项</button>
      </form>
      {assistantPanel ? (
        <aside
          className={`assistant-side-panel ${assistantPanel === "小栈AI助手" ? "text-polish-panel" : "ai-correction-panel"}`}
          aria-label={assistantPanel}
        >
          <div className="text-polish-conversation__message">
            <p>对话内容可复制</p>
          </div>
          <button type="button">面板按钮</button>
          <textarea aria-label={`${assistantPanel}输入`} />
        </aside>
      ) : null}
      <input aria-label="搜索" />
      <button type="button">菜单按钮</button>
      <button type="button" onPointerDown={(event) => preserveSelectionForPointer(event.pointerId)}>
        保留选区激活
      </button>
      {showMenu ? <div role="menu">展开的菜单</div> : null}
      {showDialog ? (
        <div role="dialog">
          <input aria-label="弹窗输入" />
        </div>
      ) : null}
    </div>
  );
}

async function flushFocusFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

describe("use patent editor focus", () => {
  test.each(["AI 纠错", "小栈AI助手"] as const)(
    "allows native %s text selection without restoring or changing the patent selection",
    async (assistantPanel) => {
      const bus = commandBus();
      render(<Harness bus={bus} assistantPanel={assistantPanel} />);
      await flushFocusFrame();
      vi.mocked(bus.focus).mockClear();
      const text = screen.getByText("对话内容可复制");
      expect(fireEvent.pointerDown(text, { pointerId: 42 })).toBe(true);
      fireEvent.focusOut(screen.getByTestId("灰色工作区"));
      fireEvent.pointerMove(text, { pointerId: 42, clientX: 100, clientY: 200 });
      fireEvent.pointerUp(text, { pointerId: 42 });
      await flushFocusFrame();
      expect(bus.focus).not.toHaveBeenCalled();
      expect(bus.setSelectionFromCoordinates).not.toHaveBeenCalled();
      expect(
        fireEvent.pointerDown(screen.getByRole("button", { name: "面板按钮" }), { pointerId: 43 }),
      ).toBe(false);
      fireEvent.pointerUp(screen.getByRole("button", { name: "面板按钮" }), { pointerId: 43 });
    },
  );
  test("focuses the active editor when the window gains focus and the page body is active", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);

    window.dispatchEvent(new Event("focus"));
    await flushFocusFrame();

    expect(bus.focus).toHaveBeenCalledWith("session-1:description");
  });

  test("does not steal focus from text inputs or dialogs", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} showDialog />);

    screen.getByLabelText("搜索").focus();
    window.dispatchEvent(new Event("focus"));
    await flushFocusFrame();
    screen.getByLabelText("弹窗输入").focus();
    window.dispatchEvent(new Event("focus"));
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
  });

  test("restores the active editor and collapses a selection after a page-level button interaction", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const button = screen.getByRole("button", { name: "菜单按钮" });
    button.focus();
    fireEvent.pointerUp(button);
    await flushFocusFrame();

    expect(bus.focus).toHaveBeenCalledWith("session-1:description", { collapseSelection: true });
  });

  test("does not restore or collapse selection for an interaction inside the active editor", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    fireEvent.pointerUp(screen.getByRole("button", { name: "正文内部按钮" }));
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
  });

  test("keeps a retained selection through the pointer-up that activates another pane", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const trigger = screen.getByRole("button", { name: "保留选区激活" });
    fireEvent.pointerDown(trigger, { pointerId: 17 });
    fireEvent.pointerUp(trigger, { pointerId: 17 });
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
  });

  test.each(["AI 纠错", "小栈AI助手"] as const)(
    "does not affect the editor when clicking or dragging on the %s panel",
    async (assistantPanel) => {
      const bus = commandBus();
      render(<Harness bus={bus} assistantPanel={assistantPanel} />);
      await flushFocusFrame();
      vi.mocked(bus.focus).mockClear();

      const panel = screen.getByRole("complementary", { name: assistantPanel });
      const button = within(panel).getByRole("button", { name: "面板按钮" });
      fireEvent.pointerDown(button, { pointerId: 11 });
      fireEvent.pointerUp(button, { pointerId: 11 });
      fireEvent.pointerDown(button, { pointerId: 12 });
      fireEvent.pointerMove(document, { pointerId: 12, clientX: 100, clientY: 200 });
      fireEvent.pointerUp(screen.getByTestId("灰色工作区"), {
        pointerId: 12,
        clientX: 100,
        clientY: 300,
      });
      await flushFocusFrame();

      expect(bus.focus).not.toHaveBeenCalled();
      expect(bus.setSelectionFromCoordinates).not.toHaveBeenCalled();
    },
  );

  test("does not collapse the match selected by a find panel action", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    fireEvent.pointerUp(screen.getByRole("button", { name: "下一个匹配项" }));
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
  });

  test("does not change the editor selection when clicking the toolbar", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const toolbarButton = screen.getByRole("button", { name: "加粗" });
    expect(fireEvent.pointerDown(toolbarButton, { pointerId: 1 })).toBe(false);
    fireEvent.pointerUp(toolbarButton, { pointerId: 1 });
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
    expect(bus.setSelectionFromCoordinates).not.toHaveBeenCalled();
  });

  test("does not restore the editor focus after selecting status-bar text", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const statusBar = screen.getByTestId("状态栏");
    fireEvent.pointerDown(statusBar, { pointerId: 7 });
    fireEvent.focusOut(screen.getByTestId("灰色工作区"));
    fireEvent.pointerMove(statusBar, { pointerId: 7, clientX: 120, clientY: 20 });
    fireEvent.pointerUp(statusBar, { pointerId: 7 });
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
    expect(bus.setSelectionFromCoordinates).not.toHaveBeenCalled();
  });

  test("does not start an editor selection when dragging from the toolbar", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const toolbarButton = screen.getByRole("button", { name: "加粗" });
    expect(fireEvent.pointerDown(toolbarButton, { pointerId: 2 })).toBe(false);
    fireEvent.pointerMove(document, { pointerId: 2, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(screen.getByTestId("灰色工作区"), {
      pointerId: 2,
      clientX: 100,
      clientY: 300,
    });
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
    expect(bus.setSelectionFromCoordinates).not.toHaveBeenCalled();
  });

  test("owns a white paper margin click from pointer-down without a second selection update", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const margin = screen.getByTestId("右侧页边距");
    expect(fireEvent.pointerDown(margin, { clientX: 20, clientY: 100, pointerId: 1 })).toBe(false);

    expect(bus.setSelectionFromCoordinates).toHaveBeenCalledWith(
      "session-1:description",
      { x: 20, y: 100 },
      { x: 20, y: 100 },
    );
    expect(bus.setSelectionFromCoordinates).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(margin, { clientX: 20, clientY: 100, pointerId: 1 });

    expect(bus.setSelectionFromCoordinates).toHaveBeenCalledTimes(1);
    expect(bus.focus).not.toHaveBeenCalled();
  });

  test("updates a white paper margin drag selection while the pointer moves", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const margin = screen.getByTestId("右侧页边距");
    fireEvent.pointerDown(margin, { clientX: 20, clientY: 100, pointerId: 1 });
    vi.mocked(bus.setSelectionFromCoordinates).mockClear();
    fireEvent.pointerMove(document, { clientX: 20, clientY: 140, pointerId: 1 });

    expect(bus.setSelectionFromCoordinates).toHaveBeenCalledWith(
      "session-1:description",
      { x: 20, y: 100 },
      { x: 20, y: 140 },
    );

    vi.mocked(bus.setSelectionFromCoordinates).mockClear();
    fireEvent.pointerUp(margin, { clientX: 20, clientY: 140, pointerId: 1 });

    expect(bus.setSelectionFromCoordinates).toHaveBeenCalledWith(
      "session-1:description",
      { x: 20, y: 100 },
      { x: 20, y: 140 },
    );
    expect(bus.focus).not.toHaveBeenCalled();
  });

  test("leaves selection-gutter interactions to the gutter itself", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const gutter = screen.getByTestId("文字选择栏");
    fireEvent.pointerDown(gutter, { clientX: 20, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(gutter, { clientX: 20, clientY: 140, pointerId: 1 });
    await flushFocusFrame();

    expect(bus.setSelectionFromCoordinates).not.toHaveBeenCalled();
    expect(bus.focus).not.toHaveBeenCalled();
  });

  test("places a caret from a click on the gray text projection surface", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const workspace = screen.getByTestId("灰色工作区");
    fireEvent.pointerDown(workspace, { clientX: 900, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(workspace, { clientX: 900, clientY: 100, pointerId: 1 });

    expect(bus.setSelectionFromCoordinates).toHaveBeenCalledWith(
      "session-1:description",
      { x: 900, y: 100 },
      { x: 900, y: 100 },
    );
    expect(bus.focus).not.toHaveBeenCalled();
  });

  test("starts a range selection from the gray pointer-down coordinate", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const workspace = screen.getByTestId("灰色工作区");
    fireEvent.pointerDown(workspace, { clientX: 900, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 900, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(workspace, { clientX: 900, clientY: 180, pointerId: 1 });

    expect(bus.setSelectionFromCoordinates).toHaveBeenCalledWith(
      "session-1:description",
      { x: 900, y: 100 },
      { x: 900, y: 180 },
    );
    expect(bus.focus).not.toHaveBeenCalled();
  });

  test.each(["文档结构标尺", "功能栏"])(
    "does not map %s interactions into the editor",
    async (name) => {
      const bus = commandBus();
      render(<Harness bus={bus} />);
      await flushFocusFrame();
      vi.mocked(bus.focus).mockClear();

      const control = screen.getByTestId(name);
      fireEvent.pointerDown(control, { clientX: 900, clientY: 100, pointerId: 1 });
      fireEvent.pointerUp(control, { clientX: 900, clientY: 100, pointerId: 1 });

      expect(bus.setSelectionFromCoordinates).not.toHaveBeenCalled();
    },
  );

  test("does not collapse the editor selection when clicking a function-rail button", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const button = screen.getByRole("button", { name: "功能栏按钮" });
    fireEvent.pointerDown(button, { pointerId: 3 });
    fireEvent.pointerUp(button, { pointerId: 3 });
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
    expect(bus.setSelectionFromCoordinates).not.toHaveBeenCalled();
  });

  test("prevents a function-rail click from moving focus out of the editor", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const button = screen.getByRole("button", { name: "功能栏按钮" });
    expect(fireEvent.pointerDown(button, { pointerId: 5 })).toBe(false);
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
  });

  test("keeps editable controls in the function rail focusable", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const input = screen.getByRole("textbox", { name: "功能栏输入" });
    expect(fireEvent.pointerDown(input, { pointerId: 6 })).toBe(true);
    fireEvent.pointerUp(input, { pointerId: 6 });
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
  });

  test("allows rail keyword selection without restoring the editor focus", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();
    const keyword = screen.getByText("电池包主体");
    expect(fireEvent.pointerDown(keyword, { pointerId: 7 })).toBe(true);
    keyword.focus();
    fireEvent.pointerUp(keyword, { pointerId: 7 });
    window.dispatchEvent(new Event("focus"));
    await flushFocusFrame();
    expect(bus.focus).not.toHaveBeenCalled();
    expect(bus.setSelectionFromCoordinates).not.toHaveBeenCalled();
  });

  test("does not start an editor selection when dragging from a function-rail button", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const button = screen.getByRole("button", { name: "功能栏按钮" });
    fireEvent.pointerDown(button, { pointerId: 4 });
    fireEvent.pointerMove(document, { pointerId: 4, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(screen.getByTestId("灰色工作区"), {
      pointerId: 4,
      clientX: 100,
      clientY: 300,
    });
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
    expect(bus.setSelectionFromCoordinates).not.toHaveBeenCalled();
  });

  test("does not restore focus while an open menu owns the interaction", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} showMenu />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const button = screen.getByRole("button", { name: "菜单按钮" });
    button.focus();
    fireEvent.pointerUp(button);
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
  });

  test("restores focus after a temporary input loses focus", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    const input = screen.getByLabelText("搜索");
    input.focus();
    input.blur();
    await flushFocusFrame();

    expect(bus.focus).toHaveBeenCalledWith("session-1:description");
  });

  test("focuses the newly active text book and ignores disabled drawing books", async () => {
    const bus = commandBus();
    const { rerender } = render(<Harness bus={bus} activeEditorId="session-1:description" />);
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();

    rerender(<Harness bus={bus} activeEditorId="session-1:claims" />);
    await flushFocusFrame();
    expect(bus.focus).toHaveBeenCalledWith("session-1:claims");

    vi.mocked(bus.focus).mockClear();
    rerender(<Harness bus={bus} activeEditorId="session-1:description-drawings" enabled={false} />);
    window.dispatchEvent(new Event("focus"));
    await flushFocusFrame();
    expect(bus.focus).not.toHaveBeenCalled();
  });

  test("focuses the newly active editor when the previously active patent editor still owns DOM focus", async () => {
    const bus = commandBus();
    const { rerender } = render(
      <Harness
        bus={bus}
        activeEditorId="session-1:description"
        backgroundEditorId="session-1:description"
      />,
    );
    await flushFocusFrame();
    vi.mocked(bus.focus).mockClear();
    screen.getByTestId("后台编辑器").focus();

    rerender(
      <Harness
        bus={bus}
        activeEditorId="session-1:claims"
        backgroundEditorId="session-1:description"
      />,
    );
    await flushFocusFrame();

    expect(bus.focus).toHaveBeenCalledWith("session-1:claims");
  });

  test("does not restore focus during IME composition", async () => {
    const bus = commandBus();
    render(<Harness bus={bus} />);
    vi.mocked(bus.focus).mockClear();

    window.dispatchEvent(new CompositionEvent("compositionstart"));
    window.dispatchEvent(new Event("focus"));
    await flushFocusFrame();

    expect(bus.focus).not.toHaveBeenCalled();
  });
});
