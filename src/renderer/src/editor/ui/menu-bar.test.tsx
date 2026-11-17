import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../../shared/settings/shortcuts";
import { ShortcutProvider } from "../../app/shortcut-dispatcher";
import { capabilitiesForPatentBook } from "../../patents/patent-toolbar-capabilities";
import * as appDialogs from "../../shared/app-dialog";
import { MenuBar } from "./menu-bar";

function createHandlers() {
  return {
    onNewDocument: vi.fn(),
    onOpenDocument: vi.fn(),
    onImportDocx: vi.fn(),
    onSaveDocument: vi.fn(),
    onSaveDocumentAs: vi.fn(),
    onExportDocx: vi.fn(),
    onExportPdf: vi.fn(),
    onPrintPreview: vi.fn(),
    onPrint: vi.fn(),
    onFind: vi.fn(),
    onReplace: vi.fn(),
    onOpenDefaultTemplates: vi.fn(),
    onOpenPageMargins: vi.fn(),
    onOpenDataSafety: vi.fn(),
    onOpenBackupManager: vi.fn(),
    onOpenSnapshotManager: vi.fn(),
    onOpenShortcutSettings: vi.fn(),
    onCreateDesktopShortcut: vi.fn(),
    onOpenThirdPartyNotices: vi.fn(),
    onOpenThirdPartyLicensesFolder: vi.fn(),
  };
}

test.each(["openharmony", "ohos"])("%s hides Agent CLI and network AI tools", (platform) => {
  vi.stubGlobal("documentFontPlatform", platform);
  try {
    render(<MenuBar {...createHandlers()} onOpenAgentCli={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "工具" }));
    expect(screen.queryByRole("menuitem", { name: "Agent CLI" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "AI 纠错" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "小栈AI助手" })).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("list menu items are unavailable for table and other unsupported selections", () => {
  const onCommand = vi.fn();
  render(
    <MenuBar
      {...createHandlers()}
      onCommand={onCommand}
      formatState={{
        bold: false,
        italic: false,
        underline: false,
        subscript: false,
        superscript: false,
        alignment: "left",
        bulletList: false,
        orderedList: false,
        paragraphStyle: "paragraph",
        listToolsAvailable: false,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "格式" }));
  fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "段落" }));
  for (const label of ["项目符号", "编号"]) {
    expect(screen.getByRole("menuitem", { name: label }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  }
  expect(onCommand).not.toHaveBeenCalled();
});

test("paragraph format menu uses the chapter heading label", () => {
  const onParagraphStyle = vi.fn();
  render(<MenuBar {...createHandlers()} onParagraphStyle={onParagraphStyle} />);
  fireEvent.click(screen.getByRole("button", { name: "格式" }));
  fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "段落" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "章节标题" }));
  expect(onParagraphStyle).toHaveBeenCalledExactlyOnceWith(1);
});

test.each(["claims", "abstract"] as const)(
  "%s hides unsupported paragraph headings in the format menu",
  (kind) => {
    render(<MenuBar {...createHandlers()} capabilities={capabilitiesForPatentBook(kind)} />);
    fireEvent.click(screen.getByRole("button", { name: "格式" }));
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "段落" }));
    expect(screen.getByRole("menuitem", { name: "正文" })).toBeDefined();
    for (const label of ["章节标题", "标题 1", "标题 2", "标题 3"])
      expect(screen.queryByRole("menuitem", { name: label })).toBeNull();
  },
);

test("tutorial navigation retains book tabs without unrelated application menus", () => {
  render(
    <MenuBar {...createHandlers()} tutorialMode>
      <button type="button">说明书</button>
    </MenuBar>,
  );
  for (const name of ["文件", "编辑", "插入", "格式", "视图", "工具", "设置", "帮助"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  expect(screen.getByRole("button", { name: "说明书" })).toBeDefined();
});

test("anchors the page submenu to its trigger row", () => {
  const handlers = createHandlers();
  render(<MenuBar {...handlers} />);
  fireEvent.click(screen.getByRole("button", { name: "格式" }));
  const trigger = screen.getByRole("menuitem", { name: "页面" });
  fireEvent.pointerEnter(trigger);
  const submenu = screen.getByRole("menu", { name: "页面格式" });
  expect(trigger.closest(".format-menu__branch")?.contains(submenu)).toBe(true);
  fireEvent.click(screen.getByRole("menuitem", { name: "页边距设置" }));
  expect(handlers.onOpenPageMargins).toHaveBeenCalledOnce();
});

test("mixed paragraph styles do not mark body style as active and can be normalized", () => {
  const onParagraphStyle = vi.fn();
  render(
    <MenuBar
      {...createHandlers()}
      onParagraphStyle={onParagraphStyle}
      formatState={{
        bold: false,
        italic: false,
        underline: false,
        subscript: false,
        superscript: false,
        alignment: "left",
        bulletList: false,
        orderedList: false,
        paragraphStyle: "paragraph",
        mixedParagraphStyle: true,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "格式" }));
  fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "段落" }));
  const body = screen.getByRole("menuitem", { name: "正文" });
  expect(body.hasAttribute("data-active")).toBe(false);
  fireEvent.click(body);
  expect(onParagraphStyle).toHaveBeenCalledExactlyOnceWith("paragraph");
});

