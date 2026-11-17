import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { setFloatingHelpDetailed } from "./floating-help";
import { ToolActionTooltips } from "./tool-action-tooltips";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test.each([
  ["本地检查", "本地检查说明", "patent-book-tools__problem-check-button"],
  ["AI 纠错", "AI纠错说明", "patent-book-tools__ai-correction-button"],
  ["小栈AI助手", "小栈AI助手说明", "patent-book-tools__text-polish-button"],
])(
  "%s has identical shared help at toolbar and function rail entries",
  (label, title, railClass) => {
    vi.useFakeTimers();
    setFloatingHelpDetailed(true);
    const action = vi.fn();
    render(
      <>
        <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
        <div className="tool-bar">
          <button type="button" aria-label={label} title={label} onClick={action}>
            {label}
          </button>
        </div>
        <div className="patent-global-function-rail-slot">
          <button type="button" className={railClass} title={label} onClick={action}>
            {label}
          </button>
        </div>
      </>,
    );
    const buttons = screen.getAllByRole("button", { name: label });
    const [toolbarButton, railButton] = buttons;
    if (!toolbarButton || !railButton) throw new Error("Both help entries are required");
    let content = "";
    for (const button of buttons) {
      fireEvent.pointerMove(button);
      act(() => vi.advanceTimersByTime(600));
      const panel = screen.getByRole("dialog", { name: title });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(button.hasAttribute("title")).toBe(false);
      if (content) expect(panel.textContent).toBe(content);
      content = panel.textContent || "";
    }
    fireEvent.click(within(screen.getByRole("dialog", { name: title })).getByRole("switch"));
    fireEvent.pointerMove(toolbarButton);
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByRole("dialog", { name: title }).classList.contains("compact-panel")).toBe(
      true,
    );
    fireEvent.pointerMove(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(toolbarButton);
    fireEvent.click(railButton);
    expect(action).toHaveBeenCalledTimes(2);
  },
);
