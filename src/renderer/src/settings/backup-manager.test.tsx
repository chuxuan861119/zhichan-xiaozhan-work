import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BackupEntry } from "../../../shared/backup/model";
import type { PatentApi } from "../../../shared/ipc/contract";
import { normalizeAppError } from "../../../shared/ipc/result";
import { BackupManager } from "./backup-manager";

const externalEntry: BackupEntry = {
  fileName: "用户手动归档.patdoc",
  displayName: "用户手动归档",
  documentType: "patent",
  documentId: "00000000-0000-4000-8000-000000000001",
  revision: 12,
  sizeBytes: 1024,
  backedUpAt: "2026-08-09T00:00:00.000Z",
  managed: false,
  status: "healthy",
  errorMessage: null,
};

const damagedManagedEntry: BackupEntry = {
  fileName:
    "PWB-AUTO-PAT-00000000-0000-4000-8000-000000000001-r13-10000000-0000-4000-8000-000000000003.patdoc",
  displayName: "损坏的自动备份",
  documentType: null,
  documentId: null,
  revision: null,
  sizeBytes: 2048,
  backedUpAt: "2026-08-09T00:01:00.000Z",
  managed: true,
  status: "damaged",
  errorMessage: "校验和不匹配",
};

const healthyManagedEntry: BackupEntry = {
  ...damagedManagedEntry,
  displayName: "健康的自动备份",
  documentType: "patent",
  documentId: "00000000-0000-4000-8000-000000000001",
  revision: 13,
  status: "healthy",
  errorMessage: null,
};

