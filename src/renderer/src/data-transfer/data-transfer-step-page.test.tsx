import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTransferStepPage, DataTransferWizardActions } from "./data-transfer-step-page";

test("associates the title, description, body and footer regions of a step page", () => {
  const { container } = render(
    <DataTransferStepPage
      title="选择保存位置"
      description="选择一个安全且空间充足的位置。"
      footer={<DataTransferWizardActions onNext={vi.fn()} />}
    >
      <p>保存位置内容</p>
    </DataTransferStepPage>,
  );

  const heading = screen.getByRole("heading", { name: "选择保存位置" });
  expect(container.querySelector("section")?.getAttribute("aria-labelledby")).toBe(heading.id);
  expect(screen.getByText("选择一个安全且空间充足的位置。")).toBeTruthy();
  expect(screen.getByText("保存位置内容")).toBeTruthy();
  expect(container.querySelector(".data-transfer-step-page__body")).toBeTruthy();
  expect(container.querySelector(".data-transfer-step-page__footer")).toBeTruthy();
});

test("renders navigation only as 上一步 and 下一步 and keeps a disabled next visible", async () => {
  const user = userEvent.setup();
  const onBack = vi.fn();
  const onNext = vi.fn();
  render(
    <DataTransferStepPage
      title="选择保存位置"
      footer={
        <DataTransferWizardActions
          onBack={onBack}
          onNext={onNext}
          nextDisabled
          nextDisabledReason="请先选择保存位置。"
          secondaryActions={<button type="button">浏览保存位置</button>}
        />
      }
    >
      <p>保存位置内容</p>
    </DataTransferStepPage>,
  );

  const back = screen.getByRole("button", { name: "上一步" });
  const next = screen.getByRole("button", { name: "下一步" }) as HTMLButtonElement;
  expect(back).toBeTruthy();
  expect(next.disabled).toBe(true);
  expect(screen.getByText("请先选择保存位置。")).toBeTruthy();
  expect(screen.queryByText(/下一步：|返回上一步/u)).toBeNull();
  expect(screen.queryByRole("button", { name: "选择保存位置" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "浏览保存位置" }));
  expect(onBack).not.toHaveBeenCalled();
  expect(onNext).not.toHaveBeenCalled();
});

test("supports a named business primary action instead of 下一步", async () => {
  const user = userEvent.setup();
  const onStart = vi.fn();
  render(
    <DataTransferStepPage
      title="设置迁移密码"
      footer={
        <DataTransferWizardActions
          onBack={vi.fn()}
          primaryAction={
            <button type="button" className="primary-button" onClick={onStart}>
              开始导出
            </button>
          }
        />
      }
    >
      <p>密码表单</p>
    </DataTransferStepPage>,
  );

  expect(screen.queryByRole("button", { name: "下一步" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "开始导出" }));
  expect(onStart).toHaveBeenCalledOnce();
});

test("focuses the new step title when a different step mounts", () => {
  const { rerender } = render(
    <DataTransferStepPage title="第一步" key="one">
      <p>a</p>
    </DataTransferStepPage>,
  );
  rerender(
    <DataTransferStepPage title="第二步" key="two">
      <p>b</p>
    </DataTransferStepPage>,
  );
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "第二步" }));
});
