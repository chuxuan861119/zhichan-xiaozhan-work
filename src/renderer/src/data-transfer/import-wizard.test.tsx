import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DataTransferLibraryInspection,
  FullDataImportPreview,
} from "../../../shared/data-transfer/model";
import type { AppResult } from "../../../shared/ipc/result";
import { ImportWizard, type ImportWizardApi } from "./import-wizard";

const OPERATION_ID = "00000000-0000-4000-8000-000000000928";
const NEXT_OPERATION_ID = "00000000-0000-4000-8000-000000000930";
const PASSWORD = "虚构导入密码十二字符9!";
const CLOSE_GUARD_REGISTRAR = { registerCloseGuard: () => () => undefined };
const EMPTY_INSPECTION: DataTransferLibraryInspection = {
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
};
const NON_EMPTY_INSPECTION: DataTransferLibraryInspection = {
  empty: false,
  blockers: [
    { kind: "patents", count: 2 },
    { kind: "assets", count: 3 },
  ],
  summary: { ...EMPTY_INSPECTION.summary, activePatents: 2, assets: 3 },
};
const PREVIEW: FullDataImportPreview = {
  operationId: OPERATION_ID,
  packageId: "00000000-0000-4000-8000-000000000929",
  exportedAt: "2026-08-17T00:00:00.000Z",
  summary: {
    activePatents: 2,
    trashedPatents: 1,
    documents: 3,
    legacyDrafts: 1,
    snapshots: 4,
    assets: 5,
    flowchartProjects: 1,

    totalBytes: 1_572_864,
  },
  packageVerified: true,
  versionCompatible: true,
  targetLibraryEmpty: true,
  settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function apiWith(patch: Partial<ImportWizardApi> = {}): ImportWizardApi {
  return {
    inspectLibrary: vi.fn(async () => ({ ok: true as const, value: EMPTY_INSPECTION })),
    selectImportPackage: vi.fn(async () => ({
      ok: true as const,
      value: {
        selectionId: "source-selection",
        fileName: "虚构完整数据.zxwbackup",
        sizeBytes: 1_572_864,
        packageFormatVersion: 2,
        minimumImporterVersion: "0.1.0",
        passwordHint: "虚构公开提示",
      },
    })),
    prepareImport: vi.fn(async () => ({ ok: true as const, value: PREVIEW })),
    commitImport: vi.fn(async () => ({
      ok: true as const,
      value: { restartPending: true as const },
    })),
    cancel: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onProgress: vi.fn(() => vi.fn()),
    ...patch,
  };
}

async function openSourceStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "导入完整数据包" }));
  await screen.findByRole("heading", { name: "当前专利库为空" });
  await user.click(screen.getByRole("button", { name: "下一步" }));
  await screen.findByRole("heading", { name: "选择完整数据包" });
}

async function reachPassword(user: ReturnType<typeof userEvent.setup>) {
  await openSourceStep(user);
  await user.click(screen.getByRole("button", { name: "浏览数据包" }));
  await screen.findByText("虚构完整数据.zxwbackup");
  await user.click(screen.getByRole("button", { name: "下一步" }));
  await screen.findByRole("heading", { name: "输入迁移密码" });
}

async function reachPreview(user: ReturnType<typeof userEvent.setup>) {
  await reachPassword(user);
  await user.type(screen.getByLabelText("迁移密码"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "验证数据包" }));
  await screen.findByRole("heading", { name: "确认导入内容" });
}

test("closing the preview waits for successful discard and does not lose a failed cleanup", async () => {
  const user = userEvent.setup();
  const api = apiWith();
  const onClose = vi.fn();
  const cleanup = deferred<AppResult<void>>();
  vi.mocked(api.cancel).mockImplementationOnce(() => cleanup.promise);
  render(
    <ImportWizard
      open
      api={api}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      onClose={onClose}
    />,
  );
  await reachPreview(user);
  await user.click(screen.getByRole("button", { name: "关闭完整数据迁移" }));
  expect(api.cancel).toHaveBeenCalledWith(OPERATION_ID);
  expect(onClose).not.toHaveBeenCalled();
  cleanup.resolve({
    ok: false,
    error: { code: "IMPORT_RECOVERY_REQUIRED", message: "清理暂时失败" },
  });
  await screen.findByText("清理暂时失败");
  expect(onClose).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "关闭完整数据迁移" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

test("opens the selected package when randomUUID is unavailable", async () => {
  const user = userEvent.setup();
  const originalRandomUuid = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  try {
    render(
      <ImportWizard
        open
        api={apiWith()}
        closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
        onClose={vi.fn()}
      />,
    );

    await openSourceStep(user);
    await user.click(screen.getByRole("button", { name: "浏览数据包" }));
    await screen.findByText("虚构完整数据.zxwbackup");
    await user.click(screen.getByRole("button", { name: "下一步" }));

    expect(await screen.findByRole("heading", { name: "输入迁移密码" })).toBeTruthy();
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: originalRandomUuid,
    });
  }
});

