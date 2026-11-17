import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DraftSummary } from "../../../shared/ipc/contract";
import { LegacyMigrationDialog } from "./legacy-migration-dialog";

function draft(name: string, draftId = "legacy-draft"): DraftSummary {
  return {
    draftId,
    documentId: draftId,
    displayName: name,
    originalPath: null,
    savedAt: "2026-08-01T02:07:04.000Z",
  };
}

test("imports selected legacy drafts and states that source drafts are retained", async () => {
  const user = userEvent.setup();
  const onImport = vi.fn(async () => true);
  render(
    <LegacyMigrationDialog
      drafts={[draft("未命名-20260801-020704")]}
      onImport={onImport}
      onLater={vi.fn()}
    />,
  );

  const dialog = screen.getByRole("dialog", { name: "旧草稿迁移" });
  expect(dialog.classList.contains("standard-dialog--l")).toBe(true);
  expect(within(dialog).getByText("未命名-20260801-020704")).toBeDefined();

  await user.click(within(dialog).getByRole("button", { name: "导入选中的旧草稿" }));

  expect(onImport).toHaveBeenCalledWith("legacy-draft");
  expect(await within(dialog).findByText("导入完成，旧草稿仍保留。")).toBeDefined();
});

test("lets the user postpone migration without importing", async () => {
  const user = userEvent.setup();
  const onImport = vi.fn(async () => true);
  const onLater = vi.fn();
  render(
    <LegacyMigrationDialog drafts={[draft("稍后处理")]} onImport={onImport} onLater={onLater} />,
  );

  await user.click(screen.getByRole("button", { name: "稍后" }));

  expect(onLater).toHaveBeenCalledOnce();
  expect(onImport).not.toHaveBeenCalled();
});
