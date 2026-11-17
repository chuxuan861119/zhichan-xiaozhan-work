import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { AGENT_CLI_POLICY_VERSION } from "../../../shared/automation/policy";
import type {
  AutomationEvent,
  AutomationUiRequest,
  AutomationUiState,
} from "../../../shared/automation/protocol";
import type { PatentApi } from "../../../shared/ipc/contract";
import { AutomationSettings } from "./automation-settings";

const patentId = "00000000-0000-4000-8000-000000000101";
const pairId = "00000000-0000-4000-8000-000000000102";
const accessInstructions = `请先读取手册：'/app/cli/zxw' manual --json\n连接实例：'/app/cli/zxw' connect --instance ${pairId} --home '/test/CLI home' --json`;
function install() {
  let listener: (event: AutomationEvent) => void = () => {};
  const unsubscribe = vi.fn();
  const state: AutomationUiState = {
    enabled: false,
    instance: null,
    pendingPairs: [{ pairId, clientId: "agent", label: "本地助手", expiresAt: Date.now() + 10000 }],
    grants: [],
    changes: [],
    stagedAssetCount: 0,
  };
  const control = vi.fn(async (request: AutomationUiRequest) => {
    if (request.action === "accessInstructions")
      return { ok: true as const, value: accessInstructions };
    if (request.action === "setEnabled") state.enabled = request.enabled;
    if (request.action === "approvePair") {
      state.grants = [
        {
          grantId: pairId,
          clientId: "agent",
          label: "本地助手",
          taskId: pairId,
          createdCount: 0,
          scope: {
            ...request.scope,
            workspace: {
              importDirectory: request.scope.workspace.importDirectory ?? "/task/materials",
              exportDirectory: request.scope.workspace.exportDirectory ?? "/task/results",
            },
          },
        },
      ];
      state.pendingPairs = [];
    }
    if (request.action === "updateGrant")
      state.grants[0]!.scope = { ...request.scope, workspace: state.grants[0]!.scope.workspace };
    if (request.action === "revoke") state.grants = [];
    return { ok: true as const, value: structuredClone(state) };
  });
  const list = vi.fn(async () => ({ ok: true, value: [{ patentId, name: "授权专利" }] }));
  window.patentApi = {
    automation: {
      control,
      onEvent: (callback: typeof listener) => {
        listener = callback;
        return unsubscribe;
      },
    },
    patents: { list },
  } as unknown as PatentApi;
  return { control, list, state, unsubscribe, event: (event: AutomationEvent) => listener(event) };
}
function seedGrant(api: ReturnType<typeof install>) {
  api.state.pendingPairs = [];
  api.state.grants = [
    {
      grantId: pairId,
      clientId: "agent",
      label: "本地助手",
      taskId: pairId,
      createdCount: 0,
      scope: {
        patents: {},
        createLimit: 0,
        workspace: { importDirectory: "/task/materials", exportDirectory: "/task/results" },
      },
    },
  ];
}
async function renderGrantEditor(api: ReturnType<typeof install>) {
  seedGrant(api);
  render(<AutomationSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "调整 本地助手 授权" }));
}
test("grant summaries retain permission values and expandable workspace details", async () => {
  const api = install();
  seedGrant(api);
  const grant = api.state.grants[0];
  if (!grant) throw new Error("Missing grant fixture");
  grant.scope.patents[patentId] = "read";
  grant.scope.createLimit = 5;
  render(<AutomationSettings />);
  await screen.findByRole("button", { name: "调整 本地助手 授权" });
  const label = screen.getByText("只读参考", { selector: "dt" });
  expect(label.nextElementSibling?.textContent).toBe("授权专利");
  expect(screen.getByText("每次新建额度", { selector: "dt" }).nextElementSibling?.textContent).toBe(
    "5",
  );
  const details = screen.getByText("目录与授权详情").closest("details");
  if (!details) throw new Error("Missing workspace disclosure");
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("目录与授权详情"));
  expect(details.open).toBe(true);
  expect(screen.getByText("材料目录：/task/materials")).toBeDefined();
  expect(screen.getByText("成果目录：/task/results")).toBeDefined();
});
test("opening Agent CLI requires consent and cancel leaves it disabled", async () => {
  const api = install();
  render(<AutomationSettings />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "启用 Agent CLI" }));
  expect(screen.getByRole("dialog", { name: "Agent CLI 使用协议与隐私说明" })).toBeDefined();
  expect(screen.getByRole("button", { name: "同意并开启" })).toHaveProperty("disabled", true);
  expect(api.state.enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "暂不开启" }));
  expect(api.control.mock.calls.some(([request]) => request.action === "setEnabled")).toBe(false);
});
function finishReadingAgentPolicy() {
  const body = screen.getByRole("dialog").querySelector(".standard-dialog__body");
  if (!body) throw new Error("Missing policy body");
  Object.defineProperties(body, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 900 },
  });
  fireEvent.scroll(body, { target: { scrollTop: 600 } });
}
test("consent enables only after reading and agreement and records the current version", async () => {
  const api = install();
  render(<AutomationSettings />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "启用 Agent CLI" }));
  const agreement = screen.getByRole("checkbox", {
    name: "我已阅读并同意 Agent CLI 使用协议与隐私说明",
  });
  expect(agreement).toHaveProperty("disabled", true);
  finishReadingAgentPolicy();
  fireEvent.click(agreement);
  fireEvent.click(screen.getByRole("button", { name: "同意并开启" }));
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "启用 Agent CLI" })).toHaveProperty(
      "checked",
      true,
    ),
  );
  expect(api.control).toHaveBeenCalledWith({
    action: "setEnabled",
    enabled: true,
    policyAcceptedVersion: AGENT_CLI_POLICY_VERSION,
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "启用 Agent CLI" }));
  await waitFor(() => expect(api.state.enabled).toBe(false));
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("failed consent keeps the dialog and permits retry without enabling", async () => {
  const api = install();
  const control = api.control.getMockImplementation();
  let fail = true;
  api.control.mockImplementation(async (request) => {
    if (request.action === "setEnabled" && fail) throw new Error("Test saving failure");
    if (!control) throw new Error("Missing control fixture");
    return control(request);
  });
  render(<AutomationSettings />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "启用 Agent CLI" }));
  finishReadingAgentPolicy();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "我已阅读并同意 Agent CLI 使用协议与隐私说明" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "同意并开启" }));
  await screen.findByText("开启未完成，Agent CLI 未开启，请重试。");
  expect(api.state.enabled).toBe(false);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "同意并开启" }));
  await waitFor(() => expect(api.state.enabled).toBe(true));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
