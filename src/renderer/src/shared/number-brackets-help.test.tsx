import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { setFloatingHelpDetailed } from "./floating-help";
import { ToolActionTooltips } from "./tool-action-tooltips";

test.each([false, true])(
  "bracket help shares compact switch and suppresses old tooltips (disabled=%s)",
  (disabled) => {
    vi.useFakeTimers();
    setFloatingHelpDetailed(true);
    render(
      <>
        <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
        <div className="tool-bar">
          <button type="button" data-number-brackets="add" disabled={disabled}>
            数字加括号
          </button>
          <button type="button" data-number-brackets="remove" disabled={disabled}>
            数字去括号
          </button>
        </div>
      </>,
    );
    fireEvent.pointerMove(screen.getByRole("button", { name: "数字加括号" }));
    act(() => vi.advanceTimersByTime(600));
    let panel = screen.getByRole("dialog", { name: "数字加括号说明" });
    expect(panel.textContent).toContain("关键词(201)");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(within(panel).getByRole("switch"));
    fireEvent.pointerMove(screen.getByRole("button", { name: "数字去括号" }));
    act(() => vi.advanceTimersByTime(600));
    panel = screen.getByRole("dialog", { name: "数字去括号说明" });
    expect(panel.classList.contains("compact-panel")).toBe(true);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect((screen.getByRole("button", { name: "数字去括号" }) as HTMLButtonElement).disabled).toBe(
      disabled,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerMove(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.useRealTimers();
  },
);
