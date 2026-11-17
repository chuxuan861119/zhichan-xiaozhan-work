import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackupRunResult } from "../../../shared/backup/model";
import type { PatentApi } from "../../../shared/ipc/contract";
import type { AppResult } from "../../../shared/ipc/result";
import { ApplicationCloseProvider } from "../app/application-close-coordinator";
import { BackupRuntimeCoordinator } from "./backup-runtime-coordinator";

function installBackupApi() {
  const closeListeners: Array<(token: string) => void> = [];
  const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const finalize = vi.fn<() => Promise<AppResult<BackupRunResult>>>(async () => ({
    ok: true as const,
    value: {
      trigger: "application-close" as const,
      attemptedCount: 0,
      successCount: 0,
      skippedCount: 0,
      failures: [],
      cancelled: false,
      completedAt: "2026-08-23T08:00:00.000Z",
    },
  }));
  window.patentApi = {
    application: {
      onPrepareClose: vi.fn((listener) => {
        closeListeners.push(listener);
        return vi.fn();
      }),
      closeResult,
    },
    backup: {
      status: vi.fn(async () => ({ ok: true as const, value: { enabled: true } })),
      finalize,
      cancelFinalization: vi.fn(async () => ({ ok: true as const, value: undefined })),
      ensureCurrent: vi.fn(async () => ({ ok: true as const, value: undefined })),
    },
  } as unknown as PatentApi;
  return { closeListeners, closeResult, finalize };
}

describe("backup runtime coordinator", () => {
  test("returns after a slow backup reaches its safe boundary and can close again", async () => {
    vi.useFakeTimers();
    const api = installBackupApi();
    let finish!: (result: AppResult<BackupRunResult>) => void;
    api.finalize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <ApplicationCloseProvider>
        <BackupRuntimeCoordinator targets={[]} />
      </ApplicationCloseProvider>,
    );
    await act(async () => api.closeListeners[0]?.("return-close"));
    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    fireEvent.click(screen.getByRole("button", { name: "返回软件" }));
    expect(window.patentApi.backup.cancelFinalization).toHaveBeenCalledOnce();
    expect(api.closeResult).not.toHaveBeenCalled();
    await act(async () =>
      finish({
        ok: true,
        value: {
          trigger: "application-close",
          attemptedCount: 1,
          successCount: 1,
          skippedCount: 0,
          failures: [],
          cancelled: true,
          completedAt: "2026-10-18T08:00:00.000Z",
        },
      }),
    );
    expect(api.closeResult).toHaveBeenCalledWith({ token: "return-close", proceed: false });
    await act(async () => api.closeListeners[0]?.("next-close"));
    expect(api.closeResult).toHaveBeenCalledWith({ token: "next-close", proceed: true });
  });

  test("labels slow verification separately from actual backup writing", async () => {
    vi.useFakeTimers();
    const api = installBackupApi();
    api.finalize.mockImplementationOnce(() => new Promise(() => {}));
    const operationStatus = vi.fn(async () => ({ ok: true, value: { currentDisplayName: null } }));
    window.patentApi.backup.operationStatus = operationStatus as never;
    render(
      <ApplicationCloseProvider>
        <BackupRuntimeCoordinator targets={[]} />
      </ApplicationCloseProvider>,
    );
    await act(async () => {
      api.closeListeners[0]?.("slow-close");
    });
    await act(async () => vi.advanceTimersByTimeAsync(1_600));
    expect(screen.getByRole("dialog", { name: "正在检查备份" })).toBeDefined();
    operationStatus.mockResolvedValue({
      ok: true,
      value: { currentDisplayName: "测试专利" },
    } as never);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByRole("dialog", { name: "正在补齐备份" })).toBeDefined();
  });
  test.each(["result", "rejection"])(
    "keeps fast %s failure decisions visible after progress delay",
    async (kind) => {
      vi.useFakeTimers();
      const api = installBackupApi();
      if (kind === "rejection") api.finalize.mockRejectedValueOnce(new Error("磁盘不可用"));
      else
        api.finalize.mockResolvedValueOnce({
          ok: false,
          error: { code: "IO_ERROR", message: "磁盘不可用" },
        } as never);
      render(
        <ApplicationCloseProvider>
          <BackupRuntimeCoordinator targets={[]} />
        </ApplicationCloseProvider>,
      );
      await act(async () => {
        api.closeListeners[0]?.("failed-close");
      });
      expect(screen.getByRole("dialog", { name: "退出备份未完成" })).toBeDefined();
      await act(async () => vi.advanceTimersByTimeAsync(6000));
      expect(screen.getByRole("dialog", { name: "退出备份未完成" })).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "返回" }));
      await act(async () => {});
      expect(api.closeResult).toHaveBeenCalledWith({ token: "failed-close", proceed: false });
      expect(
        document.querySelector('.motion-presence[data-motion-state="closing"][inert]'),
      ).not.toBeNull();
    },
  );
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("keeps a no-change application close immediate", async () => {
    const api = installBackupApi();
    render(
      <ApplicationCloseProvider>
        <BackupRuntimeCoordinator targets={[]} />
      </ApplicationCloseProvider>,
    );

    act(() => api.closeListeners[0]?.("close-token"));

    await waitFor(() =>
      expect(api.closeResult).toHaveBeenCalledWith({ token: "close-token", proceed: true }),
    );
    expect(api.finalize).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status", { name: "正在完成退出备份" })).toBeNull();
  });

  test("debounces idle backups and only targets the changed patent", async () => {
    vi.useFakeTimers();
    installBackupApi();
    const { rerender } = render(
      <ApplicationCloseProvider>
        <BackupRuntimeCoordinator
          targets={[{ patentId: "11111111-1111-4111-8111-111111111111", revision: 1 }]}
        />
      </ApplicationCloseProvider>,
    );
    rerender(
      <ApplicationCloseProvider>
        <BackupRuntimeCoordinator
          targets={[{ patentId: "11111111-1111-4111-8111-111111111111", revision: 2 }]}
        />
      </ApplicationCloseProvider>,
    );

    await act(async () => vi.advanceTimersByTimeAsync(20_000));

    expect(window.patentApi.backup.ensureCurrent).toHaveBeenCalledWith({
      documentType: "patent",
      documentId: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("offers retry, return, and safe exit when the final backup fails", async () => {
    const api = installBackupApi();
    api.finalize.mockResolvedValueOnce({
      ok: true,
      value: {
        trigger: "application-close",
        attemptedCount: 1,
        successCount: 0,
        skippedCount: 0,
        failures: [
          {
            target: { documentType: "patent", documentId: "11111111-1111-4111-8111-111111111111" },
            displayName: "测试专利",
            message: "磁盘不可用",
          },
        ],
        cancelled: false,
        completedAt: "2026-08-23T08:00:00.000Z",
      },
    });
    render(
      <ApplicationCloseProvider>
        <BackupRuntimeCoordinator targets={[]} />
      </ApplicationCloseProvider>,
    );

    act(() => api.closeListeners[0]?.("failed-close-token"));
    const dialog = await screen.findByRole("dialog", { name: "退出备份未完成" });
    expect(dialog.classList.contains("standard-dialog--s")).toBe(true);
    expect(screen.getByText("专利库内容已保存，但外部备份未完成。")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "退出但不等待备份" }));
    await waitFor(() =>
      expect(api.closeResult).toHaveBeenCalledWith({ token: "failed-close-token", proceed: true }),
    );
  });
});