test("opens the offline patent legislation reader from Help", async () => {
  render(<MenuBar {...createHandlers()} />);
  fireEvent.click(screen.getByRole("button", { name: "帮助" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "专利法律法规" }));
  expect(await screen.findByRole("dialog", { name: "专利法律法规" })).toBeDefined();
  expect(screen.getByRole("button", { name: "专利法" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "关闭专利法律法规" }));
  expect(screen.queryByRole("dialog", { name: "专利法律法规" })).toBeNull();
});

test("offers body images and dependent claims from Insert", () => {
  const onInsertImage = vi.fn();
  const onInsertDependentClaim = vi.fn();
  render(
    <MenuBar
      {...createHandlers()}
      activeBookKind="claims"
      onInsertImage={onInsertImage}
      onInsertDependentClaim={onInsertDependentClaim}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "插入" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "插入图片" }));
  expect(onInsertImage).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "插入" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "从属权利要求" }));
  expect(onInsertDependentClaim).toHaveBeenCalledOnce();
});

test("allows drawing formula insertion but not text search on drawings", () => {
  const onInsertFormula = vi.fn();
  render(
    <MenuBar
      {...createHandlers()}
      activeBookKind="description-drawings"
      showTextEditingTools={false}
      onInsertFormula={onInsertFormula}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "插入" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "插入数学公式" }));
  expect(onInsertFormula).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  for (const name of ["查找", "替换"])
    expect(screen.getByRole("menuitem", { name }).getAttribute("aria-disabled")).toBe("true");
});

test("moves cleanup to Format root and offers removal of text highlighting", () => {
  const onHighlightColor = vi.fn();
  render(<MenuBar {...createHandlers()} onHighlightColor={onHighlightColor} />);
  fireEvent.click(screen.getByRole("button", { name: "格式" }));
  expect(screen.getByRole("menuitem", { name: "清除多余格式" })).toBeDefined();
  fireEvent.click(screen.getByRole("menuitem", { name: "文字" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "取消突出显示" }));
  expect(onHighlightColor).toHaveBeenCalledWith(null);
});

test("groups recovery and safe exit in File and shortcut creation in Tools", () => {
  const handlers = createHandlers();
  const onExitApplication = vi.fn();
  render(<MenuBar {...handlers} onExitApplication={onExitApplication} />);
  for (const [name, action] of [
    ["快照版本", handlers.onOpenSnapshotManager],
    ["备份文件与恢复", handlers.onOpenBackupManager],
    ["退出软件", onExitApplication],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    fireEvent.click(screen.getByRole("menuitem", { name }));
    expect(action).toHaveBeenCalledOnce();
  }
  fireEvent.click(screen.getByRole("button", { name: "视图" }));
  expect(screen.queryByRole("menuitem", { name: "打开专利库" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "帮助" }));
  expect(screen.queryByRole("menuitem", { name: "创建桌面快捷方式" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "工具" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "创建桌面快捷方式" }));
  expect(handlers.onCreateDesktopShortcut).toHaveBeenCalledOnce();
});

test("does not expose the retired chart workspace", () => {
  render(<MenuBar {...createHandlers()} />);
  fireEvent.click(screen.getByRole("button", { name: "插入" }));
  expect(screen.queryByRole("menuitem", { name: /实验图/ })).toBeNull();
});

test("offers split view and document pairs in View", () => {
  const onToggleSplitView = vi.fn();
  const onSelectSplitPair = vi.fn();
  render(
    <MenuBar
      {...createHandlers()}
      activeBookKind="claims"
      onToggleSplitView={onToggleSplitView}
      onSelectSplitPair={onSelectSplitPair}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "视图" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "同屏双显" }));
  expect(onToggleSplitView).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "视图" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "权利要求书／说明书" }));
  expect(onSelectSplitPair).toHaveBeenCalledWith("claims-description");
});

test("closes the open menu with Escape without executing a document command", () => {
  const handlers = createHandlers();
  render(<MenuBar {...handlers} />);
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "文件" })).toBeNull();
  expect(handlers.onNewDocument).not.toHaveBeenCalled();
});

test("offers a local usage guide from Help", async () => {
  render(<MenuBar {...createHandlers()} />);
  fireEvent.click(screen.getByRole("button", { name: "帮助" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "使用手册" }));
  expect(await screen.findByRole("dialog", { name: "使用手册" })).toBeDefined();
});

test("navigates menu commands with arrow keys and Enter", () => {
  const handlers = createHandlers();
  render(<MenuBar {...handlers} />);
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  fireEvent.keyDown(document, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "新建专利" }));
  fireEvent.keyDown(document, { key: "ArrowDown" });
  fireEvent.keyDown(document, { key: "Enter" });
  expect(handlers.onImportDocx).toHaveBeenCalledOnce();
});

