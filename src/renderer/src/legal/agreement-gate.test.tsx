import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PatentApi } from "../../../shared/ipc/contract";
import type { AgreementState } from "../../../shared/legal/model";
import { AgreementGate } from "./agreement-gate";

const initial: AgreementState = {
  appVersion: "1.1.1",
  policy: {
    termsVersion: "terms-1",
    privacyVersion: "privacy-1",
    operator: "测试提供方",
    contact: "测试联系",
  },
  needsConfirmation: true,
  reason: "first-use",
  showStatistics: true,
  statistics: {
    enabled: false,
    accepted: false,
    available: true,
    status: "disabled",
    message: "测试",
    noticeVersion: "usage-1",
    lastAttempt: null,
    disclosure: {
      operator: "测试",
      contact: "测试",
      recipient: "测试",
      region: "测试",
      retentionMonths: 18,
      securityLogNotice: "测试",
    },
  },
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.reducedMotion;
  vi.restoreAllMocks();
});
async function fixture(state: AgreementState = initial) {
  const accept = vi.fn(async () => ({
    ok: true as const,
    value: { ...state, needsConfirmation: false, reason: "none" as const },
  }));
  const quit = vi.fn(async () => ({ ok: true as const, value: undefined }));
  window.patentApi = {
    agreements: { read: async () => ({ ok: true, value: state }), accept },
    application: { requestQuit: quit },
  } as unknown as PatentApi;
  render(
    <AgreementGate>
      <button type="button">工作台测试入口</button>
      <input aria-label="工作台测试草稿" defaultValue="" />
    </AgreementGate>,
  );
  await waitFor(() => expect(document.querySelector(".agreement-loading")).toBeNull());
  return { accept, quit };
}
test("unchecked statistics leaves a clickable neutral button and one confirmation unlocks immediately with inert exit paint", async () => {
  const { accept } = await fixture();
  const start = screen.getByRole("button", { name: "开始使用" });
  expect(start).toHaveProperty("disabled", false);
  expect(start.classList.contains("consent-start-blue")).toBe(false);
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "软件使用协议与隐私政策确认" })).toBeDefined();
  fireEvent.click(start);
  await waitFor(() => expect(accept).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(document.querySelector(".agreement-workspace")?.hasAttribute("inert")).toBe(false),
  );
  const overlay = document.querySelector(".agreement-gate")?.parentElement;
  expect(overlay?.dataset.motion).toBe("exit");
  expect(overlay?.hasAttribute("inert")).toBe(true);
  expect(start.textContent).toBe("开始使用");
  await waitFor(() => expect(document.querySelector(".agreement-gate")).toBeNull());
});
test("Windows first-use state hides statistics and starts with a blue button", async () => {
  const { accept } = await fixture({ ...initial, showStatistics: false });
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "查看说明" })).toBeNull();
  const start = screen.getByRole("button", { name: "开始使用" });
  expect(start.classList.contains("consent-start-blue")).toBe(true);
  expect(start).toHaveProperty("disabled", false);
  fireEvent.click(start);
  await waitFor(() =>
    expect(accept).toHaveBeenCalledWith({
      appVersion: "1.1.1",
      termsVersion: "terms-1",
      privacyVersion: "privacy-1",
    }),
  );
});

test.each([
  ["first-use", "开始使用"],
  ["software-update", "继续使用"],
  ["policy-update", "同意更新并继续"],
] as const)(
  "%s confirmation exits immediately while persistence remains pending",
  async (reason, label) => {
    const { accept } = await fixture({ ...initial, reason });
    let complete!: () => void;
    accept.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () =>
            resolve({
              ok: true,
              value: { ...initial, needsConfirmation: false, reason: "none" },
            });
        }),
    );
    const start = screen.getByRole("button", { name: label });
    fireEvent.click(start);
    expect(start.textContent).toBe(label);
    expect(start).toHaveProperty("disabled", true);
    expect(document.querySelector(".agreement-workspace")?.hasAttribute("inert")).toBe(false);
    expect(document.querySelector(".agreement-gate")?.parentElement?.dataset.motion).toBe("exit");
    expect(start.textContent).toBe(label);
    await waitFor(() => expect(document.querySelector(".agreement-gate")).toBeNull());
    await act(async () => complete());
    expect(document.querySelector(".agreement-gate")).toBeNull();
  },
);

