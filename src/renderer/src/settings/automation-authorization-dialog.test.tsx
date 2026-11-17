import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type {
  AutomationEvent,
  AutomationUiRequest,
  AutomationUiState,
} from "../../../shared/automation/protocol";
import type { PatentApi } from "../../../shared/ipc/contract";
import {
  ApplicationCloseProvider,
  useApplicationCloseGuard,
} from "../app/application-close-coordinator";
import {
  AutomationAuthorizationDialog,
  installAuthorizationKeyboardGuard,
} from "./automation-authorization-dialog";

const pairId = "00000000-0000-4000-8000-000000000102";
const patentId = "00000000-0000-4000-8000-000000000101";
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
function install() {
  let listener: (event: AutomationEvent) => void = () => {};
  const state: AutomationUiState = {
    enabled: true,
    instance: null,
    pendingPairs: [],
    grants: [],
    changes: [],
    stagedAssetCount: 0,
  };
  const control = vi.fn(async (request: AutomationUiRequest) => {
    if (request.action === "approvePair" || request.action === "rejectPair")
      state.pendingPairs = state.pendingPairs.filter((p) => p.pairId !== request.pairId);
    return { ok: true as const, value: structuredClone(state) };
  });
  const list = vi.fn(async () => ({
    ok: true,
    value: [{ patentId, name: "测试专利", createdAt: "2026-10-01T00:00:00Z" }],
  }));
  window.patentApi = {
    automation: {
      control,
      onEvent: (callback: typeof listener) => {
        listener = callback;
        return () => {};
      },
    },
    patents: { list },
  } as unknown as PatentApi;
  const request = (createRequested = false, requestedId = pairId) => {
    state.pendingPairs.push({
      pairId: requestedId,
      clientId: "agent",
      label: "测试助手",
      expiresAt: Date.now() + 60000,
      requested: {
        patents: [{ patentId, access: "read" }],
        ...(createRequested ? { createLimit: 1 } : {}),
      },
    });
    listener({ type: "stateChanged" });
  };
  return { state, control, list, request, changed: () => listener({ type: "stateChanged" }) };
}
async function agree() {
  fireEvent.click(screen.getByRole("button", { name: "用户授权须知" }));
  fireEvent.click(screen.getByLabelText("我已阅读并同意以上授权须知"));
  fireEvent.click(screen.getByRole("button", { name: "同意并返回" }));
}
async function choosePatentPermission(level: "read" | "full") {
  fireEvent.click(await screen.findByRole("button", { name: /从专利库选择|选择 \/ 调整专利/ }));
  const checkbox = await screen.findByLabelText("选择 测试专利");
  if (!(checkbox as HTMLInputElement).checked) fireEvent.click(checkbox);
  fireEvent.change(await screen.findByLabelText("所选权限 测试专利"), { target: { value: level } });
  fireEvent.click(screen.getByRole("button", { name: "确定选择" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "选择授权专利" })).toBeNull());
}
async function expectPatentPermission(level: "read" | "full") {
  expect(screen.getByText("已选 1 件")).toBeDefined();
  expect(within(screen.getByRole("alertdialog")).queryByText("测试专利")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "选择 / 调整专利" }));
  expect(await screen.findByLabelText("所选权限 测试专利")).toHaveProperty("value", level);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "选择授权专利" })).toBeNull());
}
test("automatically blocks outside settings, cannot dismiss, and authorizes selected scope once", async () => {
  const api = install();
  const removeGuard = installAuthorizationKeyboardGuard();
  const backgroundShortcut = vi.fn();
  window.addEventListener("keydown", backgroundShortcut, true);
  const view = render(<AutomationAuthorizationDialog />);
  await act(async () => api.request());
  const dialog = await screen.findByRole("alertdialog", { name: "测试助手请求操作授权" });
  expect(dialog.closest("dialog")?.open).toBe(true);
  expect(within(dialog).getByText("本地操作")).toBeDefined();
  expect(within(dialog).queryByText("请求授权的 Agent")).toBeNull();
  const footer = dialog.querySelector(".standard-dialog__footer")!;
  expect(footer.contains(screen.getByLabelText("我已阅读并同意授权须知"))).toBe(true);
  expect(footer.contains(screen.getByRole("button", { name: "用户授权须知" }))).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  fireEvent.keyDown(dialog, { key: "s", ctrlKey: true });
  expect(backgroundShortcut).not.toHaveBeenCalled();
  expect(dialog.closest("dialog")?.open).toBe(true);
  expect(screen.queryByRole("button", { name: "关闭测试助手请求操作授权" })).toBeNull();
  await choosePatentPermission("read");
  await act(async () => api.changed());
  await expectPatentPermission("read");
  await agree();
  fireEvent.click(screen.getByRole("button", { name: "授权" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(api.control).toHaveBeenCalledWith({
    action: "approvePair",
    pairId,
    scope: { patents: { [patentId]: "read" }, createLimit: 0, workspace: {} },
  });
  await act(async () => api.changed());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  view.unmount();
  window.removeEventListener("keydown", backgroundShortcut, true);
  removeGuard();
});
test("queues requests, resets scope between clients, and allows closing the application", async () => {
  const api = install();
  render(<AutomationAuthorizationDialog />);
  await act(async () => api.request());
  await screen.findByRole("button", { name: "从专利库选择" });
  await choosePatentPermission("full");
  api.state.pendingPairs.push({
    pairId: "second",
    clientId: "other",
    label: "第二个助手",
    expiresAt: Date.now() + 60000,
    requested: {
      patents: [{ patentId, access: "read" }],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  await screen.findByRole("alertdialog", { name: "第二个助手请求操作授权" });
  expect(within(screen.getByRole("alertdialog")).queryByText("测试专利")).toBeNull();
  expect(screen.queryByText("已选 1 件")).toBeNull();
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  expect(screen.queryByRole("button", { name: "关闭软件" })).toBeNull();
  const removeGuard = installAuthorizationKeyboardGuard();
  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "q", metaKey: true });
  removeGuard();
  expect(close).toHaveBeenCalledOnce();
  close.mockRestore();
  api.state.pendingPairs = [];
  await act(async () => api.changed());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});
test("compact authorization only stages requested creation permission and keeps explicit advanced selections when folded", async () => {
  const api = install();
  render(<AutomationAuthorizationDialog />);
  await act(async () => api.request(true));
  await screen.findByRole("button", { name: "从专利库选择" });
  const globals = screen.getByText("全局设置授权").closest("details");
  expect(screen.queryByText("材料与成果位置（可选）")).toBeNull();
  expect(globals?.open).toBe(false);

  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.getByText("新建专利（控制）权限")).toBeDefined();
  expect(within(screen.getByRole("alertdialog")).queryByText("测试专利")).toBeNull();
  expect(screen.queryByText("已选 1 件")).toBeNull();
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.getByText("每次最多 5 件")).toBeDefined();
  fireEvent.click(screen.getByText("全局设置授权"));
  fireEvent.change(screen.getByLabelText("全局权限 软件通用设置"), { target: { value: "read" } });
  fireEvent.click(screen.getByText("全局设置授权"));
  expect(globals?.open).toBe(false);
  expect(screen.getByText("已选 1 项")).toBeDefined();
  await agree();
  fireEvent.click(screen.getByRole("button", { name: "授权" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(api.control).toHaveBeenCalledWith({
    action: "approvePair",
    pairId,
    scope: { patents: {}, createLimit: 5, workspace: {}, global: { settings: "read" } },
  });
});
test("failed patent loading keeps the lock and offers retry or rejection without exposing errors", async () => {
  const api = install();
  api.list.mockRejectedValue(new Error("private details"));
  render(<AutomationAuthorizationDialog />);
  await act(async () => api.request());
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "授权" })).toHaveProperty("disabled", true);
  expect(screen.queryByText(/private details/)).toBeNull();
  api.list.mockResolvedValue({
    ok: true,
    value: [{ patentId, name: "测试专利", createdAt: "2026-10-01T00:00:00Z" }],
  });
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "从专利库选择" });
  expect(screen.getByRole("button", { name: "授权" })).toHaveProperty("disabled", true);
  await agree();
  expect(screen.getByRole("button", { name: "授权" })).toHaveProperty("disabled", false);
});

