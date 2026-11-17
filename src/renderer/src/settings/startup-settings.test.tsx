import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StartupSettings } from "./startup-settings";

test("Harmony uses system management and refreshes the real state on return", async () => {
  const read = vi.fn().mockResolvedValue({
    ok: true,
    value: { supported: true, enabled: false, management: "system" },
  });
  const update = vi.fn().mockResolvedValue({
    ok: true,
    value: { supported: true, enabled: false, management: "system" },
  });
  vi.stubGlobal("patentApi", { application: { readStartup: read, updateStartup: update } });
  render(<StartupSettings closeToTray onSave={vi.fn()} />);
  const button = await screen.findByRole("button", { name: "前往系统设置" });
  expect(screen.queryByRole("checkbox", { name: "开机启动" })).toBeNull();
  fireEvent.click(button);
  await screen.findByText("已打开系统设置，修改后返回刷新状态。");
  read.mockResolvedValue({
    ok: true,
    value: { supported: true, enabled: true, management: "system" },
  });
  fireEvent.focus(window);
  await screen.findByText("已开启");
  vi.unstubAllGlobals();
});

test("only the switches toggle settings, not their text or row", async () => {
  const update = vi.fn().mockResolvedValue({ ok: true, value: { supported: true, enabled: true } });
  vi.stubGlobal("patentApi", {
    application: {
      readStartup: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { supported: true, enabled: false } }),
      updateStartup: update,
    },
  });
  const save = vi.fn().mockResolvedValue(true);
  render(<StartupSettings closeToTray onSave={save} />);
  await waitFor(() =>
    expect((screen.getByRole("checkbox", { name: "开机启动" }) as HTMLInputElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByText("关闭窗口时最小化到系统托盘"));
  fireEvent.click(screen.getByText("开机启动"));
  expect(save).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "开机启动" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(true));
  vi.unstubAllGlobals();
});

test("shows the default tray option and disables login startup in a development instance", async () => {
  vi.stubGlobal("patentApi", {
    application: {
      readStartup: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { supported: false, enabled: false } }),
    },
  });
  const save = vi.fn().mockResolvedValue(true);
  render(<StartupSettings closeToTray onSave={save} />);
  const tray = screen.getByRole("checkbox", {
    name: "关闭窗口时最小化到系统托盘",
  }) as HTMLInputElement;
  expect(tray.checked).toBe(true);
  fireEvent.click(tray);
  await waitFor(() => expect(save).toHaveBeenCalledWith({ closeToTray: false }));
  expect((screen.getByRole("checkbox", { name: "开机启动" }) as HTMLInputElement).disabled).toBe(
    true,
  );
  vi.unstubAllGlobals();
});