test("offers the document file operations from the File menu", async () => {
  const user = userEvent.setup();
  const handlers = createHandlers();
  render(<MenuBar {...handlers} />);

  await user.click(screen.getByRole("button", { name: "文件" }));
  expect(screen.getByRole("menuitem", { name: "新建专利" })).toBeDefined();
  expect(screen.queryByRole("menuitem", { name: "打开自动保存草稿" })).toBeNull();
  expect(screen.queryByRole("menuitemradio")).toBeNull();
  expect(screen.queryByText("自动保存")).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: "导出 PATDOC" }));

  expect(handlers.onSaveDocumentAs).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu", { name: "文件" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: "导入 PATDOC" }));
  expect(handlers.onOpenDocument).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: "导出 DOCX" }));
  expect(handlers.onExportDocx).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", { name: "文件" }));
  expect(screen.queryByRole("menuitem", { name: "打印预览" })).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: "打印…" }));
  expect(handlers.onPrint).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: "导出 PDF" }));
  expect(handlers.onExportPdf).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: "打印…" }));
  expect(handlers.onPrint).toHaveBeenCalledTimes(2);

  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.click(screen.getByRole("menuitem", { name: "替换" }));
  expect(handlers.onReplace).toHaveBeenCalledOnce();
});

test("explains why undo and redo are unavailable on the abstract drawing", async () => {
  const user = userEvent.setup();
  const alert = vi.spyOn(appDialogs, "showAppAlert").mockImplementation(() => undefined);
  render(
    <MenuBar
      {...createHandlers()}
      historyAvailable={false}
      historyUnavailableReason="摘要附图不支持撤销和重做。"
    />,
  );

  await user.click(screen.getByRole("button", { name: "编辑" }));
  const undo = screen.getByRole("menuitem", { name: "撤销" });
  const redo = screen.getByRole("menuitem", { name: "重做" });
  expect(undo.getAttribute("aria-disabled")).toBe("true");
  expect(redo.getAttribute("title")).toBe(
    "摘要附图不支持撤销和重做。\n快捷键：Ctrl+Y / Ctrl+Shift+Z",
  );
  await user.click(redo);
  expect(alert).toHaveBeenCalledWith("摘要附图不支持撤销和重做。");
  alert.mockRestore();
});

test("disables undo and redo independently from their actual history state", async () => {
  const user = userEvent.setup();
  render(<MenuBar {...createHandlers()} canUndo={false} canRedo />);

  await user.click(screen.getByRole("button", { name: "编辑" }));
  expect(screen.getByRole("menuitem", { name: "撤销" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("menuitem", { name: "重做" }).getAttribute("aria-disabled")).toBe(
    "false",
  );
});

test("shows only shortcut information for named menu items", async () => {
  const user = userEvent.setup();
  render(<MenuBar {...createHandlers()} />);

  await user.click(screen.getByRole("button", { name: "编辑" }));
  expect(screen.getByRole("menuitem", { name: "撤销" }).getAttribute("title")).toBe("Ctrl+Z");
  expect(screen.getByRole("menuitem", { name: "重做" }).getAttribute("title")).toBe(
    "Ctrl+Y / Ctrl+Shift+Z",
  );
  expect(screen.getByRole("menuitem", { name: "复制" }).getAttribute("title")).toBe("Ctrl+C");
  expect(screen.getByRole("menuitem", { name: "查找" }).getAttribute("title")).toBe("Ctrl+F");
});

test("uses the current custom shortcut in named menu-item hover text", async () => {
  const user = userEvent.setup();
  render(
    <ShortcutProvider settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "check-problems": "F7" }}>
      <MenuBar {...createHandlers()} />
    </ShortcutProvider>,
  );

  await user.click(screen.getByRole("button", { name: "工具" }));
  expect(screen.getByRole("menuitem", { name: "本地检查" }).getAttribute("title")).toBe("F7");
});

test("opens AI correction from the Tools menu", async () => {
  const user = userEvent.setup();
  const onAiCorrection = vi.fn();
  render(
    <MenuBar {...createHandlers()} activeBookKind="description" onAiCorrection={onAiCorrection} />,
  );

  await user.click(screen.getByRole("button", { name: "工具" }));
  await user.click(screen.getByRole("button", { name: "AI 纠错实验功能说明" }));
  await user.click(screen.getByRole("dialog", { name: "AI 纠错实验功能说明" }));
  expect(screen.getByRole("menuitem", { name: "AI 纠错" })).toBeTruthy();
  expect(onAiCorrection).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "关闭实验功能说明" }));
  await user.click(screen.getByRole("menuitem", { name: "AI 纠错" }));
  expect(onAiCorrection).toHaveBeenCalledOnce();
});

test("opens text polish from the Tools menu on text books", async () => {
  const user = userEvent.setup();
  const onTextPolish = vi.fn();
  render(
    <MenuBar {...createHandlers()} activeBookKind="description" onTextPolish={onTextPolish} />,
  );

  await user.click(screen.getByRole("button", { name: "工具" }));
  await user.click(screen.getByRole("menuitem", { name: "小栈AI助手" }));
  expect(onTextPolish).toHaveBeenCalledOnce();
});