test("does not select or inspect a package when the library is non-empty", async () => {
  const user = userEvent.setup();
  const api = apiWith({
    inspectLibrary: vi.fn(async () => ({ ok: true as const, value: NON_EMPTY_INSPECTION })),
  });
  render(
    <ImportWizard
      open
      api={api}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
      onExportCurrent={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "导入完整数据包" }));
  expect(await screen.findByText("当前专利库不是空库")).toBeTruthy();
  expect(api.selectImportPackage).not.toHaveBeenCalled();
  expect(screen.getByText("2 项专利")).toBeTruthy();
  expect(screen.getByText("3 个附件与图片")).toBeTruthy();
  expect(screen.getByRole("button", { name: "导出当前完整数据包" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "返回专利库" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /覆盖|继续|清空/u })).toBeNull();
});

test("rejects multiple files and a wrong extension before opening a source handle", async () => {
  const user = userEvent.setup();
  const api = apiWith();
  render(
    <ImportWizard
      open
      api={api}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await openSourceStep(user);
  const dropTarget = screen.getByRole("button", { name: "拖放完整数据包" });

  fireEvent.drop(dropTarget, {
    dataTransfer: {
      files: [new File(["a"], "a.zxwbackup"), new File(["b"], "b.zxwbackup")],
    },
  });
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("一次只能选择一个数据包"),
  );
  fireEvent.drop(dropTarget, {
    dataTransfer: { files: [new File(["x"], "不是数据包.txt")] },
  });
  expect(screen.getByRole("alert").textContent).toContain("请选择 .zxwbackup 文件");
  expect(api.selectImportPackage).not.toHaveBeenCalled();
});

