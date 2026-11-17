import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LibraryDocumentSummary, LibraryPatentSummary } from "../../../shared/library/model";
import { DocumentLibrary } from "./document-library";

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  // Keep August and September fixtures in the two initially expanded months.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
});

afterEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: originalScrollIntoView,
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function summary(overrides: Partial<LibraryDocumentSummary> = {}): LibraryDocumentSummary {
  return {
    libraryDocumentId: overrides.libraryDocumentId ?? "00000000-0000-4000-8000-000000000101",
    title: overrides.title ?? "往复式夹具",
    snippet: overrides.snippet ?? "本发明涉及一种夹具。",
    revision: overrides.revision ?? 7,
    saveState: overrides.saveState ?? "saved",
    createdAt: overrides.createdAt ?? "2026-08-01T00:00:00.000Z",
    modifiedAt: overrides.modifiedAt ?? "2026-08-01T01:00:00.000Z",
    deletedAt: overrides.deletedAt ?? null,
    quarantinedAt: overrides.quarantinedAt ?? null,
    recoveryState: overrides.recoveryState ?? "healthy",
    recoveryErrorCode: overrides.recoveryErrorCode ?? null,
  };
}

test("switches to an illustrated patent view and exposes complete hover previews", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T23:59:59Z"));
  const save = vi.fn(async () => true);
  const getLibraryPreview = vi.fn(async () => ({
    ok: true as const,
    value: Uint8Array.from([137, 80, 78, 71]),
  }));
  vi.stubGlobal("patentApi", { patents: { getLibraryPreview } });
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:patent-preview"),
    revokeObjectURL: vi.fn(),
  });
  const openPatent = vi.fn();

  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary({ customer: "山东一二三四五有限公司" })]}
      loading={false}
      patentLibraryViewMode="single"
      onPatentLibraryViewModeChange={save}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onOpenPatent={openPatent}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "图文视图" }));
    await Promise.resolve();
  });
  expect(save).toHaveBeenCalledWith("illustrated");
  expect(screen.getByLabelText("专利列表").getAttribute("data-view-mode")).toBe("illustrated");
  expect(screen.getByText(/本发明公开了一种往复式夹具/u)).toBeDefined();
  const card = screen.getByLabelText("往复式夹具");
  const footer = card.querySelector(".patent-illustrated-card__footer");
  expect(footer).not.toBeNull();
  expect(within(footer as HTMLElement).getByText(/创建：/u)).toBeDefined();
  expect(within(footer as HTMLElement).getByText(/最后编辑：/u)).toBeDefined();
  expect(within(footer as HTMLElement).getByRole("button", { name: "更多操作" })).toBeDefined();

  await act(async () => Promise.resolve());
  const imageTrigger = screen.getByRole("button", { name: "查看往复式夹具附图大图" });
  fireEvent.mouseEnter(imageTrigger);
  await act(async () => vi.advanceTimersByTime(300));
  expect(
    screen
      .getByRole("dialog", { name: "查看往复式夹具附图大图" })
      .classList.contains("patent-illustrated-hover__popover--image"),
  ).toBe(true);

  fireEvent.mouseLeave(imageTrigger);
  await act(async () => vi.advanceTimersByTime(300));
  fireEvent.doubleClick(imageTrigger);
  expect(openPatent).toHaveBeenCalledWith(
    expect.objectContaining({ patentId: patentSummary().patentId }),
  );
  const abstractTrigger = screen.getByRole("button", { name: "查看往复式夹具完整摘要" });
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const measure = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("patent-illustrated-hover__popover")) {
        return new DOMRect(0, 0, 420, 200);
      }
      if (this === abstractTrigger) return new DOMRect(760, 700, 80, 40);
      return originalRect.call(this);
    });
  fireEvent.mouseEnter(abstractTrigger);
  await act(async () => vi.advanceTimersByTime(300));
  const abstractPreview = screen.getByRole("dialog", { name: "查看往复式夹具完整摘要" });
  expect(abstractPreview).toBeDefined();
  expect(abstractPreview.closest(".spatial-collapse__content")).toBeNull();
  expect(abstractPreview.style.visibility).toBe("visible");
  expect(abstractPreview.style.left).toBe(`${window.innerWidth - 428}px`);
  expect(abstractPreview.style.top).toBe("492px");
  measure.mockRestore();
  fireEvent.mouseLeave(abstractTrigger);
  await act(async () => vi.advanceTimersByTime(300));
  fireEvent.focus(abstractTrigger);
  expect(screen.getByRole("dialog", { name: "查看往复式夹具完整摘要" }).textContent).toContain(
    "本发明公开了一种往复式夹具",
  );
  fireEvent.doubleClick(abstractTrigger);
  expect(openPatent).toHaveBeenCalledTimes(2);
});

test("refreshes existing patents without inserting a layout shifting loading row", () => {
  render(<DocumentLibrary documents={[]} patents={[patentSummary()]} loading
    onNewDocument={vi.fn()} onImportPatdoc={vi.fn()} onOpenTrash={vi.fn()}
    onOpenDocument={vi.fn()} onRenameDocument={vi.fn()} onExportPatdoc={vi.fn()}
    onExportDocx={vi.fn()} onExportPdf={vi.fn()} onMoveToTrash={vi.fn()} />);
  expect(screen.queryByText("正在读取专利库…")).toBeNull();
  expect(screen.getByRole("article", { name: "往复式夹具" })).toBeDefined();
});

function patentSummary(overrides: Partial<LibraryPatentSummary> = {}): LibraryPatentSummary {
  return {
    patentId: overrides.patentId ?? "00000000-0000-4000-8000-000000000201",
    name: overrides.name === undefined ? "往复式夹具" : overrides.name,
    customer: overrides.customer === undefined ? null : overrides.customer,
    patentType: overrides.patentType ?? "utility-model",
    revision: overrides.revision ?? 7,
    bookStatuses: overrides.bookStatuses ?? {
      claims: "draft",
      description: "complete",
      "description-drawings": "empty",
      abstract: "empty",
      "abstract-drawing": "empty",
    },
    issueCount: overrides.issueCount ?? 4,
    saveState: overrides.saveState ?? "saved",
    createdAt: overrides.createdAt ?? "2026-08-01T00:00:00.000Z",
    modifiedAt: overrides.modifiedAt ?? "2026-08-01T01:00:00.000Z",
    deletedAt: overrides.deletedAt ?? null,
    recoveryState: overrides.recoveryState ?? "healthy",
    recoveryErrorCode: overrides.recoveryErrorCode ?? null,
    abstractText:
      overrides.abstractText ?? "本发明公开了一种往复式夹具，能够提高定位精度并降低重复装夹时间。",
    drawingPreviewAssetId:
      overrides.drawingPreviewAssetId ?? "00000000-0000-4000-8000-000000000301",
  };
}

function createdAtMonthOffset(offset: number): string {
  const value = new Date();
  value.setDate(10);
  value.setHours(12, 0, 0, 0);
  value.setMonth(value.getMonth() + offset);
  return value.toISOString();
}