test("a cancelled safe application close restores the blocking dialog and its draft", async () => {
  const api = install();
  let prepareClose: (token: string) => void = () => {};
  let finishClose!: (result: { ok: true; value: undefined }) => void;
  window.patentApi.application = {
    onPrepareClose: (callback: (token: string) => void) => {
      prepareClose = callback;
      return () => {};
    },
    closeResult: vi.fn(
      () =>
        new Promise((resolve) => {
          finishClose = resolve;
        }),
    ),
  } as unknown as PatentApi["application"];
  function CancelClose() {
    useApplicationCloseGuard("test-cancel", async () => false);
    return null;
  }
  render(
    <ApplicationCloseProvider>
      <CancelClose />
      <AutomationAuthorizationDialog />
    </ApplicationCloseProvider>,
  );
  await act(async () => api.request());
  await choosePatentPermission("full");
  await act(async () => prepareClose("closing"));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(window.patentApi.application.closeResult).toHaveBeenCalledWith({
    token: "closing",
    proceed: false,
  });
  await act(async () => finishClose({ ok: true, value: undefined }));
  expect(await screen.findByRole("alertdialog")).toBeDefined();
  await expectPatentPermission("full");
});

test("failed approval remains blocked with the same scope and can be retried", async () => {
  const api = install();
  render(<AutomationAuthorizationDialog />);
  await act(async () => api.request());
  await choosePatentPermission("full");
  api.control.mockRejectedValueOnce(new Error("private approval failure"));
  await agree();
  fireEvent.click(screen.getByRole("button", { name: "授权" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alertdialog").closest("dialog")?.open).toBe(true);
  await expectPatentPermission("full");
  await agree();
  fireEvent.click(screen.getByRole("button", { name: "授权" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

test("an expired request unlocks without needing a later state event", async () => {
  vi.useFakeTimers();
  try {
    const api = install();
    api.control.mockImplementation(async () => {
      api.state.pendingPairs = api.state.pendingPairs.filter((p) => p.expiresAt > Date.now());
      return { ok: true, value: structuredClone(api.state) };
    });
    render(<AutomationAuthorizationDialog />);
    await act(async () => api.request());
    expect(screen.getByRole("alertdialog")).toBeDefined();
    await act(async () => vi.advanceTimersByTimeAsync(60050));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test.each(["approvePair", "rejectPair"] as const)(
  "a confirmed %s unlocks even if the following status refresh fails",
  async (action) => {
    const api = install();
    render(<AutomationAuthorizationDialog />);
    await act(async () => api.request());
    await screen.findByRole("button", { name: "从专利库选择" });
    const execute = api.control.getMockImplementation();
    if (!execute) throw new Error("missing fixture implementation");
    let approved = false;
    api.control.mockImplementation(async (request) => {
      if (request.action === "status" && approved) throw new Error("temporary IPC failure");
      const result = await execute(request);
      if (request.action === action) approved = true;
      return result;
    });
    if (action === "approvePair") await agree();
    fireEvent.click(
      screen.getByRole("button", {
        name: action === "approvePair" ? "授权" : "拒绝",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  },
);

test("creation renewal presents its request without a switch and one consent check enables approval", async () => {
  const api = install();
  api.state.pendingPairs.push({
    pairId,
    clientId: "agent",
    label: "测试助手",
    expiresAt: Date.now() + 60000,
    creationRenewal: true,
  });
  render(<AutomationAuthorizationDialog />);
  const dialog = await screen.findByRole("alertdialog", { name: "测试助手请求操作授权" });
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.queryByText("从专利库选择")).toBeNull();
  expect(screen.queryByText("全局设置授权")).toBeNull();
  expect(screen.getByRole("button", { name: "授权" })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.getByText("新建专利（控制）权限")).toBeDefined();
  fireEvent.click(screen.getByLabelText("我已阅读并同意授权须知"));
  expect(screen.queryByRole("dialog", { name: "Agent 用户授权须知" })).toBeNull();
  expect(screen.getByRole("button", { name: "授权" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "授权" }));
  await waitFor(() => expect(dialog.closest("dialog")?.open).not.toBe(true));
  expect(api.control).toHaveBeenCalledWith({
    action: "approvePair",
    pairId,
    scope: { patents: {}, createLimit: 5, workspace: {} },
  });
});

test("an initial creation request needs only consent and authorization, and unrequested creation remains absent", async () => {
  const api = install();
  render(<AutomationAuthorizationDialog />);
  await act(async () => api.request(true));
  await screen.findByRole("alertdialog", { name: "测试助手请求操作授权" });
  expect(screen.queryByRole("switch")).toBeNull();
  expect(api.control).not.toHaveBeenCalledWith(expect.objectContaining({ action: "approvePair" }));
  fireEvent.click(screen.getByLabelText("我已阅读并同意授权须知"));
  expect(screen.getByRole("button", { name: "授权" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "授权" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(api.control).toHaveBeenCalledWith({
    action: "approvePair",
    pairId,
    scope: { patents: {}, createLimit: 5, workspace: {} },
  });
  await act(async () => api.request(false, "00000000-0000-4000-8000-000000000002"));
  await screen.findByRole("alertdialog", { name: "测试助手请求操作授权" });
  expect(screen.queryByText("新建专利（控制）权限")).toBeNull();
  expect(screen.getByRole("button", { name: "授权" })).toHaveProperty("disabled", true);
});
