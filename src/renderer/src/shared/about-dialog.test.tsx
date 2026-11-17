import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import policy from "../../../../resources/legal-policies.json";
import {
  APPLICATION_COPYRIGHT,
  APPLICATION_NAME,
  APPLICATION_VERSION,
} from "../../../shared/branding";
import { AboutDialog, ThirdPartyNoticesDialog } from "./about-dialog";

test("shows the official product identity and closes", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onOpen = vi.fn();
  render(<AboutDialog onClose={onClose} onOpen={onOpen} />);

  const dialog = screen.getByRole("dialog", { name: `关于${APPLICATION_NAME}` });
  expect(dialog.classList.contains("standard-dialog--s")).toBe(true);
  expect(dialog.parentElement?.classList.contains("standard-dialog-overlay")).toBe(true);
  expect(screen.getByRole("img", { name: `${APPLICATION_NAME} Logo` })).toBeDefined();
  expect(screen.getByText(APPLICATION_NAME)).toBeDefined();
  expect(screen.getByText(`版本 ${APPLICATION_VERSION}`)).toBeDefined();
  expect(screen.getByText(policy.operator)).toBeDefined();
  expect(screen.getByText(APPLICATION_COPYRIGHT)).toBeDefined();
  expect(screen.queryByRole("region", { name: "隐私与联网说明" })).toBeNull();
  for (const [label, destination] of [
    ["软件使用协议", "terms"],
    ["隐私政策", "privacy"],
    ["联系与反馈", "feedback"],
    ["开源声明", "notices"],
  ] as const) {
    await user.click(screen.getByRole("button", { name: label }));
    expect(onOpen).toHaveBeenLastCalledWith(destination);
  }
  const details = dialog.querySelector("details");
  expect(details?.open).toBe(false);
  await user.click(screen.getByText("版本详情"));
  expect(details?.open).toBe(true);
  expect(screen.getByText(/构建标识/)).toBeDefined();
  expect(screen.getByText(/构建时间/)).toBeDefined();

  await user.click(dialog.parentElement as HTMLElement);
  expect(onClose).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "关闭关于窗口" }));
  expect(onClose).toHaveBeenCalledOnce();
});

test("explains third-party components and exposes the bundled notices", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onOpenNotices = vi.fn();
  const onOpenLicensesFolder = vi.fn();
  render(
    <ThirdPartyNoticesDialog
      onClose={onClose}
      onOpenNotices={onOpenNotices}
      onOpenLicensesFolder={onOpenLicensesFolder}
    />,
  );

  const dialog = screen.getByRole("dialog", { name: "开源许可证与第三方声明" });
  expect(dialog.classList.contains("standard-dialog--l")).toBe(true);
  expect(screen.getByText("第三方组件说明")).toBeDefined();
  expect(screen.getByText("draw.io")).toBeDefined();
  expect(screen.getByText("Ketcher / Indigo")).toBeDefined();
  expect(screen.getByText("MathLive、KaTeX 与 MathJax")).toBeDefined();
  expect(screen.getByText("Sharp / libvips")).toBeDefined();
  expect(screen.getByText("应用框架与文档组件")).toBeDefined();
  expect(screen.getByText("IPC 数据中心")).toBeDefined();
  expect(screen.getByText("CAD 图纸转换")).toBeDefined();

  await user.click(screen.getByRole("button", { name: "查看完整第三方声明" }));
  expect(onOpenNotices).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", { name: "打开许可证目录" }));
  expect(onOpenLicensesFolder).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", { name: "关闭第三方声明窗口" }));
  expect(onClose).toHaveBeenCalledOnce();
});
