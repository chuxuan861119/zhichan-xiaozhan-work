import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { setFloatingHelpDetailed } from "./floating-help";
import { ToolActionTooltips } from "./tool-action-tooltips";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test.each([false, true])(
  "all four list actions replace small hints and share the detail preference (disabled=%s)",
  (disabled) => {
    vi.useFakeTimers();
    setFloatingHelpDetailed(true);
    const classes = [
      "reference-mark-panel__fill",
      "reference-mark-panel__copy",
      "drawing-explanation-rail__fill",
      "drawing-explanation-rail__copy",
    ];
    const labels = [
      "附图标记填入说明书说明",
      "附图标记复制说明",
      "附图说明填入说明书说明",
      "附图说明复制说明",
    ];
    render(
      <>
        <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
        <div className="patent-global-function-rail-slot">
          {classes.map((name, i) => (
            <button type="button" key={name} className={name} title="旧提示" disabled={disabled}>
              入口{i}
            </button>
          ))}
        </div>
      </>,
    );
    classes.forEach((_, i) => {
      const button = screen.getByRole("button", { name: `入口${i}` });
      fireEvent.pointerMove(button);
      act(() => vi.advanceTimersByTime(600));
      const panel = screen.getByRole("dialog", { name: labels[i] ?? "" });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(button.hasAttribute("title")).toBe(false);
      expect(panel.querySelectorAll(".document-example h5")).toHaveLength(i % 2 === 0 ? 1 : 0);
      expect(panel.querySelectorAll(".sample img")).toHaveLength(0);
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("switch"));
    fireEvent.pointerMove(screen.getByRole("button", { name: "入口0" }));
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByRole("dialog").classList.contains("compact-panel")).toBe(true);
    expect(screen.getByRole("dialog").querySelector(".details")?.hasAttribute("hidden")).toBe(true);
    fireEvent.pointerMove(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);
