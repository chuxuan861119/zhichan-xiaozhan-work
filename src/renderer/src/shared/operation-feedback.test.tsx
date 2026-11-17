import { act, fireEvent, render, screen } from "@testing-library/react";
import { OperationFeedbackOverlay } from "./operation-feedback";

describe("operation feedback overlay", () => {
  test("shows a success status and dismisses it automatically", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <OperationFeedbackOverlay
        feedback={{ tone: "success", title: "填入成功" }}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("填入成功");
    expect(screen.getByRole("status").className).toContain("is-success");
    act(() => vi.advanceTimersByTime(1500));
    expect(onClose).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  test("keeps a red failure dialog open until the user acknowledges it", () => {
    const onClose = vi.fn();
    render(
      <OperationFeedbackOverlay
        feedback={{ tone: "error", title: "无法填入", message: "说明书中缺少“附图说明”标题。" }}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.className).toContain("is-error");
    expect(dialog.textContent).toContain("说明书中缺少“附图说明”标题。");
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