test.each(["single", "double", "illustrated"] as const)(
  "windows %s cards without limiting search, bulk export or restored focus",
  async (mode) => {
    vi.stubGlobal("patentApi", { patents: {} });
    const patents = Array.from({ length: 500 }, (_, index) =>
      patentSummary({
        patentId: testUuid(index + 1000),
        name: `大库专利 ${index}`,
        customer: `客户 ${index}`,
        createdAt: "2026-09-01T00:00:00Z",
        modifiedAt: "2026-09-01T00:00:00Z",
        drawingPreviewAssetId: null,
      }),
    );
    const onExportPatents = vi.fn();
    const onPatentFocusHandled = vi.fn();
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const props = {
      documents: [],
      patents,
      loading: false,
      patentLibraryViewMode: mode,
      onNewDocument: vi.fn(),
      onImportPatdoc: vi.fn(),
      onOpenTrash: vi.fn(),
      onOpenDocument: vi.fn(),
      onOpenPatent: vi.fn(),
      onRenameDocument: vi.fn(),
      onExportPatdoc: vi.fn(),
      onExportDocx: vi.fn(),
      onExportPdf: vi.fn(),
      onMoveToTrash: vi.fn(),
      onExportPatents,
      onPatentFocusHandled,
    };
    const view = render(<DocumentLibrary {...props} />);
    expect(screen.getAllByRole("article").length).toBeLessThan(100);
    expect(screen.queryByRole("article", { name: "大库专利 499" })).toBeNull();
    const search = screen.getByRole("searchbox", { name: "搜索专利题目与客户" });
    fireEvent.change(search, { target: { value: "大库专利 499" } });
    expect(screen.getByRole("article", { name: "大库专利 499" })).toBeDefined();
    fireEvent.change(search, { target: { value: "客户 498" } });
    expect(screen.getByRole("article", { name: "大库专利 498" })).toBeDefined();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.click(screen.getByRole("button", { name: "全选当前筛选专利" }));
    fireEvent.click(screen.getByRole("button", { name: "导出所选（500）" }));
    expect(onExportPatents).toHaveBeenCalledWith(expect.arrayContaining(patents));
    expect(onExportPatents.mock.calls[0]![0]).toHaveLength(500);
    view.rerender(
      <DocumentLibrary
        {...props}
        patentFocusRequest={{ patentId: patents[499]!.patentId, requestKey: 73 }}
      />,
    );
    await act(async () => undefined);
    expect(screen.getByRole("article", { name: "大库专利 499" }).className).toContain(
      "is-snapshot-restore-highlight",
    );
    expect(onPatentFocusHandled).toHaveBeenCalledWith(73);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    vi.stubGlobal("patentApi", {
      patents: {},
      contentSearch: {
        request: vi.fn(async () => ({
          ok: true,
          value: {
            enabled: true,
            running: false,
            completed: 500,
            total: 500,
            updatedAt: "2026-09-08T12:00:00Z",
            error: false,
            incomplete: false,
            hits: [
              {
                patentId: patents[499]!.patentId,
                books: [{ kind: "description", count: 1, snippets: ["采用螺旋输送结构"] }],
              },
            ],
          },
        })),
      },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "搜索正文" }));
    await screen.findByRole("searchbox", { name: "搜索五书正文" });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索五书正文" }), {
      target: { value: "螺旋" },
    });
    const bodyHit = await screen.findByRole("button", { name: /说明书.*采用螺旋/ });
    fireEvent.click(bodyHit);
    expect(props.onOpenPatent).toHaveBeenCalledWith(
      patents[499],
      expect.objectContaining({ kind: "description", query: "螺旋" }),
      expect.any(String),
    );
    view.unmount();
  },
);

function monthLabel(offset: number): string {
  const value = new Date();
  value.setDate(10);
  value.setHours(12, 0, 0, 0);
  value.setMonth(value.getMonth() + offset);
  return `${value.getFullYear()}年${value.getMonth() + 1}月`;
}

test("uses compact patent library copy and unlabeled filter surfaces", () => {
  render(
    <DocumentLibrary
      documents={[]}
      patents={[]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  expect(
    screen.queryByText("这里按专利管理基础三书；说明书附图和摘要附图会按专利状态显示。"),
  ).toBeNull();
  expect(screen.queryByText("搜索专利题目与客户", { selector: "span" })).toBeNull();
  expect(screen.queryByText("专利类型", { selector: "span" })).toBeNull();
  expect(screen.getByText("还没有专利，点击“新建专利”开始。")).toBeDefined();
  expect(screen.getByRole("searchbox", { name: "搜索专利题目与客户" })).toHaveProperty(
    "placeholder",
    "搜索专利题目或客户",
  );
});

test("keeps export selection active while a batch deletion is running", async () => {
  const user = userEvent.setup();
  const view = (deletingPatents: boolean) => (
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary()]}
      loading={false}
      deletingPatents={deletingPatents}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
      onExportPatents={vi.fn()}
    />
  );
  const { rerender } = render(view(false));
  const button = screen.getByRole("button", { name: "导出" });
  await user.click(button);
  rerender(view(true));
  expect(button).toHaveProperty("disabled", true);
  await user.click(button);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("group", { name: "专利多选操作" })).toBeDefined();
  rerender(view(false));
  await user.click(button);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("group", { name: "专利多选操作" })).toBeNull();
});

