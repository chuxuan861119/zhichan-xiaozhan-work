import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OpenedPatent } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { PatentBookPicker, PatentBookSwitcher } from "./patent-book-picker";
import { createPatentSession } from "./patent-reducer";

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function session(name: string, index: number, drawingsEnabled = true) {
  const patent = createBlankPatent({ patentType: "invention", name });
  patent.patentId = testUuid(100 + index);
  patent.drawingBooksEnabled = drawingsEnabled;
  const opened: OpenedPatent = {
    patentId: patent.patentId,
    sessionId: testUuid(200 + index),
    revision: 0,
    patent,
    saveState: "saved",
  };
  return createPatentSession(opened);
}

test("shows opened patents and available books while excluding the opposite target", async () => {
  const user = userEvent.setup();
  const first = session("电池装置", 1);
  const second = session("回收工艺", 2, false);
  const onSelectPatent = vi.fn();
  const onSelectTarget = vi.fn();
  render(
    <PatentBookPicker
      sessions={[first, second]}
      selectedPatentId={first.patentId}
      excludedTarget={{ patentId: first.patentId, bookKind: "claims" }}
      onSelectPatent={onSelectPatent}
      onSelectTarget={onSelectTarget}
      onOpenOtherPatent={vi.fn()}
    />,
  );

  const patents = screen.getByRole("list", { name: "已打开的专利" });
  expect(
    within(patents)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["电池装置", "回收工艺"]);
  const books = screen.getByRole("list", { name: "电池装置的文档" });
  expect(within(books).queryByRole("button", { name: "权利要求书" })).toBeNull();
  expect(within(books).getByRole("button", { name: "说明书附图" })).toBeDefined();

  await user.click(within(patents).getByRole("button", { name: "回收工艺" }));
  expect(onSelectPatent).toHaveBeenCalledWith(second.patentId);
  await user.click(within(books).getByRole("button", { name: "说明书" }));
  expect(onSelectTarget).toHaveBeenCalledWith({
    patentId: first.patentId,
    bookKind: "description",
  });
});

test("excludes every displayed target from the document choices", () => {
  const current = session("夹具", 11);
  const onSelectTarget = vi.fn();
  render(
    <PatentBookSwitcher
      sessions={[current]}
      currentTarget={{ patentId: current.patentId, bookKind: "description" }}
      excludedTarget={{ patentId: current.patentId, bookKind: "claims" }}
      excludedTargets={[
        { patentId: current.patentId, bookKind: "description" },
        { patentId: current.patentId, bookKind: "claims" },
      ]}
      onSelectTarget={onSelectTarget}
      onOpenOtherPatent={vi.fn()}
    />,
  );

  const books = screen.getByRole("list", { name: "夹具的文档" });
  expect(within(books).queryByRole("button", { name: "权利要求书" })).toBeNull();
  expect(within(books).queryByRole("button", { name: "说明书" })).toBeNull();
  expect(onSelectTarget).not.toHaveBeenCalled();
});

test("offers a direct way to reveal the target already displayed on the opposite pane", async () => {
  const user = userEvent.setup();
  const current = session("夹具", 3);
  const onRevealExistingPane = vi.fn();
  render(
    <PatentBookPicker
      sessions={[current]}
      selectedPatentId={current.patentId}
      excludedTarget={{ patentId: current.patentId, bookKind: "claims" }}
      onSelectPatent={vi.fn()}
      onSelectTarget={vi.fn()}
      onRevealExistingPane={onRevealExistingPane}
      onOpenOtherPatent={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "切换到另一侧的权利要求书" }));
  expect(onRevealExistingPane).toHaveBeenCalledOnce();
});

test("keeps the other-patent entry when there is no second document", async () => {
  const user = userEvent.setup();
  const onOpenOtherPatent = vi.fn();
  render(
    <PatentBookPicker
      sessions={[]}
      selectedPatentId={null}
      excludedTarget={null}
      onSelectPatent={vi.fn()}
      onSelectTarget={vi.fn()}
      onOpenOtherPatent={onOpenOtherPatent}
    />,
  );

  expect(screen.getByText("请选择文档")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "打开其他专利……" }));
  expect(onOpenOtherPatent).toHaveBeenCalledOnce();
});

