import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InsertTablePopover } from "./insert-table-popover";

describe("insert table popover", () => {
  test("submits the hovered grid size with the selected header-row option", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<InsertTablePopover open onClose={vi.fn()} onConfirm={onConfirm} />);

    await user.click(screen.getByRole("checkbox", { name: "将首行设为标题行" }));
    const gridCell = screen.getByRole("button", { name: "插入 4 行 6 列表格" });
    fireEvent.mouseEnter(gridCell);
    expect(screen.getByText("4 行 × 6 列")).toBeDefined();
    await user.click(gridCell);

    expect(onConfirm).toHaveBeenCalledWith({
      rows: 4,
      columns: 6,
      headerRowCount: 1,
      layoutMode: "fit-page",
    });
  });

  test("validates custom dimensions before submitting", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<InsertTablePopover open onClose={vi.fn()} onConfirm={onConfirm} />);

    fireEvent.change(screen.getByRole("spinbutton", { name: "行数" }), {
      target: { value: "101" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "列数" }), {
      target: { value: "31" },
    });
    await user.click(screen.getByRole("button", { name: "插入自定义表格" }));
    expect(screen.getByRole("alert").textContent).toContain("行数应为 1–100，列数应为 1–30");
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("spinbutton", { name: "行数" }), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "列数" }), {
      target: { value: "5" },
    });
    await user.click(screen.getByRole("button", { name: "插入自定义表格" }));
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 12,
      columns: 5,
      headerRowCount: 0,
      layoutMode: "fit-page",
    });
  });

  test("closes on Escape and outside pointer input", () => {
    const onClose = vi.fn();
    const { rerender } = render(<InsertTablePopover open onClose={onClose} onConfirm={vi.fn()} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    onClose.mockClear();
    rerender(<InsertTablePopover open onClose={onClose} onConfirm={vi.fn()} />);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
