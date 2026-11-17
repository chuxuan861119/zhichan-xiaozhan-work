import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ColorPicker } from "./color-picker";

test("highlight uses the same split behavior and remembers the last color after removing highlight", () => {
  const onSelect = vi.fn();
  render(<ColorPicker kind="highlight" onSelect={onSelect} />);
  const apply = screen.getByRole("button", { name: "应用文本突出显示颜色" });
  const dropdown = screen.getByRole("button", { name: "打开文本突出显示颜色菜单" });
  fireEvent.click(apply);
  expect(onSelect).toHaveBeenLastCalledWith("#FFFF00");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(dropdown);
  fireEvent.click(screen.getByRole("button", { name: "突出显示色 #FFE699" }));
  fireEvent.click(dropdown);
  fireEvent.click(screen.getByRole("button", { name: "无高亮" }));
  expect(onSelect).toHaveBeenLastCalledWith(null);
  fireEvent.click(apply);
  expect(onSelect).toHaveBeenLastCalledWith("#FFE699");
  fireEvent.click(dropdown);
  fireEvent.click(screen.getByRole("button", { name: "其他突出显示颜色" }));
  fireEvent.change(screen.getByLabelText("HEX"), { target: { value: "#123abc" } });
  fireEvent.keyDown(screen.getByLabelText("HEX"), { key: "Enter" });
  expect(onSelect).toHaveBeenLastCalledWith("#123ABC", true, false);
});

test("applies the current color directly and uses a separate dropdown for choosing colors", () => {
  const onSelect = vi.fn();
  render(<ColorPicker value="#C00000" onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "应用文字颜色" }));
  expect(onSelect).toHaveBeenLastCalledWith("#C00000");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开文字颜色菜单" }));
  fireEvent.click(screen.getByRole("button", { name: "标准色 #0070C0" }));
  fireEvent.click(screen.getByRole("button", { name: "应用文字颜色" }));
  expect(onSelect).toHaveBeenLastCalledWith("#0070C0");
});

test("uses the toolbar swatches and closes after applying standard or custom colors", () => {
  const onSelect = vi.fn();
  render(<ColorPicker value="#000000" onSelect={onSelect} />);
  const trigger = screen.getByRole("button", { name: "打开文字颜色菜单" });
  expect(screen.queryByLabelText("其他颜色")).toBeNull();
  fireEvent.click(trigger);
  const palette = screen.getByRole("dialog", { name: "文字颜色" });
  expect(within(palette).getAllByRole("button")).toHaveLength(66);
  fireEvent.click(within(palette).getByRole("button", { name: "主题色 深蓝" }));
  expect(onSelect).toHaveBeenLastCalledWith("#17365D");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "其他颜色" }));
  fireEvent.change(screen.getByLabelText("HEX"), { target: { value: "#123456" } });
  fireEvent.keyDown(screen.getByLabelText("HEX"), { key: "Enter" });
  expect(onSelect).toHaveBeenLastCalledWith("#123456", true, false);
  expect(screen.getByRole("dialog", { name: "其他颜色" })).toBeDefined();
});

test("closes with Escape or an outside click without changing the color", () => {
  const onSelect = vi.fn();
  render(<ColorPicker value="#000000" onSelect={onSelect} />);
  const trigger = screen.getByRole("button", { name: "打开文字颜色菜单" });
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
});

test("read-only controls cannot open the palette", () => {
  render(<ColorPicker value="#000000" disabled onSelect={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "打开文字颜色菜单" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("custom popup applies continuously and stays open after hue changes", () => {
  const onSelect = vi.fn();
  render(<ColorPicker value="#FF0000" onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "打开文字颜色菜单" }));
  fireEvent.click(screen.getByRole("button", { name: "其他颜色" }));
  const popup = screen.getByRole("dialog", { name: "其他颜色" });
  expect(within(popup).queryByRole("button", { name: "确定" })).toBeNull();
  expect(within(popup).queryByRole("button", { name: "取消" })).toBeNull();
  const hue = within(popup).getByLabelText("色相");
  fireEvent.change(hue, { target: { value: "120" } });
  expect(onSelect).toHaveBeenCalledWith("#00FF00", true, false);
  expect((within(popup).getByLabelText("HEX") as HTMLInputElement).value).toBe("#00FF00");
  fireEvent.pointerUp(hue);
  expect(onSelect).toHaveBeenCalledWith("#00FF00", true, false);
  expect(screen.getByRole("dialog", { name: "其他颜色" })).toBeDefined();
  fireEvent.change(hue, { target: { value: "240" } });
  expect(onSelect).toHaveBeenLastCalledWith("#0000FF", true, false);
});

test.each(["Escape", "outside"])(
  "custom popup closes on %s without applying incomplete edits",
  (action) => {
    const onSelect = vi.fn();
    render(<ColorPicker value="#123456" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "打开文字颜色菜单" }));
    fireEvent.click(screen.getByRole("button", { name: "其他颜色" }));
    const input = screen.getByLabelText("HEX");
    fireEvent.change(input, { target: { value: "#bad" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
    else fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "其他颜色" })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  },
);

test.each(["sample", "cancel"])(
  "screen picker %s respects direct apply and cancellation",
  async (result) => {
    const onSelect = vi.fn();
    const open = vi
      .fn()
      .mockImplementation(() =>
        result === "sample"
          ? Promise.resolve({ sRGBHex: "#abcdef" })
          : Promise.reject(new DOMException("Cancelled", "AbortError")),
      );
    vi.stubGlobal(
      "EyeDropper",
      class {
        open = open;
      },
    );
    try {
      render(<ColorPicker value="#123456" onSelect={onSelect} />);
      fireEvent.click(screen.getByRole("button", { name: "打开文字颜色菜单" }));
      fireEvent.click(screen.getByRole("button", { name: "其他颜色" }));
      fireEvent.click(screen.getByRole("button", { name: "屏幕取色" }));
      if (result === "sample") {
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith("#ABCDEF", true, false));
        expect(screen.getByRole("dialog", { name: "其他颜色" })).toBeDefined();
      } else {
        await waitFor(() =>
          expect(
            (screen.getByRole("button", { name: "屏幕取色" }) as HTMLButtonElement).disabled,
          ).toBe(false),
        );
        expect(onSelect).not.toHaveBeenCalled();
        expect(screen.queryByRole("alert")).toBeNull();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

test("first custom application works even when its value matches the default", () => {
  const onSelect = vi.fn();
  render(<ColorPicker kind="highlight" onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "打开文本突出显示颜色菜单" }));
  fireEvent.click(screen.getByRole("button", { name: "其他突出显示颜色" }));
  const input = screen.getByLabelText("HEX");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSelect).toHaveBeenCalledWith("#FFFF00", true, false);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog", { name: "其他突出显示颜色" })).toBeDefined();
});