test("shows the public hint and clears the unlock password when returning to source selection", async () => {
  const user = userEvent.setup();
  const api = apiWith();
  render(
    <ImportWizard
      open
      api={api}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPassword(user);
  expect(screen.getByText("虚构公开提示")).toBeTruthy();
  expect(screen.getByText(/提示本身不保密/u)).toBeTruthy();
  await user.type(screen.getByLabelText("迁移密码"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "上一步" }));
  expect(screen.getByText("虚构完整数据.zxwbackup")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新选择" })).toBeTruthy();
  expect(screen.queryByLabelText("迁移密码")).toBeNull();
  await user.click(screen.getByRole("button", { name: "下一步" }));
  expect(screen.getByLabelText<HTMLInputElement>("迁移密码").value).toBe("");
});

test("requires the final empty-library and restart acknowledgement", async () => {
  const user = userEvent.setup();
  render(
    <ImportWizard
      open
      api={apiWith()}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPreview(user);

  const commit = screen.getByRole<HTMLButtonElement>("button", { name: "导入并重新启动" });
  expect(commit.disabled).toBe(true);
  expect(screen.getByText("密码正确")).toBeTruthy();
  expect(screen.getByText("文件完整")).toBeTruthy();
  expect(screen.getByText("版本兼容")).toBeTruthy();
  expect(screen.getByText("当前专利库为空")).toBeTruthy();
  expect(screen.getByText("2 项在用专利")).toBeTruthy();
  expect(screen.getByText(/备份位置/u)).toBeTruthy();
  expect(screen.getByText(/AI 凭据/u)).toBeTruthy();
  expect(screen.getByText(/打印机/u)).toBeTruthy();
  await user.click(
    screen.getByRole("checkbox", { name: "我确认当前专利库为空，并同意导入后重新启动" }),
  );
  expect(commit.disabled).toBe(false);
});

test("throttles the fourth password-or-package failure without retaining the password", async () => {
  const user = userEvent.setup();
  const delay = vi.fn(async () => undefined);
  const invalidResult: AppResult<FullDataImportPreview> = {
    ok: false,
    error: {
      code: "PASSWORD_OR_PACKAGE_INVALID",
      message: "密码错误或数据包已损坏。",
      nextAction: "请检查密码和文件后重试。",
    },
  };
  const api = apiWith({ prepareImport: vi.fn(async () => invalidResult) });
  render(
    <ImportWizard
      open
      api={api}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      delay={delay}
      onClose={vi.fn()}
    />,
  );
  await reachPassword(user);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await user.type(screen.getByLabelText("迁移密码"), `${PASSWORD}${attempt}`);
    await user.click(screen.getByRole("button", { name: "验证数据包" }));
    await screen.findByText("密码错误或数据包已损坏，请检查密码和文件后重试。");
    expect(screen.queryByDisplayValue(`${PASSWORD}${attempt}`)).toBeNull();
  }
  expect(delay).toHaveBeenCalledTimes(1);
  expect(delay).toHaveBeenCalledWith(2_000);
});

test("waits for the prepare task to report cancellation after the cancel request is acknowledged", async () => {
  const user = userEvent.setup();
  const prepared = deferred<AppResult<FullDataImportPreview>>();
  const api = apiWith({ prepareImport: vi.fn(() => prepared.promise) });
  render(
    <ImportWizard
      open
      api={api}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPassword(user);
  await user.type(screen.getByLabelText("迁移密码"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "验证数据包" }));
  await user.click(await screen.findByRole("button", { name: "取消迁移" }));

  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith(OPERATION_ID));
  expect(screen.queryByRole("heading", { name: "已取消验证" })).toBeNull();
  prepared.resolve({
    ok: false,
    error: { code: "CANCELLED", message: "操作已取消。", nextAction: "无需其他操作。" },
  });
  await screen.findByRole("heading", { name: "已取消验证" });
  expect(screen.getByText(/当前空专利库未改变/u)).toBeTruthy();
});

test("never exposes a committable preview when cancellation races with a successful prepare", async () => {
  const user = userEvent.setup();
  const prepared = deferred<AppResult<FullDataImportPreview>>();
  const cancelled = deferred<AppResult<void>>();
  const api = apiWith({
    prepareImport: vi.fn(() => prepared.promise),
    cancel: vi.fn(() => cancelled.promise),
  });
  render(
    <ImportWizard
      open
      api={api}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPassword(user);
  await user.type(screen.getByLabelText("迁移密码"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "验证数据包" }));
  await user.click(await screen.findByRole("button", { name: "取消迁移" }));

  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith(OPERATION_ID));
  prepared.resolve({ ok: true, value: PREVIEW });
  cancelled.resolve({ ok: true, value: undefined });

  await screen.findByRole("heading", { name: "已取消验证" });
  expect(screen.queryByRole("heading", { name: "确认导入内容" })).toBeNull();
  expect(screen.queryByRole("button", { name: "导入并重新启动" })).toBeNull();
});

test("renders package failures without offering an unsafe continuation", async () => {
  const user = userEvent.setup();
  const api = apiWith({
    selectImportPackage: vi.fn(async () => ({
      ok: false as const,
      error: {
        code: "PACKAGE_TOO_NEW" as const,
        message: "此数据包需要更新版本的软件。",
        nextAction: "请安装不低于 2.0.0 的版本。",
      },
    })),
  });
  render(
    <ImportWizard
      open
      api={api}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await openSourceStep(user);
  await user.click(screen.getByRole("button", { name: "浏览数据包" }));

  expect(await screen.findByRole("heading", { name: "无法读取完整数据包" })).toBeTruthy();
  expect(screen.getByText("此数据包需要更新版本的软件。")).toBeTruthy();
  expect(screen.getByText("请安装不低于 2.0.0 的版本。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /仍然继续|强制导入/u })).toBeNull();
});

test("unlocks application closing after a failed import commit", async () => {
  const user = userEvent.setup();
  let guard: (() => Promise<boolean>) | undefined;
  render(
    <ImportWizard
      open
      api={apiWith({
        commitImport: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "LIBRARY_NOT_EMPTY" as const,
            message: "当前专利库不是空库。",
            nextAction: "请检查专利库。",
          },
        })),
      })}
      closeGuardRegistrar={{
        registerCloseGuard: (_id, callback) => {
          guard = callback;
          return () => {};
        },
      }}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPreview(user);
  await user.click(
    screen.getByRole("checkbox", { name: "我确认当前专利库为空，并同意导入后重新启动" }),
  );
  await user.click(screen.getByRole("button", { name: "导入并重新启动" }));
  await screen.findByText("当前专利库不是空库。");
  await expect(guard?.()).resolves.toBe(true);
});

