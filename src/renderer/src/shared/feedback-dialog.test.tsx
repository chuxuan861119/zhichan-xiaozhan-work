import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeedbackDialog } from "./feedback-dialog";

test("shows the contact channels as selectable plain text", () => {
  render(<FeedbackDialog onClose={() => undefined} />);

  const dialog = screen.getByRole("dialog", { name: "建议与反馈" });
  expect(dialog.getAttribute("aria-modal")).toBe("false");
  expect(screen.getByText(/我们会认真阅读每一条反馈，尽力把软件做得更好用/)).toBeDefined();
  expect(screen.getByText("yyqc861@163.com")).toBeDefined();
  expect(screen.getByText("huxiulong777")).toBeDefined();
  expect(screen.getByText("1126433961")).toBeDefined();

  expect(screen.queryByText("861936697")).toBeNull();
  expect(screen.getByText("QQ群")).toBeDefined();
  expect(screen.getByRole("img", { name: "QQ群 1126433961 加群二维码" })).toBeDefined();

  // 只有纯文本联系方式，不出现输入框或任何可编辑控件。
  expect(screen.queryByRole("textbox")).toBeNull();
  for (const value of ["yyqc861@163.com", "huxiulong777", "1126433961"]) {
    expect(screen.getByText(value).classList.contains("feedback-dialog__channel-value")).toBe(true);
  }
});

test("copies a contact value when its text is clicked", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

  render(<FeedbackDialog onClose={() => undefined} />);
  await user.click(screen.getByText("1126433961"));

  expect(writeText).toHaveBeenCalledWith("1126433961");
  expect(screen.getByText("已复制")).toBeDefined();
  vi.unstubAllGlobals();
});

test("closes via the close button and Escape", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const { unmount } = render(<FeedbackDialog onClose={onClose} />);

  await user.click(screen.getByRole("button", { name: "关闭建议与反馈窗口" }));
  expect(onClose).toHaveBeenCalledOnce();

  unmount();
  const onCloseAgain = vi.fn();
  render(<FeedbackDialog onClose={onCloseAgain} />);
  const closeButtonAgain = screen.getByRole("button", { name: "关闭建议与反馈窗口" });
  closeButtonAgain.focus();
  fireEvent.keyDown(closeButtonAgain, { key: "Escape" });
  expect(onCloseAgain).toHaveBeenCalledOnce();
});

test("moves with header dragging but never leaves the viewport", () => {
  render(<FeedbackDialog onClose={() => undefined} />);
  const dialog = screen.getByRole("dialog", { name: "建议与反馈" });
  // jsdom 不计算布局，getBoundingClientRect 返回 0， clamp 后坐标仍应保持在安全边界内。
  const header = dialog.querySelector(".feedback-dialog__header") as HTMLElement;

  fireEvent.pointerDown(header, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 5000, clientY: 5000 });
  fireEvent.pointerUp(window, { pointerId: 1 });

  const left = Number.parseFloat(dialog.style.left);
  const top = Number.parseFloat(dialog.style.top);
  expect(Number.isFinite(left)).toBe(true);
  expect(Number.isFinite(top)).toBe(true);
  expect(top).toBeGreaterThanOrEqual(0);
});

test("clicking the close button inside the header does not start a drag", () => {
  render(<FeedbackDialog onClose={() => undefined} />);
  const dialog = screen.getByRole("dialog", { name: "建议与反馈" });
  const closeButton = screen.getByRole("button", { name: "关闭建议与反馈窗口" });
  const beforeLeft = dialog.style.left;

  fireEvent.pointerDown(closeButton, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 300 });
  fireEvent.pointerUp(window, { pointerId: 1 });

  expect(dialog.style.left).toBe(beforeLeft);
});

test("keeps Escape in the document from closing the non-modal dialog", () => {
  const onClose = vi.fn();
  render(<FeedbackDialog onClose={onClose} />);
  const dialog = screen.getByRole("dialog", { name: "建议与反馈" });
  const closeButton = screen.getByRole("button", { name: "关闭建议与反馈窗口" });

  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.keyDown(closeButton, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  expect(dialog).toBeDefined();
});

test("reclamps its position when the viewport is resized", () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  try {
    render(<FeedbackDialog onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog", { name: "建议与反馈" });
    const panel = dialog as HTMLDivElement;
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      width: 340,
      height: 200,
      left: Number.parseFloat(panel.style.left) || 0,
      top: Number.parseFloat(panel.style.top) || 0,
      right: 340,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    });
    const header = dialog.querySelector(".feedback-dialog__header") as HTMLElement;
    fireEvent.pointerDown(header, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700, clientY: 500 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(Number.parseFloat(panel.style.left)).toBe(452);
    expect(Number.parseFloat(panel.style.top)).toBe(392);

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    fireEvent(window, new Event("resize"));
    expect(Number.parseFloat(panel.style.left)).toBe(152);
    expect(Number.parseFloat(panel.style.top)).toBe(92);
  } finally {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  }
});