test("renders patent cards with type badge and overflow actions menu", async () => {
  const user = userEvent.setup();
  const patent = patentSummary();
  const handlers = {
    onExportPatents: vi.fn(),
    onImportBundle: vi.fn(),
    onNewDocument: vi.fn(),
    onImportPatdoc: vi.fn(),
    onOpenTrash: vi.fn(),
    onOpenDocument: vi.fn(),
    onRenameDocument: vi.fn(),
    onExportPatdoc: vi.fn(),
    onExportDocx: vi.fn(),
    onExportPdf: vi.fn(),
    onMoveToTrash: vi.fn(),
    onNewPatent: vi.fn(),
    onOpenPatent: vi.fn(),
    onEditPatentSettings: vi.fn(),
    onExportPatent: vi.fn(),
    onMovePatentToTrash: vi.fn(),
  };
  const { unmount } = render(
    <DocumentLibrary documents={[]} patents={[patent]} loading={false} {...handlers} />,
  );

  expect(screen.getByRole("heading", { name: "专利库" })).toBeDefined();
  const article = screen.getByRole("article", { name: "往复式夹具" });
  expect(within(article).getByText(/实用新型/u)).toBeDefined();
  expect(within(article).getByText("实用新型").className).toContain("patent-type-badge");

  await user.click(within(article).getByRole("button", { name: "更多操作" }));
  await user.click(screen.getByRole("menuitem", { name: "继续编辑" }));
  await user.click(within(article).getByRole("button", { name: "更多操作" }));
  await user.click(screen.getByRole("menuitem", { name: "设置" }));
  await user.click(within(article).getByRole("button", { name: "更多操作" }));
  await user.click(screen.getByRole("menuitem", { name: "导出" }));
  await user.click(within(article).getByRole("button", { name: "更多操作" }));
  await user.click(screen.getByRole("menuitem", { name: "删除" }));

  expect(handlers.onOpenPatent).toHaveBeenCalledWith(patent);
  expect(handlers.onEditPatentSettings).toHaveBeenCalledWith(patent);
  expect(handlers.onExportPatent).toHaveBeenCalledWith(patent);
  expect(handlers.onMovePatentToTrash).toHaveBeenCalledWith(patent);
  expect(screen.queryByRole("checkbox", { name: /^选择 / })).toBeNull();
  await user.click(screen.getByRole("button", { name: "导出" }));
  expect(screen.getByRole("button", { name: "导出所选（0）" })).toHaveProperty("disabled", true);
  const selectionRow = screen.getByRole("group", { name: "专利多选操作" });
  expect(within(selectionRow).getAllByRole("button")).toHaveLength(3);
  expect(selectionRow.classList.contains("library-selection-actions")).toBe(true);
  const exportButton = screen.getByRole("button", { name: "导出" });
  expect(exportButton.getAttribute("aria-expanded")).toBe("true");
  expect(exportButton.getAttribute("aria-pressed")).toBe("true");
  expect(selectionRow.closest(".library-export-menu")).toBeNull();
  expect(selectionRow.closest(".library-toolbar")).toBe(exportButton.closest(".library-toolbar"));
  expect(selectionRow.closest(".spatial-collapse")?.getAttribute("data-motion")).toBe("enter");
  expect(selectionRow.contains(screen.getByRole("button", { name: "新建专利" }))).toBe(false);
  await user.click(document.body);
  expect(screen.getByRole("group", { name: "专利多选操作" })).toBe(selectionRow);
  await user.click(screen.getByRole("searchbox", { name: "搜索专利题目与客户" }));
  expect(document.activeElement).toBe(
    screen.getByRole("searchbox", { name: "搜索专利题目与客户" }),
  );
  expect(screen.getByRole("group", { name: "专利多选操作" })).toBe(selectionRow);
  const checkbox = within(article).getByRole("checkbox", { name: "选择 往复式夹具" });
  await user.dblClick(checkbox);
  expect(handlers.onOpenPatent).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "全选当前筛选专利" }));
  await user.click(screen.getByRole("button", { name: "导出所选（1）" }));
  expect(handlers.onExportPatents).toHaveBeenCalledWith([patent]);
  expect(
    within(screen.getByRole("region", { name: "专利筛选" })).queryByRole("button", {
      name: /导出|全选|取消选择/,
    }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "取消选择" }));
  expect(screen.queryByRole("checkbox", { name: /^选择 / })).toBeNull();
  expect(screen.queryByRole("group", { name: "专利多选操作" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "导出" }));
  expect(within(article).getByRole("checkbox")).toHaveProperty("checked", false);
  await user.click(screen.getByRole("button", { name: "全选当前筛选专利" }));
  await user.click(exportButton);
  expect(exportButton.getAttribute("aria-pressed")).toBe("false");
  expect(exportButton.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("group", { name: "专利多选操作" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /^选择 / })).toBeNull();
  await user.click(exportButton);
  expect(within(article).getByRole("checkbox")).toHaveProperty("checked", false);
  await user.click(screen.getByRole("button", { name: "取消选择" }));
  await user.click(screen.getByRole("button", { name: "导入" }));
  await user.click(screen.getByRole("menuitem", { name: "导入专利压缩包" }));
  expect(handlers.onImportBundle).toHaveBeenCalledOnce();
  for (const name of ["新建专利", "导入", "回收站"]) {
    await user.click(screen.getByRole("button", { name: "导出" }));
    await user.click(screen.getByRole("button", { name: "全选当前筛选专利" }));
    await user.click(screen.getByRole("button", { name }));
    expect(screen.queryByRole("group", { name: "专利多选操作" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /^选择 / })).toBeNull();
  }
  for (const name of ["设置"]) {
    await user.click(screen.getByRole("button", { name: "导出" }));
    expect(screen.getByRole("checkbox", { name: /^选择 / })).toHaveProperty("checked", false);
    fireEvent.contextMenu(article, { clientX: 200, clientY: 100 });
    await user.click(screen.getByRole("menuitem", { name }));
    expect(screen.queryByRole("group", { name: "专利多选操作" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /^选择 / })).toBeNull();
  }
  const toolbarAction = vi.fn();
  const toolbar = render(
    <nav className="menu-bar" aria-label="测试主菜单">
      <button type="button" role="menuitem" onClick={toolbarAction}>
        工具菜单项
      </button>
    </nav>,
  );
  await user.click(screen.getByRole("button", { name: "导出" }));
  await user.click(screen.getByRole("menuitem", { name: "工具菜单项" }));
  expect(toolbarAction).toHaveBeenCalledOnce();
  expect(screen.queryByRole("group", { name: "专利多选操作" })).toBeNull();
  toolbar.unmount();
  await user.click(screen.getByRole("button", { name: "导出" }));
  expect(screen.getByRole("group", { name: "专利多选操作" })).toBeDefined();
  unmount();
  expect(screen.queryByRole("group", { name: "专利多选操作" })).toBeNull();
});

test.each(
  (["single", "double", "illustrated"] as const).flatMap((mode) =>
    (["button", "context"] as const).map((entry) => ({ mode, entry })),
  ),
)("enters multi-select from $entry menu in $mode view", async ({ mode, entry }) => {
  vi.stubGlobal("patentApi", { patents: {} });
  const user = userEvent.setup();
  const first = patentSummary();
  const second = patentSummary({ patentId: testUuid(202), name: "第二项专利" });
  const onOpenPatent = vi.fn();
  const onExportPatents = vi.fn();
  render(
    <DocumentLibrary
      documents={[]}
      patents={[first, second]}
      loading={false}
      patentLibraryViewMode={mode}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onOpenPatent={onOpenPatent}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onExportPatents={onExportPatents}
      onMoveToTrash={vi.fn()}
    />,
  );
  const card = screen.getByRole("article", { name: "往复式夹具" });
  await user.click(within(card).getByRole("button", { name: "更多操作" }));
  const menu = screen.getByRole("menu", { name: "专利操作" });
  expect(menu.closest(".spatial-presence")?.parentElement).toBe(document.body);
  expect(menu.style.position).toBe("fixed");
  const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
  expect(screen.queryByText("排序")).toBeNull();
  expect(screen.queryByText("视图")).toBeNull();
  expect(screen.queryByText(/按创建时间排序|按最近编辑排序/)).toBeNull();
  expect(screen.getByText("总计 2 项 · 发明 0 项 · 新型 2 项")).toBeDefined();
  if (entry === "context") {
    await user.keyboard("{Escape}");
    expect(fireEvent.contextMenu(card, { clientX: 230, clientY: 180 })).toBe(false);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(items);
    expect(screen.getByRole("menu").style.left).toBe("230px");
    expect(screen.getByRole("menu").style.top).toBe("180px");
    const secondCard = screen.getByRole("article", { name: "第二项专利" });
    fireEvent.contextMenu(secondCard, { clientX: 250, clientY: 190 });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    await user.click(screen.getByRole("menuitem", { name: "继续编辑" }));
    expect(onOpenPatent).toHaveBeenCalledWith(second);
    onOpenPatent.mockClear();
    fireEvent.contextMenu(card, { clientX: 230, clientY: 180 });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(card, { clientX: 230, clientY: 180 });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    const measure = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 180, 200));
    try {
      fireEvent.contextMenu(card, {
        clientX: window.innerWidth - 1,
        clientY: window.innerHeight - 1,
      });
      const menu = screen.getByRole("menu");
      expect(menu.closest(".spatial-presence")?.parentElement).toBe(document.body);
      expect(menu.style.position).toBe("fixed");
      expect(menu.style.left).toBe(`${window.innerWidth - 188}px`);
      expect(menu.style.top).toBe(`${window.innerHeight - 208}px`);
      fireEvent.scroll(menu);
      expect(screen.getByRole("menu")).toBe(menu);
      fireEvent.scroll(window);
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      measure.mockRestore();
    }
    fireEvent.contextMenu(card, { clientX: 230, clientY: 180 });
  }
  await user.click(screen.getByRole("menuitem", { name: "多选" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(within(card).getByRole("checkbox")).toHaveProperty("checked", true);
  expect(screen.getByRole("checkbox", { name: "选择 第二项专利" })).toHaveProperty(
    "checked",
    false,
  );
  expect(onOpenPatent).not.toHaveBeenCalled();
  expect(onExportPatents).not.toHaveBeenCalled();
  if (entry === "context") fireEvent.contextMenu(card, { clientX: 230, clientY: 180 });
  else await user.click(within(card).getByRole("button", { name: "更多操作" }));
  const deleteItem = screen.getByRole("menuitem", { name: "删除" });
  expect(deleteItem).toHaveProperty("disabled", false);
  await user.click(deleteItem);
  expect(screen.getByRole("group", { name: "专利多选操作" })).toBeDefined();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("checkbox", { name: "选择 第二项专利" }));
  await user.click(screen.getByRole("button", { name: "导出所选（2）" }));
  expect(onExportPatents).toHaveBeenCalledWith(expect.arrayContaining([first, second]));
  await user.click(screen.getByRole("button", { name: "取消选择" }));
  expect(screen.queryByRole("checkbox", { name: /^选择 / })).toBeNull();
  if (entry === "context") fireEvent.contextMenu(card, { clientX: 230, clientY: 180 });
  else await user.click(within(card).getByRole("button", { name: "更多操作" }));
  expect(screen.getByRole("menuitem", { name: "删除" })).toHaveProperty("disabled", false);
});

