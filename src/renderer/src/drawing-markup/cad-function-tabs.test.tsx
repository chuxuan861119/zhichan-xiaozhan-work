import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CadFunctionTabs } from "./cad-function-tabs";

const storageKey = "patent-workbench:cad-function-rail:tab:v1";
beforeEach(() => localStorage.removeItem(storageKey));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete document.documentElement.dataset.reducedMotion;
});
function open(cadAvailable = true) {
  return render(
    <CadFunctionTabs
      cadAvailable={cadAvailable}
      tools={<input aria-label="未完成的绘图参数" defaultValue="草稿" />}
      referenceMarks={<p>附图标记列表</p>}
    />,
  );
}
test("CAD tools are the first-use default and switching preserves mounted drafts", () => {
  open();
  const tools = screen.getByRole("tab", { name: "CAD工具" });
  expect(tools.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel", { name: "CAD工具" }).getAttribute("data-tool-tooltip")).toBe(
    "off",
  );
  const input = screen.getByRole("textbox", { name: "未完成的绘图参数" });
  fireEvent.change(input, { target: { value: "保留草稿" } });
  fireEvent.click(screen.getByRole("tab", { name: "附图标记" }));
  expect(screen.queryByRole("textbox", { name: "未完成的绘图参数" })).toBeNull();
  expect(screen.getByRole("tabpanel", { name: "附图标记" }).textContent).toBe("附图标记列表");
  fireEvent.click(tools);
  expect(screen.getByRole("textbox", { name: "未完成的绘图参数" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("保留草稿");
});

test("switching retains only inert outgoing paint and rapid reversal preserves the live draft", () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const animate = vi.fn().mockReturnValue({ cancel });
  const original = HTMLElement.prototype.animate;
  HTMLElement.prototype.animate = animate;
  try {
    open();
    const outgoing = screen.getByRole("tabpanel", { name: "CAD工具" });
    const draft = screen.getByRole("textbox", { name: "未完成的绘图参数" });
    fireEvent.change(draft, { target: { value: "正在编辑" } });
    fireEvent.click(screen.getByRole("tab", { name: "附图标记" }));
    expect(outgoing.hidden).toBe(false);
    expect(outgoing.getAttribute("aria-hidden")).toBe("true");
    expect(outgoing.hasAttribute("inert")).toBe(true);
    expect(animate).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({
        duration: 600,
        easing: "ease-in-out",
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "CAD工具" }));
    expect(screen.getByRole("textbox", { name: "未完成的绘图参数" })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("正在编辑");
    expect(cancel).toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(650));
    expect(outgoing.hidden).toBe(false);
    const marksId = screen.getByRole("tab", { name: "附图标记" }).getAttribute("aria-controls")!;
    expect(document.getElementById(marksId)?.hidden).toBe(true);
  } finally {
    HTMLElement.prototype.animate = original;
  }
});

test("reduced motion switches immediately without leaving an outgoing interactive panel", () => {
  document.documentElement.dataset.reducedMotion = "true";
  open();
  const outgoing = screen.getByRole("tabpanel", { name: "CAD工具" });
  fireEvent.click(screen.getByRole("tab", { name: "附图标记" }));
  expect(outgoing.hidden).toBe(true);
  expect(outgoing.hasAttribute("inert")).toBe(true);
  expect(screen.getByRole("tabpanel", { name: "附图标记" })).toBeTruthy();
});
test("the last explicit tab is remembered after reopening including keyboard selection", () => {
  const view = open();
  fireEvent.click(screen.getByRole("tab", { name: "附图标记" }));
  expect(localStorage.getItem(storageKey)).toBe("marks");
  view.unmount();
  open();
  expect(screen.getByRole("tab", { name: "附图标记" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "附图标记" }), { key: "Home" });
  expect(screen.getByRole("tab", { name: "CAD工具" }).getAttribute("aria-selected")).toBe("true");
  expect(localStorage.getItem(storageKey)).toBe("tools");
});
test("invalid preferences fall back to CAD tools and raster drawings keep their reference list", () => {
  localStorage.setItem(storageKey, "unknown");
  const view = open();
  expect(screen.getByRole("tab", { name: "CAD工具" }).getAttribute("aria-selected")).toBe("true");
  view.unmount();
  open(false);
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.getByText("附图标记列表")).toBeTruthy();
  expect(localStorage.getItem(storageKey)).toBe("unknown");
});

test("image tools reuse the function rail without presenting CAD commands", () => {
  render(<CadFunctionTabs cadAvailable toolsLabel="图片工具"
    tools={<button type="button">局部放大</button>} referenceMarks={<p>附图标记列表</p>} />);
  expect(screen.getByRole("tab", { name: "图片工具" })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "CAD工具" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "附图标记" }));
  expect(screen.getByText("附图标记列表")).toBeTruthy();
});

test("a detail activation reveals CAD tools without overriding later manual tab choices", () => {
  localStorage.setItem(storageKey, "marks");
  const props = {
    cadAvailable: true,
    tools: <p>局部放大参数</p>,
    referenceMarks: <p>附图标记列表</p>,
  };
  const view = render(<CadFunctionTabs {...props} requestTools={false} />);
  expect(screen.getByRole("tab", { name: "附图标记" }).getAttribute("aria-selected")).toBe("true");
  view.rerender(<CadFunctionTabs {...props} requestTools />);
  expect(screen.getByRole("tab", { name: "CAD工具" }).getAttribute("aria-selected")).toBe("true");
  expect(localStorage.getItem(storageKey)).toBe("tools");
  fireEvent.click(screen.getByRole("tab", { name: "附图标记" }));
  view.rerender(<CadFunctionTabs {...props} requestTools />);
  expect(screen.getByRole("tab", { name: "附图标记" }).getAttribute("aria-selected")).toBe("true");
});

test("a new detail activation reveals tools even when an existing detail already requests them", () => {
  const props = {
    cadAvailable: true,
    tools: <p>局部放大参数</p>,
    referenceMarks: <p>附图标记列表</p>,
    requestTools: true,
  };
  const view = render(<CadFunctionTabs {...props} requestKey="existing-detail" />);
  fireEvent.click(screen.getByRole("tab", { name: "附图标记" }));
  view.rerender(<CadFunctionTabs {...props} requestKey={1} />);
  expect(screen.getByRole("tab", { name: "CAD工具" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "附图标记" }));
  view.rerender(<CadFunctionTabs {...props} requestKey={1} />);
  expect(screen.getByRole("tab", { name: "附图标记" }).getAttribute("aria-selected")).toBe("true");
});