describe("backup manager", () => {
  test("opens protection settings from an empty embedded backup list", async () => {
    window.patentApi = {
      backup: { list: async () => ({ ok: true, value: [] }) },
    } as unknown as PatentApi;
    const onOpenSettings = vi.fn();
    render(
      <BackupManager
        embedded
        open
        onClose={vi.fn()}
        onRestored={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "设置定时备份" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
  test("directs the empty state to periodic-backup settings", async () => {
    window.patentApi = {
      backup: {
        list: async () => ({ ok: true, value: [] }),
      },
    } as unknown as PatentApi;

    render(<BackupManager open onClose={vi.fn()} onRestored={vi.fn()} />);

    expect(
      await screen.findByText("暂无备份文件。请先在「定时备份」中启用定时备份。"),
    ).toBeDefined();
  });

  test("keeps refresh with the centered embedded empty state", async () => {
    window.patentApi = {
      backup: {
        list: async () => ({ ok: true, value: [] }),
      },
    } as unknown as PatentApi;

    const { container } = render(
      <BackupManager embedded open onClose={vi.fn()} onRestored={vi.fn()} />,
    );

    await screen.findByText("暂无备份文件");
    const emptyState = container.querySelector(".backup-manager__empty");
    expect(emptyState).toBeTruthy();
    expect(within(emptyState as HTMLElement).getByRole("button", { name: "刷新" })).toBeDefined();
  });

  test("protects external archives from deletion and shows damaged details", async () => {
    window.patentApi = {
      backup: {
        list: async () => ({ ok: true, value: [externalEntry, damagedManagedEntry] }),
      },
    } as unknown as PatentApi;

    render(<BackupManager open onClose={vi.fn()} onRestored={vi.fn()} />);

    expect(await screen.findByText("外部 PATDOC")).toBeDefined();
    expect(screen.getByText("版本 12")).toBeDefined();
    expect(screen.getByText("校验和不匹配")).toBeDefined();
    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    expect((deleteButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((deleteButtons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  test("exposes modal semantics and closes with Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    window.patentApi = {
      backup: { list: async () => ({ ok: true, value: [] }) },
    } as unknown as PatentApi;
    render(<BackupManager open onClose={onClose} onRestored={vi.fn()} />);

    expect(await screen.findByRole("dialog", { name: "备份管理器" })).toBeDefined();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("renders embedded backup management in the workspace and keeps delete confirmation in its DOM", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const remove = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.patentApi = {
      backup: {
        list: async () => ({ ok: true as const, value: [healthyManagedEntry] }),
        delete: remove,
      },
    } as unknown as PatentApi;
    render(<BackupManager embedded open onClose={onClose} onRestored={vi.fn()} />);

    const region = await screen.findByRole("region", { name: "备份管理器" });
    expect(screen.queryByRole("dialog", { name: "备份管理器" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "备份管理器" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(
      within(region)
        .getByRole("alertdialog", { name: "永久删除备份" })
        .classList.contains("standard-dialog--s"),
    ).toBe(true);
    await user.click(within(region).getByRole("button", { name: "取消" }));
    expect(remove).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("shows the specific list error and recommended next action", async () => {
    window.patentApi = {
      backup: {
        list: async () => ({
          ok: false,
          error: normalizeAppError({
            code: "NO_PERMISSION",
            message: "无法读取备份文件夹。",
            nextAction: "请检查文件夹权限。",
          }),
        }),
      },
    } as unknown as PatentApi;
    render(<BackupManager open onClose={vi.fn()} onRestored={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "没有权限访问所选位置。 请选择有访问权限的位置后重试。",
    );
    expect(screen.queryByText(/暂无备份文件/)).toBeNull();
  });

  test("refreshes the backup list without closing the dialog", async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: [] })
      .mockResolvedValueOnce({ ok: true, value: [externalEntry] });
    window.patentApi = { backup: { list } } as unknown as PatentApi;
    render(<BackupManager open onClose={vi.fn()} onRestored={vi.fn()} />);
    await screen.findByText(/暂无备份文件/);

    await user.click(screen.getByRole("button", { name: "刷新" }));

    expect(await screen.findByText("用户手动归档")).toBeDefined();
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("disables every conflicting action while a restore is in progress", async () => {
    const user = userEvent.setup();
    let finishRestore: (() => void) | undefined;
    const restore = vi.fn(
      () =>
        new Promise<{ ok: true; value: { displayName: string } }>((resolve) => {
          finishRestore = () => resolve({ ok: true, value: { displayName: "恢复副本" } });
        }),
    );
    window.patentApi = {
      backup: {
        list: async () => ({
          ok: true,
          value: [
            healthyManagedEntry,
            {
              ...healthyManagedEntry,
              fileName: healthyManagedEntry.fileName.replace("r13", "r14"),
            },
          ],
        }),
        restore,
        delete: vi.fn(),
      },
    } as unknown as PatentApi;
    render(<BackupManager open onClose={vi.fn()} onRestored={vi.fn()} />);
    const restoreButtons = await screen.findAllByRole("button", { name: "恢复" });
    const firstRestoreButton = restoreButtons[0];
    if (!firstRestoreButton) throw new Error("恢复按钮不存在");

    await user.click(firstRestoreButton);

    await waitFor(() => {
      expect(
        screen
          .getAllByRole("button", { name: /恢复|删除|刷新|关闭/ })
          .every((button) => (button as HTMLButtonElement).disabled),
      ).toBe(true);
    });
    finishRestore?.();
  });

  test("reports a completed restore separately when the patent-library refresh fails", async () => {
    const user = userEvent.setup();
    window.patentApi = {
      backup: {
        list: async () => ({ ok: true, value: [healthyManagedEntry] }),
        restore: async () => ({
          ok: true,
          value: {
            documentType: "patent" as const,
            documentId: "00000000-0000-4000-8000-000000000009",
            displayName: "已恢复专利",
          },
        }),
      },
    } as unknown as PatentApi;
    render(
      <BackupManager
        open
        onClose={vi.fn()}
        onRestored={vi.fn(async () => Promise.reject(new Error("刷新失败")))}
      />,
    );
    const [restoreButton] = await screen.findAllByRole("button", { name: "恢复" });
    if (!restoreButton) throw new Error("恢复按钮不存在");
    await user.click(restoreButton);

    expect((await screen.findByRole("status")).textContent).toBe(
      "已恢复“已恢复专利”，但专利库刷新失败，请手动刷新或重新打开专利库。",
    );
    expect(screen.queryByText(/恢复失败/)).toBeNull();
  });
});