test("uses one import menu for DOCX and PATDOC and closes it on Escape", async () => {
  const user = userEvent.setup();
  const onImportDocx = vi.fn();
  const onImportPatdoc = vi.fn();
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary()]}
      loading={false}
      onNewDocument={vi.fn()}
      onNewPatent={vi.fn()}
      onImportDocx={onImportDocx}
      onImportPatdoc={onImportPatdoc}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onOpenPatent={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "导入" }));
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "导入 DOCX",
    "导入 PATDOC",
  ]);
  await user.click(screen.getByRole("menuitem", { name: "导入 DOCX" }));
  expect(onImportDocx).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "导入" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menuitem", { name: "导入 PATDOC" })).toBeNull();
});

test("reserves the customer column when a patent has no customer name", () => {
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary({ customer: null })]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  const article = screen.getByRole("article", { name: "往复式夹具" });
  const customer = article.querySelector(".patent-list-row__customer");
  const modified = article.querySelector("time");

  if (!customer || !modified) throw new Error("customer or date column is missing");
  expect(customer.textContent).toBe("—");
  expect(modified?.getAttribute("title")).toMatch(/^创建：/u);
  expect(
    customer.compareDocumentPosition(modified) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test.each(["single", "double", "illustrated"] as const)(
  "preserves drag selection but blocks double-click word selection in %s view",
  async (mode) => {
    vi.stubGlobal("patentApi", { patents: {} });
    const onOpenPatent = vi.fn();
    render(
      <DocumentLibrary
        documents={[]}
        patents={[patentSummary()]}
        loading={false}
        patentLibraryViewMode={mode}
        onNewDocument={vi.fn()}
        onImportPatdoc={vi.fn()}
        onOpenTrash={vi.fn()}
        onOpenDocument={vi.fn()}
        onRenameDocument={vi.fn()}
        onExportPatdoc={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onMoveToTrash={vi.fn()}
        onOpenPatent={onOpenPatent}
      />,
    );
    const card = screen.getByRole("article", { name: "往复式夹具" });
    const title = within(card).getByRole("heading", { name: "往复式夹具" });
    expect(fireEvent.mouseDown(title, { button: 0, detail: 1 })).toBe(true);
    expect(fireEvent.mouseDown(title, { button: 0, detail: 2 })).toBe(false);
    expect(fireEvent.mouseDown(title, { button: 2, detail: 2 })).toBe(true);
    expect(
      fireEvent.mouseDown(within(card).getByRole("button", { name: "更多操作" }), {
        button: 0,
        detail: 2,
      }),
    ).toBe(true);
    fireEvent.doubleClick(title);
    expect(onOpenPatent).toHaveBeenCalledOnce();
  },
);

test("opens an editable patent by double-clicking its library card", async () => {
  const user = userEvent.setup();
  const patent = patentSummary();
  const onOpenPatent = vi.fn();
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patent]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
      onOpenPatent={onOpenPatent}
    />,
  );

  const article = screen.getByRole("article", { name: "往复式夹具" });
  await user.dblClick(article);

  expect(onOpenPatent).toHaveBeenCalledOnce();
  expect(onOpenPatent).toHaveBeenCalledWith(patent);
});

test("does not open a patent when double-clicking its actions menu", async () => {
  const user = userEvent.setup();
  const onOpenPatent = vi.fn();
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary()]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
      onOpenPatent={onOpenPatent}
    />,
  );

  const article = screen.getByRole("article", { name: "往复式夹具" });
  await user.dblClick(within(article).getByRole("button", { name: "更多操作" }));

  expect(onOpenPatent).not.toHaveBeenCalled();
});

test("reveals and highlights a restored patent for exactly five seconds", async () => {
  vi.useFakeTimers();
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  const first = patentSummary({ patentId: testUuid(201), name: "原专利" });
  const restored = patentSummary({ patentId: testUuid(202), name: "恢复副本" });
  const onPatentFocusHandled = vi.fn();
  const props = {
    documents: [],
    patents: [first, restored],
    loading: false,
    onNewDocument: vi.fn(),
    onImportPatdoc: vi.fn(),
    onOpenTrash: vi.fn(),
    onOpenDocument: vi.fn(),
    onRenameDocument: vi.fn(),
    onExportPatdoc: vi.fn(),
    onExportDocx: vi.fn(),
    onExportPdf: vi.fn(),
    onMoveToTrash: vi.fn(),
    onPatentFocusHandled,
  };
  const view = render(<DocumentLibrary {...props} patentFocusRequest={null} />);

  fireEvent.change(screen.getByRole("searchbox", { name: "搜索专利题目与客户" }), {
    target: { value: "原专利" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "专利类型" }), {
    target: { value: "invention" },
  });
  view.rerender(
    <DocumentLibrary
      {...props}
      patentFocusRequest={{ patentId: restored.patentId, requestKey: 1 }}
    />,
  );

  await act(async () => undefined);
  expect(
    screen.getByRole<HTMLInputElement>("searchbox", { name: "搜索专利题目与客户" }).value,
  ).toBe("");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "专利类型" }).value).toBe("all");
  const restoredCard = screen.getByRole("article", { name: "恢复副本" });
  expect(restoredCard.className).toContain("is-snapshot-restore-highlight");
  expect(screen.getByRole("article", { name: "原专利" }).className).not.toContain(
    "is-snapshot-restore-highlight",
  );
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(onPatentFocusHandled).toHaveBeenCalledWith(1);

  act(() => vi.advanceTimersByTime(4999));
  expect(restoredCard.className).toContain("is-snapshot-restore-highlight");
  act(() => vi.advanceTimersByTime(1));
  expect(restoredCard.className).not.toContain("is-snapshot-restore-highlight");
});

