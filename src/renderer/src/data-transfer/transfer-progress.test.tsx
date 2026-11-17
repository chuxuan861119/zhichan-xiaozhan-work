import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DataTransferProgress } from "../../../shared/data-transfer/model";
import { TransferProgress } from "./transfer-progress";

const OPERATION_ID = "00000000-0000-4000-8000-000000000926";

function createProgress(patch: Partial<DataTransferProgress> = {}): DataTransferProgress {
  return {
    operationId: OPERATION_ID,
    kind: "full-data-export",
    phase: "encrypting",
    completedBytes: 25,
    totalBytes: 100,
    currentCategory: "database",
    elapsedMs: 1_000,
    remainingMs: 3_000,
    cancellable: true,
    ...patch,
  };
}

test("shows a determinate percentage only for a positive known total", () => {
  render(<TransferProgress progress={createProgress()} />);
  expect(screen.getByRole<HTMLProgressElement>("progressbar").value).toBe(25);
  expect(screen.getByText("25%")).toBeTruthy();
  expect(screen.getByText("正在加密数据").getAttribute("aria-live")).toBe("polite");
  expect(screen.queryByText(OPERATION_ID)).toBeNull();
});

test("reports processed bytes and elapsed and remaining time without inventing totals", () => {
  render(<TransferProgress progress={createProgress()} />);
  expect(screen.getByText(/已处理 25 B \/ 100 B/u)).toBeTruthy();
  expect(screen.getByText(/预计剩余 3 秒/u)).toBeTruthy();
  expect(screen.getByText(/已用时 1 秒/u)).toBeTruthy();
});

test.each([null, 0] as const)("uses phase-only progress when total bytes are %s", (totalBytes) => {
  render(<TransferProgress progress={createProgress({ totalBytes })} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText(/%/u)).toBeNull();
  expect(screen.getByText("正在加密数据")).toBeTruthy();
});

test("uses a fixed alert for failure without exposing identifiers or raw phases", () => {
  render(<TransferProgress progress={createProgress({ phase: "failed", cancellable: false })} />);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("迁移未完成");
  expect(alert.textContent).not.toContain(OPERATION_ID);
  expect(alert.textContent).not.toContain("failed");
});

test("offers cancellation only while the authoritative progress allows it", async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  const { rerender } = render(<TransferProgress progress={createProgress()} onCancel={onCancel} />);
  await user.click(screen.getByRole("button", { name: "取消迁移" }));
  expect(onCancel).toHaveBeenCalledOnce();

  rerender(
    <TransferProgress
      progress={createProgress({ phase: "swapping", kind: "library-swap", cancellable: false })}
      onCancel={onCancel}
    />,
  );
  expect(screen.queryByRole("button", { name: "取消迁移" })).toBeNull();
  expect(screen.getByText("正在安全切换数据")).toBeTruthy();
});
