import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTransferDialog } from "./data-transfer-dialog";
import { DataTransferStepPage } from "./data-transfer-step-page";

const STEPS = [
  { id: "summary", label: "确认数据" },
  { id: "password", label: "设置密码" },
  { id: "progress", label: "安全处理" },
] as const;

test("labels the wizard, exposes its steps and traps keyboard focus", async () => {
  const user = userEvent.setup();
  render(
    <DataTransferDialog
      open
      steps={STEPS}
      currentStep="password"
      cancellable={false}
      onClose={vi.fn()}
    >
      <button type="button">继续</button>
    </DataTransferDialog>,
  );

  const dialog = screen.getByRole("dialog", { name: "完整数据迁移" });
  expect(dialog.classList.contains("standard-dialog--xl")).toBe(true);
  expect(dialog.parentElement?.classList.contains("standard-dialog-overlay")).toBe(true);
  expect(screen.getByRole("navigation", { name: "迁移步骤" })).toBeTruthy();
  expect(screen.getByText("设置密码").closest("li")?.getAttribute("aria-current")).toBe("step");
  const close = screen.getByRole("button", { name: "关闭完整数据迁移" });
  await waitFor(() => expect(document.activeElement).toBe(close));
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "继续" }));
});

test("routes Escape to cancellation while an operation remains cancellable", async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  const onClose = vi.fn();
  render(
    <DataTransferDialog
      open
      steps={STEPS}
      currentStep="progress"
      cancellable
      onCancel={onCancel}
      onClose={onClose}
    >
      <p>正在处理</p>
    </DataTransferDialog>,
  );

  await user.keyboard("{Escape}");
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "取消迁移" })).toBeTruthy();
});

test("has no close affordance and ignores Escape during an irreversible commit", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onCancel = vi.fn();
  render(
    <DataTransferDialog
      open
      steps={STEPS}
      currentStep="progress"
      cancellable={false}
      locked
      onClose={onClose}
      onCancel={onCancel}
    >
      <p>正在安全切换并重新启动</p>
    </DataTransferDialog>,
  );

  expect(screen.queryByRole("button", { name: /关闭|取消/u })).toBeNull();
  await user.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "完整数据迁移" })).toBeTruthy();
});

test("renders nothing while closed", () => {
  render(
    <DataTransferDialog
      open={false}
      steps={STEPS}
      currentStep="summary"
      cancellable={false}
      onClose={vi.fn()}
    >
      hidden
    </DataTransferDialog>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("marks steps as completed, current and upcoming without making them clickable", () => {
  const { container } = render(
    <DataTransferDialog
      open
      steps={STEPS}
      currentStep="password"
      cancellable={false}
      onClose={vi.fn()}
    >
      <p>内容</p>
    </DataTransferDialog>,
  );

  const items = container.querySelectorAll("nav li");
  expect(items).toHaveLength(3);
  expect(items[0]?.getAttribute("data-state")).toBe("completed");
  expect(items[0]?.getAttribute("aria-current")).toBeNull();
  expect(items[1]?.getAttribute("data-state")).toBe("current");
  expect(items[1]?.getAttribute("aria-current")).toBe("step");
  expect(items[2]?.getAttribute("data-state")).toBe("upcoming");
  expect(container.querySelector("nav button")).toBeNull();
});

test("moves focus to the new step title when the step changes", () => {
  const { rerender } = render(
    <DataTransferDialog
      open
      steps={STEPS}
      currentStep="summary"
      cancellable={false}
      onClose={vi.fn()}
    >
      <DataTransferStepPage key="summary" title="确认数据">
        <p>a</p>
      </DataTransferStepPage>
    </DataTransferDialog>,
  );
  rerender(
    <DataTransferDialog
      open
      steps={STEPS}
      currentStep="password"
      cancellable={false}
      onClose={vi.fn()}
    >
      <DataTransferStepPage key="password" title="设置密码">
        <p>b</p>
      </DataTransferStepPage>
    </DataTransferDialog>,
  );
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "设置密码" }));
});