test("opens and closes Format submenus on pointer hover", async () => {
  const user = userEvent.setup();
  render(<MenuBar {...createHandlers()} />);

  await user.click(screen.getByRole("button", { name: "格式" }));
  fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "文字" }));
  expect(screen.getByRole("menu", { name: "文字格式" })).toBeTruthy();

  fireEvent.pointerLeave(screen.getByRole("menu", { name: "格式" }));
  expect(screen.getByRole("menu", { name: "文字格式" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("menu", { name: "文字格式" })).toBeNull());
});

test("renders trailing children after the Help button", () => {
  const handlers = createHandlers();
  const { container } = render(
    <MenuBar {...handlers}>
      <div data-testid="trailing-navigation">五书导航</div>
    </MenuBar>,
  );

  const helpButton = screen.getByRole("button", { name: "帮助" });
  const trailingNavigation = screen.getByTestId("trailing-navigation");
  const bookNavigation = trailingNavigation.closest(".menu-bar__book-navigation");
  const helpSeparator = container.querySelector(".menu-bar__book-navigation-separator");

  expect(bookNavigation).not.toBeNull();
  expect(helpSeparator).not.toBeNull();
  expect(helpSeparator?.previousElementSibling).toBe(helpButton.closest(".menu-bar__menu-group"));
  expect(helpSeparator?.nextElementSibling).toBe(bookNavigation);
  expect(
    helpButton.compareDocumentPosition(bookNavigation as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(container.querySelector(".menu-bar")?.lastElementChild).toBe(bookNavigation);
});

test("renders same-screen split controls after the book tabs with a separator", () => {
  render(
    <MenuBar
      {...createHandlers()}
      splitViewActive={false}
      onToggleSplitView={vi.fn()}
      onSelectSplitPair={vi.fn()}
      availableBookKinds={["claims", "description", "abstract"]}
    >
      <div data-testid="book-tabs">五书标签</div>
    </MenuBar>,
  );

  const navigation = screen.getByTestId("book-tabs").closest(".menu-bar__book-navigation");
  const controls = screen.getByRole("group", { name: "同屏双显控制" });
  const separator = controls.querySelector(".patent-split-controls__separator");

  expect(navigation).not.toBeNull();
  expect(separator).not.toBeNull();
  expect(
    screen.getByTestId("book-tabs").compareDocumentPosition(controls) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("renders a closable flowchart tab after the split controls with its own separator", () => {
  const onActivate = vi.fn();
  const onRequestClose = vi.fn();
  const { container } = render(
    <MenuBar
      {...createHandlers()}
      splitViewActive={false}
      onToggleSplitView={vi.fn()}
      onSelectSplitPair={vi.fn()}
      availableBookKinds={["claims", "description", "abstract"]}
      flowchartTab={{ active: true, patentId: "patent-a", onActivate, onRequestClose }}
    >
      <div data-testid="book-tabs">五书标签</div>
    </MenuBar>,
  );

  const controls = screen.getByRole("group", { name: "同屏双显控制" });
  const flowchartTab = screen.getByRole("tab", { name: "流程图" });
  const tabShell = flowchartTab.closest(".menu-bar__flowchart-tab-shell");

  expect(tabShell?.previousElementSibling?.classList).toContain(
    "menu-bar__flowchart-tab-separator",
  );
  expect(
    controls.compareDocumentPosition(flowchartTab) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(flowchartTab.getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector(".menu-bar")?.lastElementChild).toBe(tabShell?.parentElement);

  fireEvent.click(flowchartTab);
  fireEvent.click(screen.getByRole("button", { name: "关闭流程图" }));
  expect(onActivate).toHaveBeenCalledOnce();
  expect(onRequestClose).toHaveBeenCalledOnce();
});

test("starts a tool-target workspace drag from the CAD标号 tab and swallows the follow-up click", () => {
  const onActivate = vi.fn();
  const start = vi.fn();
  const consumeClick = vi.fn(() => true);
  render(
    <MenuBar
      {...createHandlers()}
      availableBookKinds={["claims", "description", "abstract"]}
      drawingTab={{ active: true, patentId: "patent-a", onActivate, onRequestClose: vi.fn() }}
      workspaceTabDrag={{ start, consumeClick }}
    >
      <div data-testid="book-tabs">五书标签</div>
    </MenuBar>,
  );

  const drawingTab = screen.getByRole("tab", { name: "CAD标号" });
  fireEvent.pointerDown(drawingTab, { pointerId: 7, button: 0, clientX: 120, clientY: 12 });

  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceElement: drawingTab,
      pointerId: 7,
      button: 0,
      source: {
        key: "tool:patent-a:drawing-markup",
        label: "CAD标号",
        target: { patentId: "patent-a", kind: "tool", tool: "drawing-markup" },
      },
    }),
  );

  fireEvent.click(drawingTab);

  expect(consumeClick).toHaveBeenCalledWith("tool:patent-a:drawing-markup");
  expect(onActivate).not.toHaveBeenCalled();
});

test("keeps the editor focus when pressing the menu bar surface", () => {
  render(<MenuBar {...createHandlers()} />);

  const event = createEvent.pointerDown(screen.getByRole("navigation", { name: "主菜单" }), {
    button: 0,
  });
  const dispatched = fireEvent(screen.getByRole("navigation", { name: "主菜单" }), event);

  expect(dispatched).toBe(false);
  expect(event.defaultPrevented).toBe(true);
});

test("dismisses the open menu when clicking outside the menu bar", async () => {
  const user = userEvent.setup();
  render(
    <>
      <MenuBar {...createHandlers()} />
      <button type="button">菜单栏外按钮</button>
    </>,
  );

  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("button", { name: "菜单栏外按钮" }));

  expect(screen.queryByRole("menu", { name: "文件" })).toBeNull();
});

test("dismisses the open menu before an outside surface stops pointer propagation", async () => {
  const user = userEvent.setup();
  render(
    <>
      <MenuBar {...createHandlers()} />
      <button type="button" onPointerDown={(event) => event.stopPropagation()}>
        阻止冒泡的外部区域
      </button>
    </>,
  );

  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("button", { name: "阻止冒泡的外部区域" }));

  expect(screen.queryByRole("menu", { name: "文件" })).toBeNull();
});

test("dismisses the open menu when focus enters an embedded workspace", async () => {
  const user = userEvent.setup();
  render(
    <>
      <MenuBar {...createHandlers()} />
      <iframe title="嵌入式工作区" />
    </>,
  );

  await user.click(screen.getByRole("button", { name: "文件" }));
  fireEvent.blur(window);

  expect(screen.queryByRole("menu", { name: "文件" })).toBeNull();
});

test("dismisses the open menu and preserves a trailing child click", async () => {
  const user = userEvent.setup();
  const onTrailingClick = vi.fn();
  render(
    <MenuBar {...createHandlers()}>
      <button type="button" onClick={onTrailingClick}>
        五书导航
      </button>
    </MenuBar>,
  );

  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("button", { name: "五书导航" }));

  expect(onTrailingClick).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu", { name: "文件" })).toBeNull();
});

