import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OpenedPatent } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { PATENT_BOOK_LABELS, PATENT_BOOK_ORDER } from "../../../shared/patent/model";
import * as appDialogs from "../shared/app-dialog";
import { PatentBookTabs } from "./patent-book-tabs";
import { createPatentSession } from "./patent-reducer";

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function session() {
  const patent = createBlankPatent({
    patentType: "invention",
    name: "夹具专利",
  });
  patent.patentId = testUuid(101);
  patent.books.forEach((book, index) => {
    book.bookId = testUuid(301 + index);
    book.document.documentId = testUuid(401 + index);
  });
  const opened: OpenedPatent = {
    patentId: patent.patentId,
    sessionId: testUuid(201),
    revision: 0,
    patent,
    saveState: "saved",
  };
  return createPatentSession(opened);
}

test("starts a workspace drag with the exact five-book target", () => {
  const activeSession = session();
  const workspaceTabDrag = { start: vi.fn(), consumeClick: vi.fn(() => false) };

  render(
    <PatentBookTabs
      session={activeSession}
      onActivateBook={vi.fn()}
      onSetDrawingBooksEnabled={vi.fn(async () => true)}
      workspaceTabDrag={workspaceTabDrag}
    />,
  );
  const tab = screen.getByRole("tab", { name: "说明书摘要" });

  fireEvent.pointerDown(tab, { pointerId: 8, button: 0, clientX: 360, clientY: 70 });

  expect(workspaceTabDrag.start).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceElement: tab,
      source: {
        key: `book:${activeSession.patentId}:abstract`,
        label: "说明书摘要",
        target: { patentId: activeSession.patentId, bookKind: "abstract" },
      },
    }),
  );
});

test("keeps drawing removal controls outside workspace drag handling", () => {
  const activeSession = session();
  const workspaceTabDrag = { start: vi.fn(), consumeClick: vi.fn(() => false) };

  render(
    <PatentBookTabs
      session={activeSession}
      onActivateBook={vi.fn()}
      onSetDrawingBooksEnabled={vi.fn(async () => true)}
      workspaceTabDrag={workspaceTabDrag}
    />,
  );

  fireEvent.pointerDown(
    screen.getAllByRole("button", { name: "删除说明书附图和摘要附图" })[0] as HTMLElement,
    { pointerId: 9, button: 0, clientX: 600, clientY: 70 },
  );

  expect(workspaceTabDrag.start).not.toHaveBeenCalled();
  const removal = screen.getAllByRole("button", { name: "删除说明书附图和摘要附图" })[0];
  expect(removal?.querySelector("svg")).not.toBeNull();
  expect(removal?.querySelector("svg.lucide-x")).not.toBeNull();
  expect(removal?.textContent).not.toContain("✕");
});

test("opens description drawings before importing images dropped on its tab", async () => {
  const activeSession = session();
  activeSession.activeBookKind = "claims";
  const onActivateBook = vi.fn();
  let finishImport: ((imported: boolean) => void) | undefined;
  const onDropDrawingFiles = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finishImport = resolve;
      }),
  );
  const image = new File([new Uint8Array([1, 2, 3])], "附图1.png", { type: "image/png" });

  render(
    <PatentBookTabs
      session={activeSession}
      onActivateBook={onActivateBook}
      onSetDrawingBooksEnabled={vi.fn(async () => true)}
      onDropDrawingFiles={onDropDrawingFiles}
    />,
  );

  const drawingTab = screen.getByRole("tab", { name: "说明书附图" });
  fireEvent.dragOver(drawingTab, {
    dataTransfer: { types: ["Files"], files: [image] },
  });
  expect(drawingTab.classList.contains("is-file-drop-target")).toBe(true);

  fireEvent.drop(drawingTab, {
    dataTransfer: { types: ["Files"], files: [image] },
  });

  expect(onActivateBook).toHaveBeenCalledWith(activeSession.patentId, "description-drawings");
  await waitFor(() =>
    expect(onDropDrawingFiles).toHaveBeenCalledWith(activeSession.patentId, [image]),
  );
  finishImport?.(true);
  expect(drawingTab.classList.contains("is-file-drop-target")).toBe(false);
});

test("ignores non-image files dropped on the description drawings tab", async () => {
  const activeSession = session();
  activeSession.activeBookKind = "description";
  const onActivateBook = vi.fn();
  const onDropDrawingFiles = vi.fn(async () => true);
  const text = new File(["说明"], "说明.txt", { type: "text/plain" });

  render(
    <PatentBookTabs
      session={activeSession}
      onActivateBook={onActivateBook}
      onSetDrawingBooksEnabled={vi.fn(async () => true)}
      onDropDrawingFiles={onDropDrawingFiles}
    />,
  );

  fireEvent.drop(screen.getByRole("tab", { name: "说明书附图" }), {
    dataTransfer: { types: ["Files"], files: [text] },
  });

  expect(onActivateBook).not.toHaveBeenCalled();
  expect(onDropDrawingFiles).not.toHaveBeenCalled();
});

