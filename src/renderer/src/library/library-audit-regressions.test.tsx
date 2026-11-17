import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import { DocumentLibrary, type PatentLibraryNavigationState } from "./document-library";
import { LibraryProvider, useLibrary } from "./library-context";
import { TrashView } from "./trash-view";

const handlers = () => ({
  onNewDocument: vi.fn(),
  onImportPatdoc: vi.fn(),
  onOpenTrash: vi.fn(),
  onOpenDocument: vi.fn(),
  onRenameDocument: vi.fn(),
  onExportPatdoc: vi.fn(),
  onExportDocx: vi.fn(),
  onExportPdf: vi.fn(),
  onMoveToTrash: vi.fn(),
});
const trashHandlers = () => ({
  onBackToLibrary: vi.fn(),
  onRestoreDocument: vi.fn(),
  onPermanentlyDeleteDocument: vi.fn(),
});
function patent(overrides: Partial<LibraryPatentSummary> = {}): LibraryPatentSummary {
  return {
    patentId: "00000000-0000-4000-8000-000000000123",
    name: "测试专利",
    customer: null,
    patentType: "invention",
    revision: 1,
    bookStatuses: {
      claims: "draft",
      description: "draft",
      abstract: "empty",
      "description-drawings": "empty",
      "abstract-drawing": "empty",
    },
    issueCount: 0,
    saveState: "saved",
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    deletedAt: null,
    recoveryState: "healthy",
    recoveryErrorCode: null,
    ...overrides,
  };
}
afterEach(() => vi.unstubAllGlobals());

test("preserves library search, type, sort and scroll across leaving the view", () => {
  const navigation = { current: null as PatentLibraryNavigationState | null };
  const props = {
    documents: [],
    patents: [patent()],
    loading: false,
    navigationStateRef: navigation,
    ...handlers(),
  };
  const first = render(<DocumentLibrary {...props} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "测试" } });
  fireEvent.change(screen.getByRole("combobox", { name: "专利类型" }), {
    target: { value: "invention" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "排序方式" }), {
    target: { value: "modified" },
  });
  const main = screen.getByRole("main");
  main.scrollTop = 220;
  fireEvent.scroll(main);
  first.unmount();
  render(<DocumentLibrary {...props} />);
  expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("测试");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "专利类型" }).value).toBe(
    "invention",
  );
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "排序方式" }).value).toBe(
    "modified",
  );
  expect(screen.getByRole("main").scrollTop).toBe(220);
});

test("preserves body search results, expansion and scroll when returning from a patent", async () => {
  vi.stubGlobal("patentApi", {
    contentSearch: {
      request: vi.fn(async (input: { action: string }) => ({
        ok: true,
        value: {
          enabled: true,
          running: false,
          manual: false,
          paused: false,
          completed: 1,
          total: 1,
          updatedAt: "2026-10-03T00:00:00.000Z",
          error: false,
          incomplete: false,
          hits: [
            {
              patentId: "00000000-0000-4000-8000-000000000123",
              books: [
                {
                  kind: "description",
                  count: 4,
                  snippets:
                    input.action === "search-details"
                      ? ["输送结果一", "输送结果二", "输送结果三", "输送结果四"]
                      : ["输送结果一", "输送结果二", "输送结果三"],
                },
              ],
            },
          ],
          hasMore: false,
        },
      })),
    },
  });
  const navigation = { current: null as PatentLibraryNavigationState | null };
  const props = {
    documents: [],
    patents: [patent()],
    loading: false,
    navigationStateRef: navigation,
    ...handlers(),
  };

  const first = render(<DocumentLibrary {...props} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "输送机构" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "搜索正文" }));
  expect(await screen.findByRole("region", { name: "正文搜索结果" })).toBeDefined();
  fireEvent.click(await screen.findByRole("button", { name: "展开全部 4 处" }));
  await screen.findByRole("button", { name: /说明书.*输送结果四/ });
  const main = screen.getByRole("main");
  main.scrollTop = 340;
  fireEvent.scroll(main);

  first.unmount();
  render(<DocumentLibrary {...props} />);

  expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("输送机构");
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "搜索正文" }).checked).toBe(true);
  expect(await screen.findByRole("region", { name: "正文搜索结果" })).toBeDefined();
  expect(screen.getByRole("button", { name: "收起全部匹配" })).toBeDefined();
  expect(screen.getByRole("main").scrollTop).toBe(340);
});

test("keeps the patent library header, buttons and search box fixed above the scrolling list", () => {
  const { container } = render(
    <DocumentLibrary documents={[]} patents={[patent()]} loading={false} {...handlers()} />,
  );
  const main = screen.getByRole("main", { name: "专利库" });
  const toolbar = container.querySelector<HTMLElement>(".library-toolbar");
  if (!toolbar) throw new Error("未找到专利库吸顶工具条");

  // 吸顶块必须是滚动容器的直接子元素，否则 sticky 贴不到列表上方。
  expect(toolbar.parentElement).toBe(main);
  expect(within(toolbar).getByRole("heading", { name: "专利库" })).toBeDefined();
  expect(within(toolbar).getByRole("button", { name: "新建专利" })).toBeDefined();
  expect(within(toolbar).getByRole("searchbox", { name: "搜索专利题目与客户" })).toBeDefined();
  // 列表在吸顶块之外，所以只有它跟着滚动。
  expect(within(toolbar).queryByRole("region", { name: "专利列表" })).toBeNull();
  expect(within(main).getByRole("region", { name: "专利列表" })).toBeDefined();
});