test("keeps the open menu through a pointerdown inside its popover so its item can run", async () => {
  const user = userEvent.setup();
  const handlers = createHandlers();
  render(<MenuBar {...handlers} />);

  await user.click(screen.getByRole("button", { name: "文件" }));
  const fileMenu = screen.getByRole("menu", { name: "文件" });
  fireEvent.pointerDown(fileMenu);

  expect(screen.getByRole("menu", { name: "文件" })).not.toBeNull();
  await user.click(screen.getByRole("menuitem", { name: "新建专利" }));
  expect(handlers.onNewDocument).toHaveBeenCalledOnce();
});

test("switches between main menus and toggles the current menu closed", async () => {
  const user = userEvent.setup();
  render(<MenuBar {...createHandlers()} />);

  await user.click(screen.getByRole("button", { name: "文件" }));
  expect(screen.getByRole("menu", { name: "文件" })).not.toBeNull();

  await user.click(screen.getByRole("button", { name: "编辑" }));
  expect(screen.queryByRole("menu", { name: "文件" })).toBeNull();
  expect(screen.getByRole("menu", { name: "编辑" })).not.toBeNull();

  await user.click(screen.getByRole("button", { name: "工具" }));
  expect(screen.queryByRole("menu", { name: "编辑" })).toBeNull();
  expect(screen.getByRole("menu", { name: "工具" })).not.toBeNull();

  await user.click(screen.getByRole("button", { name: "帮助" }));
  expect(screen.queryByRole("menu", { name: "工具" })).toBeNull();
  expect(screen.getByRole("menu", { name: "帮助" })).not.toBeNull();

  await user.click(screen.getByRole("button", { name: "帮助" }));
  expect(screen.queryByRole("menu", { name: "帮助" })).toBeNull();
});

test("opens the branded About dialog from Help", async () => {
  const user = userEvent.setup();
  render(<MenuBar {...createHandlers()} />);

  await user.click(screen.getByRole("button", { name: "帮助" }));
  await user.click(screen.getByRole("menuitem", { name: "关于知产小栈Work" }));

  expect(screen.getByRole("dialog", { name: "关于知产小栈Work" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "隐私政策" }));
  expect(await screen.findByRole("dialog", { name: "隐私政策" })).toBeDefined();
  expect(screen.queryByRole("dialog", { name: "关于知产小栈Work" })).toBeNull();
});

test("opens third-party notices from Help", async () => {
  const user = userEvent.setup();
  const handlers = createHandlers();
  render(<MenuBar {...handlers} />);

  await user.click(screen.getByRole("button", { name: "帮助" }));
  await user.click(screen.getByRole("menuitem", { name: "开源许可证与第三方声明" }));

  expect(screen.getByRole("dialog", { name: "开源许可证与第三方声明" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "查看完整第三方声明" }));
  expect(handlers.onOpenThirdPartyNotices).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "打开许可证目录" }));
  expect(handlers.onOpenThirdPartyLicensesFolder).toHaveBeenCalledOnce();
});

