import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { LibraryDocumentSummary, LibraryPatentSummary } from "../../../shared/library/model";
import { confirmAppAction } from "../shared/app-dialog";
import { TrashDialog } from "./trash-dialog";

vi.mock("../shared/app-dialog", () => ({ confirmAppAction: vi.fn(async () => true) }));
const documentItem: LibraryDocumentSummary = {
  libraryDocumentId: "00000000-0000-4000-8000-000000000001",
  title: "写作草稿",
  snippet: "正文摘要",
  revision: 1,
  saveState: "saved",
  createdAt: "2026-08-01T00:00:00Z",
  modifiedAt: "2026-09-29T00:00:00Z",
  deletedAt: "2026-09-29T00:00:00Z",
  quarantinedAt: null,
  recoveryState: "healthy",
  recoveryErrorCode: null,
};
const patent: LibraryPatentSummary = {
  patentId: "00000000-0000-4000-8000-000000000002",
  name: "电池温控装置",
  customer: null,
  patentType: "invention",
  revision: 1,
  bookStatuses: {
    claims: "draft",
    description: "draft",
    "description-drawings": "unavailable",
    abstract: "draft",
    "abstract-drawing": "unavailable",
  },
  issueCount: 0,
  saveState: "saved",
  createdAt: "2026-08-01T00:00:00Z",
  modifiedAt: "2026-09-28T00:00:00Z",
  deletedAt: "2026-09-28T00:00:00Z",
  recoveryState: "healthy",
  recoveryErrorCode: null,
};
function props(overrides: Partial<ComponentProps<typeof TrashDialog>> = {}) {
  return {
    documents: [documentItem],
    patents: [patent],
    loading: false,
    error: null,
    onRetry: vi.fn(),
    onClose: vi.fn(),
    onRestoreDocument: vi.fn(async () => true),
    onRestorePatent: vi.fn(async () => true),
    onDeleteDocument: vi.fn(async () => true),
    onDeletePatent: vi.fn(async () => true),
    ...overrides,
  };
}
beforeEach(() => {
  vi.mocked(confirmAppAction).mockReset().mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());
const restore = () => screen.getByRole("button", { name: "恢复" });
const remove = () => screen.getByRole("button", { name: "永久删除" });
const manyDocuments = Array.from({ length: 21 }, (_, index) => ({
  ...documentItem,
  libraryDocumentId: `document-${index}`,
  title: `草稿 ${index + 1}`,
}));
test("searches titles only, resets selection and paginates matching results", async () => {
  render(<TrashDialog {...props({ documents: manyDocuments, patents: [patent] })} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 草稿 1" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索回收站题目" }), {
    target: { value: "草稿 1" },
  });
  await waitFor(() => expect(screen.getByText("共 11 项 · 每页 10 项")).toBeDefined());
  expect(restore()).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索回收站题目" }), {
    target: { value: "正文摘要" },
  });
  await waitFor(() => expect(screen.getByText("未找到匹配的题目")).toBeDefined());
  expect(screen.queryByRole("textbox", { name: "跳转页码" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "选择 草稿 1" })).toBeDefined());
});
test("sorts names naturally in both directions and dates and retention by actual time", () => {
  render(
    <TrashDialog
      {...props({
        documents: [
          {
            ...documentItem,
            title: "草稿 10",
            libraryDocumentId: "ten",
            deletedAt: "2026-09-28T00:00:00Z",
          },
          {
            ...documentItem,
            title: "草稿 2",
            libraryDocumentId: "two",
            deletedAt: "2026-09-29T00:00:00Z",
          },
        ],
        patents: [],
      })}
    />,
  );
  const names = () =>
    [...document.querySelectorAll(".trash-dialog__name")].map((node) => node.textContent);
  fireEvent.click(screen.getByRole("button", { name: "按名称排序" }));
  expect(names()).toEqual(["草稿 2", "草稿 10"]);
  fireEvent.click(screen.getByRole("button", { name: "按名称排序" }));
  expect(names()).toEqual(["草稿 10", "草稿 2"]);
  fireEvent.click(screen.getByRole("button", { name: "按删除时间排序" }));
  expect(names()).toEqual(["草稿 2", "草稿 10"]);
  fireEvent.click(screen.getByRole("button", { name: "按删除时间排序" }));
  expect(names()).toEqual(["草稿 10", "草稿 2"]);
  fireEvent.click(screen.getByRole("button", { name: "按剩余保留排序" }));
  expect(names()).toEqual(["草稿 10", "草稿 2"]);
  fireEvent.click(screen.getByRole("button", { name: "按剩余保留排序" }));
  expect(names()).toEqual(["草稿 2", "草稿 10"]);
});
test("sorts types and leaves unknown deletion times last in either direction", () => {
  render(
    <TrashDialog
      {...props({
        patents: [
          patent,
          {
            ...patent,
            patentId: "utility",
            name: "实用",
            patentType: "utility-model",
            deletedAt: "invalid",
          },
        ],
      })}
    />,
  );
  const names = () =>
    [...document.querySelectorAll(".trash-dialog__name")].map((node) => node.textContent);
  fireEvent.click(screen.getByRole("button", { name: "按类型排序" }));
  expect(names()).toEqual(["电池温控装置", "实用", "写作草稿"]);
  fireEvent.click(screen.getByRole("button", { name: "按类型排序" }));
  expect(names()).toEqual(["写作草稿", "实用", "电池温控装置"]);
  fireEvent.click(screen.getByRole("button", { name: "按删除时间排序" }));
  expect(names().at(-1)).toBe("实用");
  fireEvent.click(screen.getByRole("button", { name: "按删除时间排序" }));
  expect(names().at(-1)).toBe("实用");
});
test("paginates ten rows, preserves cross-page selection and jumps to valid pages", () => {
  render(<TrashDialog {...props({ documents: manyDocuments, patents: [] })} />);
  expect(screen.getAllByRole("checkbox")).toHaveLength(11);
  expect(screen.getByRole("button", { name: "上一页" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox", { name: "全选当前页" }));
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.queryByRole("checkbox", { name: "选择 草稿 1" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 草稿 11" }));
  expect(screen.getByText("已选择 11 项")).toBeDefined();
  const input = screen.getByRole("textbox", { name: "跳转页码" });
  fireEvent.change(input, { target: { value: "99" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveProperty("value", "3");
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "下一页" })).toHaveProperty("disabled", true);
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(input).toHaveProperty("value", "3");
  fireEvent.change(input, { target: { value: "1" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("checkbox", { name: "全选当前页" })).toHaveProperty("checked", true);
});
test("clamps the page after items disappear and hides pagination at ten items", () => {
  const p = props({ documents: manyDocuments, patents: [] });
  const view = render(<TrashDialog {...p} />);
  fireEvent.change(screen.getByRole("textbox", { name: "跳转页码" }), { target: { value: "3" } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "跳转页码" }), { key: "Enter" });
  view.rerender(<TrashDialog {...p} documents={manyDocuments.slice(0, 20)} />);
  expect(screen.getByRole("textbox", { name: "跳转页码" })).toHaveProperty("value", "2");
  expect(screen.getByRole("checkbox", { name: "选择 草稿 11" })).toBeDefined();
  view.rerender(<TrashDialog {...p} documents={manyDocuments.slice(0, 10)} />);
  expect(screen.queryByRole("textbox", { name: "跳转页码" })).toBeNull();
  expect(screen.getAllByRole("checkbox")).toHaveLength(11);
});
test("selection controls all, partial and cleared selections, including mixed types", () => {
  render(<TrashDialog {...props()} />);
  expect(restore()).toHaveProperty("disabled", true);
  const all = screen.getByRole("checkbox", { name: "全选回收站内容" });
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 写作草稿" }));
  expect(all).toHaveProperty("indeterminate", true);
  fireEvent.click(all);
  expect(all).toHaveProperty("checked", true);
  expect(screen.getByText("已选择 2 项")).toBeDefined();
  fireEvent.click(all);
  expect(restore()).toHaveProperty("disabled", true);
});
test("restores mixed content sequentially and leaves the dialog open", async () => {
  const p = props();
  render(<TrashDialog {...p} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "全选回收站内容" }));
  fireEvent.click(restore());
  await waitFor(() => expect(p.onRestorePatent).toHaveBeenCalledOnce());
  expect(p.onRestoreDocument).toHaveBeenCalledWith(documentItem);
  expect(confirmAppAction).not.toHaveBeenCalled();
  expect(p.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "回收站" })).toBeDefined();
  expect(screen.getByText("已恢复 2 项，可在专利库中查看。")).toBeDefined();
});
test("locks actions and close while running, stops on failure, retains unprocessed selection", async () => {
  let resolve: (value: boolean) => void = () => {};
  const p = props({
    onRestoreDocument: vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        }),
    ),
  });
  render(<TrashDialog {...p} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "全选回收站内容" }));
  fireEvent.click(restore());
  fireEvent.click(restore());
  expect(screen.getByRole("button", { name: "关闭回收站" })).toHaveProperty("disabled", true);
  await act(async () => resolve(false));
  expect(p.onRestoreDocument).toHaveBeenCalledOnce();
  expect(p.onRestorePatent).not.toHaveBeenCalled();
  expect(screen.getByText("已选择 2 项")).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain("未处理");
});
test("a later failure retains only failed and unprocessed selections", async () => {
  const p = props({ onRestorePatent: vi.fn(async () => false) });
  render(<TrashDialog {...p} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "全选回收站内容" }));
  fireEvent.click(restore());
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("已恢复 1 项"));
  expect(screen.getByText("已选择 1 项")).toBeDefined();
  expect(screen.getByRole("checkbox", { name: "选择 电池温控装置" })).toHaveProperty(
    "checked",
    true,
  );
});
test("cancelled batch delete changes nothing; accepted delete names and removes both types", async () => {
  vi.mocked(confirmAppAction).mockResolvedValueOnce(false);
  const p = props();
  render(<TrashDialog {...p} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "全选回收站内容" }));
  fireEvent.click(remove());
  await waitFor(() => expect(remove()).toHaveProperty("disabled", false));
  expect(p.onDeleteDocument).not.toHaveBeenCalled();
  expect(screen.getByText("已选择 2 项")).toBeDefined();
  fireEvent.click(remove());
  await waitFor(() => expect(p.onDeletePatent).toHaveBeenCalledOnce());
  expect(confirmAppAction).toHaveBeenLastCalledWith(expect.stringContaining("共 2 项"));
  expect(p.onDeleteDocument).toHaveBeenCalledOnce();
});
test("protected patents block the whole delete selection and unlock at 24h", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T08:59:59Z"));
  render(
    <TrashDialog {...props({ patents: [{ ...patent, deletedAt: "2026-10-03T09:00:00Z" }] })} />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "全选回收站内容" }));
  expect(remove()).toHaveProperty("disabled", true);
  expect(restore()).toHaveProperty("disabled", false);
  act(() => vi.advanceTimersByTime(1000));
  expect(remove()).toHaveProperty("disabled", false);
});
test("rechecks the selected patent protection after confirmation", async () => {
  let accept: (value: boolean) => void = () => {};
  vi.mocked(confirmAppAction).mockImplementation(
    () =>
      new Promise((r) => {
        accept = r;
      }),
  );
  const p = props({ documents: [] });
  const view = render(<TrashDialog {...p} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 电池温控装置" }));
  fireEvent.click(remove());
  view.rerender(
    <TrashDialog {...p} patents={[{ ...patent, deletedAt: new Date().toISOString() }]} />,
  );
  await act(async () => accept(true));
  expect(p.onDeletePatent).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeDefined();
});
test("failed reads keep previous rows, disable actions and allow retry", () => {
  const p = props({ error: { code: "DISK_FULL", message: "读取失败" } });
  render(<TrashDialog {...p} />);
  expect(screen.getByText("电池温控装置")).toBeDefined();
  expect(screen.queryByText("回收站为空")).toBeNull();
  expect(screen.getByRole("checkbox", { name: "全选回收站内容" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "重试读取回收站" }));
  expect(p.onRetry).toHaveBeenCalledOnce();
});
test("loading and empty are distinct, disappearing items prune selection", () => {
  const p = props();
  const v = render(<TrashDialog {...p} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "全选回收站内容" }));
  v.rerender(<TrashDialog {...p} documents={[]} />);
  expect(screen.getByText("已选择 1 项")).toBeDefined();
  v.rerender(<TrashDialog {...p} documents={[]} patents={[]} loading />);
  expect(screen.queryByText("回收站为空")).toBeNull();
  v.rerender(<TrashDialog {...p} documents={[]} patents={[]} />);
  expect(screen.getByText("回收站为空")).toBeDefined();
  expect(restore()).toHaveProperty("disabled", true);
});
test("close and Escape use the same return path", () => {
  const p = props();
  render(<TrashDialog {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(p.onClose).toHaveBeenCalledTimes(2);
});