test("renders five books in canonical order and activates the selected book", async () => {
  const user = userEvent.setup();
  const activeSession = session();
  activeSession.activeBookKind = "description";
  const onActivateBook = vi.fn();

  render(
    <PatentBookTabs
      session={activeSession}
      onActivateBook={onActivateBook}
      onSetDrawingBooksEnabled={vi.fn(async () => true)}
    />,
  );

  const tablist = screen.getByRole("tablist", { name: "五书标签栏" });
  expect(
    within(tablist)
      .getAllByRole("tab")
      .map((tab) => tab.getAttribute("aria-label")),
  ).toEqual(PATENT_BOOK_ORDER.map((kind) => PATENT_BOOK_LABELS[kind]));
  expect(within(tablist).getByRole("tab", { name: "说明书" }).getAttribute("aria-selected")).toBe(
    "true",
  );

  await user.click(within(tablist).getByRole("tab", { name: "权利要求书" }));
  expect(onActivateBook).toHaveBeenCalledWith(activeSession.patentId, "claims");
});

test("does not render per-book status dots", () => {
  const activeSession = session();

  render(
    <PatentBookTabs
      session={activeSession}
      onActivateBook={vi.fn()}
      onSetDrawingBooksEnabled={vi.fn(async () => true)}
    />,
  );

  expect(screen.queryByRole("status")).toBeNull();
});

test("allows an invention to remove both drawing books after explicit confirmation", async () => {
  const user = userEvent.setup();
  const activeSession = session();
  const onSetDrawingBooksEnabled = vi.fn(async () => true);

  render(
    <PatentBookTabs
      session={activeSession}
      onActivateBook={vi.fn()}
      onSetDrawingBooksEnabled={onSetDrawingBooksEnabled}
    />,
  );

  const removeButton = screen.getAllByRole("button", { name: "删除说明书附图和摘要附图" })[0];
  if (!removeButton) throw new Error("附图删除按钮不存在");
  const drawingTab = screen.getByRole("tab", { name: "说明书附图" });
  const drawingTabShell = drawingTab.closest(".patent-book-tabs__tab-shell");
  expect(drawingTabShell).not.toBeNull();
  expect(drawingTabShell?.contains(removeButton)).toBe(true);
  await user.click(removeButton);

  const dialog = screen.getByRole("alertdialog", { name: "删除说明书附图和摘要附图" });
  expect(within(dialog).getByRole("alert").textContent).toContain("不可撤销");
  await user.click(within(dialog).getByRole("button", { name: "确认删除" }));

  expect(onSetDrawingBooksEnabled).toHaveBeenCalledWith(activeSession.patentId, false);
});

test("retains the drawing-book removal dialog inertly while it exits", async () => {
  const user = userEvent.setup();
  const view = render(
    <PatentBookTabs
      session={session()}
      onActivateBook={vi.fn()}
      onSetDrawingBooksEnabled={vi.fn(async () => true)}
    />,
  );
  const removeButton = screen.getAllByRole("button", {
    name: "删除说明书附图和摘要附图",
  })[0];
  if (!removeButton) throw new Error("附图删除按钮不存在");
  await user.click(removeButton);
  await user.click(screen.getByRole("button", { name: "取消" }));

  expect(
    view.container.querySelector('.motion-presence[data-motion-state="closing"][inert]'),
  ).not.toBeNull();
});

test("hides drawing tabs and lets an invention add them back", async () => {
  const user = userEvent.setup();
  const activeSession = session();
  activeSession.patent.drawingBooksEnabled = false;
  const onSetDrawingBooksEnabled = vi.fn(async () => true);
  vi.spyOn(appDialogs, "confirmAppAction").mockResolvedValue(true);

  render(
    <PatentBookTabs
      session={activeSession}
      onActivateBook={vi.fn()}
      onSetDrawingBooksEnabled={onSetDrawingBooksEnabled}
    />,
  );

  expect(screen.queryByRole("tab", { name: "说明书附图" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "摘要附图" })).toBeNull();

  const abstractTab = screen.getByRole("tab", { name: "说明书摘要" });
  const addButton = screen.getByRole("button", { name: "添加附图" });
  expect(abstractTab.parentElement?.contains(addButton)).toBe(true);

  await user.click(addButton);

  expect(appDialogs.confirmAppAction).toHaveBeenCalledWith(
    "重新添加说明书附图和摘要附图？将创建两本新的空白附图书。",
  );
  expect(onSetDrawingBooksEnabled).toHaveBeenCalledWith(activeSession.patentId, true);
});

test("keeps drawing tabs visible when deleting them fails", async () => {
  const user = userEvent.setup();
  const activeSession = session();
  const onSetDrawingBooksEnabled = vi.fn(async () => false);

  render(
    <PatentBookTabs
      session={activeSession}
      onActivateBook={vi.fn()}
      onSetDrawingBooksEnabled={onSetDrawingBooksEnabled}
    />,
  );

  const removeButton = screen.getAllByRole("button", { name: "删除说明书附图和摘要附图" })[0];
  if (!removeButton) throw new Error("附图删除按钮不存在");
  await user.click(removeButton);
  const dialog = screen.getByRole("alertdialog", { name: "删除说明书附图和摘要附图" });
  await user.click(within(dialog).getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(onSetDrawingBooksEnabled).toHaveBeenCalledOnce());

  expect(screen.getByRole("tab", { name: "说明书附图" })).not.toBeNull();
  expect(screen.getByRole("tab", { name: "摘要附图" })).not.toBeNull();
});

test("does not offer drawing book controls for utility models", () => {
  const activeSession = session();
  activeSession.patent.patentType = "utility-model";

  render(
    <PatentBookTabs
      session={activeSession}
      onActivateBook={vi.fn()}
      onSetDrawingBooksEnabled={vi.fn(async () => true)}
    />,
  );

  expect(screen.queryByRole("button", { name: "删除说明书附图和摘要附图" })).toBeNull();
  expect(screen.queryByRole("button", { name: "添加附图" })).toBeNull();
});
