import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PatentApi } from "../../../shared/ipc/contract";
import {
  USAGE_NOTICE_VERSION,
  type UsageChoice,
  type UsageState,
} from "../../../shared/usage-statistics/model";
import { UsageStatisticsProvider, UsageStatisticsSettings } from "./usage-statistics-settings";

afterEach(cleanup);
function fixture(
  options: { enabled?: boolean; accepted?: boolean; available?: boolean; failure?: boolean } = {},
) {
  let state: UsageState = {
    enabled: options.enabled ?? true,
    accepted: options.accepted ?? false,
    available: options.available ?? true,
    status: options.enabled === false ? "disabled" : options.accepted ? "participating" : "pending",
    message: "测试状态",
    noticeVersion: USAGE_NOTICE_VERSION,
    lastAttempt: null,
    disclosure: {
      operator: "测试运营方",
      contact: "测试联系",
      recipient: "测试接收方",
      region: "测试地域",
      retentionMonths: 18,
      securityLogNotice: "安全日志测试说明",
    },
  };
  let changed: ((next: UsageState) => void) | undefined;
  const choose = vi.fn(async (choice: UsageChoice) => {
    if (options.failure)
      state = { ...state, enabled: false, status: "error", message: "关闭选项未保存，请重试" };
    else
      state = {
        ...state,
        enabled: choice.enabled,
        accepted: choice.enabled || state.accepted,
        status: choice.enabled ? "participating" : "disabled",
      };
    return { ok: true as const, value: state };
  });
  window.patentApi = {
    usageStatistics: {
      read: async () => ({ ok: true, value: state }),
      choose,
      onChanged: (listener: (next: UsageState) => void) => {
        changed = listener;
        return () => {};
      },
    },
  } as unknown as PatentApi;
  render(
    <UsageStatisticsProvider>
      <UsageStatisticsSettings />
      <button type="button">本地编辑入口</button>
    </UsageStatisticsProvider>,
  );
  return {
    choose,
    changed: (next: Partial<UsageState>) => {
      state = { ...state, ...next };
      changed?.(state);
    },
  };
}
test.each([true, false])(
  "service available=%s never opens notice or moves editing focus",
  async (available) => {
    const { choose } = fixture({ available });
    const editing = screen.getByRole("button", { name: "本地编辑入口" });
    editing.focus();
    await screen.findByText(/待确认统计告知：/);
    expect(screen.getByRole("switch", { name: "参与使用统计" })).toHaveProperty("checked", true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "同意并参与统计" })).toBeNull();
    expect(document.activeElement).toBe(editing);
    expect(choose).not.toHaveBeenCalled();
  },
);
test("explicit inline choice sends the notice version; opting out needs no consent", async () => {
  const { choose } = fixture();
  fireEvent.click(await screen.findByRole("button", { name: "查看统计告知并选择" }));
  expect(screen.getByRole("region", { name: "使用统计告知" })).toBeDefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "同意并参与统计" }));
  await waitFor(() =>
    expect(choose).toHaveBeenCalledWith({ enabled: true, noticeVersion: USAGE_NOTICE_VERSION }),
  );
  await waitFor(() => expect(screen.queryByRole("region", { name: "使用统计告知" })).toBeNull());
  fireEvent.click(screen.getByRole("switch", { name: "参与使用统计" }));
  await waitFor(() => expect(choose).toHaveBeenCalledWith({ enabled: false }));
});
test("unopened service is disclosed inline and cannot accept", async () => {
  fixture({ available: false });
  fireEvent.click(await screen.findByRole("button", { name: "查看统计告知并选择" }));
  expect(screen.getByRole("button", { name: "同意并参与统计" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "关闭统计" }));
  await screen.findByText(/已关闭：/);
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("notice changes are silent and terms are available only on explicit page action", async () => {
  const f = fixture({ accepted: true });
  await screen.findByText(/已参与：/);
  const editing = screen.getByRole("button", { name: "本地编辑入口" });
  editing.focus();
  act(() => f.changed({ accepted: false, noticeVersion: "new-notice", status: "pending" }));
  await screen.findByText(/待确认统计告知：/);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("region", { name: "使用统计告知" })).toBeNull();
  expect(document.activeElement).toBe(editing);
  fireEvent.click(screen.getByRole("button", { name: "用户协议：使用统计" }));
  expect(screen.getByRole("region", { name: "用户协议：使用统计" })).toBeDefined();
});
test("turning an unaccepted option back on shows an inline choice and never accepts implicitly", async () => {
  const { choose } = fixture({ enabled: false });
  await screen.findByText(/已关闭：/);
  fireEvent.click(screen.getByRole("switch", { name: "参与使用统计" }));
  expect(screen.getByRole("region", { name: "使用统计告知" })).toBeDefined();
  expect(choose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "收起说明" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(choose).not.toHaveBeenCalled();
});
test("withdrawal persistence failure is visible and offers retry", async () => {
  fixture({ accepted: true, failure: true });
  const toggle = await screen.findByRole("switch", { name: "参与使用统计" });
  await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
  fireEvent.click(toggle);
  expect(await screen.findByRole("button", { name: "重试保存关闭选项" })).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain("未保存");
});
