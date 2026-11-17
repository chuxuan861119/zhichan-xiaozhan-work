import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { confirmAppAction, promptAppText, showAppAlert } from "./app-dialog";

afterEach(async () => {
  while (screen.queryByRole("dialog")) {
    await userEvent.click(screen.getByRole("button", { name: /关闭/ }));
  }
});

test("cancel restores focus and the original inert state without a native dialog", async () => {
  const background = document.createElement("div");
  const input = document.createElement("input");
  background.append(input);
  document.body.append(background);
  input.focus();
  const native = vi.spyOn(window, "confirm");
  let result!: Promise<boolean>;
  act(() => {
    result = confirmAppAction("继续替换？");
  });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" })),
  );
  expect(background.inert).toBe(true);
  fireEvent.keyDown(screen.getByRole("button", { name: "取消" }), { key: "Escape" });
  expect(await result).toBe(false);
  expect(document.activeElement).toBe(input);
  expect(background.inert).not.toBe(true);
  expect(native).not.toHaveBeenCalled();
  native.mockRestore();
  background.remove();
});

test("confirm resolves once after removing the dialog and ignores concurrent actions", async () => {
  let result!: Promise<boolean>;
  act(() => {
    result = confirmAppAction("删除？");
  });
  expect(await confirmAppAction("删除？")).toBe(false);
  expect(await promptAppText("重命名", "旧名称")).toBeNull();
  const button = screen.getByRole("button", { name: "确定" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(await result).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("prompt accepts edited text with Enter and cancels without a value", async () => {
  let result!: Promise<string | null>;
  act(() => {
    result = promptAppText("文档名称", "原名称");
  });
  const input = screen.getByRole("textbox", { name: "文档名称" });
  await userEvent.clear(input);
  await userEvent.type(input, "新名称{Enter}");
  expect(await result).toBe("新名称");
  act(() => {
    result = promptAppText("文档名称", "原名称");
  });
  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(await result).toBeNull();
});

test("alerts are serialized and retain their complete messages", async () => {
  act(() => {
    showAppAlert("第一条\n详细说明");
    showAppAlert("第二条");
  });
  await screen.findByRole("dialog");
  expect(screen.getByRole("dialog").classList.contains("operation-feedback")).toBe(true);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("dialog").textContent).toContain("第一条\n详细说明");
  await userEvent.click(screen.getByRole("button", { name: "知道了" }));
  expect(screen.getByRole("dialog").textContent).toContain("第二条");
  await userEvent.click(screen.getByRole("button", { name: "知道了" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("confirmation releases interaction once while retaining its exit paint", async () => {
  vi.useFakeTimers();
  try {
    let result!: Promise<boolean>;
    act(() => {
      result = confirmAppAction("动画退出确认");
    });
    const host = screen.getByRole("dialog").closest(".app-dialog-host");
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await act(async () => {
      expect(await result).toBe(true);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(host?.querySelector(".motion-presence[inert]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(host?.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(20));
    expect(host?.isConnected).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