test("viewing the agreement never enables Agent CLI and cancelling resets the consent", async () => {
  const api = install();
  render(<AutomationSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Agent CLI 使用协议与隐私说明" }));
  expect(screen.queryByRole("button", { name: "同意并开启" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("checkbox", { name: "启用 Agent CLI" }));
  finishReadingAgentPolicy();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "我已阅读并同意 Agent CLI 使用协议与隐私说明" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "暂不开启" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("checkbox", { name: "启用 Agent CLI" }));
  expect(
    screen.getByRole("checkbox", { name: "我已阅读并同意 Agent CLI 使用协议与隐私说明" }),
  ).toHaveProperty("checked", false);
  expect(screen.getByRole("button", { name: "同意并开启" })).toHaveProperty("disabled", true);
  expect(api.state.enabled).toBe(false);
});
test("the inline guide copies one complete onboarding prompt and preserves manual copying on clipboard failure", async () => {
  const api = install();
  api.state.pendingPairs = [];
  api.state.enabled = true;
  api.state.instance = {
    instanceId: pairId,
    libraryId: patentId,
    protocolVersion: 2,
    version: "test",
    endpoint: "/test/agent.sock",
    pid: 1,
    label: "测试实例",
  };
  const writeText = vi.fn(async () => ({ ok: true as const, value: undefined }));
  window.patentApi.clipboard = {
    writeText,
    paste: vi.fn(async () => ({ ok: true as const, value: undefined })),
    readText: vi.fn(async () => ({ ok: true as const, value: "" })),
  };
  render(<AutomationSettings />);
  await screen.findByText("已开启");
  expect(screen.queryByText("zxw manual --output agent-cli-manual.md")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "复制 Agent 接入指令" }));
  await screen.findByText("接入指令已复制，连同任务要求一次发给 Agent 即可。");
  expect(writeText).toHaveBeenCalledWith(accessInstructions);
  writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "复制 Agent 接入指令" }));
  expect(
    await screen.findByText("复制未完成，请重试；已有接入指令可展开后手动复制。"),
  ).toBeDefined();
  expect(screen.getByText("查看完整接入指令")).toBeDefined();
  expect(
    api.control.mock.calls.every(([request]) =>
      ["status", "accessInstructions"].includes(request.action),
    ),
  ).toBe(true);
});
test("refreshes patent choices on state changes and manual refresh while preserving selected scope", async () => {
  const api = install();
  await renderGrantEditor(api);
  fireEvent.change(await screen.findByLabelText("权限 授权专利"), { target: { value: "read" } });
  const addedId = "00000000-0000-4000-8000-000000000103";
  api.list.mockResolvedValue({
    ok: true,
    value: [
      { patentId, name: "授权专利" },
      { patentId: addedId, name: "新建专利" },
    ],
  });
  await act(async () => api.event({ type: "stateChanged" }));
  await screen.findByLabelText("权限 新建专利");
  expect(screen.getByLabelText("权限 授权专利")).toHaveProperty("value", "read");
  api.list.mockResolvedValue({
    ok: true,
    value: [
      { patentId, name: "重命名专利" },
      { patentId: addedId, name: "新建专利" },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  await screen.findByLabelText("权限 重命名专利");
  expect(screen.getByLabelText("权限 重命名专利")).toHaveProperty("value", "read");
});
test("a delayed older refresh cannot overwrite newer patent choices", async () => {
  const api = install();
  seedGrant(api);
  let finish!: (value: Awaited<ReturnType<typeof api.list>>) => void;
  api.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<AutomationSettings />);
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
  api.list.mockResolvedValue({ ok: true, value: [{ patentId, name: "最新专利" }] });
  await act(async () => api.event({ type: "stateChanged" }));
  fireEvent.click(await screen.findByRole("button", { name: "调整 本地助手 授权" }));
  await screen.findByLabelText("权限 最新专利");
  await act(async () => finish({ ok: true, value: [{ patentId, name: "过时专利" }] }));
  expect(screen.queryByLabelText("权限 过时专利")).toBeNull();
  expect(screen.getByLabelText("权限 最新专利")).toBeDefined();
});
test("adjusts existing patent grants and revokes without a second inline approval entry", async () => {
  const api = install();
  await renderGrantEditor(api);
  const role = await screen.findByLabelText("权限 授权专利");
  expect(role).toHaveProperty("value", "none");
  fireEvent.change(role, { target: { value: "read" } });
  fireEvent.click(screen.getByRole("button", { name: "保存授权范围" }));
  await waitFor(() =>
    expect(api.control).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "updateGrant",
        grantId: pairId,
        scope: expect.objectContaining({ patents: { [patentId]: "read" } }),
      }),
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "撤销 本地助手 授权" }));
  await waitFor(() =>
    expect(api.control).toHaveBeenCalledWith({ action: "revoke", grantId: pairId }),
  );
});
test("refreshes on state event, unsubscribes, and does not expose control error details", async () => {
  const api = install();
  const view = render(<AutomationSettings />);
  await screen.findByText("待授权请求");
  expect(screen.queryByRole("button", { name: "按以上范围批准配对" })).toBeNull();
  expect(screen.queryByLabelText("权限 授权专利")).toBeNull();
  api.state.pendingPairs = [];
  await act(async () => api.event({ type: "stateChanged" }));
  expect(await screen.findByText("暂无已授权 Agent")).toBeDefined();
  expect(screen.queryByText("待授权请求")).toBeNull();
  view.unmount();
  expect(api.unsubscribe).toHaveBeenCalledOnce();
  window.patentApi = {
    automation: {
      control: vi.fn(async () => ({
        ok: false,
        error: { message: "secret-token", code: "INTERNAL" },
      })),
      onEvent: () => () => {},
    },
    patents: { list: vi.fn(async () => ({ ok: true, value: [] })) },
  } as unknown as PatentApi;
  render(<AutomationSettings />);
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(screen.queryByText(/secret-token/)).toBeNull();
});

