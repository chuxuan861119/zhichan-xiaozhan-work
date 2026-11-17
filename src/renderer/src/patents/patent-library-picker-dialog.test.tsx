import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OpenedPatent, PatentApi } from "../../../shared/ipc/contract";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { PatentLibraryPickerDialog } from "./patent-library-picker-dialog";
import { createPatentSession } from "./patent-reducer";

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function summary(name: string, index: number): LibraryPatentSummary {
  return {
    patentId: testUuid(300 + index),
    name,
    customer: null,
    patentType: "invention",
    revision: 0,
    bookStatuses: {
      claims: "draft",
      description: "draft",
      "description-drawings": "empty",
      abstract: "draft",
      "abstract-drawing": "empty",
    },
    issueCount: 0,
    saveState: "saved",
    createdAt: "2026-08-10T00:00:00.000Z",
    modifiedAt: "2026-08-10T00:00:00.000Z",
    deletedAt: null,
    recoveryState: "healthy",
    recoveryErrorCode: null,
  };
}

function openedPatent(item: LibraryPatentSummary, index: number): OpenedPatent {
  const patent = createBlankPatent({ patentType: item.patentType, name: item.name });
  patent.patentId = item.patentId;
  return {
    patentId: item.patentId,
    sessionId: testUuid(500 + index),
    revision: item.revision,
    patent,
    saveState: "saved",
  };
}

function api(items: LibraryPatentSummary[]): Pick<PatentApi["patents"], "list"> {
  return { list: vi.fn(async () => ({ ok: true as const, value: items })) };
}

test("uses the standard medium dialog shell", () => {
  render(
    <PatentLibraryPickerDialog
      sessions={[]}
      patentApi={api([])}
      onOpenPatent={vi.fn()}
      onSelectPatent={vi.fn()}
      onCancel={vi.fn()}
    />,
  );

  expect(
    screen.getByRole("dialog", { name: "打开其他专利" }).classList.contains("standard-dialog--m"),
  ).toBe(true);
});

test("loads the patent library and filters it by name", async () => {
  const user = userEvent.setup();
  const patentApi = api([summary("电池装置", 1), summary("输送机构", 2)]);
  render(
    <PatentLibraryPickerDialog
      sessions={[]}
      patentApi={patentApi}
      onOpenPatent={vi.fn()}
      onSelectPatent={vi.fn()}
      onCancel={vi.fn()}
    />,
  );

  await screen.findByRole("button", { name: "电池装置" });
  expect(patentApi.list).toHaveBeenCalledWith("active");
  await user.type(screen.getByRole("searchbox", { name: "搜索专利名称" }), "输送");
  expect(screen.queryByRole("button", { name: "电池装置" })).toBeNull();
  expect(screen.getByRole("button", { name: "输送机构" })).toBeDefined();
});

test("reuses an existing session instead of opening a duplicate", async () => {
  const user = userEvent.setup();
  const item = summary("现有专利", 3);
  const existing = createPatentSession(openedPatent(item, 3));
  const onOpenPatent = vi.fn();
  const onSelectPatent = vi.fn();
  render(
    <PatentLibraryPickerDialog
      sessions={[existing]}
      patentApi={api([item])}
      onOpenPatent={onOpenPatent}
      onSelectPatent={onSelectPatent}
      onCancel={vi.fn()}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "现有专利" }));
  await user.click(screen.getByRole("button", { name: "打开所选专利" }));
  expect(onOpenPatent).not.toHaveBeenCalled();
  expect(onSelectPatent).toHaveBeenCalledWith(item.patentId);
});

test("opens a new session before returning the selected patent", async () => {
  const user = userEvent.setup();
  const item = summary("待打开专利", 4);
  const opened = createPatentSession(openedPatent(item, 4));
  const onOpenPatent = vi.fn(async () => opened);
  const onSelectPatent = vi.fn();
  render(
    <PatentLibraryPickerDialog
      sessions={[]}
      patentApi={api([item])}
      onOpenPatent={onOpenPatent}
      onSelectPatent={onSelectPatent}
      onCancel={vi.fn()}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "待打开专利" }));
  await user.click(screen.getByRole("button", { name: "打开所选专利" }));
  await waitFor(() => expect(onOpenPatent).toHaveBeenCalledWith(item.patentId));
  expect(onSelectPatent).toHaveBeenCalledWith(item.patentId);
});

test("cancel and failed open leave the current pane unchanged", async () => {
  const user = userEvent.setup();
  const item = summary("无法打开", 5);
  const onSelectPatent = vi.fn();
  const onCancel = vi.fn();
  render(
    <PatentLibraryPickerDialog
      sessions={[]}
      patentApi={api([item])}
      onOpenPatent={vi.fn(async () => null)}
      onSelectPatent={onSelectPatent}
      onCancel={onCancel}
    />,
  );

  const dialog = screen.getByRole("dialog", { name: "打开其他专利" });
  await user.click(await within(dialog).findByRole("button", { name: "无法打开" }));
  await user.click(within(dialog).getByRole("button", { name: "打开所选专利" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("未能打开所选专利");
  expect(onSelectPatent).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onSelectPatent).not.toHaveBeenCalled();
});