test("moves the full highlight window to the latest restore request", async () => {
  vi.useFakeTimers();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const first = patentSummary({ patentId: testUuid(211), name: "恢复副本一" });
  const second = patentSummary({ patentId: testUuid(212), name: "恢复副本二" });
  const props = {
    documents: [],
    patents: [first, second],
    loading: false,
    onNewDocument: vi.fn(),
    onImportPatdoc: vi.fn(),
    onOpenTrash: vi.fn(),
    onOpenDocument: vi.fn(),
    onRenameDocument: vi.fn(),
    onExportPatdoc: vi.fn(),
    onExportDocx: vi.fn(),
    onExportPdf: vi.fn(),
    onMoveToTrash: vi.fn(),
    onPatentFocusHandled: vi.fn(),
  };
  const view = render(
    <DocumentLibrary {...props} patentFocusRequest={{ patentId: first.patentId, requestKey: 1 }} />,
  );
  await act(async () => undefined);
  expect(screen.getByRole("article", { name: "恢复副本一" }).className).toContain(
    "is-snapshot-restore-highlight",
  );

  act(() => vi.advanceTimersByTime(4000));
  view.rerender(
    <DocumentLibrary
      {...props}
      patentFocusRequest={{ patentId: second.patentId, requestKey: 2 }}
    />,
  );
  await act(async () => undefined);
  expect(screen.getByRole("article", { name: "恢复副本一" }).className).not.toContain(
    "is-snapshot-restore-highlight",
  );
  const secondCard = screen.getByRole("article", { name: "恢复副本二" });
  expect(secondCard.className).toContain("is-snapshot-restore-highlight");

  act(() => vi.advanceTimersByTime(4999));
  expect(secondCard.className).toContain("is-snapshot-restore-highlight");
  act(() => vi.advanceTimersByTime(1));
  expect(secondCard.className).not.toContain("is-snapshot-restore-highlight");
});

test("renders unnamed patent cards without mutating their stored name", () => {
  const patent = patentSummary({
    name: null,
    createdAt: new Date(2026, 8, 6, 1, 28).toISOString(),
  });
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patent]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
      onNewPatent={vi.fn()}
      onOpenPatent={vi.fn()}
      onEditPatentSettings={vi.fn()}
      onMovePatentToTrash={vi.fn()}
    />,
  );

  expect(screen.getByRole("article", { name: "未命名专利 202609060128" })).toBeDefined();
  expect(patent.name).toBeNull();
});

test("searches and filters patents while keeping newest edits first", async () => {
  const user = userEvent.setup();
  const olderInvention = patentSummary({
    patentId: "00000000-0000-4000-8000-000000000202",
    name: "旧式夹具",
    patentType: "invention",
    modifiedAt: "2026-07-01T01:00:00.000Z",
  });
  const newerUtilityModel = patentSummary({
    patentId: "00000000-0000-4000-8000-000000000203",
    name: "新式夹具",
    patentType: "utility-model",
    modifiedAt: "2026-08-01T01:00:00.000Z",
  });
  render(
    <DocumentLibrary
      documents={[]}
      patents={[olderInvention, newerUtilityModel]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  expect(
    screen.getAllByRole("article").map((article) => article.getAttribute("aria-label")),
  ).toEqual(["旧式夹具", "新式夹具"]);
  await user.selectOptions(screen.getByRole("combobox", { name: "专利类型" }), "invention");
  expect(screen.getByRole("article", { name: "旧式夹具" })).toBeDefined();
  expect(screen.queryByRole("article", { name: "新式夹具" })).toBeNull();
  await user.type(screen.getByRole("searchbox", { name: "搜索专利题目与客户" }), "不存在");
  expect(screen.getByText("没有符合条件的专利。")).toBeDefined();
  await user.selectOptions(screen.getByRole("combobox", { name: "排序方式" }), "modified");
  expect(screen.queryByRole("button", { name: /最近编辑.*0\s*项/u })).toBeNull();
});

test("groups patents by creation month with the two most recent months open", async () => {
  const user = userEvent.setup();
  const current = patentSummary({
    patentId: testUuid(801),
    name: "本月专利",
    createdAt: createdAtMonthOffset(0),
  });
  const previous = patentSummary({
    patentId: testUuid(802),
    name: "上月专利",
    createdAt: createdAtMonthOffset(-1),
  });
  const older = patentSummary({
    patentId: testUuid(803),
    name: "早月专利",
    createdAt: createdAtMonthOffset(-2),
  });
  render(
    <DocumentLibrary
      documents={[]}
      patents={[older, previous, current]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  expect(
    screen
      .getByRole("button", { name: new RegExp(`${monthLabel(0)}.*1\\s*项`, "u") })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    screen
      .getByRole("button", { name: new RegExp(`${monthLabel(-1)}.*1\\s*项`, "u") })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  const olderHeading = screen.getByRole("button", {
    name: new RegExp(`${monthLabel(-2)}.*1\\s*项`, "u"),
  });
  expect(olderHeading.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("article", { name: "早月专利" })).toBeNull();

  await user.click(olderHeading);
  expect(olderHeading.getAttribute("aria-expanded")).toBe("true");
  const card = screen.getByRole("article", { name: "早月专利" });
  vi.useFakeTimers();
  fireEvent.click(olderHeading);
  expect(card.closest(".spatial-collapse")?.hasAttribute("inert")).toBe(true);
  act(() => vi.advanceTimersByTime(200));
  expect(card.isConnected).toBe(true);
  fireEvent.click(olderHeading);
  act(() => vi.advanceTimersByTime(420));
  expect(screen.getByRole("article", { name: "早月专利" })).toBe(card);
  fireEvent.click(olderHeading);
  act(() => vi.advanceTimersByTime(420));
  expect(card.isConnected).toBe(false);
});

test("temporarily opens matching older months and resets them after filters clear", async () => {
  const user = userEvent.setup();
  const current = patentSummary({
    patentId: testUuid(811),
    name: "本月专利",
    createdAt: createdAtMonthOffset(0),
  });
  const older = patentSummary({
    patentId: testUuid(812),
    name: "检索目标专利",
    createdAt: createdAtMonthOffset(-2),
  });
  render(
    <DocumentLibrary
      documents={[]}
      patents={[current, older]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  await user.type(screen.getByRole("searchbox", { name: "搜索专利题目与客户" }), "检索目标");
  expect(screen.getByRole("article", { name: "检索目标专利" })).toBeDefined();
  expect(
    screen
      .getByRole("button", { name: new RegExp(`${monthLabel(-2)}.*1\\s*项`, "u") })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  await user.click(
    screen.getByRole("button", { name: new RegExp(`${monthLabel(-2)}.*1\\s*项`, "u") }),
  );
  expect(
    screen
      .getByRole("button", { name: new RegExp(`${monthLabel(-2)}.*1\\s*项`, "u") })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(screen.queryByRole("article", { name: "检索目标专利" })).toBeNull();

  await user.clear(screen.getByRole("searchbox", { name: "搜索专利题目与客户" }));
  await act(async () => undefined);
  expect(
    screen
      .getByRole("button", { name: new RegExp(`${monthLabel(-2)}.*1\\s*项`, "u") })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(screen.queryByRole("article", { name: "检索目标专利" })).toBeNull();
});

test("changes the displayed view only after the preference is saved", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => true);
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary()]}
      loading={false}
      patentLibraryViewMode="single"
      onPatentLibraryViewModeChange={save}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  expect(screen.getByLabelText("专利列表").getAttribute("data-view-mode")).toBe("single");
  await user.click(screen.getByRole("button", { name: "双栏视图" }));
  expect(save).toHaveBeenCalledWith("double");
  expect(screen.getByLabelText("专利列表").getAttribute("data-view-mode")).toBe("double");
});

test("uses labelled view icons and a standard chevron for a month group", async () => {
  const user = userEvent.setup();
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary()]}
      loading={false}
      patentLibraryViewMode="single"
      onPatentLibraryViewModeChange={vi.fn(async () => true)}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: "单栏视图" }).getAttribute("title")).toBe("单栏显示");
  expect(screen.getByRole("button", { name: "双栏视图" }).getAttribute("title")).toBe("双栏显示");

  const monthGroup = screen.getByRole("button", { name: /2026年8月/u });
  expect(monthGroup.getAttribute("aria-expanded")).toBe("true");
  expect(
    monthGroup.querySelector(".patent-library-month-chevron .lucide-chevron-right"),
  ).not.toBeNull();

  await user.click(monthGroup);
  expect(monthGroup.getAttribute("aria-expanded")).toBe("false");
  expect(monthGroup.querySelector(".lucide-chevron-right")).not.toBeNull();
});

test("lays out patent company and timestamps for each library view", () => {
  const customer = "山东一二三四五有限公司专利技术服务中心（有限合伙）";
  const title = "一种用于高温高压环境的超长多级风机叶片清理装置及其控制方法";
  const patent = patentSummary({
    customer,
    name: title,
  });
  const { rerender } = render(
    <DocumentLibrary
      documents={[]}
      patents={[patent]}
      loading={false}
      patentLibraryViewMode="single"
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  const row = screen.getByRole("article", { name: title });
  expect(row.querySelector(".patent-list-row__customer")?.textContent).toBe(customer);
  expect(row.querySelector("h2")?.getAttribute("title")).toBe(title);
  expect(row.querySelector("time")?.getAttribute("title")).toMatch(/^创建：/u);
  expect(row.querySelector("time")?.textContent).toMatch(/^最后编辑：2026\/08\/01/u);

  rerender(
    <DocumentLibrary
      documents={[]}
      patents={[patent]}
      loading={false}
      patentLibraryViewMode="double"
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  const card = screen.getByRole("article", { name: title });
  expect(card.querySelector(".library-card-meta")?.textContent).toMatch(
    new RegExp(`^${customer}\\s*创建：`, "u"),
  );
  expect(card.querySelector(".library-card-customer")?.getAttribute("title")).toBe(customer);
  expect(card.querySelector(".library-card-title-content .patent-type-badge")).not.toBeNull();
  expect(card.querySelector(".patent-card-title-modified")).toBeNull();
  expect(card.querySelector(".library-card-meta .patent-card-meta-modified")?.textContent).toMatch(
    /^最后编辑：2026\/08\/01/u,
  );
});

test("keeps the previous view when the preference cannot be saved", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => false);
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary()]}
      loading={false}
      patentLibraryViewMode="single"
      onPatentLibraryViewModeChange={save}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "双栏视图" }));
  expect(save).toHaveBeenCalledWith("double");
  expect(screen.getByLabelText("专利列表").getAttribute("data-view-mode")).toBe("single");
});

