import { fireEvent, render, screen } from "@testing-library/react";
import { InsertTablePopover } from "../table/insert-table-popover";
import { AlignmentPicker } from "./alignment-picker";
import { ColorPicker } from "./color-picker";
import { toolbarDropdownPosition } from "./toolbar-dropdown-position";

function bounds(element: Element | null, left: number, top: number, width: number, height: number) {
  if (!element) throw new Error("Missing positioning target");
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON() {},
  });
}

test("aligns toolbar menus with its bottom and the button or component left edge", () => {
  const { container } = render(
    <div className="tool-bar">
      <div>
        <button type="button">触发</button>
      </div>
    </div>,
  );
  const toolbar = container.firstElementChild as HTMLElement;
  const component = toolbar.firstElementChild as HTMLElement;
  const trigger = component.firstElementChild as HTMLElement;
  bounds(toolbar, 12, 40, 800, 52);
  bounds(component, 120, 50, 45, 30);
  bounds(trigger, 149, 50, 16, 30);
  expect(toolbarDropdownPosition(trigger)).toEqual({ top: 92, left: 149 });
  expect(toolbarDropdownPosition(trigger, component)).toEqual({ top: 92, left: 120 });
});

test("leaves non-toolbar floating tools on their own positioning path", () => {
  render(
    <div className="editor-mini-row">
      <button type="button">触发</button>
    </div>,
  );
  expect(toolbarDropdownPosition(screen.getByRole("button", { name: "触发" }))).toBeNull();
});

test.each(["text", "highlight"] as const)("%s palette aligns with its split component", (kind) => {
  const { container } = render(
    <div className="tool-bar">
      <ColorPicker kind={kind} onSelect={vi.fn()} />
    </div>,
  );
  bounds(container.firstElementChild, 12, 40, 800, 52);
  bounds(container.querySelector(".color-picker"), 120, 50, 45, 30);
  const trigger = screen.getByRole("button", {
    name: kind === "text" ? "打开文字颜色菜单" : "打开文本突出显示颜色菜单",
  });
  bounds(trigger, 149, 50, 16, 30);
  fireEvent.click(trigger);
  const palette = screen.getByRole("dialog");
  expect(palette.style.top).toBe("92px");
  expect(palette.style.left).toBe("120px");
});

test("alignment menu uses the toolbar edge and its own button", () => {
  const { container } = render(
    <div className="tool-bar">
      <AlignmentPicker alignment="left" disabled={false} onCommand={vi.fn()} />
    </div>,
  );
  bounds(container.firstElementChild, 12, 40, 800, 52);
  const trigger = screen.getByRole("button", { name: "段落对齐" });
  bounds(trigger, 180, 50, 44, 30);
  fireEvent.click(trigger);
  const menu = screen.getByRole("menu", { name: "段落对齐方式" });
  expect(menu.style.top).toBe("92px");
  expect(menu.style.left).toBe("180px");
});

test("table insertion follows the toolbar trigger instead of the document page", () => {
  const anchor = document.createElement("button");
  const toolbar = document.createElement("div");
  toolbar.className = "tool-bar";
  toolbar.append(anchor);
  document.body.append(toolbar);
  bounds(toolbar, 12, 40, 800, 52);
  bounds(anchor, 230, 50, 32, 30);
  try {
    render(<InsertTablePopover open anchor={anchor} onClose={vi.fn()} onConfirm={vi.fn()} />);
    const panel = screen.getByRole("region", { name: "插入表格设置" });
    expect(panel.style.top).toBe("92px");
    expect(panel.style.left).toBe("230px");
  } finally {
    toolbar.remove();
  }
});

test("clamps measured toolbar popovers to both viewport edges", () => {
  const toolbar = document.createElement("div");
  toolbar.className = "tool-bar";
  const trigger = document.createElement("button");
  toolbar.append(trigger);
  bounds(toolbar, 0, 0, 1024, 40);
  bounds(trigger, window.innerWidth - 32, 0, 32, 40);
  expect(toolbarDropdownPosition(trigger, trigger, 260)?.left).toBe(window.innerWidth - 268);
  bounds(trigger, -20, 0, 32, 40);
  expect(toolbarDropdownPosition(trigger, trigger, 260)?.left).toBe(8);
});
