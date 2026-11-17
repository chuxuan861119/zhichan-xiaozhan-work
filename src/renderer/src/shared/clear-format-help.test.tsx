import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { clearFormatHelpPosition } from "./clear-format-help";
import { setFloatingHelpDetailed } from "./floating-help";
import { ToolActionTooltips } from "./tool-action-tooltips";

beforeEach(() => {
  vi.useFakeTimers();
  setFloatingHelpDetailed(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
test("panel prefers left and stays below title bar within the viewport at edges", () => {
  expect(clearFormatHelpPosition(new DOMRect(1000, 200, 160, 40), 680, 530, 1440, 900)).toEqual({
    left: 302,
    top: 144,
  });
  expect(clearFormatHelpPosition(new DOMRect(20, 800, 160, 40), 680, 530, 1440, 900)).toEqual({
    left: 198,
    top: 362,
  });
  const compact = clearFormatHelpPosition(new DOMRect(50, 10, 100, 30), 360, 160, 400, 600);
  expect(compact).toEqual({ left: 32, top: 40 });
});
test("help shows current custom shortcut and restores title when unmounted", () => {
  const view = render(
    <>
      <ToolActionTooltips
        settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "clear-extra-formatting": "Alt+F6" }}
      />
      <div className="patent-global-function-rail-slot">
        <button type="button" className="patent-book-tools__clear-extra-formatting" title="Alt+F6">
          清除多余格式
        </button>
      </div>
    </>,
  );
  fireEvent.pointerMove(screen.getByRole("button"));
  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByRole("dialog").textContent).toContain("快捷键：Alt+F6");
  view.unmount();
  expect(screen.queryByRole("dialog")).toBeNull();
});
function setup() {
  const action = vi.fn();
  const view = render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot">
        <button
          type="button"
          className="patent-book-tools__clear-extra-formatting"
          title="旧提示"
          onClick={action}
        >
          清除多余格式
        </button>
      </div>
    </>,
  );
  const button = screen.getByRole("button", { name: "清除多余格式" });
  fireEvent.pointerMove(button);
  act(() => vi.advanceTimersByTime(600));
  return { button, action, view };
}
test.each([false, true])(
  "switch respects reduced motion %s and cancels interrupted transitions",
  (reduced) => {
    vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
    setup();
    fireEvent.pointerMove(screen.getByRole("button", { name: "清除多余格式" }));
    act(() => vi.advanceTimersByTime(600));
    const panel = screen.getByRole("dialog");
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel, onfinish: null }));
    Object.defineProperty(panel, "animate", { value: animate });
    fireEvent.click(screen.getByRole("switch"));
    if (reduced) {
      expect(animate).not.toHaveBeenCalled();
      return;
    }
    expect(animate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ width: expect.any(String), height: expect.any(String) }),
      ]),
      expect.objectContaining({ duration: 400, easing: "ease-in-out" }),
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(cancel).toHaveBeenCalled();
  },
);
test("clear formatting uses the approved detailed help instead of the old tooltip", () => {
  const { button } = setup();
  const panel = screen.getByRole("dialog", { name: "清除多余格式说明" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(panel.textContent).toContain("功能：一键将当前文档整理干净整洁");
  expect(panel.textContent).toContain("表格内仅清除文字颜色与高亮，其余样式和空白均保留。");
  expect(panel.querySelectorAll(".comparison img")).toHaveLength(2);
  expect(panel.textContent).toContain("快捷键：未设置");
  expect(panel.textContent).not.toContain("Ctrl+Z");
  expect(screen.getByRole("switch", { name: "详细介绍" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(button.hasAttribute("title")).toBe(false);
});
test("moving into the help keeps it readable; leaving closes and restores native title", () => {
  const { button } = setup();
  const panel = screen.getByRole("dialog");
  fireEvent.pointerOut(button, { relatedTarget: panel });
  fireEvent.pointerMove(panel);
  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByRole("dialog")).toBe(panel);
  fireEvent.pointerMove(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(button.title).toBe("旧提示");
});
test("toggle never executes cleanup, compact retains logo and preference across hovers", () => {
  const { button, action } = setup();
  const control = screen.getByRole("switch");
  fireEvent.pointerDown(control);
  fireEvent.click(control);
  const panel = screen.getByRole("dialog");
  expect(panel.className).toContain("compact-panel");
  expect(panel.querySelectorAll("img")).toHaveLength(1);
  expect(panel.querySelector(".comparison")).toBeNull();
  expect(action).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.pointerMove(document.body);
  fireEvent.pointerMove(button);
  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("switch"));
  expect(screen.getByRole("dialog").querySelectorAll(".comparison img")).toHaveLength(2);
});
test("trigger click still performs cleanup once and dismisses help", () => {
  const { button, action } = setup();
  fireEvent.pointerDown(button);
  fireEvent.click(button);
  expect(action).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("keyboard can enter the switch, and Escape returns focus to trigger", () => {
  const { button } = setup();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.focusIn(button);
  act(() => vi.advanceTimersByTime(600));
  fireEvent.keyDown(button, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("switch"));
  fireEvent.keyDown(screen.getByRole("switch"), { key: "Escape" });
  expect(document.activeElement).toBe(button);
  expect(screen.queryByRole("dialog")).toBeNull();
});
