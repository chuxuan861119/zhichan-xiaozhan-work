import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { useModalDialog } from "./use-modal-dialog";

function Harness({ escapeEnabled = true }: { escapeEnabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const modalOptions = {
    open,
    onClose: () => setOpen(false),
    containerRef: dialogRef,
    initialFocusRef: firstRef,
    escapeEnabled,
  };
  useModalDialog(modalOptions);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      {open ? (
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="测试弹窗">
          <button ref={firstRef} type="button">
            第一个
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            关闭
          </button>
          <button type="button">最后一个</button>
        </div>
      ) : null}
      <button type="button">弹窗外按钮</button>
    </>
  );
}

test("modal dialog focuses inside, traps Tab, closes with Escape and restores focus", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "打开" });
  await user.click(trigger);

  const first = await screen.findByRole("button", { name: "第一个" });
  await waitFor(() => expect(document.activeElement).toBe(first));
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "最后一个" }));
  const restoreFocus = vi.spyOn(trigger, "focus");
  await user.keyboard("{Escape}");

  expect(screen.queryByRole("dialog", { name: "测试弹窗" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(restoreFocus).toHaveBeenCalledWith({ preventScroll: true });
  restoreFocus.mockRestore();
});

test("returns ordinary Tab to the first control when focus is outside the modal", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "打开" }));
  const first = await screen.findByRole("button", { name: "第一个" });
  const outside = screen.getByRole("button", { name: "弹窗外按钮" });

  outside.focus();
  await user.tab();

  expect(document.activeElement).toBe(first);
});

test("keeps the topmost modal open on Escape when Escape closing is disabled", async () => {
  const user = userEvent.setup();
  render(<Harness escapeEnabled={false} />);
  const trigger = screen.getByRole("button", { name: "打开" });
  await user.click(trigger);
  const first = await screen.findByRole("button", { name: "第一个" });
  await waitFor(() => expect(document.activeElement).toBe(first));

  await user.keyboard("{Escape}");

  expect(screen.getByRole("dialog", { name: "测试弹窗" })).toBeDefined();
  const last = screen.getByRole("button", { name: "最后一个" });
  last.focus();
  await user.tab();
  expect(document.activeElement).toBe(first);

  const close = screen.getByRole("button", { name: "关闭" });
  await user.click(close);
  expect(screen.queryByRole("dialog", { name: "测试弹窗" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

function NestedHarness() {
  const [outerOpen, setOuterOpen] = useState(true);
  const [innerOpen, setInnerOpen] = useState(true);
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  useModalDialog({
    open: outerOpen,
    onClose: () => setOuterOpen(false),
    containerRef: outerRef,
  });
  useModalDialog({
    open: innerOpen,
    onClose: () => setInnerOpen(false),
    containerRef: innerRef,
  });
  return outerOpen ? (
    <div ref={outerRef} role="dialog" aria-modal="true" aria-label="外层弹窗">
      <button type="button">外层按钮</button>
      {innerOpen ? (
        <div ref={innerRef} role="dialog" aria-modal="true" aria-label="内层弹窗">
          <button type="button">内层按钮</button>
        </div>
      ) : null}
    </div>
  ) : null;
}

test("Escape closes only the topmost nested modal", async () => {
  const user = userEvent.setup();
  render(<NestedHarness />);
  await screen.findByRole("dialog", { name: "内层弹窗" });

  await user.keyboard("{Escape}");

  expect(screen.queryByRole("dialog", { name: "内层弹窗" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "外层弹窗" })).toBeDefined();
});

test("skips cached hidden pages when initializing and cycling modal focus", async () => {
  function CachedPages() {
    const ref = useRef<HTMLDivElement>(null);
    useModalDialog({ open: true, containerRef: ref, onClose: vi.fn() });
    return (
      <div ref={ref} role="dialog">
        <div hidden>
          <button type="button">隐藏开头</button>
        </div>
        <button type="button">可见开头</button>
        <button type="button">可见结尾</button>
        <div style={{ display: "none" }}>
          <button type="button">隐藏结尾</button>
        </div>
        <div inert>
          <button type="button">不可交互结尾</button>
        </div>
      </div>
    );
  }
  render(<CachedPages />);
  const first = screen.getByRole("button", { name: "可见开头" });
  const last = screen.getByRole("button", { name: "可见结尾" });
  await waitFor(() => expect(document.activeElement).toBe(first));
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
});

test("does not close a modal while Escape is cancelling IME composition", async () => {
  render(<NestedHarness />);
  fireEvent.keyDown(document, { key: "Escape", isComposing: true });
  expect(screen.getByRole("dialog", { name: "内层弹窗" })).toBeDefined();
});
