import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { APPLICATION_NAME } from "../../../shared/branding";
import { WelcomeDialog } from "./welcome-dialog";

test("welcomes users with the official brand and logo", () => {
  render(
    <WelcomeDialog
      busy={false}
      canRestoreFullData={false}
      onClose={vi.fn()}
      onRestoreFullData={vi.fn()}
    />,
  );

  expect(screen.getByRole("heading", { name: `欢迎使用${APPLICATION_NAME}` })).toBeDefined();
  expect(
    screen
      .getByRole("dialog", { name: `欢迎使用${APPLICATION_NAME}` })
      .classList.contains("standard-dialog--m"),
  ).toBe(true);
  expect(screen.getByRole("img", { name: `${APPLICATION_NAME} Logo` })).toBeDefined();
  expect(screen.getByText("本机数据将安全保存在本地")).toBeDefined();
});

test("offers full-data recovery only for an authoritatively empty library", async () => {
  const user = userEvent.setup();
  const onRestoreFullData = vi.fn();
  const { rerender } = render(
    <WelcomeDialog
      busy={false}
      canRestoreFullData
      onClose={vi.fn()}
      onRestoreFullData={onRestoreFullData}
    />,
  );

  await user.click(screen.getByRole("button", { name: "已有完整数据包？从旧电脑恢复" }));
  expect(onRestoreFullData).toHaveBeenCalledOnce();

  rerender(
    <WelcomeDialog
      busy={false}
      canRestoreFullData={false}
      onClose={vi.fn()}
      onRestoreFullData={onRestoreFullData}
    />,
  );
  expect(screen.queryByRole("button", { name: "已有完整数据包？从旧电脑恢复" })).toBeNull();
});

test("renders the full-data recovery entry as a distinct disabled-aware action", async () => {
  const user = userEvent.setup();
  const onRestoreFullData = vi.fn();
  const { rerender } = render(
    <WelcomeDialog
      busy={false}
      canRestoreFullData
      onClose={vi.fn()}
      onRestoreFullData={onRestoreFullData}
    />,
  );

  const restore = screen.getByRole("button", { name: "已有完整数据包？从旧电脑恢复" });
  expect(restore.className).toContain("welcome-dialog__restore");
  expect((restore as HTMLButtonElement).disabled).toBe(false);
  await user.click(restore);
  expect(onRestoreFullData).toHaveBeenCalledOnce();

  rerender(
    <WelcomeDialog
      busy
      canRestoreFullData
      onClose={vi.fn()}
      onRestoreFullData={onRestoreFullData}
    />,
  );
  expect(
    (screen.getByRole("button", { name: "已有完整数据包？从旧电脑恢复" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("keeps only the recovery action after desktop shortcut choice moves to the installer", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <WelcomeDialog busy={false} canRestoreFullData onClose={onClose} onRestoreFullData={vi.fn()} />,
  );

  expect(screen.queryByText("软件完全离线运行。是否在桌面创建一个可选快捷方式？")).toBeNull();
  expect(screen.queryByRole("button", { name: "暂不创建" })).toBeNull();
  expect(screen.queryByRole("button", { name: "创建桌面快捷方式" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "关闭欢迎提示" }));
  expect(onClose).toHaveBeenCalledOnce();
});

test("uses the standard header close control", () => {
  const { container } = render(
    <WelcomeDialog busy={false} canRestoreFullData onClose={vi.fn()} onRestoreFullData={vi.fn()} />,
  );
  const dismiss = screen.getByRole("button", { name: "关闭欢迎提示" });
  const header = container.querySelector<HTMLElement>(".standard-dialog__header");
  expect(header).not.toBeNull();
  expect(header?.contains(dismiss)).toBe(true);
  expect(dismiss.querySelector("svg.dialog-close-icon")).not.toBeNull();
});

test("structures full-data recovery as a clear two-level action", () => {
  const { container } = render(
    <WelcomeDialog busy={false} canRestoreFullData onClose={vi.fn()} onRestoreFullData={vi.fn()} />,
  );
  const restore = screen.getByRole("button", { name: "已有完整数据包？从旧电脑恢复" });
  expect(restore.className).toContain("welcome-dialog__restore");
  expect(container.querySelector(".welcome-dialog__restore-context")?.textContent).toBe(
    "已有完整数据包？",
  );
  expect(container.querySelector(".welcome-dialog__restore-title")?.textContent).toBe(
    "从旧电脑恢复完整数据",
  );
  expect(container.querySelector(".welcome-dialog__restore-icon")).not.toBeNull();
});
