import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BackupStatus } from "../../../shared/backup/model";
import type { PatentApi } from "../../../shared/ipc/contract";
import { normalizeAppError } from "../../../shared/ipc/result";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { DataSafetyDialog } from "./data-safety-dialog";

afterEach(() => vi.useRealTimers());

test("aligns backup actions without an individual vertical offset", async () => {
  renderDialog({ embedded: true });
  const save = await screen.findByRole("button", { name: "保存定时备份设置" });
  const revert = screen.getByRole("button", { name: "还原未保存修改" });
  expect(save.style.marginTop).not.toBe("8px");
  expect(save.classList.contains("settings-action-button")).toBe(true);
  expect(revert.classList.contains("settings-action-button")).toBe(true);
});

function renderDialog(
  options: {
    snapshotConfigureFails?: boolean;
    settingsReadFails?: boolean;
    backupStatusValues?: BackupStatus[];
    embedded?: boolean;
    section?: "backup" | "snapshot";
    backupFolder?: string;
  } = {},
) {
  const settingsWarning = "设置文件损坏且没有有效备份，请重新确认数据安全设置。";
  const snapshotConfigure = vi.fn(async () =>
    options.snapshotConfigureFails
      ? { ok: false as const, error: normalizeAppError({ code: "INTERNAL", message: "失败" }) }
      : { ok: true as const, value: undefined },
  );
  const defaultBackupStatus: BackupStatus = {
    enabled: false,
    folder: null,
    intervalMinutes: 5,
    lastAttemptAt: null,
    lastBackupAt: null,
    nextBackupAt: null,
    lastRunSuccessCount: 0,
    lastRunFailureCount: 0,
    lastError: settingsWarning,
  };
  let backupStatusIndex = 0;
  const backupStatus = vi.fn(async () => ({
    ok: true as const,
    value:
      options.backupStatusValues?.[
        Math.min(backupStatusIndex++, options.backupStatusValues.length - 1)
      ] ?? defaultBackupStatus,
  }));
  window.patentApi = {
    settings: {
      read: async () =>
        options.settingsReadFails
          ? {
              ok: false as const,
              error: normalizeAppError({ code: "CORRUPT_FILE", message: "损坏" }),
            }
          : {
              ok: true as const,
              value: {
                ...structuredClone(DEFAULT_APP_SETTINGS),
                backup: { ...DEFAULT_APP_SETTINGS.backup, folder: options.backupFolder ?? null },
              },
            },
    },
    backup: {
      status: backupStatus,
      configure: async () => ({ ok: true, value: undefined }),
      selectFolder: async () => ({ ok: true, value: null }),
    },
    snapshot: {
      status: async () => ({
        ok: true,
        value: {
          enabled: true,
          intervalMinutes: 5,
          openPatentCount: 0,
          lastCheckAt: null,
          lastAutomaticSnapshotAt: null,
          nextCheckAt: null,
          lastError: null,
        },
      }),
      configure: snapshotConfigure,
      create: vi.fn(),
      list: vi.fn(),
      restore: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as PatentApi;
  const onClose = vi.fn();
  render(
    <DataSafetyDialog
      open
      section={options.section ?? "backup"}
      onClose={onClose}
      {...(options.embedded === undefined ? {} : { embedded: options.embedded })}
    />,
  );
  return {
    onClose,
    settingsWarning,
    snapshotConfigure,
    backupStatus,
  };
}

describe("data safety dialog", () => {
  test("persists the opt-in exit backup policy with the other backup settings", async () => {
    renderDialog();
    const configure = vi.spyOn(window.patentApi.backup, "configure");
    const user = userEvent.setup();
    const policy = await screen.findByRole("checkbox", { name: /退出前确保外部备份完成/ });
    expect(policy).toHaveProperty("checked", false);
    await user.click(policy);
    await user.click(screen.getByRole("button", { name: "保存定时备份设置" }));
    await waitFor(() =>
      expect(configure).toHaveBeenCalledWith(expect.objectContaining({ waitOnExit: true })),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "还原未保存修改" })).toHaveProperty(
        "disabled",
        true,
      ),
    );
    await user.click(policy);
    expect(screen.getByRole("button", { name: "还原未保存修改" })).toHaveProperty(
      "disabled",
      false,
    );
  });
  test("migration notification refreshes the folder without discarding an edited interval", async () => {
    renderDialog({ backupFolder: "C:/old" });
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("备份间隔"), "10");
    window.dispatchEvent(
      new CustomEvent("backup-settings-changed", {
        detail: {
          enabled: false,
          folder: "D:/new",
          intervalMinutes: 5,
        },
      }),
    );
    await waitFor(() => expect(screen.getByDisplayValue("D:/new")).toBeDefined());
    expect((screen.getByLabelText("备份间隔") as HTMLSelectElement).value).toBe("10");
  });
  test("saving an interval after an external folder migration retains the new folder", async () => {
    renderDialog({ backupFolder: "C:/old" });
    await screen.findByLabelText("备份间隔");
    window.patentApi.settings.read = async () => ({
      ok: true,
      value: {
        ...structuredClone(DEFAULT_APP_SETTINGS),
        backup: { enabled: true, folder: "D:/new", intervalMinutes: 5 },
      },
    });
    const configure = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.patentApi.backup.configure = configure;
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("备份间隔"), "10");
    await user.click(screen.getByRole("button", { name: "保存定时备份设置" }));
    await waitFor(() =>
      expect(configure).toHaveBeenCalledWith({
        enabled: true,
        folder: "D:/new",
        intervalMinutes: 10,
        expectedSourceFolder: "D:/new",
      }),
    );
  });
  test.each(["取消", "仅切换位置", "迁移备份并切换"])(
    "folder switch choice: %s",
    async (choice) => {
      renderDialog({ backupFolder: "C:/old" });
      const configure = vi.fn(async () => ({ ok: true as const, value: undefined }));
      window.patentApi.backup.configure = configure;
      window.patentApi.backup.selectFolder = async () => ({ ok: true, value: "C:/new" });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "选择…" }));
      await user.click(screen.getByRole("button", { name: "保存定时备份设置" }));
      expect(configure).not.toHaveBeenCalled();
      await user.click(await screen.findByRole("button", { name: choice }));
      if (choice === "取消") expect(configure).not.toHaveBeenCalled();
      else
        await waitFor(() =>
          expect(configure).toHaveBeenCalledWith(
            expect.objectContaining({
              folder: "C:/new",
              expectedSourceFolder: "C:/old",
              migrateExisting: choice === "迁移备份并切换",
            }),
          ),
        );
    },
  );
  test("uses the periodic-backup name and defaults to a five-minute interval", async () => {
    renderDialog();

    expect(await screen.findByRole("heading", { name: "定时备份" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "启用定时备份" })).toBeDefined();
    expect((screen.getByLabelText("备份间隔") as HTMLSelectElement).value).toBe("5");
    expect(screen.getByRole("button", { name: "保存定时备份设置" })).toBeDefined();
    expect(screen.getByText(/定时备份文件为未加密的 PATDOC/)).toBeDefined();
  });

  test("keeps a settings recovery warning visible", async () => {
    const { settingsWarning } = renderDialog();

    expect(await screen.findByText(`失败原因: ${settingsWarning}`)).toBeDefined();
  });

  test("does not render a snapshot retention limit control", async () => {
    renderDialog({ section: "snapshot" });

    expect(await screen.findByRole("dialog", { name: "数据安全设置" })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "自动快照保留上限" })).toBeNull();
  });

  test("does not render a separate snapshot settings save button", async () => {
    renderDialog({ section: "snapshot" });

    await screen.findByRole("checkbox", { name: "启用自动快照" });
    expect(screen.queryByRole("button", { name: "保存快照设置" })).toBeNull();
  });

  test("refreshes scheduled-backup status while the dialog remains open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const initial: BackupStatus = {
      enabled: true,
      folder: "D:\\备份",
      intervalMinutes: 5,
      lastAttemptAt: null,
      lastBackupAt: null,
      nextBackupAt: "2026-08-16T08:05:00.000Z",
      lastRunSuccessCount: 0,
      lastRunFailureCount: 0,
      lastError: null,
    };
    const refreshed: BackupStatus = {
      ...initial,
      lastAttemptAt: "2026-08-16T08:00:00.000Z",
      lastBackupAt: "2026-08-16T08:00:00.000Z",
      nextBackupAt: "2026-08-16T08:10:00.000Z",
      lastRunSuccessCount: 1,
      lastRunFailureCount: 1,
      lastError: "一份文件写入失败",
    };
    const { backupStatus } = renderDialog({ backupStatusValues: [initial, refreshed] });

    expect(await screen.findByText("尚无成功备份")).toBeDefined();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await screen.findByText(/上次成功：/)).toBeDefined();
    expect(screen.getByText("本轮写入成功：1；待处理失败：1")).toBeDefined();
    expect(screen.getByText(/下次备份：/)).toBeDefined();
    expect(backupStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("reports an automatic snapshot settings failure and restores the prior value", async () => {
    const user = userEvent.setup();
    const { snapshotConfigure } = renderDialog({
      snapshotConfigureFails: true,
      section: "snapshot",
    });
    const toggle = await screen.findByRole("checkbox", { name: "启用自动快照" });

    await user.click(toggle);

    await waitFor(() => expect(snapshotConfigure).toHaveBeenCalledOnce());
    expect(await screen.findByText("快照设置保存失败，请稍后重试。")).toBeDefined();
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });

  test("does not expose saveable defaults when settings cannot be read", async () => {
    renderDialog({ settingsReadFails: true });

    expect((await screen.findByRole("alert")).textContent).toContain("文件内容损坏或不完整");
    expect(screen.getByRole("button", { name: "重新读取" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "保存快照设置" })).toBeNull();
  });

  test("exposes dialog semantics and closes with Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    expect(await screen.findByRole("dialog", { name: "数据安全设置" })).toBeDefined();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("renders embedded data safety settings inside a workspace region without closing it", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog({ embedded: true });

    expect(await screen.findByRole("region", { name: "数据安全设置" })).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "数据安全设置" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "数据安全设置" })).toBeNull();
    expect(screen.getByText(/未加密的 PATDOC/u)).toBeDefined();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  test("shows only backup settings on the backup page", async () => {
    renderDialog({ embedded: true });

    const region = await screen.findByRole("region", { name: "数据安全设置" });
    const grid = region.querySelector(".data-safety-dialog__grid");
    const cards = region.querySelectorAll(".data-safety-dialog__section");

    expect(grid).toBeTruthy();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute("aria-label")).toBe("定时备份设置");
    expect(region.querySelectorAll(".data-safety-dialog__switch")).toHaveLength(1);
    expect(region.querySelector(".data-safety-dialog__backup-actions")).toBeTruthy();
    expect(region.querySelector(".data-safety-dialog__retention")).toBeNull();
  });
  test("shows only snapshot controls and never queries backup status on the snapshot page", async () => {
    const { backupStatus } = renderDialog({ embedded: true, section: "snapshot" });
    expect(await screen.findByRole("checkbox", { name: "启用自动快照" })).toBeDefined();
    expect(screen.queryByRole("checkbox", { name: "启用定时备份" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存定时备份设置" })).toBeNull();
    expect(backupStatus).not.toHaveBeenCalled();
  });

  test("disables automatic controls when automatic snapshots are off", async () => {
    const user = userEvent.setup();
    const { snapshotConfigure } = renderDialog({ section: "snapshot" });
    const toggle = await screen.findByRole("checkbox", { name: "启用自动快照" });

    await user.click(toggle);

    await waitFor(() =>
      expect(snapshotConfigure).toHaveBeenCalledWith({ enabled: false, intervalMinutes: 5 }),
    );
    expect((screen.getByLabelText("自动快照检查间隔") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByLabelText("自动快照保留上限")).toBeNull();
  });

  test("saves the selected snapshot interval immediately", async () => {
    const user = userEvent.setup();
    const { snapshotConfigure } = renderDialog({ section: "snapshot" });
    const interval = (await screen.findByLabelText("自动快照检查间隔")) as HTMLSelectElement;

    await user.selectOptions(interval, "10");

    await waitFor(() =>
      expect(snapshotConfigure).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 10 }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("快照设置已保存");
  });

  test("keeps protection settings free of full migration entry points", async () => {
    renderDialog();

    expect(await screen.findByRole("heading", { name: "定时备份" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "快照版本" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "完整数据迁移" })).toBeNull();
    expect(screen.queryByRole("button", { name: "导出完整数据包" })).toBeNull();
    expect(screen.queryByRole("button", { name: "导入完整数据包" })).toBeNull();
  });
});