test("locks the dialog at restartPending and never invents a completed state", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <ImportWizard
      open
      api={apiWith()}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      onClose={onClose}
    />,
  );
  await reachPreview(user);
  await user.click(
    screen.getByRole("checkbox", { name: "我确认当前专利库为空，并同意导入后重新启动" }),
  );
  await user.click(screen.getByRole("button", { name: "导入并重新启动" }));

  await screen.findByText("正在安全切换并重新启动");
  expect(screen.queryByRole("button", { name: /关闭|取消/u })).toBeNull();
  expect(screen.queryByText("迁移完成")).toBeNull();
  await user.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
});

test("keeps the source page after selection until the user confirms it", async () => {
  const user = userEvent.setup();
  render(
    <ImportWizard
      open
      api={apiWith()}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await openSourceStep(user);

  const next = screen.getByRole<HTMLButtonElement>("button", { name: "下一步" });
  expect(next.disabled).toBe(true);
  expect(screen.getByText("请先选择一个 .zxwbackup 文件。")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "浏览数据包" }));
  expect(await screen.findByText("虚构完整数据.zxwbackup")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新选择" })).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "下一步" }).disabled).toBe(false);
  expect(screen.queryByText("请先选择一个 .zxwbackup 文件。")).toBeNull();
  expect(screen.queryByRole("heading", { name: "输入迁移密码" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "下一步" }));
  expect(await screen.findByRole("heading", { name: "输入迁移密码" })).toBeTruthy();
});

test("returns from preview only after the prepared import is discarded", async () => {
  const user = userEvent.setup();
  const cancelled = deferred<AppResult<void>>();
  let operationSequence = 0;
  const api = apiWith({ cancel: vi.fn(() => cancelled.promise) });
  render(
    <ImportWizard
      open
      api={api}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => {
        operationSequence += 1;
        return operationSequence === 1 ? OPERATION_ID : NEXT_OPERATION_ID;
      }}
      onClose={vi.fn()}
    />,
  );
  await reachPreview(user);
  await user.click(screen.getByRole("button", { name: "上一步" }));

  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith(OPERATION_ID));
  expect(screen.getByRole("heading", { name: "确认导入内容" })).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "上一步" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "导入并重新启动" }).disabled).toBe(
    true,
  );
  expect(screen.getByText("正在返回…")).toBeTruthy();

  cancelled.resolve({ ok: true, value: undefined });
  await screen.findByRole("heading", { name: "输入迁移密码" });
  expect(screen.getByLabelText<HTMLInputElement>("迁移密码").value).toBe("");
  expect(screen.getByText("虚构完整数据.zxwbackup")).toBeTruthy();
});

test("stays on preview with an error when discarding the prepared import fails", async () => {
  const user = userEvent.setup();
  const cancelled = deferred<AppResult<void>>();
  const commitImport = vi.fn();
  const api = apiWith({ cancel: vi.fn(() => cancelled.promise), commitImport });
  render(
    <ImportWizard
      open
      api={api}
      closeGuardRegistrar={CLOSE_GUARD_REGISTRAR}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPreview(user);
  await user.click(screen.getByRole("button", { name: "上一步" }));
  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith(OPERATION_ID));

  cancelled.resolve({
    ok: false,
    error: { code: "INTERNAL", message: "本地操作失败。", nextAction: "请重试。" },
  });
  await screen.findByText("本地操作失败。");
  expect(screen.getByRole("heading", { name: "确认导入内容" })).toBeTruthy();
  expect(screen.getByText("密码正确")).toBeTruthy();
  expect(commitImport).not.toHaveBeenCalled();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "上一步" }).disabled).toBe(false);
});
