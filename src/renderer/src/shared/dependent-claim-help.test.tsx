import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { setFloatingHelpDetailed } from "./floating-help";
import { ToolActionTooltips } from "./tool-action-tooltips";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test("dependent claim help shares mode, shows current shortcut and preserves the action", () => {
  vi.useFakeTimers();
  setFloatingHelpDetailed(true);
  const insert = vi.fn();
  render(
    <>
      <ToolActionTooltips
        settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "insert-dependent-claim": "Alt+F8" }}
      />
      <div className="patent-global-function-rail-slot">
        <button
          type="button"
          className="patent-book-tools__insert-dependent-claim"
          onClick={insert}
        >
          插入从权
        </button>
        <button type="button" className="patent-book-tools__problem-check-button">
          本地检查
        </button>
      </div>
    </>,
  );
  const trigger = screen.getByRole("button", { name: "插入从权" });
  fireEvent.pointerMove(trigger);
  act(() => vi.advanceTimersByTime(600));
  const panel = screen.getByRole("dialog", { name: "插入从权说明" });
  expect(panel.textContent).toContain("快捷键：Alt+F8");
  expect(within(panel).getByRole("region", { name: "插入前示意" }).querySelector("em")).toBeNull();
  expect(within(panel).getByRole("region", { name: "插入后示意" }).textContent).toContain(
    "根据权利要求3",
  );
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(within(panel).getByRole("switch"));
  expect(panel.querySelector(".dependent-claim-help__details")).toBeNull();
  expect(insert).not.toHaveBeenCalled();
  fireEvent.pointerMove(screen.getByRole("button", { name: "本地检查" }));
  act(() => vi.advanceTimersByTime(600));
  expect(screen.queryByRole("dialog", { name: "插入从权说明" })).toBeNull();
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
  expect(insert).toHaveBeenCalledTimes(1);
});