test("opens patent settings from the File menu", async () => {
  const user = userEvent.setup();
  const onOpenPatentSettings = vi.fn();
  render(
    <MenuBar
      {...createHandlers()}
      activeBookKind="claims"
      onOpenPatentSettings={onOpenPatentSettings}
    />,
  );

  await user.click(screen.getByRole("button", { name: "文件" }));
  await user.click(screen.getByRole("menuitem", { name: "专利信息与设置" }));

  expect(onOpenPatentSettings).toHaveBeenCalledOnce();
});

test("offers existing insert, format, and view capabilities through the main menus", async () => {
  const user = userEvent.setup();
  render(<MenuBar {...createHandlers()} />);

  await user.click(screen.getByRole("button", { name: "插入" }));
  expect(screen.getByRole("menuitem", { name: "插入表格" })).toBeDefined();
  expect(screen.getByRole("menuitem", { name: "插入数学公式" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "格式" }));
  await user.click(screen.getByRole("menuitem", { name: "文字" }));
  expect(screen.getByRole("menuitem", { name: "粗体" })).toBeDefined();

  await user.click(screen.getByRole("menuitem", { name: "段落" }));
  expect(screen.getByRole("menuitem", { name: "两端对齐" })).toBeDefined();

  await user.click(screen.getByRole("menuitem", { name: "页面" }));
  expect(screen.getByRole("menuitem", { name: "页边距设置" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "视图" }));
  expect(screen.getByRole("menuitem", { name: "放大" })).toBeDefined();
  expect(screen.getByRole("menuitem", { name: "恢复为 100%" })).toBeDefined();
});

test("runs inserted table actions from the Insert menu", async () => {
  const user = userEvent.setup();
  const onInsertTable = vi.fn();
  render(<MenuBar {...createHandlers()} onInsertTable={onInsertTable} />);

  await user.click(screen.getByRole("button", { name: "插入" }));
  await user.click(screen.getByRole("menuitem", { name: "插入表格" }));

  expect(onInsertTable).toHaveBeenCalledWith({
    rows: 2,
    columns: 2,
    headerRowCount: 0,
    layoutMode: "fit-page",
  });
});

test("explains why unsupported tools cannot be used", async () => {
  const user = userEvent.setup();
  render(
    <MenuBar
      {...createHandlers()}
      capabilities={{
        headings: false,
        lists: false,
        tables: false,
        formulas: false,
        chemistry: false,
        images: false,
        pageBreaks: false,
      }}
    />,
  );

  await user.click(screen.getByRole("button", { name: "插入" }));

  const tableItem = screen.getByRole("menuitem", { name: "插入表格" });
  expect(tableItem.getAttribute("aria-disabled")).toBe("true");
  expect(tableItem.getAttribute("title")).toBe("当前书册不支持表格。");
});

test("opens all official websites on hover or click and closes the submenu with Escape", () => {
  render(<MenuBar {...createHandlers()} />);
  fireEvent.click(screen.getByRole("button", { name: "帮助" }));
  const trigger = screen.getByRole("menuitem", { name: "常用官方网站" });
  fireEvent.pointerEnter(trigger);
  const menu = screen.getByRole("menu", { name: "常用官方网站" });
  expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(19);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "常用官方网站" })).toBeNull();
  expect(screen.getByRole("menu", { name: "帮助" })).toBeDefined();
  fireEvent.click(trigger);
  expect(screen.getByRole("menu", { name: "常用官方网站" })).toBeDefined();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu", { name: "帮助" })).toBeNull();
});

test("launches a selected official site and reports browser failure", async () => {
  const open = vi.fn().mockResolvedValue({ ok: false, error: { code: "FAILED" } });
  const original = window.patentApi;
  const alert = vi.spyOn(appDialogs, "showAppAlert").mockImplementation(() => undefined);
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: { application: { openOfficialWebsite: open } },
  });
  try {
    render(<MenuBar {...createHandlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "帮助" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "常用官方网站" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "国家知识产权局" }));
    expect(open).toHaveBeenCalledWith("cnipa");
    expect(screen.queryByRole("menu", { name: "帮助" })).toBeNull();
    await vi.waitFor(() =>
      expect(alert).toHaveBeenCalledWith("无法打开官方网站，请检查系统默认浏览器设置后重试。"),
    );
  } finally {
    Object.defineProperty(window, "patentApi", { configurable: true, value: original });
    alert.mockRestore();
  }
});

test("keyboard submenu navigation skips a submenu during its exit", async () => {
  const user = userEvent.setup();
  render(<MenuBar {...createHandlers()} />);
  await user.click(screen.getByRole("button", { name: "格式" }));
  await user.click(screen.getByRole("menuitem", { name: "文字" }));
  const previous = screen.getByRole("menu", { name: "文字格式" });
  const paragraph = screen.getByRole("menuitem", { name: "段落" });
  paragraph.focus();
  fireEvent.keyDown(paragraph, { key: "ArrowRight" });
  const current = await screen.findByRole("menu", { name: "段落格式" });
  expect(previous.closest(".spatial-presence")?.hasAttribute("inert")).toBe(true);
  await waitFor(() => expect(current.contains(document.activeElement)).toBe(true));
});

