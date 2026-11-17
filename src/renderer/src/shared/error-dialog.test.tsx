import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorDialog } from "./error-dialog";

test("renders an application error in the standard alert dialog and closes through its action", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <ErrorDialog
      error={{ code: "INTERNAL", message: "写入失败", nextAction: "请重试。" }}
      onClose={onClose}
    />,
  );

  const dialog = screen.getByRole("alertdialog", { name: "操作未完成" });
  expect(dialog.classList.contains("operation-feedback")).toBe(true);
  expect(screen.getByText("本地操作失败。")).toBeDefined();
  expect(screen.getByText("请重试；如果问题持续，请重新启动应用。")).toBeDefined();

  await user.click(screen.getByRole("button", { name: "知道了" }));
  expect(onClose).toHaveBeenCalledOnce();
});