test("slides remaining patent cards into place after a type filter changes", async () => {
  vi.setSystemTime(new Date("2026-08-02T23:59:59Z"));
  const originalAnimate = HTMLElement.prototype.animate;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const card = this.closest<HTMLElement>(".library-card");
    const index = card?.parentElement ? Array.from(card.parentElement.children).indexOf(card) : 0;
    const top = Math.max(0, index) * 100;
    return {
      width: 500,
      height: 80,
      top,
      bottom: top + 80,
      left: 0,
      right: 500,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  };
  const newerUtility = patentSummary({
    patentId: testUuid(901),
    name: "新式夹具",
    patentType: "utility-model",
    modifiedAt: "2026-08-02T00:00:00.000Z",
  });
  const olderInvention = patentSummary({
    patentId: testUuid(902),
    name: "旧式夹具",
    patentType: "invention",
    modifiedAt: "2026-08-01T00:00:00.000Z",
  });

  try {
    const user = userEvent.setup();
    render(
      <DocumentLibrary
        documents={[]}
        patents={[newerUtility, olderInvention]}
        loading={false}
        onNewDocument={vi.fn()}
        onImportPatdoc={vi.fn()}
        onOpenTrash={vi.fn()}
        onOpenDocument={vi.fn()}
        onRenameDocument={vi.fn()}
        onExportPatdoc={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onMoveToTrash={vi.fn()}
      />,
    );
    animate.mockClear();
    await user.selectOptions(screen.getByRole("combobox", { name: "专利类型" }), "invention");

    await vi.waitFor(() =>
      expect(animate).toHaveBeenCalledWith(
        [{ transform: "translate(0px, 100px)" }, { transform: "translate(0, 0)" }],
        expect.objectContaining({ duration: 400, easing: "ease-in-out" }),
      ),
    );
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});

test("does not animate patent cards during continuous search input", async () => {
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;
  try {
    const user = userEvent.setup();
    render(
      <DocumentLibrary
        documents={[]}
        patents={[patentSummary(), patentSummary({ patentId: testUuid(903), name: "轴承" })]}
        loading={false}
        onNewDocument={vi.fn()}
        onImportPatdoc={vi.fn()}
        onOpenTrash={vi.fn()}
        onOpenDocument={vi.fn()}
        onRenameDocument={vi.fn()}
        onExportPatdoc={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onMoveToTrash={vi.fn()}
      />,
    );
    animate.mockClear();
    await user.type(screen.getByRole("searchbox", { name: "搜索专利题目与客户" }), "轴");
    expect(animate).not.toHaveBeenCalled();
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
  }
});

test("does not show the completeness issue count on patent cards", () => {
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary({ issueCount: 3 })]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  expect(screen.queryByText("需检查 3 项")).toBeNull();
  expect(screen.queryByText(/需检查/u)).toBeNull();
  expect(screen.queryByText("完整性检查通过")).toBeNull();
});

test("shows a retryable read error instead of a false empty patent library", async () => {
  const user = userEvent.setup();
  const onRetryActive = vi.fn();

  render(
    <DocumentLibrary
      documents={[]}
      patents={[]}
      loading={false}
      activeError={{ code: "INTERNAL", message: "读取专利库失败。" }}
      onRetryActive={onRetryActive}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  expect(screen.getByRole("alert").textContent).toContain("专利库暂时无法读取");
  expect(screen.queryByRole("region", { name: "空专利库" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "重试读取专利库" }));
  expect(onRetryActive).toHaveBeenCalledTimes(1);
});

test("marks quarantined patent actions unavailable while still allowing safe deletion", async () => {
  const user = userEvent.setup();
  const patent = patentSummary({
    name: "待恢复专利",
    recoveryState: "quarantined",
    recoveryErrorCode: "CORRUPT_FILE",
    issueCount: 1,
    bookStatuses: {
      claims: "unavailable",
      description: "unavailable",
      "description-drawings": "unavailable",
      abstract: "unavailable",
      "abstract-drawing": "unavailable",
    },
  });
  const handlers = {
    onOpenPatent: vi.fn(),
    onEditPatentSettings: vi.fn(),
    onRecoverPatent: vi.fn(),
    onExportPatentPatdoc: vi.fn(),
    onMovePatentToTrash: vi.fn(),
  };

  render(
    <DocumentLibrary
      documents={[]}
      patents={[patent]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
      {...handlers}
    />,
  );

  const article = screen.getByRole("article", { name: "待恢复专利" });
  expect(within(article).getByText(/文件内容损坏或不完整/u)).toBeDefined();
  expect(within(article).getByText(/诊断代码：CORRUPT_FILE/u)).toBeDefined();
  await user.click(within(article).getByRole("button", { name: "更多操作" }));
  expect((screen.getByRole("menuitem", { name: "继续编辑" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("menuitem", { name: "设置" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("menuitem", { name: "导出" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("menuitem", { name: "修复并打开" })).toBeDefined();
  await user.click(screen.getByRole("menuitem", { name: "修复并打开" }));
  await user.click(within(article).getByRole("button", { name: "更多操作" }));
  await user.click(screen.getByRole("menuitem", { name: "删除" }));
  expect(handlers.onRecoverPatent).toHaveBeenCalledWith(patent);
  expect(handlers.onMovePatentToTrash).toHaveBeenCalledWith(patent);
});

test("offers inline repair and snapshot actions for a broken journal chain", async () => {
  const user = userEvent.setup();
  const patent = patentSummary({
    name: "断链专利",
    recoveryState: "quarantined",
    recoveryErrorCode: "RECOVERY_CHAIN_BROKEN",
    issueCount: 0,
    bookStatuses: {
      claims: "unavailable",
      description: "unavailable",
      "description-drawings": "unavailable",
      abstract: "unavailable",
      "abstract-drawing": "unavailable",
    },
  });
  // Stays pending so the busy state can be observed without resolving it after the assertions.
  const onRecoverPatent = vi.fn(() => new Promise<void>(() => undefined));
  const onOpenSnapshots = vi.fn();

  render(
    <DocumentLibrary
      documents={[]}
      patents={[patent]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
      onOpenSnapshots={onOpenSnapshots}
      onRecoverPatent={onRecoverPatent}
    />,
  );

  const article = screen.getByRole("article", { name: "断链专利" });
  expect(within(article).getByText(/编辑历史无法自证，但正文内容完好/u)).toBeDefined();
  expect(within(article).getByText(/诊断代码：RECOVERY_CHAIN_BROKEN/u)).toBeDefined();
  expect(within(article).queryByText(/文件内容损坏/u)).toBeNull();

  await user.click(within(article).getByRole("button", { name: "查看快照版本" }));
  expect(onOpenSnapshots).toHaveBeenCalledWith(patent);

  await user.click(within(article).getByRole("button", { name: "修复并打开" }));
  expect(onRecoverPatent).toHaveBeenCalledWith(patent);
  expect(within(article).getByRole("button", { name: "正在修复" })).toBeDefined();
});

test("renders document summaries with library actions", async () => {
  const user = userEvent.setup();
  const handlers = {
    onNewDocument: vi.fn(),
    onImportPatdoc: vi.fn(),
    onOpenTrash: vi.fn(),
    onOpenDocument: vi.fn(),
    onRenameDocument: vi.fn(),
    onExportPatdoc: vi.fn(),
    onExportDocx: vi.fn(),
    onExportPdf: vi.fn(),
    onMoveToTrash: vi.fn(),
  };
  render(<DocumentLibrary documents={[summary()]} loading={false} {...handlers} />);

  expect(screen.getByRole("heading", { name: "文档库" })).toBeDefined();
  const article = screen.getByRole("article", { name: "往复式夹具" });
  expect(within(article).getByText("本发明涉及一种夹具。")).toBeDefined();
  expect(within(article).getByRole("status", { name: "已保存" })).toBeDefined();

  await user.click(within(article).getByRole("button", { name: "继续编辑 往复式夹具" }));
  await user.click(within(article).getByRole("button", { name: "导出 PATDOC 往复式夹具" }));
  await user.click(within(article).getByRole("button", { name: "删除 往复式夹具" }));

  expect(handlers.onOpenDocument).toHaveBeenCalledWith(summary());
  expect(handlers.onExportPatdoc).toHaveBeenCalledWith(summary());
  expect(handlers.onMoveToTrash).toHaveBeenCalledWith(summary());
});

test("blocks quarantined documents from normal editing actions", () => {
  render(
    <DocumentLibrary
      documents={[
        summary({
          title: "损坏文档",
          recoveryState: "quarantined",
          quarantinedAt: "2026-08-01T02:00:00.000Z",
          recoveryErrorCode: "SNAPSHOT_HASH_FAILED",
        }),
      ]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  const article = screen.getByRole("article", { name: "损坏文档" });
  expect(within(article).getByText(/诊断代码：SNAPSHOT_HASH_FAILED/u)).toBeDefined();
  expect(
    (within(article).getByRole("button", { name: "继续编辑 损坏文档" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (within(article).getByRole("button", { name: "重命名 损坏文档" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("body search scope clears hidden bulk selection and prevents unseen batch actions", () => {
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary()]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
      onExportPatents={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "导出" }));
  expect(screen.getByRole("group", { name: "专利多选操作" })).toBeDefined();
  fireEvent.click(screen.getByRole("checkbox", { name: "搜索正文" }));
  expect(screen.queryByRole("group", { name: "专利多选操作" })).toBeNull();
  expect(screen.getByRole("button", { name: "导出" })).toHaveProperty("disabled", true);
});

test("labels both patent search modes with a search results heading", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("patentApi", {
    contentSearch: {
      request: vi.fn(async () => ({
        ok: true,
        value: {
          enabled: false,
          running: false,
          completed: 0,
          total: 0,
          updatedAt: null,
          error: false,
          incomplete: true,
          hits: [],
        },
      })),
    },
  });
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary()]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onOpenPatent={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  expect(screen.queryByRole("heading", { name: "搜索结果" })).toBeNull();
  await user.type(screen.getByRole("searchbox", { name: "搜索专利题目与客户" }), "夹具");
  expect(screen.getByRole("heading", { name: "搜索结果" })).toBeDefined();

  await user.click(screen.getByRole("checkbox", { name: "搜索正文" }));
  expect(screen.getAllByRole("heading", { name: "搜索结果" })).toHaveLength(1);
});

test("shows a clear body-search switch inside the patent search field", async () => {
  const user = userEvent.setup();
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary()]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  const search = screen.getByRole("searchbox", { name: "搜索专利题目与客户" });
  const bodySearch = screen.getByRole<HTMLInputElement>("checkbox", { name: "搜索正文" });
  expect(search.closest(".patent-library-search")?.contains(bodySearch)).toBe(true);
  expect(bodySearch.checked).toBe(false);
  expect(search).toHaveProperty("placeholder", "搜索专利题目或客户");
  expect(screen.queryByRole("combobox", { name: "搜索范围" })).toBeNull();

  await user.click(bodySearch);
  expect(bodySearch.checked).toBe(true);
  expect(screen.getByRole("searchbox", { name: "搜索五书正文" })).toHaveProperty(
    "placeholder",
    "搜索五书正文",
  );
});

test.each([
  { updatedAt: null },
  { updatedAt: "2026-10-03T12:00:00Z", indexedCount: 0, pendingCount: 1 },
])("offers to build a missing body index before enabling body search", async (coverage) => {
  const request = vi.fn(async () => ({
    ok: true as const,
    value: {
      enabled: true,
      running: false,
      completed: 0,
      total: 1,
      ...coverage,
      error: false,
      incomplete: true,
    },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  const user = userEvent.setup();
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary()]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );

  const bodySearch = screen.getByRole<HTMLInputElement>("checkbox", { name: "搜索正文" });
  await user.click(bodySearch);

  expect(await screen.findByRole("dialog", { name: "建立正文索引" })).toBeDefined();
  expect(bodySearch.checked).toBe(false);
  expect(screen.getByRole("button", { name: "先建立索引" })).toBeDefined();
  expect(request).toHaveBeenCalledWith({ action: "status" });

  await user.click(screen.getByRole("button", { name: "暂不索引" }));
  expect(bodySearch.checked).toBe(false);
  expect(request).not.toHaveBeenCalledWith({ action: "start" });
});

test("keeps sidebar type navigation synchronized with the filter and uses the real logo", async () => {
  const trash = vi.fn();
  render(
    <DocumentLibrary
      documents={[]}
      patents={[
        patentSummary(),
        patentSummary({ patentId: testUuid(999), name: "发明样例", patentType: "invention" }),
      ]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={trash}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );
  const sidebar = screen.getByRole("complementary", { name: "专利库导航" });
  expect(sidebar.querySelector("img")?.getAttribute("src")).toContain("xiaozhan-logo.png");
  expect(within(sidebar).getByText("Work")).toBeDefined();
  await act(async () => fireEvent.click(within(sidebar).getByRole("button", { name: "发明" })));
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "专利类型" }).value).toBe(
    "invention",
  );
  expect(screen.queryByRole("article", { name: "往复式夹具" })).toBeNull();
  expect(screen.getByRole("article", { name: "发明样例" })).toBeDefined();
  fireEvent.change(screen.getByRole("combobox", { name: "专利类型" }), {
    target: { value: "utility-model" },
  });
  expect(
    within(sidebar).getByRole("button", { name: "实用新型" }).getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.click(within(sidebar).getByRole("button", { name: "回收站" }));
  expect(trash).toHaveBeenCalledOnce();
});

test("starts row and whole-list selection using the existing batch export flow", async () => {
  const exportPatents = vi.fn();
  const patent = patentSummary();
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patent]}
      loading={false}
      onExportPatents={exportPatents}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "多选 往复式夹具" }));
  expect(screen.getByRole("checkbox", { name: "选择 往复式夹具" })).toHaveProperty("checked", true);
  fireEvent.click(screen.getByRole("button", { name: "导出所选（1）" }));
  expect(exportPatents).toHaveBeenCalledWith([patent]);
  fireEvent.click(screen.getByRole("button", { name: "取消选择" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "选择全部专利进行批量操作" }));
  expect(screen.getByRole("checkbox", { name: "选择 往复式夹具" })).toHaveProperty("checked", true);
});

test.each(["checkbox", "toolbar"])(
  "canceling whole-list selection via %s exits the export bar",
  (control) => {
    render(
      <DocumentLibrary
        documents={[]}
        patents={[
          patentSummary(),
          patentSummary({ patentId: testUuid(202), name: "第二项专利" }),
          patentSummary({
            patentId: testUuid(203),
            name: "隔离专利",
            recoveryState: "quarantined",
          }),
        ]}
        loading={false}
        onExportPatents={vi.fn()}
        onNewDocument={vi.fn()}
        onImportPatdoc={vi.fn()}
        onOpenTrash={vi.fn()}
        onOpenDocument={vi.fn()}
        onRenameDocument={vi.fn()}
        onExportPatdoc={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onMoveToTrash={vi.fn()}
      />,
    );
    const all = screen.getByRole("checkbox", { name: "选择全部专利进行批量操作" });
    expect(all).toHaveProperty("checked", false);
    fireEvent.click(all);
    const first = screen.getByRole("checkbox", { name: "选择 往复式夹具" });
    const second = screen.getByRole("checkbox", { name: "选择 第二项专利" });
    const quarantined = screen.getByRole("checkbox", { name: "选择 隔离专利" });
    expect(all).toHaveProperty("checked", true);
    expect(first).toHaveProperty("checked", true);
    expect(second).toHaveProperty("checked", true);
    expect(quarantined).toHaveProperty("disabled", true);
    expect(quarantined).toHaveProperty("checked", false);

    fireEvent.click(second);
    expect(all).toHaveProperty("checked", false);
    expect(all).toHaveProperty("indeterminate", true);
    fireEvent.click(all);
    expect(all).toHaveProperty("checked", true);
    expect(all).toHaveProperty("indeterminate", false);
    if (control === "checkbox") {
      fireEvent.click(all);
    } else {
      fireEvent.click(screen.getByRole("button", { name: "全选当前筛选专利" }));
    }
    expect(all).toHaveProperty("checked", false);
    expect(screen.queryByRole("button", { name: /导出所选/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "专利多选操作" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "选择 往复式夹具" })).toBeNull();
    expect(screen.getByRole("button", { name: "多选 往复式夹具" })).toBeTruthy();
    fireEvent.click(all);
    expect(all).toHaveProperty("checked", true);
    expect(screen.getByRole("button", { name: "导出所选（2）" })).toBeTruthy();
  },
);

test("library More preserves shortcut creation and exit, and Escape cancels without acting", () => {
  const createShortcut = vi.fn();
  const exit = vi.fn();
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patentSummary()]}
      loading={false}
      onNewDocument={vi.fn()}
      onImportPatdoc={vi.fn()}
      onOpenTrash={vi.fn()}
      onOpenDocument={vi.fn()}
      onRenameDocument={vi.fn()}
      onExportPatdoc={vi.fn()}
      onExportDocx={vi.fn()}
      onExportPdf={vi.fn()}
      onMoveToTrash={vi.fn()}
      onCreateDesktopShortcut={createShortcut}
      onExitApplication={exit}
    />,
  );
  const trigger = screen.getByRole("button", { name: "更多" });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: "创建桌面快捷方式" }));
  expect(createShortcut).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu", { name: "专利库更多操作" })).toBeNull();
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "退出软件" }), { key: "Escape" });
  expect(exit).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: "退出软件" }));
  expect(exit).toHaveBeenCalledOnce();
});

test.each([
  { triggerName: "导入", menuName: "导入文件", itemName: "导入 DOCX" },
  { triggerName: "更多", menuName: "专利库更多操作", itemName: "创建桌面快捷方式" },
])(
  "anchors $triggerName to its button and keeps the menu inside the viewport",
  async ({ triggerName, menuName, itemName }) => {
    const action = vi.fn();
    const user = userEvent.setup();
    render(
      <DocumentLibrary
        documents={[]}
        patents={[patentSummary()]}
        loading={false}
        onNewDocument={vi.fn()}
        onImportPatdoc={vi.fn()}
        onImportDocx={action}
        onCreateDesktopShortcut={action}
        onExitApplication={vi.fn()}
        onOpenTrash={vi.fn()}
        onOpenDocument={vi.fn()}
        onRenameDocument={vi.fn()}
        onExportPatdoc={vi.fn()}
        onExportDocx={vi.fn()}
        onExportPdf={vi.fn()}
        onMoveToTrash={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: triggerName });
    let triggerLeft = 150;
    const measure = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return this === trigger
          ? new DOMRect(triggerLeft, 30, 80, 36)
          : new DOMRect(0, 0, 218, 122);
      });
    try {
      await user.click(trigger);
      const menu = screen.getByRole("menu", { name: menuName });
      expect(menu.style.left).toBe("150px");
      expect(menu.style.top).toBe("74px");
      expect(menu.closest(".spatial-presence")?.parentElement).toBe(document.body);
      triggerLeft = window.innerWidth - 90;
      fireEvent.resize(window);
      expect(menu.style.left).toBe(`${window.innerWidth - 218 - 8}px`);
      triggerLeft = 220;
      fireEvent.scroll(document);
      expect(menu.style.left).toBe("220px");
      await user.click(screen.getByRole("menuitem", { name: itemName }));
      expect(action).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu", { name: menuName })).toBeNull();
    } finally {
      measure.mockRestore();
    }
  },
);
