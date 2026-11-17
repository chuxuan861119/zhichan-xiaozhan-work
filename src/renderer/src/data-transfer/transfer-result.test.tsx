import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FullDataExportResult } from "../../../shared/data-transfer/model";
import { TransferResult } from "./transfer-result";

const RESULT: FullDataExportResult = {
  operationId: "00000000-0000-4000-8000-000000000927",
  displayPath: "移动磁盘\\完整数据.zxwbackup",
  sizeBytes: 786_432,
  cutoffAt: "2026-08-17T00:00:00.000Z",
  packageFormatVersion: 2,
  summary: {
    activePatents: 2,
    trashedPatents: 1,
    documents: 3,
    legacyDrafts: 1,
    snapshots: 4,
    assets: 5,
    flowchartProjects: 1,

    totalBytes: 1_572_864,
  },
  fullVerificationPassed: true,
};

test("presents the verified export details and password separation warning", () => {
  const { container } = render(<TransferResult outcome="success" result={RESULT} />);
  expect(screen.getByRole("heading", { name: "完整数据包已生成" })).toBeTruthy();
  expect(screen.getByText(RESULT.displayPath)).toBeTruthy();
  expect(screen.getByText(/768 KB/u)).toBeTruthy();
  expect(screen.getByText("格式版本 2")).toBeTruthy();
  expect(screen.getByText("完整性验证通过")).toBeTruthy();
  expect(screen.getByText(/数据包和密码分开保存/u)).toBeTruthy();
  expect(screen.getByText(/2026/u)).toBeTruthy();
  expect(container.querySelector(".data-transfer-result__details")).toBeTruthy();
  expect(container.querySelector(".data-transfer-result__summary")).toBeTruthy();
});

test("uses explicit safe cancellation language without a success claim", () => {
  render(<TransferResult outcome="cancelled" />);
  expect(screen.getByRole("heading", { name: "已取消导出" })).toBeTruthy();
  expect(screen.getByText(/原专利库未改变、未生成正式数据包/u)).toBeTruthy();
  expect(screen.queryByText("完整性验证通过")).toBeNull();
});

test("labels the retry action on cancellation and failure results", async () => {
  const user = userEvent.setup();
  const onRetry = vi.fn();
  const { rerender } = render(<TransferResult outcome="cancelled" onRetry={onRetry} />);
  await user.click(screen.getByRole("button", { name: "返回重试" }));
  expect(onRetry).toHaveBeenCalledOnce();

  rerender(
    <TransferResult
      outcome="failure"
      error={{
        code: "DESTINATION_UNAVAILABLE",
        message: "所选位置当前不可用。",
        nextAction: "请重新连接移动磁盘后重试。",
      }}
      onRetry={onRetry}
    />,
  );
  await user.click(screen.getByRole("button", { name: "返回重试" }));
  expect(onRetry).toHaveBeenCalledTimes(2);
});

test("renders failure as what happened, data safety and the next action", () => {
  render(
    <TransferResult
      outcome="failure"
      error={{
        code: "DESTINATION_UNAVAILABLE",
        message: "所选位置当前不可用。",
        nextAction: "请重新连接移动磁盘后重试。",
      }}
    />,
  );
  expect(screen.getByRole("heading", { name: "完整数据包未生成" })).toBeTruthy();
  expect(screen.getByText("所选位置当前不可用。")).toBeTruthy();
  expect(screen.getByText(/原专利库未改变、未生成正式数据包/u)).toBeTruthy();
  expect(screen.getByText("请重新连接移动磁盘后重试。")).toBeTruthy();
  expect(screen.queryByText("完整性验证通过")).toBeNull();
});
