import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PatentApi } from "../../../shared/ipc/contract";
import {
  ApplicationCloseProvider,
  useApplicationCloseParticipant,
} from "../app/application-close-coordinator";
import * as appDialogs from "../shared/app-dialog";
import { DataTransferSettings } from "./data-transfer-settings";

const PASSWORD = "虚构关闭导出密码十二字符9!";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function SaveParticipant({ flush }: Readonly<{ flush: () => Promise<boolean> }>) {
  useApplicationCloseParticipant("test-save-participant", flush);
  return null;
}

function renderPage(
  options: {
    dataTransfer?: Partial<PatentApi["dataTransfer"]>;
    exportPackage?: PatentApi["dataTransfer"]["exportPackage"];
    saveParticipant?: () => Promise<boolean>;
  } = {},
) {
  const cancel = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const closeResult = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const prepareCloseListeners: Array<(token: string) => void> = [];
  window.patentApi = {
    dataTransfer: {
      inspectLibrary: vi.fn(async () => ({
        ok: true as const,
        value: {
          empty: true,
          blockers: [],
          summary: {
            activePatents: 0,
            trashedPatents: 0,
            documents: 0,
            legacyDrafts: 0,
            snapshots: 0,
            assets: 0,
            flowchartProjects: 0,

            totalBytes: 0,
          },
        },
      })),
      selectExportDestination: vi.fn(async () => ({
        ok: true as const,
        value: {
          selectionId: "destination-selection",
          displayPath: "移动磁盘",
          suggestedFileName: "虚构完整数据.zxwbackup",
        },
      })),
      exportPackage:
        options.exportPackage ??
        vi.fn(async (request) => ({
          ok: true as const,
          value: {
            operationId: request.operationId,
            displayPath: "移动磁盘\\虚构完整数据.zxwbackup",
            sizeBytes: 128,
            cutoffAt: "2026-08-17T00:00:00.000Z",
            packageFormatVersion: 2 as const,
            summary: {
              activePatents: 0,
              trashedPatents: 0,
              documents: 0,
              legacyDrafts: 0,
              snapshots: 0,
              assets: 0,
              flowchartProjects: 0,

              totalBytes: 0,
            },
            fullVerificationPassed: true as const,
          },
        })),
      selectImportPackage: vi.fn(async () => ({ ok: true as const, value: null })),
      prepareImport: vi.fn(),
      commitImport: vi.fn(),
      cancel,
      onProgress: vi.fn(() => vi.fn()),
      ...options.dataTransfer,
    },
    application: {
      onPrepareClose: vi.fn((listener) => {
        prepareCloseListeners.push(listener);
        return vi.fn();
      }),
      closeResult,
    },
  } as unknown as PatentApi;
  const onClose = vi.fn();
  render(
    <ApplicationCloseProvider>
      {options.saveParticipant ? <SaveParticipant flush={options.saveParticipant} /> : null}
      <DataTransferSettings open />
    </ApplicationCloseProvider>,
  );
  return { cancel, closeResult, onClose, prepareCloseListeners };
}

async function reachExportPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "导出完整数据包" }));
  const wizard = await screen.findByRole("dialog", { name: "完整数据迁移" });
  await user.click(await within(wizard).findByRole("button", { name: "下一步" }));
  await user.click(within(wizard).getByRole("button", { name: "浏览保存位置" }));
  await within(wizard).findByText("移动磁盘\\虚构完整数据.zxwbackup");
  await user.click(within(wizard).getByRole("button", { name: "下一步" }));
  await user.type(await within(wizard).findByLabelText("迁移密码"), PASSWORD);
  await user.type(within(wizard).getByLabelText("再次输入迁移密码"), PASSWORD);
  await user.click(within(wizard).getByRole("checkbox", { name: "我已记录并妥善保管迁移密码" }));
  return wizard;
}

