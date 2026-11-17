import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { setFloatingHelpDetailed } from "./floating-help";
import { ToolActionTooltips } from "./tool-action-tooltips";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("drawing and AI rich panels replace old tips, share detail preference, and preserve actions", () => {
  vi.useFakeTimers();
  setFloatingHelpDetailed(true);
  const action = vi.fn();
  render(
    <>
      <ToolActionTooltips
        settings={{
          ...DEFAULT_SHORTCUT_SETTINGS,
          "ai-correction": "F8",
          "toggle-drawing-sort": "F9",
        }}
      />
      <div className="patent-global-function-rail-slot">
        <button type="button" className="drawing-sort-button" title="附图排序" onClick={action}>
          附图排序
        </button>
      </div>
      <div className="tool-bar">
        <button type="button" aria-label="AI 纠错" title="AI 纠错" onClick={action}>
          AI 纠错
        </button>
        <button type="button" aria-label="小栈AI助手" title="小栈AI助手">
          AI
        </button>
      </div>
    </>,
  );
  const drawing = screen.getByRole("button", { name: "附图排序" });
  fireEvent.pointerMove(drawing);
  act(() => vi.advanceTimersByTime(600));
  let panel = screen.getByRole("dialog", { name: "附图排序说明" });
  expect(panel.textContent).toContain("鼠标拖动调整说明书附图的排列顺序");
  expect(panel.textContent).toContain("快捷键：F9");
  expect(panel.querySelectorAll(".drawing")).toHaveLength(6);
  expect(panel.querySelector("[marker-end]")).not.toBeNull();
  const correction = screen.getByRole("button", { name: "AI 纠错" });
  fireEvent.pointerMove(correction);
  act(() => vi.advanceTimersByTime(600));
  panel = screen.getByRole("dialog", { name: "AI纠错说明" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(correction.hasAttribute("title")).toBe(false);
  expect(panel.querySelectorAll(".review-row")).toHaveLength(4);
  expect(panel.textContent).toContain("快捷键：F8");
  expect(panel.textContent).toContain("会将文档或选中的文字");
  fireEvent.click(within(panel).getByRole("switch"));
  const assistant = screen.getByRole("button", { name: "小栈AI助手" });
  fireEvent.pointerMove(assistant);
  act(() => vi.advanceTimersByTime(600));
  panel = screen.getByRole("dialog", { name: "小栈AI助手说明" });
  expect(panel.classList.contains("compact-panel")).toBe(true);
  expect(panel.querySelector(".details")).toBeNull();
  fireEvent.click(within(panel).getByRole("switch"));
  expect(panel.querySelectorAll(".message")).toHaveLength(4);
  expect(panel.querySelectorAll(".start-card")).toHaveLength(2);
  fireEvent.pointerMove(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(drawing);
  expect(action).toHaveBeenCalledTimes(1);
});