test("the settings page directs pending clients to the central consent-gated dialog", async () => {
  const api = install();
  render(<AutomationSettings />);
  await screen.findByText("请在中央授权窗口处理此请求。");
  expect(screen.queryByRole("button", { name: "按以上范围批准配对" })).toBeNull();
  expect(screen.queryByRole("button", { name: "选择材料目录" })).toBeNull();
  expect(api.control.mock.calls.every(([request]) => request.action === "status")).toBe(true);
});

test("shows exact before/after structures without a second approval action", async () => {
  const api = install();
  api.state.pendingPairs = [];
  api.state.changes = [
    {
      changeId: pairId,
      patentId,
      name: "审阅专利",
      clientLabel: "助手",
      expectedRevision: 4,
      risk: { requireApproval: false, reasons: ["destructive-structured-content"] },
      diff: {
        metadata: { name: { before: "原名称", after: "新名称" } },
        books: [
          {
            bookKind: "claims",
            before: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "原正文", marks: [{ type: "bold" }] }],
              },
            ],
            after: [{ type: "paragraph", content: [{ type: "text", text: "新正文", marks: [] }] }],
          },
        ],
      },
      expiresAt: Date.now() + 10000,
    },
  ];
  render(<AutomationSettings />);
  await screen.findByText("原正文");
  expect(screen.getByText("新正文")).toBeDefined();
  expect(screen.getByText("可能移除表格、公式、样式等结构信息")).toBeDefined();
  expect(screen.getByText(/"bold"/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "批准此修改" })).toBeNull();
  expect(screen.getByText(/无需再次批准/)).toBeDefined();
  expect(api.control.mock.calls.every(([request]) => request.action === "status")).toBe(true);
});

test("global permissions are independently selected and never inherited from patent permission", async () => {
  const api = install();
  const { control } = api;
  await renderGrantEditor(api);
  const patent = await screen.findByLabelText("权限 授权专利");
  fireEvent.change(patent, { target: { value: "full" } });
  const global = screen.getByLabelText("全局权限 软件通用设置") as HTMLSelectElement;
  expect(global.value).toBe("none");
  fireEvent.change(global, { target: { value: "read" } });
  const templates = screen.getByLabelText("全局权限 全局默认模板") as HTMLSelectElement;
  expect(templates.value).toBe("none");
  fireEvent.change(templates, { target: { value: "full" } });
  fireEvent.click(screen.getByRole("button", { name: "保存授权范围" }));
  await waitFor(() =>
    expect(control).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "updateGrant",
        scope: expect.objectContaining({
          patents: { [patentId]: "full" },
          global: { settings: "read", templates: "full" },
        }),
      }),
    ),
  );
});