describe("data transfer settings page", () => {
  test("offers the full migration entry points on the dedicated page", () => {
    renderPage();

    expect(screen.getByRole("region", { name: "数据迁移" })).toBeDefined();
    expect(screen.getByText(/用于更换电脑、重装系统或搬迁整个专利库/u)).toBeDefined();
    expect(screen.getByText(/导入只允许在空专利库中进行/u)).toBeDefined();
    expect(screen.getByRole("button", { name: "导出完整数据包" })).toBeDefined();
    expect(screen.getByRole("button", { name: "导入完整数据包" })).toBeDefined();
  });

  test("separates routine export from high-risk import before either wizard opens", () => {
    renderPage();

    const exportAction = screen.getByRole("article", { name: "导出完整数据包" });
    const importAction = screen.getByRole("article", { name: "导入完整数据包" });

    expect(exportAction.getAttribute("data-risk")).toBe("routine");
    expect(importAction.getAttribute("data-risk")).toBe("high");
    expect(within(exportAction).getByText(/不会改变当前专利库/u)).toBeDefined();
    expect(within(importAction).getByText(/只允许在空专利库中进行/u)).toBeDefined();
  });

  test("blocks application close during export until cancellation reaches an authoritative terminal", async () => {
    const user = userEvent.setup();
    const exported = deferred<Awaited<ReturnType<PatentApi["dataTransfer"]["exportPackage"]>>>();
    const exportPackage = vi.fn(() => exported.promise);
    const setup = renderPage({ exportPackage });
    const wizard = await reachExportPassword(user);
    await user.click(within(wizard).getByRole("button", { name: "开始导出" }));
    await waitFor(() => expect(exportPackage).toHaveBeenCalledOnce());

    vi.spyOn(appDialogs, "confirmAppAction").mockResolvedValueOnce(false);
    await waitFor(() => expect(setup.prepareCloseListeners).toHaveLength(1));
    setup.prepareCloseListeners[0]?.("continue-export-token");
    await waitFor(() =>
      expect(setup.closeResult).toHaveBeenCalledWith({
        token: "continue-export-token",
        proceed: false,
      }),
    );
    expect(setup.cancel).not.toHaveBeenCalled();

    vi.mocked(appDialogs.confirmAppAction).mockResolvedValueOnce(true);
    setup.prepareCloseListeners[0]?.("cancel-export-token");
    await waitFor(() => expect(setup.cancel).toHaveBeenCalledWith(expect.any(String)));
    expect(setup.closeResult).not.toHaveBeenCalledWith({
      token: "cancel-export-token",
      proceed: true,
    });

    exported.resolve({
      ok: false,
      error: { code: "CANCELLED", message: "操作已取消。", nextAction: "无需其他操作。" },
    });
    await waitFor(() =>
      expect(setup.closeResult).toHaveBeenCalledWith({
        token: "cancel-export-token",
        proceed: true,
      }),
    );
  });

  test("protects application close from the beginning of the pre-export save flush", async () => {
    const user = userEvent.setup();
    const save = deferred<boolean>();
    const saveParticipant = vi.fn(() => save.promise);
    const exportPackage = vi.fn();
    const setup = renderPage({ exportPackage, saveParticipant });
    const wizard = await reachExportPassword(user);
    await user.click(within(wizard).getByRole("button", { name: "开始导出" }));
    await waitFor(() => expect(saveParticipant).toHaveBeenCalledOnce());

    const confirm = vi
      .spyOn(appDialogs, "confirmAppAction")
      .mockClear()
      .mockResolvedValueOnce(false);
    setup.prepareCloseListeners[0]?.("continue-flushing-token");
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(setup.closeResult).toHaveBeenCalledWith({
        token: "continue-flushing-token",
        proceed: false,
      }),
    );
    expect(exportPackage).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    setup.prepareCloseListeners[0]?.("cancel-flushing-token");
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(setup.closeResult).not.toHaveBeenCalledWith({
      token: "cancel-flushing-token",
      proceed: true,
    });

    save.resolve(true);
    await waitFor(() =>
      expect(setup.closeResult).toHaveBeenCalledWith({
        token: "cancel-flushing-token",
        proceed: true,
      }),
    );
    expect(exportPackage).not.toHaveBeenCalled();
  });

  test("blocks application close throughout import commit and restart pending", async () => {
    const user = userEvent.setup();
    const committed = deferred<Awaited<ReturnType<PatentApi["dataTransfer"]["commitImport"]>>>();
    const setup = renderPage({
      dataTransfer: {
        selectImportPackage: vi.fn(async () => ({
          ok: true as const,
          value: {
            selectionId: "source-selection",
            fileName: "虚构完整数据.zxwbackup",
            sizeBytes: 128,
            packageFormatVersion: 2,
            minimumImporterVersion: "0.1.0",
            passwordHint: null,
          },
        })),
        prepareImport: vi.fn(async (request) => ({
          ok: true as const,
          value: {
            operationId: request.operationId,
            packageId: "00000000-0000-4000-8000-000000000942",
            exportedAt: "2026-08-17T00:00:00.000Z",
            summary: {
              activePatents: 1,
              trashedPatents: 0,
              documents: 0,
              legacyDrafts: 0,
              snapshots: 0,
              assets: 0,
              flowchartProjects: 0,

              totalBytes: 64,
            },
            packageVerified: true as const,
            versionCompatible: true as const,
            targetLibraryEmpty: true as const,
            settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"] as const,
          },
        })),
        commitImport: vi.fn(() => committed.promise),
      },
    });
    await user.click(await screen.findByRole("button", { name: "导入完整数据包" }));
    const wizard = await screen.findByRole("dialog", { name: "完整数据迁移" });
    await user.click(within(wizard).getByRole("button", { name: "导入完整数据包" }));
    await user.click(await within(wizard).findByRole("button", { name: "下一步" }));
    await user.click(within(wizard).getByRole("button", { name: "浏览数据包" }));
    await within(wizard).findByText("虚构完整数据.zxwbackup");
    await user.click(within(wizard).getByRole("button", { name: "下一步" }));
    await user.type(await within(wizard).findByLabelText("迁移密码"), PASSWORD);
    await user.click(within(wizard).getByRole("button", { name: "验证数据包" }));
    await user.click(
      await within(wizard).findByRole("checkbox", {
        name: "我确认当前专利库为空，并同意导入后重新启动",
      }),
    );
    await user.click(within(wizard).getByRole("button", { name: "导入并重新启动" }));

    setup.prepareCloseListeners[0]?.("settings-import-commit-token");
    await waitFor(() =>
      expect(setup.closeResult).toHaveBeenCalledWith({
        token: "settings-import-commit-token",
        proceed: false,
      }),
    );

    committed.resolve({ ok: true, value: { restartPending: true } });
    await within(wizard).findByText("正在安全切换并重新启动");
    setup.prepareCloseListeners[0]?.("settings-import-restart-token");
    await waitFor(() =>
      expect(setup.closeResult).toHaveBeenCalledWith({
        token: "settings-import-restart-token",
        proceed: false,
      }),
    );
  });

  test("keeps the settings page mounted when Escape cancels a running export", async () => {
    const user = userEvent.setup();
    const exported = deferred<Awaited<ReturnType<PatentApi["dataTransfer"]["exportPackage"]>>>();
    const setup = renderPage({ exportPackage: vi.fn(() => exported.promise) });
    const wizard = await reachExportPassword(user);
    await user.click(within(wizard).getByRole("button", { name: "开始导出" }));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(setup.cancel).toHaveBeenCalledOnce());
    expect(screen.getByRole("region", { name: "数据迁移" })).toBeDefined();

    exported.resolve({
      ok: false,
      error: { code: "CANCELLED", message: "操作已取消。", nextAction: "无需其他操作。" },
    });
    expect(await screen.findByRole("heading", { name: "已取消导出" })).toBeDefined();
  });
});
