import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DataTransferLibraryInspection,
  FullDataExportResult,
} from "../../../shared/data-transfer/model";
import type { AppResult } from "../../../shared/ipc/result";
import { ExportWizard, type ExportWizardApi } from "./export-wizard";

const OPERATION_ID = "00000000-0000-4000-8000-000000000927";
const PASSWORD = "虚构迁移密码十二字符9!";
const INSPECTION: DataTransferLibraryInspection = {
  empty: false,
  blockers: [],
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
};
const RESULT: FullDataExportResult = {
  operationId: OPERATION_ID,
  displayPath: "移动磁盘\\完整数据.zxwbackup",
  sizeBytes: 786_432,
  cutoffAt: "2026-08-17T00:00:00.000Z",
  packageFormatVersion: 2,
  summary: INSPECTION.summary,
  fullVerificationPassed: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function apiWith(
  exportPackage: ExportWizardApi["exportPackage"] = vi.fn(async () => ({
    ok: true as const,
    value: RESULT,
  })),
): ExportWizardApi {
  return {
    inspectLibrary: vi.fn(async () => ({ ok: true as const, value: INSPECTION })),
    selectExportDestination: vi.fn(async () => ({
      ok: true as const,
      value: {
        selectionId: "destination-selection",
        displayPath: "移动磁盘",
        suggestedFileName: "完整数据.zxwbackup",
      },
    })),
    exportPackage,
    cancel: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onProgress: vi.fn(() => vi.fn()),
  };
}

async function reachPasswordStep(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText("2 项在用专利");
  expect(screen.queryByText("某真实专利名称")).toBeNull();
  expect(screen.queryByRole("button", { name: "选择保存位置" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "下一步" }));
  expect(screen.getByText(/专利库内部/u)).toBeTruthy();
  expect(screen.getByText(/4 GB/u)).toBeTruthy();
  expect(screen.getByText(/不会覆盖/u)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "浏览保存位置" }));
  await screen.findByText("移动磁盘\\完整数据.zxwbackup");
  await user.click(screen.getByRole("button", { name: "下一步" }));
  await screen.findByRole("heading", { name: "设置迁移密码" });
  expect(screen.queryByText(/下一步：|返回上一步/u)).toBeNull();
}

test("keeps the next page disabled until a destination is chosen and explains why", async () => {
  const user = userEvent.setup();
  render(
    <ExportWizard
      open
      api={apiWith()}
      flushAll={vi.fn(async () => ({ ok: true, failedParticipantIds: [] }))}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );

  await screen.findByText("2 项在用专利");
  await user.click(screen.getByRole("button", { name: "下一步" }));
  const back = screen.getByRole("button", { name: "上一步" });
  const next = screen.getByRole<HTMLButtonElement>("button", { name: "下一步" });
  expect(back).toBeTruthy();
  expect(next.disabled).toBe(true);
  expect(screen.getByText("请先选择保存位置。")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "浏览保存位置" }));
  await screen.findByText("移动磁盘\\完整数据.zxwbackup");
  expect(screen.getByRole("button", { name: "重新选择" })).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "下一步" }).disabled).toBe(false);
  expect(screen.queryByText("请先选择保存位置。")).toBeNull();
});

test("confirms the selected destination before continuing to the password step", async () => {
  const user = userEvent.setup();
  render(
    <ExportWizard
      open
      api={apiWith()}
      flushAll={vi.fn(async () => ({ ok: true, failedParticipantIds: [] }))}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );

  await screen.findByText("2 项在用专利");
  await user.click(screen.getByRole("button", { name: "下一步" }));
  await user.click(screen.getByRole("button", { name: "浏览保存位置" }));

  expect(await screen.findByText("移动磁盘\\完整数据.zxwbackup")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新选择" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "设置迁移密码" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "下一步" }));
  expect(await screen.findByRole("heading", { name: "设置迁移密码" })).toBeTruthy();
});

test("keeps the selected destination when randomUUID is unavailable", async () => {
  const user = userEvent.setup();
  const originalRandomUuid = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  try {
    render(
      <ExportWizard
        open
        api={apiWith()}
        flushAll={vi.fn(async () => ({ ok: true, failedParticipantIds: [] }))}
        onClose={vi.fn()}
      />,
    );

    await screen.findByText("2 项在用专利");
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "浏览保存位置" }));

    expect(await screen.findByText("移动磁盘\\完整数据.zxwbackup")).toBeTruthy();
    expect(screen.getByRole("button", { name: "下一步" })).toBeTruthy();
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: originalRandomUuid,
    });
  }
});

test("returns through the reversible export setup steps without retaining the password", async () => {
  const user = userEvent.setup();
  render(
    <ExportWizard
      open
      api={apiWith()}
      flushAll={vi.fn(async () => ({ ok: true, failedParticipantIds: [] }))}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );

  await reachPasswordStep(user);
  await user.type(screen.getByLabelText("迁移密码"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "上一步" }));

  expect(await screen.findByText("移动磁盘\\完整数据.zxwbackup")).toBeTruthy();
  expect(screen.queryByDisplayValue(PASSWORD)).toBeNull();
  await user.click(screen.getByRole("button", { name: "上一步" }));
  expect(await screen.findByRole("heading", { name: "确认要迁移的数据" })).toBeTruthy();
});