test("reader return retains choice, restores focus, and submits independent current notice", async () => {
  const { accept } = await fixture();
  fireEvent.click(screen.getByRole("checkbox"));
  const trigger = screen.getByRole("button", { name: "软件使用协议" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "软件使用协议" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "返回协议确认" }));
  expect(document.activeElement).toBe(trigger);
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
  expect(
    screen.getByRole("button", { name: "开始使用" }).classList.contains("consent-start-blue"),
  ).toBe(true);
  await waitFor(() => expect(document.querySelector(".consent-reader")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
  await waitFor(() =>
    expect(accept).toHaveBeenCalledWith({
      appVersion: "1.1.1",
      termsVersion: "terms-1",
      privacyVersion: "privacy-1",
      participate: true,
      statisticsNoticeVersion: "usage-1",
    }),
  );
});
test("a persistence failure keeps the workspace blocked and permits retry", async () => {
  const { accept } = await fixture();
  accept.mockRejectedValueOnce(new Error("磁盘写入失败"));
  fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("磁盘写入失败"),
  );
  expect(document.querySelector(".agreement-workspace")?.hasAttribute("inert")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
  await waitFor(() => expect(accept).toHaveBeenCalledTimes(2));
});
test("a late background save failure restores confirmation without losing workspace input", async () => {
  const { accept } = await fixture();
  let fail!: () => void;
  accept.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = () => reject(new Error("磁盘写入失败"));
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
  expect(document.querySelector(".agreement-workspace")?.hasAttribute("inert")).toBe(false);
  const draft = screen.getByRole("textbox", { name: "工作台测试草稿" });
  fireEvent.change(draft, { target: { value: "正在撰写的内容" } });
  await waitFor(() => expect(document.querySelector(".agreement-gate")).toBeNull());
  await act(async () => fail());
  expect(screen.getByRole("alert").textContent).toContain("磁盘写入失败");
  expect(document.querySelector(".agreement-workspace")?.hasAttribute("inert")).toBe(true);
  expect(draft).toHaveProperty("value", "正在撰写的内容");
  fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
  await waitFor(() =>
    expect(document.querySelector(".agreement-workspace")?.hasAttribute("inert")).toBe(false),
  );
});
test("agreement-only changes never include or re-enable statistics", async () => {
  const { accept } = await fixture({ ...initial, reason: "policy-update", showStatistics: false });
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByText("查看说明")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "同意更新并继续" }));
  await waitFor(() =>
    expect(accept).toHaveBeenCalledWith({
      appVersion: "1.1.1",
      termsVersion: "terms-1",
      privacyVersion: "privacy-1",
    }),
  );
});
test("unopened statistics cannot be chosen but local use remains available", async () => {
  const { accept } = await fixture({
    ...initial,
    statistics: { ...initial.statistics!, available: false, status: "unconfigured" },
  });
  expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
  await waitFor(() => expect(accept).toHaveBeenCalledOnce());
});
test("refusal waits for shared exit retention, reduced motion exits immediately", async () => {
  const { quit } = await fixture();
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "不同意并退出" }));
  expect(quit).not.toHaveBeenCalled();
  expect(document.querySelector(".agreement-gate")?.parentElement?.hasAttribute("inert")).toBe(
    true,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(419);
  });
  expect(quit).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(quit).toHaveBeenCalledOnce();
  cleanup();
  vi.useRealTimers();
  document.documentElement.dataset.reducedMotion = "true";
  const reduced = await fixture();
  fireEvent.click(screen.getByRole("button", { name: "不同意并退出" }));
  expect(reduced.quit).toHaveBeenCalledOnce();
});
test("a previously confirmed version has no entry dialog", async () => {
  await fixture({ ...initial, needsConfirmation: false, reason: "none" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a cancelled protected quit restores the agreement instead of leaving an inert blank screen", async () => {
  document.documentElement.dataset.reducedMotion = "true";
  await fixture();
  fireEvent.click(screen.getByRole("button", { name: "不同意并退出" }));
  act(() => window.dispatchEvent(new Event("workbench:application-close-cancelled")));
  expect(screen.getByRole("dialog", { name: "软件使用协议与隐私政策确认" })).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain("软件退出未完成");
  expect(screen.getByRole("button", { name: "不同意并退出" })).toHaveProperty("disabled", false);
});
