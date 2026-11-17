import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { MotionPresence } from "../app/motion-presence";
import { StandardDialog, type StandardDialogSize } from "./standard-dialog";

test("uses a centered vector close icon without changing its accessible name or action", () => {
  const onCancel = vi.fn();
  render(
    <StandardDialog open title="导入实验数据" onCancel={onCancel}>
      说明
    </StandardDialog>,
  );
  const close = screen.getByRole("button", { name: "关闭导入实验数据" });
  expect(close.classList.contains("dialog-close-control")).toBe(true);
  expect(close.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(close.textContent).toBe("");
  fireEvent.click(close);
  expect(onCancel).toHaveBeenCalledOnce();
});

test("can cancel an editing gesture with Escape while the close button still closes the dialog", () => {
  const onCancel = vi.fn(),
    onEscape = vi.fn();
  const view = render(
    <StandardDialog open title="编辑手势" onCancel={onCancel} onEscape={onEscape}>
      工作区
    </StandardDialog>,
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onEscape).toHaveBeenCalledOnce();
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭编辑手势" }));
  expect(onCancel).toHaveBeenCalledOnce();
  view.rerender(
    <StandardDialog open title="编辑手势" closeDisabled onCancel={onCancel} onEscape={onEscape}>
      工作区
    </StandardDialog>,
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onEscape).toHaveBeenCalledOnce();
});

function DialogHarness({
  size = "m",
  closeDisabled = false,
}: {
  size?: StandardDialogSize;
  closeDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开标准弹窗
      </button>
      <StandardDialog
        open={open}
        title="测试任务"
        subtitle="任务说明"
        size={size}
        onCancel={() => setOpen(false)}
        closeDisabled={closeDisabled}
        initialFocusRef={inputRef}
        footer={
          <>
            <button type="button" onClick={() => setOpen(false)}>
              取消
            </button>
            <button type="button">保存</button>
          </>
        }
      >
        <label>
          名称
          <input ref={inputRef} />
        </label>
      </StandardDialog>
    </>
  );
}

test.each<StandardDialogSize>(["s", "m", "l", "xl"])(
  "renders the %s size with labelled header, scrolling body, and fixed footer",
  async (size) => {
    const user = userEvent.setup();
    render(<DialogHarness size={size} />);
    await user.click(screen.getByRole("button", { name: "打开标准弹窗" }));

    const dialog = screen.getByRole("dialog", { name: "测试任务" });
    expect(dialog.classList.contains(`standard-dialog--${size}`)).toBe(true);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("任务说明")).toBeDefined();
    expect(dialog.querySelector(".standard-dialog__body")).not.toBeNull();
    expect(dialog.querySelector(".standard-dialog__footer")).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox")));
  },
);

test("keeps the dialog open when the overlay is clicked and closes through one cancel path", async () => {
  const user = userEvent.setup();
  render(<DialogHarness />);
  const trigger = screen.getByRole("button", { name: "打开标准弹窗" });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "测试任务" });
  const overlay = dialog.parentElement;
  expect(overlay?.classList.contains("standard-dialog-overlay")).toBe(true);

  if (overlay) await user.click(overlay);
  expect(screen.getByRole("dialog", { name: "测试任务" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "关闭测试任务" }));
  expect(screen.queryByRole("dialog", { name: "测试任务" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("disables both close button and Escape while close is protected", async () => {
  const user = userEvent.setup();
  render(<DialogHarness closeDisabled />);
  await user.click(screen.getByRole("button", { name: "打开标准弹窗" }));

  expect(screen.getByRole("button", { name: "关闭测试任务" }).hasAttribute("disabled")).toBe(true);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "测试任务" })).toBeDefined();
});

test("can omit the close control for irreversible work", () => {
  render(
    <StandardDialog open title="不可关闭" showClose={false} onCancel={vi.fn()}>
      <p>正在安全切换数据</p>
    </StandardDialog>,
  );

  expect(screen.queryByRole("button", { name: "关闭不可关闭" })).toBeNull();
});

test("supports an explicitly movable modal without changing modal semantics", () => {
  window.localStorage.clear();
  render(
    <StandardDialog open title="可移动模态" movable onCancel={() => undefined}>
      内容
    </StandardDialog>,
  );

  const dialog = screen.getByRole("dialog", { name: "可移动模态" });
  const header = dialog.querySelector(".standard-dialog__header");
  expect(dialog.classList.contains("standard-dialog--movable")).toBe(true);
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(header).not.toBeNull();
  if (!header) return;
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
    x: 40,
    y: 50,
    left: 40,
    top: 50,
    right: 600,
    bottom: 350,
    width: 560,
    height: 300,
    toJSON: () => undefined,
  });
  fireEvent.pointerDown(header, { button: 0, clientX: 60, clientY: 70, pointerId: 5 });
  fireEvent.pointerMove(window, { buttons: 1, clientX: 100, clientY: 110, pointerId: 5 });
  fireEvent.pointerUp(window, { clientX: 100, clientY: 110, pointerId: 5 });
  expect(dialog.style.left).toBe("80px");
  expect(dialog.style.top).toBe("90px");
});

