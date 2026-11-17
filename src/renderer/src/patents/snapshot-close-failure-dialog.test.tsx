import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnapshotCloseFailureDialog } from "./snapshot-close-failure-dialog";

test("offers retry, cancel, and still-close decisions with an explicit safety explanation", async () => {
  const user = userEvent.setup();
  const onDecision = vi.fn();
  render(<SnapshotCloseFailureDialog errorMessage="磁盘空间不足" onDecision={onDecision} />);

  const dialog = screen.getByRole("alertdialog", { name: "关闭恢复点创建失败" });
  expect(dialog.classList.contains("standard-dialog--s")).toBe(true);
  expect(dialog.parentElement?.classList.contains("standard-dialog-overlay")).toBe(true);
  expect(screen.getByText("正文及编辑内容已经安全保存，但本次关闭恢复点未能创建。")).toBeDefined();
  expect(screen.getByText("磁盘空间不足")).toBeDefined();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "重试创建快照" })),
  );

  await user.click(screen.getByRole("button", { name: "重试创建快照" }));
  expect(onDecision).toHaveBeenCalledOnce();
  expect(onDecision).toHaveBeenCalledWith("retry");
});

test("treats Escape as cancel and resolves the decision only once", async () => {
  const onDecision = vi.fn();
  render(<SnapshotCloseFailureDialog errorMessage="写入失败" onDecision={onDecision} />);

  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.keyDown(document, { key: "Escape" });

  expect(onDecision).toHaveBeenCalledOnce();
  expect(onDecision).toHaveBeenCalledWith("cancel");
});

test.each([
  ["取消关闭", "cancel"],
  ["仍然关闭", "skip"],
] as const)("maps %s to the %s decision", async (label, decision) => {
  const user = userEvent.setup();
  const onDecision = vi.fn();
  render(<SnapshotCloseFailureDialog errorMessage="写入失败" onDecision={onDecision} />);

  await user.click(screen.getByRole("button", { name: label }));

  expect(onDecision).toHaveBeenCalledWith(decision);
});