test("library menu supports arrow navigation and Escape returns to the trigger", () => {
  render(<DocumentLibrary documents={[]} patents={[patent()]} loading={false} {...handlers()} />);
  const trigger = screen.getByRole("button", { name: "更多操作" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "继续编辑" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "设置" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("patent cards do not show a separate continue-editing button", () => {
  render(<DocumentLibrary documents={[]} patents={[patent()]} loading={false} {...handlers()} />);
  const article = screen.getByRole("article", { name: "测试专利" });
  expect(within(article).queryByRole("button", { name: "继续编辑" })).toBeNull();
  expect(within(article).getByRole("button", { name: "更多操作" })).toBeDefined();
});

test("defers library thumbnail reads until the card enters the visible range", async () => {
  let show: IntersectionObserverCallback = () => {};
  const observeThumbnail = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(element: Element) {
        if (element.matches(".patent-illustrated-card__empty-image")) {
          show = this.callback;
          observeThumbnail(element);
        }
      }
      disconnect = vi.fn();
    },
  );
  const getLibraryPreview = vi.fn(async () => ({ ok: true, value: new Uint8Array([1, 2]) }));
  vi.stubGlobal("patentApi", { patents: { getLibraryPreview } });
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
  render(
    <DocumentLibrary
      documents={[]}
      patents={[patent({ drawingPreviewAssetId: "00000000-0000-4000-8000-000000000125" })]}
      loading={false}
      patentLibraryViewMode="illustrated"
      {...handlers()}
    />,
  );
  expect(getLibraryPreview).not.toHaveBeenCalled();
  expect(observeThumbnail).toHaveBeenCalledOnce();
  await act(async () =>
    show([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
  );
  await waitFor(() => expect(getLibraryPreview).toHaveBeenCalledOnce());
});

test("unnamed visible titles remain searchable and stable after filtering and trashing", () => {
  const target = patent({ name: null });
  const other = patent({
    patentId: "00000000-0000-4000-8000-000000000124",
    name: null,
    patentType: "utility-model",
  });
  const props = { documents: [], patents: [other, target], loading: false, ...handlers() };
  const view = render(<DocumentLibrary {...props} />);
  const title = screen
    .getAllByRole("article")
    .find((element) => element.dataset.libraryItemKey === target.patentId)!
    .getAttribute("aria-label")!;
  fireEvent.change(screen.getByRole("combobox", { name: "专利类型" }), {
    target: { value: "invention" },
  });
  expect(screen.getByRole("article", { name: title })).toBeDefined();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: title } });
  expect(screen.getByRole("article", { name: title })).toBeDefined();
  view.rerender(
    <TrashView documents={[]} patents={[target]} loading={false} {...trashHandlers()} />,
  );
  expect(screen.getByRole("article", { name: title })).toBeDefined();
});

test.each(["single", "double", "illustrated"] as const)(
  "explains quarantine in %s view",
  (mode) => {
    render(
      <DocumentLibrary
        documents={[]}
        patents={[patent({ recoveryState: "quarantined", recoveryErrorCode: "CORRUPT_FILE" })]}
        loading={false}
        patentLibraryViewMode={mode}
        {...handlers()}
      />,
    );
    const diagnosis = screen.getByText(/文件内容损坏或不完整/);
    expect(diagnosis.textContent).toContain("诊断代码：CORRUPT_FILE");
  },
);

test("scrolls restored card only after its collapsed group mounts", async () => {
  const scroll = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const target = patent();
  const done = vi.fn();
  const props = {
    documents: [],
    patents: [target],
    loading: false,
    ...handlers(),
    onPatentFocusHandled: done,
  };
  const view = render(<DocumentLibrary {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /年.*月/ }));
  expect(screen.queryByRole("article")).toBeNull();
  view.rerender(
    <DocumentLibrary
      {...props}
      patentFocusRequest={{ patentId: target.patentId, requestKey: 1 }}
    />,
  );
  await waitFor(() => expect(scroll).toHaveBeenCalledOnce());
  expect(done).toHaveBeenCalledWith(1);
});

test("trash has short action labels and lists only enabled books", () => {
  const target = patent({ name: "长名称".repeat(30) });
  target.bookStatuses["description-drawings"] = "unavailable";
  target.bookStatuses["abstract-drawing"] = "unavailable";
  render(<TrashView documents={[]} patents={[target]} loading={false} {...trashHandlers()} />);
  const card = screen.getByRole("article");
  expect(within(card).getByRole("button", { name: `恢复 ${target.name}` }).textContent).toBe(
    "恢复",
  );
  expect(within(card).getByRole("button", { name: `永久删除 ${target.name}` }).textContent).toBe(
    "永久删除",
  );
  expect(card.querySelector(".library-card-snippet")!.textContent).not.toContain("附图");
  expect(screen.getByRole("button", { name: "返回专利库" })).toBeDefined();
});

function TrashHarness() {
  const library = useLibrary();
  return (
    <>
      <button type="button" onClick={() => void library.refreshTrash()}>
        读取
      </button>
      <TrashView
        documents={library.trashDocuments}
        patents={library.trashPatents}
        loading={library.trashLoading}
        error={library.trashError}
        onRetry={() => void library.refreshTrash()}
        {...trashHandlers()}
      />
    </>
  );
}
test("trash failure does not pretend to be empty and can retry without losing old results", async () => {
  let fail = true;
  vi.stubGlobal("patentApi", {
    patents: {
      list: vi.fn(async (scope) =>
        scope === "active"
          ? { ok: true, value: [] }
          : fail
            ? { ok: false, error: { code: "INTERNAL", message: "测试读取失败" } }
            : { ok: true, value: [patent()] },
      ),
    },
  });
  render(
    <LibraryProvider>
      <TrashHarness />
    </LibraryProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "读取" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("回收站为空。")).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试读取回收站" }));
  await screen.findByRole("article");
  expect(screen.queryByRole("alert")).toBeNull();
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "读取" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("article")).toBeDefined();
});