async function fillPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("迁移密码"), PASSWORD);
  await user.type(screen.getByLabelText("再次输入迁移密码"), PASSWORD);
  await user.click(screen.getByRole("checkbox", { name: "我已记录并妥善保管迁移密码" }));
}

test("flushes editors before invoking export and clears password immediately", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const flush = deferred<{ ok: boolean; failedParticipantIds: string[] }>();
  const calls: string[] = [];
  const flushAll = vi.fn(() => {
    calls.push("flush");
    return flush.promise;
  });
  const exportResult = deferred<AppResult<FullDataExportResult>>();
  const exportPackage = vi.fn(() => {
    calls.push("export");
    return exportResult.promise;
  });
  render(
    <ExportWizard
      open
      api={apiWith(exportPackage)}
      flushAll={flushAll}
      createOperationId={() => OPERATION_ID}
      onClose={onClose}
    />,
  );
  await reachPasswordStep(user);
  await fillPassword(user);

  await user.click(screen.getByRole("button", { name: "开始导出" }));
  expect(flushAll).toHaveBeenCalledWith("full-data-transfer");
  expect(screen.queryByDisplayValue(PASSWORD)).toBeNull();
  expect(exportPackage).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "关闭完整数据迁移" })).toBeNull();
  await user.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();

  flush.resolve({ ok: true, failedParticipantIds: [] });
  await waitFor(() => expect(exportPackage).toHaveBeenCalledOnce());
  expect(calls).toEqual(["flush", "export"]);
  expect(exportPackage).toHaveBeenCalledWith({
    operationId: OPERATION_ID,
    destinationSelectionId: "destination-selection",
    password: PASSWORD,
    passwordHint: null,
    passwordRecorded: true,
  });
  exportResult.resolve({ ok: true, value: RESULT });
});

test("does not start export when the wizard unmounts while editors are flushing", async () => {
  const user = userEvent.setup();
  const flush = deferred<{ ok: boolean; failedParticipantIds: string[] }>();
  const exportTask = deferred<AppResult<FullDataExportResult>>();
  const exportPackage = vi.fn(() => exportTask.promise);
  const { unmount } = render(
    <ExportWizard
      open
      api={apiWith(exportPackage)}
      flushAll={vi.fn(() => flush.promise)}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPasswordStep(user);
  await fillPassword(user);
  await user.click(screen.getByRole("button", { name: "开始导出" }));

  unmount();
  flush.resolve({ ok: true, failedParticipantIds: [] });
  await Promise.resolve();
  await Promise.resolve();
  expect(exportPackage).not.toHaveBeenCalled();
});

test("stays before export and names unsaved participants without reporting a package", async () => {
  const user = userEvent.setup();
  const api = apiWith();
  render(
    <ExportWizard
      open
      api={api}
      flushAll={vi.fn(async () => ({
        ok: false,
        failedParticipantIds: ["documents", `flowchart-workspace:${OPERATION_ID}`],
      }))}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPasswordStep(user);
  await fillPassword(user);
  await user.click(screen.getByRole("button", { name: "开始导出" }));

  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("文档编辑器"),
  );
  expect(screen.getByRole("alert").textContent).toContain("流程图编辑器");
  expect(screen.getByRole("alert").textContent).toContain("未生成正式数据包");
  expect(screen.getByRole("heading", { name: "设置迁移密码" })).toBeTruthy();
  expect(api.exportPackage).not.toHaveBeenCalled();
  expect(screen.queryByText("完整性验证通过")).toBeNull();
});

test("shows success when export wins the race with an acknowledged cancellation", async () => {
  const user = userEvent.setup();
  const exportResult = deferred<AppResult<FullDataExportResult>>();
  const api = apiWith(vi.fn(() => exportResult.promise));
  const cancelResult = deferred<AppResult<void>>();
  api.cancel = vi.fn(() => cancelResult.promise);
  const background = document.createElement("div");
  document.body.append(background);
  render(
    <ExportWizard
      open
      api={api}
      flushAll={vi.fn(async () => ({ ok: true, failedParticipantIds: [] }))}
      createOperationId={() => OPERATION_ID}
      backgroundElement={background}
      onClose={vi.fn()}
    />,
  );
  await reachPasswordStep(user);
  await fillPassword(user);
  await user.click(screen.getByRole("button", { name: "开始导出" }));
  await screen.findByRole("button", { name: "取消迁移" });
  expect(background.inert).toBe(true);
  await user.click(screen.getByRole("button", { name: "取消迁移" }));
  expect(screen.queryByRole("button", { name: /关闭完整数据迁移|取消迁移/u })).toBeNull();
  cancelResult.resolve({ ok: true, value: undefined });
  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith(OPERATION_ID));
  expect(screen.queryByRole("heading", { name: "已取消导出" })).toBeNull();
  expect(background.inert).toBe(true);
  await act(async () => {
    exportResult.resolve({ ok: true, value: RESULT });
  });

  await screen.findByRole("heading", { name: "完整数据包已生成" });
  expect(screen.getByText("完整性验证通过")).toBeTruthy();
  expect(background.inert).toBe(false);
  background.remove();
});

