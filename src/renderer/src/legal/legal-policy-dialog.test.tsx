import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PatentApi } from "../../../shared/ipc/contract";
import type { AgreementState } from "../../../shared/legal/model";
import {
  USAGE_NOTICE_VERSION,
  type UsageChoice,
  type UsageState,
} from "../../../shared/usage-statistics/model";
import { UsageStatisticsProvider } from "../settings/usage-statistics-settings";
import { LegalPolicyDialog } from "./legal-policy-dialog";

const previousApi = window.patentApi;

function statisticsFixture(accepted = true, failure = false) {
  let statistics: UsageState = {
    enabled: accepted,
    accepted,
    available: true,
    status: accepted ? "participating" : "disabled",
    message: "测试统计状态",
    noticeVersion: USAGE_NOTICE_VERSION,
    lastAttempt: null,
    disclosure: {
      operator: "测试运营方",
      contact: "测试联系",
      recipient: "测试接收方",
      region: "测试地域",
      retentionMonths: 18,
      securityLogNotice: "测试日志规则",
    },
  };
  const choose = vi.fn(async (choice: UsageChoice) => {
    if (failure) return { ok: false, error: { code: "failed", message: "统计选项保存失败" } };
    statistics = {
      ...statistics,
      enabled: choice.enabled,
      accepted: statistics.accepted || choice.enabled,
      status: choice.enabled ? "participating" : "disabled",
    };
    return { ok: true, value: statistics };
  });
  window.patentApi = {
    usageStatistics: {
      read: async () => ({ ok: true, value: statistics }),
      choose,
      onChanged: () => () => {},
    },
  } as unknown as PatentApi;
  const ui = (document: "terms" | "privacy" | null) => (
    <UsageStatisticsProvider>
      <LegalPolicyDialog document={document} onClose={() => {}} />
    </UsageStatisticsProvider>
  );
  return { choose, ui };
}

test("terms integrates statistics choice in its chapter without implicitly changing consent", async () => {
  const { choose, ui } = statisticsFixture();
  const view = render(ui("terms"));
  const toggle = await screen.findByRole("switch", { name: "参与使用统计" });
  await waitFor(() => expect(toggle).toHaveProperty("checked", true));
  expect(toggle.closest("article > section")?.querySelector("h3")?.textContent).toContain(
    "使用统计",
  );
  expect(screen.queryByText("用户协议：使用统计")).toBeNull();
  expect(screen.getByRole("dialog").textContent).not.toContain("设置 → 数据与安全 → 使用统计");
  expect(choose).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  await waitFor(() => expect(choose).toHaveBeenCalledExactlyOnceWith({ enabled: false }));
  view.rerender(ui(null));
  view.rerender(ui("terms"));
  await waitFor(() => expect(screen.getByRole("switch")).toHaveProperty("checked", false));
  expect(choose).toHaveBeenCalledTimes(1);
  view.rerender(ui("privacy"));
  expect(screen.queryByRole("switch")).toBeNull();
});

test("enabling in terms still requires an explicit notice-version choice", async () => {
  const { choose, ui } = statisticsFixture(false);
  render(ui("terms"));
  const toggle = await screen.findByRole("switch", { name: "参与使用统计" });
  await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
  fireEvent.click(toggle);
  expect(choose).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "使用统计告知" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "同意并参与统计" }));
  await waitFor(() =>
    expect(choose).toHaveBeenCalledWith({ enabled: true, noticeVersion: USAGE_NOTICE_VERSION }),
  );
});

test("statistics save failure remains visible in terms", async () => {
  const { ui } = statisticsFixture(true, true);
  render(ui("terms"));
  const toggle = await screen.findByRole("switch", { name: "参与使用统计" });
  await waitFor(() => expect(toggle).toHaveProperty("checked", true));
  fireEvent.click(toggle);
  expect((await screen.findByRole("alert")).textContent).toContain("统计选项保存失败");
  expect(toggle).toHaveProperty("checked", true);
});
afterEach(() => {
  cleanup();
  window.patentApi = previousApi;
});
test("read failures still show the offline policy, without changing consent", async () => {
  const accept = vi.fn();
  window.patentApi = {
    agreements: {
      read: async () => {
        throw new Error("read failed");
      },
      accept,
    },
  } as unknown as PatentApi;
  render(<LegalPolicyDialog document="privacy" onClose={() => {}} />);
  expect(screen.getByRole("dialog", { name: "隐私政策" })).toBeDefined();
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    expect.stringContaining("离线协议正文"),
  );
  expect(document.querySelectorAll("article section").length).toBeGreaterThan(10);
  expect(accept).not.toHaveBeenCalled();
});
test("closing keeps inert exit content stable and ignores a late read response", async () => {
  let complete!: (state: { ok: true; value: AgreementState }) => void;
  window.patentApi = {
    agreements: {
      read: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
  } as unknown as PatentApi;
  const view = render(<LegalPolicyDialog document="terms" onClose={() => {}} />);
  const dialog = screen.getByRole("dialog", { name: "软件使用协议" });
  const before = dialog.textContent;
  view.rerender(<LegalPolicyDialog document={null} onClose={() => {}} />);
  expect(dialog.parentElement?.dataset.motion).toBe("exit");
  expect(dialog.parentElement?.hasAttribute("inert")).toBe(true);
  await act(async () =>
    complete({
      ok: true,
      value: {
        appVersion: "1.1.1",
        policy: {
          termsVersion: "late",
          privacyVersion: "late",
          operator: "迟到的配置",
          contact: "测试",
        },
        needsConfirmation: false,
        reason: "none",
        showStatistics: false,
        statistics: null,
      },
    }),
  );
  expect(dialog.textContent).toBe(before);
  await waitFor(() => expect(document.querySelector(".consent-reader")).toBeNull());
});

test("older preload reads its statistics disclosure without accepting or changing it", async () => {
  const choose = vi.fn();
  window.patentApi = {
    usageStatistics: {
      read: async () => ({
        ok: true,
        value: {
          enabled: false,
          accepted: false,
          available: false,
          status: "unconfigured",
          message: "",
          noticeVersion: "legacy-notice",
          lastAttempt: null,
          disclosure: {
            operator: "测试历史运营主体",
            contact: "测试联系",
            recipient: "测试接收方",
            region: "测试地域",
            retentionMonths: 18,
            securityLogNotice: "测试日志说明",
          },
        },
      }),
      choose,
    },
  } as unknown as PatentApi;
  render(<LegalPolicyDialog document="privacy" onClose={() => {}} />);
  await waitFor(() =>
    expect(screen.getByRole("dialog", { name: "隐私政策" }).textContent).toContain(
      "测试历史运营主体",
    ),
  );
  expect(choose).not.toHaveBeenCalled();
});
