import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { PatentApi } from "../../../shared/ipc/contract";
import type { StartupRecoveryReport } from "../../../shared/recovery/startup-recovery";
import { RecoveryCenter } from "./recovery-center";

vi.mock("../settings/snapshot-manager", () => ({
  SnapshotManager: ({
    restore,
    onRestored,
    recoveryReadOnly,
  }: {
    restore: PatentApi["snapshot"]["restore"];
    onRestored(id: string): unknown;
    recoveryReadOnly: boolean;
  }) => (
    <div>
      <span>{recoveryReadOnly ? "快照保护" : "可写快照"}</span>
      <button
        type="button"
        onClick={() =>
          void restore({
            documentType: "patent",
            documentId: "00000000-0000-4000-8000-000000000001",
            revision: 2,
          }).then((result) => {
            if (result.ok) onRestored(result.value.documentId);
          })
        }
      >
        恢复所选快照
      </button>
    </div>
  ),
}));
vi.mock("../settings/backup-manager", () => ({
  BackupManager: ({
    restore,
    onRestored,
    recoveryReadOnly,
  }: {
    restore: PatentApi["backup"]["restore"];
    onRestored(): unknown;
    recoveryReadOnly: boolean;
  }) => (
    <div>
      <span>{recoveryReadOnly ? "备份保护" : "可写备份"}</span>
      <button
        type="button"
        onClick={() =>
          void restore("selected.patdoc").then((result) => {
            if (result.ok) onRestored();
          })
        }
      >
        恢复所选备份
      </button>
    </div>
  ),
}));

const report: StartupRecoveryReport = {
  previousShutdown: "unclean",
  mode: "read-only",
  replayedEditCount: 0,
  recoveredPatentCount: 0,
  quarantinedPatentCount: 1,
  backupCreated: false,
  checkedAt: "2026-10-04T00:00:00.000Z",
};
const prepared = {
  token: "00000000-0000-4000-8000-000000000002",
  libraryPath: "/test/recovered-library",
  documentId: "00000000-0000-4000-8000-000000000003",
  displayName: "恢复副本",
};
const prepareRecovery = vi.fn();
const activateRecovery = vi.fn();
const restoreSnapshot = vi.fn();
const restoreBackup = vi.fn();
beforeEach(() => {
  prepareRecovery.mockReset().mockResolvedValue({ ok: true, value: prepared });
  activateRecovery.mockReset().mockResolvedValue({ ok: true, value: undefined });
  restoreSnapshot.mockReset().mockResolvedValue({
    ok: true,
    value: {
      documentId: prepared.documentId,
      displayName: prepared.displayName,
      documentType: "patent",
    },
  });
  restoreBackup.mockReset().mockResolvedValue({
    ok: true,
    value: {
      documentId: prepared.documentId,
      displayName: prepared.displayName,
      documentType: "patent",
    },
  });
  window.patentApi = {
    application: { prepareRecovery, activateRecovery },
    snapshot: { restore: restoreSnapshot },
    backup: { restore: restoreBackup },
  } as unknown as PatentApi;
});

test.each(["snapshots", "backups"] as const)(
  "read-only %s recovery writes a separate library and waits for explicit activation",
  async (initialTab) => {
    const onRestored = vi.fn();
    const onClose = vi.fn();
    render(
      <RecoveryCenter
        report={report}
        initialTab={initialTab}
        onClose={onClose}
        onRestored={onRestored}
        onImportFile={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: initialTab === "snapshots" ? "恢复所选快照" : "恢复所选备份",
      }),
    );
    const ready = await screen.findByRole("status", { name: "恢复副本已准备好" });
    expect(ready.textContent).toContain("新库仅包含本次选中的恢复内容");
    expect(ready.textContent).toContain(prepared.libraryPath);
    expect(restoreSnapshot).not.toHaveBeenCalled();
    expect(restoreBackup).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
    expect(activateRecovery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保留副本，暂不切换" }));
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "使用恢复库并重启" }));
    await waitFor(() => expect(activateRecovery).toHaveBeenCalledWith(prepared.token));
  },
);

test("canceling the file picker leaves the recovery options available without activation", async () => {
  prepareRecovery.mockResolvedValue({ ok: true, value: null });
  render(
    <RecoveryCenter
      report={report}
      initialTab="backups"
      onClose={vi.fn()}
      onRestored={vi.fn()}
      onImportFile={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "选择其他 PATDOC 备份" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "选择其他 PATDOC 备份" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(screen.queryByRole("status", { name: "恢复副本已准备好" })).toBeNull();
  expect(activateRecovery).not.toHaveBeenCalled();
});

test("a failed file recovery explains the failure and permits another attempt", async () => {
  prepareRecovery.mockResolvedValue({
    ok: false,
    error: { code: "CORRUPT_FILE", message: "备份损坏", nextAction: "请选择其他备份" },
  });
  render(
    <RecoveryCenter
      report={report}
      initialTab="backups"
      onClose={vi.fn()}
      onRestored={vi.fn()}
      onImportFile={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "选择其他 PATDOC 备份" }));
  expect((await screen.findByRole("alert")).textContent).toContain("请选择其他备份");
  expect(activateRecovery).not.toHaveBeenCalled();
});

test.each(["snapshots", "backups"] as const)(
  "writable %s recovery retains the existing safe copy interface",
  async (initialTab) => {
    const onRestored = vi.fn(async () => undefined);
    render(
      <RecoveryCenter
        report={{ ...report, mode: "read-write" }}
        initialTab={initialTab}
        onClose={vi.fn()}
        onRestored={onRestored}
        onImportFile={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: initialTab === "snapshots" ? "恢复所选快照" : "恢复所选备份",
      }),
    );
    await waitFor(() => expect(onRestored).toHaveBeenCalledOnce());
    expect(prepareRecovery).not.toHaveBeenCalled();
    expect(activateRecovery).not.toHaveBeenCalled();
  },
);

test("unreadable source libraries give a PATDOC fallback instead of unusable snapshot controls", () => {
  render(
    <RecoveryCenter
      report={{ ...report, recoverySourcesUnavailable: true }}
      initialTab="snapshots"
      onClose={vi.fn()}
      onRestored={vi.fn()}
      onImportFile={vi.fn()}
    />,
  );
  expect(screen.getByText(/无法安全读取快照/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "恢复所选快照" })).toBeNull();
  expect(screen.getByRole("button", { name: "选择其他 PATDOC 备份" })).toBeDefined();
});