test("reports cancellation only after the export task returns its cancelled terminal result", async () => {
  const user = userEvent.setup();
  const exportResult = deferred<AppResult<FullDataExportResult>>();
  const api = apiWith(vi.fn(() => exportResult.promise));
  render(
    <ExportWizard
      open
      api={api}
      flushAll={vi.fn(async () => ({ ok: true, failedParticipantIds: [] }))}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPasswordStep(user);
  await fillPassword(user);
  await user.click(screen.getByRole("button", { name: "开始导出" }));
  await user.click(await screen.findByRole("button", { name: "取消迁移" }));

  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith(OPERATION_ID));
  expect(screen.queryByRole("heading", { name: "已取消导出" })).toBeNull();
  exportResult.resolve({
    ok: false,
    error: {
      code: "CANCELLED",
      message: "操作已取消。",
      nextAction: "无需其他操作。",
    },
  });
  await screen.findByRole("heading", { name: "已取消导出" });
  expect(screen.getByText(/原专利库未改变、未生成正式数据包/u)).toBeTruthy();
  expect(screen.queryByText("完整性验证通过")).toBeNull();
});

test("shows a fully verified result only after the export succeeds", async () => {
  const user = userEvent.setup();
  render(
    <ExportWizard
      open
      api={apiWith()}
      flushAll={vi.fn(async () => ({ ok: true, failedParticipantIds: [] }))}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPasswordStep(user);
  await fillPassword(user);
  await user.click(screen.getByRole("button", { name: "开始导出" }));

  await screen.findByRole("heading", { name: "完整数据包已生成" });
  expect(screen.getByText("完整性验证通过")).toBeTruthy();
  expect(screen.getByText(RESULT.displayPath)).toBeTruthy();
});

test("shows progress without navigation and keeps only the cancellation affordance", async () => {
  const user = userEvent.setup();
  const exportResult = deferred<AppResult<FullDataExportResult>>();
  const api = apiWith(vi.fn(() => exportResult.promise));
  render(
    <ExportWizard
      open
      api={api}
      flushAll={vi.fn(async () => ({ ok: true, failedParticipantIds: [] }))}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPasswordStep(user);
  await fillPassword(user);
  await user.click(screen.getByRole("button", { name: "开始导出" }));

  await screen.findByRole("button", { name: "取消迁移" });
  expect(screen.queryByRole("button", { name: /上一步|下一步/u })).toBeNull();
  exportResult.resolve({ ok: true, value: RESULT });
  await screen.findByRole("heading", { name: "完整数据包已生成" });
});

test("uses result actions on success and cancellation pages instead of navigation", async () => {
  const user = userEvent.setup();
  const exportResult = deferred<AppResult<FullDataExportResult>>();
  const api = apiWith(vi.fn(() => exportResult.promise));
  const onClose = vi.fn();
  const { unmount } = render(
    <ExportWizard
      open
      api={api}
      flushAll={vi.fn(async () => ({ ok: true, failedParticipantIds: [] }))}
      createOperationId={() => OPERATION_ID}
      onClose={onClose}
    />,
  );
  await reachPasswordStep(user);
  await fillPassword(user);
  await user.click(screen.getByRole("button", { name: "开始导出" }));
  exportResult.resolve({ ok: true, value: RESULT });

  await screen.findByRole("heading", { name: "完整数据包已生成" });
  expect(screen.queryByRole("button", { name: /上一步|下一步/u })).toBeNull();
  await user.click(screen.getByRole("button", { name: "完成" }));
  expect(onClose).toHaveBeenCalledOnce();
  unmount();

  // 取消页同样只使用结果动作
  const cancelledApi = apiWith();
  cancelledApi.exportPackage = vi.fn(
    async (): Promise<AppResult<FullDataExportResult>> => ({
      ok: false as const,
      error: { code: "CANCELLED", message: "操作已取消。", nextAction: "无需其他操作。" },
    }),
  );
  render(
    <ExportWizard
      open
      api={cancelledApi}
      flushAll={vi.fn(async () => ({ ok: true, failedParticipantIds: [] }))}
      createOperationId={() => OPERATION_ID}
      onClose={vi.fn()}
    />,
  );
  await reachPasswordStep(user);
  await fillPassword(user);
  await user.click(screen.getByRole("button", { name: "开始导出" }));

  await screen.findByRole("heading", { name: "已取消导出" });
  expect(screen.queryByRole("button", { name: /上一步|下一步/u })).toBeNull();
  expect(screen.getByRole("button", { name: /返回/u })).toBeTruthy();
});
