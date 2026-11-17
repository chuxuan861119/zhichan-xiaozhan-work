import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { UPDATE_RECOMMENDATION } from "../../../shared/updates/model";
import { SoftwareUpdateSettings } from "./software-update-settings";

const state = {
  channel: "preview",
  currentVersion: "1.1.1",
  status: "unconfigured",
  release: null,
  lastCheckedAt: null,
  notification: false,
  sourceHost: null,
  message: "更新服务尚未开放",
};
function stub() {
  const check = vi.fn().mockResolvedValue({ ok: true, value: state });
  vi.stubGlobal("patentApi", {
    updates: {
      read: vi.fn().mockResolvedValue({ ok: true, value: state }),
      onChanged: () => () => {},
      check,
    },
  });
  return check;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test("shows recommendation and default on; disabling saves, keeps manual check, and adds clear status", async () => {
  const check = stub();
  const save = vi.fn().mockResolvedValue(true);
  render(<SoftwareUpdateSettings enabled onSave={save} />);
  const toggle = screen.getByRole("checkbox", { name: "自动检查新版本" }) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  expect(screen.getByText(UPDATE_RECOMMENDATION)).toBeTruthy();
  await screen.findByText("预览通道");
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(false));
  expect(save).toHaveBeenCalledWith({ autoCheckUpdates: false });
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  await waitFor(() => expect(check).toHaveBeenCalledOnce());
  expect(screen.getByText("已关闭后台检测。您仍可点击“检查更新”获取新版本信息。")).toBeTruthy();
});
test("failed persistence keeps the original switch and displays retry", async () => {
  stub();
  render(<SoftwareUpdateSettings enabled onSave={vi.fn().mockResolvedValue(false)} />);
  const toggle = screen.getByRole("checkbox", { name: "自动检查新版本" }) as HTMLInputElement;
  fireEvent.click(toggle);
  await screen.findByText("保存失败，请重试。");
  expect(toggle.checked).toBe(true);
});