test("defaults the document switcher to the current patent without submitting a left-column choice", async () => {
  const user = userEvent.setup();
  const first = session("电池装置", 4);
  const second = session("回收工艺", 5, false);
  const onSelectTarget = vi.fn();
  render(
    <PatentBookSwitcher
      sessions={[first, second]}
      currentTarget={{ patentId: first.patentId, bookKind: "claims" }}
      excludedTarget={null}
      onSelectTarget={onSelectTarget}
      onOpenOtherPatent={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: "电池装置" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.getByRole("list", { name: "电池装置的文档" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "回收工艺" }));

  expect(onSelectTarget).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "回收工艺" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  const books = screen.getByRole("list", { name: "回收工艺的文档" });
  await user.click(within(books).getByRole("button", { name: "说明书" }));
  expect(onSelectTarget).toHaveBeenCalledWith({
    patentId: second.patentId,
    bookKind: "description",
  });
});

test("applies one requested patent selection without carrying it into a remounted switcher", async () => {
  const first = session("电池装置", 12);
  const second = session("回收工艺", 13);
  const onRequestedPatentApplied = vi.fn();
  const props = {
    sessions: [first, second],
    currentTarget: { patentId: first.patentId, bookKind: "claims" } as const,
    excludedTarget: null,
    onSelectTarget: vi.fn(),
    onOpenOtherPatent: vi.fn(),
  };
  const { rerender, unmount } = render(
    <PatentBookSwitcher
      {...props}
      requestedPatentId={second.patentId}
      onRequestedPatentApplied={onRequestedPatentApplied}
    />,
  );

  expect(await screen.findByRole("list", { name: "回收工艺的文档" })).toBeDefined();
  expect(onRequestedPatentApplied).toHaveBeenCalledOnce();

  rerender(<PatentBookSwitcher {...props} requestedPatentId={null} />);
  expect(screen.getByRole("list", { name: "回收工艺的文档" })).toBeDefined();

  unmount();
  render(<PatentBookSwitcher {...props} requestedPatentId={null} />);
  expect(screen.getByRole("list", { name: "电池装置的文档" })).toBeDefined();
});

test("passes the open-other-patent action through the document switcher", async () => {
  const user = userEvent.setup();
  const current = session("夹具", 9);
  const onOpenOtherPatent = vi.fn();
  render(
    <PatentBookSwitcher
      sessions={[current]}
      currentTarget={{ patentId: current.patentId, bookKind: "description" }}
      excludedTarget={null}
      onSelectTarget={vi.fn()}
      onOpenOtherPatent={onOpenOtherPatent}
    />,
  );

  await user.click(screen.getByRole("button", { name: "打开其他专利……" }));
  expect(onOpenOtherPatent).toHaveBeenCalledOnce();
});

test("keeps opposite-pane targets unavailable and exposes the reveal action", async () => {
  const user = userEvent.setup();
  const current = session("夹具", 6);
  const onRevealExistingPane = vi.fn();
  render(
    <PatentBookSwitcher
      sessions={[current]}
      currentTarget={{ patentId: current.patentId, bookKind: "description" }}
      excludedTarget={{ patentId: current.patentId, bookKind: "claims" }}
      onSelectTarget={vi.fn()}
      onRevealExistingPane={onRevealExistingPane}
      onOpenOtherPatent={vi.fn()}
    />,
  );

  const books = screen.getByRole("list", { name: "夹具的文档" });
  expect(within(books).queryByRole("button", { name: "权利要求书" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "切换到另一侧的权利要求书" }));
  expect(onRevealExistingPane).toHaveBeenCalledOnce();
});

test("keeps the local patent across equivalent targets and resets when the target patent changes", async () => {
  const user = userEvent.setup();
  const first = session("电池装置", 7);
  const second = session("回收工艺", 8);
  const third = session("夹具", 10);
  const { rerender } = render(
    <PatentBookSwitcher
      sessions={[first, second, third]}
      currentTarget={{ patentId: first.patentId, bookKind: "claims" }}
      excludedTarget={null}
      onSelectTarget={vi.fn()}
      onOpenOtherPatent={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "回收工艺" }));
  expect(screen.getByRole("list", { name: "回收工艺的文档" })).toBeDefined();

  rerender(
    <PatentBookSwitcher
      sessions={[first, second, third]}
      currentTarget={{ patentId: first.patentId, bookKind: "claims" }}
      excludedTarget={null}
      onSelectTarget={vi.fn()}
      onOpenOtherPatent={vi.fn()}
    />,
  );

  expect(screen.getByRole("list", { name: "回收工艺的文档" })).toBeDefined();

  rerender(
    <PatentBookSwitcher
      sessions={[first, second, third]}
      currentTarget={{ patentId: first.patentId, bookKind: "description" }}
      excludedTarget={null}
      onSelectTarget={vi.fn()}
      onOpenOtherPatent={vi.fn()}
    />,
  );

  expect(screen.getByRole("list", { name: "回收工艺的文档" })).toBeDefined();

  rerender(
    <PatentBookSwitcher
      sessions={[first, second, third]}
      currentTarget={{ patentId: third.patentId, bookKind: "description" }}
      excludedTarget={null}
      onSelectTarget={vi.fn()}
      onOpenOtherPatent={vi.fn()}
    />,
  );

  expect(await screen.findByRole("list", { name: "夹具的文档" })).toBeDefined();
  expect(screen.getByRole("button", { name: "夹具" }).getAttribute("aria-pressed")).toBe("true");
});

test("offers diagram and CAD workspaces in the dual pane picker", async () => {
  const owner = session("工具工作区", 3);
  const onSelectTarget = vi.fn();
  render(
    <PatentBookPicker
      sessions={[owner]}
      selectedPatentId={owner.patentId}
      excludedTarget={null}
      onSelectPatent={vi.fn()}
      onSelectTarget={onSelectTarget}
      onOpenOtherPatent={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "CAD标号" }));
  expect(onSelectTarget).toHaveBeenLastCalledWith({
    patentId: owner.patentId,
    kind: "tool",
    tool: "drawing-markup",
  });
  await userEvent.click(screen.getByRole("button", { name: "流程图 / 电路图" }));
  expect(onSelectTarget).toHaveBeenLastCalledWith({
    patentId: owner.patentId,
    kind: "tool",
    tool: "flowchart",
  });
});