test.each([
  ["e", 620, 400, 100, 100],
  ["w", 580, 400, 120, 100],
  ["s", 600, 430, 100, 100],
  ["n", 600, 370, 100, 130],
])("resizes edge %s on only its own axis", (edge, width, height, left, top) => {
  window.localStorage.clear();
  render(
    <StandardDialog open title="边缘拉伸" movable resizable onCancel={vi.fn()}>
      内容
    </StandardDialog>,
  );
  const dialog = screen.getByRole("dialog", { name: "边缘拉伸" });
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 100,
    left: 100,
    top: 100,
    right: 700,
    bottom: 500,
    width: 600,
    height: 400,
    toJSON: () => undefined,
  });
  const handle = dialog.querySelector(`.dialog-resize--${edge}`) as HTMLButtonElement;
  handle.setPointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { button: 0, clientX: 200, clientY: 200, pointerId: 1 });
  fireEvent.pointerMove(handle, { buttons: 1, clientX: 220, clientY: 230, pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(dialog.style.width).toBe(`${width}px`);
  expect(dialog.style.height).toBe(`${height}px`);
  expect(dialog.style.left).toBe(`${left}px`);
  expect(dialog.style.top).toBe(`${top}px`);
  expect(dialog.querySelectorAll(".dialog-resize")).toHaveLength(8);
});

test("omits an empty footer region", async () => {
  const user = userEvent.setup();
  render(
    <>
      <button type="button">触发按钮</button>
      <StandardDialog open title="纯信息" size="s" onCancel={() => undefined}>
        内容
      </StandardDialog>
    </>,
  );

  expect(
    screen.getByRole("dialog", { name: "纯信息" }).querySelector(".standard-dialog__footer"),
  ).toBeNull();
  await user.keyboard("{Escape}");
});

test("accepts scoped dialog and body classes while exposing the container ref", () => {
  const externalRef = { current: null as HTMLDivElement | null };
  const extensions = {
    className: "snapshot-preview-shell",
    bodyClassName: "snapshot-preview-body",
    dialogRef: externalRef,
  };
  render(
    <StandardDialog open title="扩展外壳" size="l" onCancel={() => undefined} {...extensions}>
      内容
    </StandardDialog>,
  );

  const dialog = screen.getByRole("dialog", { name: "扩展外壳" });
  expect(dialog.classList.contains("snapshot-preview-shell")).toBe(true);
  expect(
    dialog.querySelector(".standard-dialog__body")?.classList.contains("snapshot-preview-body"),
  ).toBe(true);
  expect(externalRef.current).toBe(dialog);
});

test("lifts a modal out of a z-indexed pane so the neighbouring pane cannot paint over it", () => {
  const view = render(
    <div className="embedded-drawing-pane" style={{ position: "absolute", zIndex: 1 }}>
      <StandardDialog open title="成图预览" portal onCancel={() => undefined}>
        预览内容
      </StandardDialog>
    </div>,
  );

  const overlay = screen.getByRole("dialog", { name: "成图预览" }).parentElement;
  expect(overlay?.classList.contains("standard-dialog-overlay")).toBe(true);
  // 任何 z-index 都无法穿透祖先的层叠上下文，所以遮罩必须直接挂到 body 上。
  expect(overlay?.parentElement).toBe(document.body);
  expect(view.container.querySelector(".standard-dialog-overlay")).toBeNull();
});

test("parent presence closes a portal dialog and releases its modal listener immediately", () => {
  vi.useFakeTimers();
  const onCancel = vi.fn();
  try {
    const child = (
      <StandardDialog open portal title="Portal退出" onCancel={onCancel}>
        内容
      </StandardDialog>
    );
    const view = render(<MotionPresence>{child}</MotionPresence>);
    const dialog = screen.getByRole("dialog", { name: "Portal退出" });
    view.rerender(<MotionPresence>{null}</MotionPresence>);
    expect(dialog.parentElement?.getAttribute("data-motion")).toBe("exit");
    expect(dialog.parentElement?.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(400));
    expect(dialog.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(20));
    expect(dialog.isConnected).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