test("keeps a submenu during a brief gap and cancels closing when the pointer arrives", () => {
  vi.useFakeTimers();
  try {
    render(<MenuBar {...createHandlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "帮助" }));
    const trigger = screen.getByRole("menuitem", { name: "常用官方网站" });
    fireEvent.pointerEnter(trigger);
    const submenu = screen.getByRole("menu", { name: "常用官方网站" });
    fireEvent.pointerLeave(trigger.closest(".official-websites-group")!);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("menu", { name: "常用官方网站" })).toBe(submenu);
    fireEvent.pointerEnter(submenu);
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByRole("menu", { name: "常用官方网站" })).toBe(submenu);
    fireEvent.pointerLeave(trigger.closest(".official-websites-group")!);
    act(() => vi.advanceTimersByTime(350));
    expect(screen.queryByRole("menu", { name: "常用官方网站" })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("does not switch submenus when crossing another trigger briefly", () => {
  vi.useFakeTimers();
  try {
    render(<MenuBar {...createHandlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "格式" }));
    const text = screen.getByRole("menuitem", { name: "文字" });
    const paragraph = screen.getByRole("menuitem", { name: "段落" });
    fireEvent.pointerEnter(text);
    fireEvent.pointerLeave(text.closest(".format-menu__branch")!);
    fireEvent.pointerEnter(paragraph);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByRole("menu", { name: "段落格式" })).toBeNull();
    fireEvent.pointerLeave(paragraph);
    fireEvent.pointerEnter(screen.getByRole("menu", { name: "文字格式" }));
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByRole("menu", { name: "文字格式" })).toBeDefined();
    expect(screen.queryByRole("menu", { name: "段落格式" })).toBeNull();
    fireEvent.pointerEnter(paragraph);
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByRole("menu", { name: "段落格式" })).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});

test("click and dismissal cancel pending hover changes", () => {
  vi.useFakeTimers();
  try {
    render(<MenuBar {...createHandlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "格式" }));
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "文字" }));
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "段落" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "页面" }));
    expect(screen.getByRole("menu", { name: "页面格式" })).toBeDefined();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("menu", { name: "段落格式" })).toBeNull();
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "段落" }));
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("menu", { name: "段落格式" })).toBeNull();
    expect(screen.queryByRole("menu", { name: "页面格式" })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test.each([false, true])("highlights feedback in the help menu (library: %s)", (libraryMode) => {
  render(<MenuBar {...createHandlers()} libraryMode={libraryMode} />);
  fireEvent.click(screen.getByRole("button", { name: "帮助" }));
  const feedback = screen.getByRole("menuitem", { name: "建议与反馈" });
  expect(feedback.classList.contains("menu-item--feedback")).toBe(true);
  fireEvent.click(feedback);
  expect(screen.getByRole("dialog", { name: "建议与反馈" })).toBeDefined();
});

test("library presentation preserves global actions and help without editor menus", () => {
  const handlers = createHandlers();
  const onOpenSettings = vi.fn();
  render(<MenuBar {...handlers} libraryMode onOpenSettings={onOpenSettings} />);
  for (const name of ["文件", "编辑", "插入", "格式", "视图", "工具"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "备份与恢复" }));
  expect(handlers.onOpenBackupManager).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  expect(onOpenSettings).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "帮助" }));
  for (const name of [
    "使用手册",
    "专利法律法规",
    "常用官方网站",
    "建议与反馈",
    "开源许可证与第三方声明",
  ])
    expect(screen.getByRole("menuitem", { name })).toBeDefined();
  fireEvent.click(screen.getByRole("menuitem", { name: "使用手册" }));
  expect(screen.getByRole("dialog", { name: /使用手册/ })).toBeDefined();
});

test("library website submenu accepts pointer and keyboard input outside the sidebar", () => {
  render(<MenuBar {...createHandlers()} libraryMode />);
  fireEvent.click(screen.getByRole("button", { name: "帮助" }));
  const trigger = screen.getByRole("menuitem", { name: "常用官方网站" });
  fireEvent.click(trigger);
  const submenu = screen.getByRole("menu", { name: "常用官方网站" });
  expect(screen.getByRole("navigation", { name: "专利库辅助功能" }).contains(submenu)).toBe(false);
  const site = screen.getByRole("menuitem", { name: "国家知识产权局" });
  fireEvent.pointerDown(site);
  expect(screen.getByRole("menu", { name: "常用官方网站" })).toBe(submenu);
  site.focus();
  fireEvent.keyDown(site, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "常用官方网站" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "帮助" })).toBeNull();
});

test("file menu imports DOCX through its dedicated handler", () => {
  const onImportDocx = vi.fn();
  render(<MenuBar {...createHandlers()} onImportDocx={onImportDocx} />);
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "导入 DOCX" }));
  expect(onImportDocx).toHaveBeenCalledOnce();
});

test.each([false, true])("view menu toggles columns with active state %s", (columnsActive) => {
  const onToggleColumns = vi.fn();
  render(
    <MenuBar
      {...createHandlers()}
      activeBookKind="description"
      columnsActive={columnsActive}
      onToggleColumns={onToggleColumns}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "视图" }));
  fireEvent.click(
    screen.getByRole("menuitem", { name: columnsActive ? "退出双列显示" : "双列显示" }),
  );
  expect(onToggleColumns).toHaveBeenCalledOnce();
});

test.each(["abstract", "description-drawings"] as const)(
  "columns stay unavailable in %s",
  (activeBookKind) => {
    const onToggleColumns = vi.fn();
    render(
      <MenuBar
        {...createHandlers()}
        activeBookKind={activeBookKind}
        onToggleColumns={onToggleColumns}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "视图" }));
    expect(screen.getByRole("menuitem", { name: "双列显示" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  },
);

test.each([false, true])("number bracket menu actions require selection %s", (selected) => {
  const onCommand = vi.fn();
  render(
    <MenuBar
      {...createHandlers()}
      onCommand={onCommand}
      formatState={{
        bold: false,
        italic: false,
        underline: false,
        subscript: false,
        superscript: false,
        alignment: "left",
        bulletList: false,
        orderedList: false,
        paragraphStyle: "paragraph",
        hasBracketTextSelection: selected,
      }}
    />,
  );
  for (const [label, command] of [
    ["数字加括号", "add-number-brackets"],
    ["数字去括号", "remove-number-brackets"],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const item = screen.getByRole("menuitem", { name: label });
    if (!selected) expect(item.getAttribute("aria-disabled")).toBe("true");
    else {
      fireEvent.click(item);
      expect(onCommand).toHaveBeenLastCalledWith(command);
    }
    if (!selected) fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  }
  if (!selected) expect(onCommand).not.toHaveBeenCalled();
});

test.each([false, true])("page break menu follows editor capability %s", (enabled) => {
  const onCommand = vi.fn();
  render(
    <MenuBar
      {...createHandlers()}
      onCommand={onCommand}
      capabilities={{
        headings: true,
        lists: true,
        tables: true,
        formulas: true,
        chemistry: true,
        images: true,
        pageBreaks: enabled,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "插入" }));
  const item = screen.getByRole("menuitem", { name: "分页符" });
  expect(item.getAttribute("aria-disabled")).toBe(String(!enabled));
  if (enabled) {
    fireEvent.click(item);
    expect(onCommand).toHaveBeenCalledExactlyOnceWith("page-break");
  } else expect(onCommand).not.toHaveBeenCalled();
});

test("Agent CLI tool opens its settings directly without an active patent", () => {
  const onOpenAgentCli = vi.fn();
  render(<MenuBar {...createHandlers()} activeBookKind={null} onOpenAgentCli={onOpenAgentCli} />);
  fireEvent.click(screen.getByRole("button", { name: "工具" }));
  const item = screen.getByRole("menuitem", { name: "Agent CLI" });
  const badge = screen.getByRole("button", { name: "Agent CLI实验功能说明" });
  expect(badge.className).toBe("ai-experimental-badge");
  expect(badge.textContent).toBe("实验功能");
  for (const feature of ["AI 纠错", "小栈AI助手"]) {
    expect(screen.getByRole("button", { name: `${feature}实验功能说明` }).className).toBe(
      badge.className,
    );
  }
  fireEvent.click(badge);
  const notice = screen.getByRole("dialog", { name: "Agent CLI实验功能说明" });
  expect(notice.textContent).toContain("授权");
  expect(notice.textContent).not.toContain("DeepSeek");
  expect(onOpenAgentCli).not.toHaveBeenCalled();
  expect(screen.getByRole("menu", { name: "工具" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭实验功能说明" }));
  expect(item.getAttribute("aria-disabled")).toBe("false");
  fireEvent.click(item);
  expect(onOpenAgentCli).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu", { name: "工具" })).toBeNull();
});

test("Agent CLI menu explains an unavailable settings handler", () => {
  render(<MenuBar {...createHandlers()} />);
  fireEvent.click(screen.getByRole("button", { name: "工具" }));
  expect(screen.getByRole("menuitem", { name: "Agent CLI" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Agent CLI实验功能说明" }));
  expect(screen.getByRole("dialog", { name: "Agent CLI实验功能说明" })).toBeTruthy();
});

test.each([false, true])(
  "help legal documents open without the startup gate (libraryMode=%s)",
  async (libraryMode) => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(window, "patentApi");
    Object.defineProperty(window, "patentApi", { configurable: true, writable: true, value: {} });
    try {
      render(<MenuBar {...createHandlers()} libraryMode={libraryMode} />);
      for (const title of ["软件使用协议", "隐私政策"]) {
        fireEvent.click(screen.getByRole("button", { name: "帮助" }));
        fireEvent.click(screen.getByRole("menuitem", { name: title }));
        const dialog = await screen.findByRole("dialog", { name: title });
        expect(dialog.querySelectorAll("article section").length).toBeGreaterThanOrEqual(10);
        fireEvent.click(screen.getByRole("button", { name: /^关闭$/ }));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: title })).toBeNull());
      }
    } finally {
      if (previousDescriptor) Object.defineProperty(window, "patentApi", previousDescriptor);
      else Reflect.deleteProperty(window, "patentApi");
    }
  },
);
