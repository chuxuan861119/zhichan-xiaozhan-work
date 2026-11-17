import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { setFloatingHelpDetailed } from "./floating-help";
import { ToolActionTooltips } from "./tool-action-tooltips";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("claims supplement help describes parenthesized marks and shares the detail switch", () => {
  vi.useFakeTimers();
  setFloatingHelpDetailed(true);
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot">
        <button
          type="button"
          className="patent-book-tools__supplement-claims-numbers"
          title="旧提示"
        >
          权利要求增补
        </button>
        <button type="button" className="patent-book-tools__supplement-reference-numbers">
          说明书增补
        </button>
      </div>
    </>,
  );
  const trigger = screen.getByRole("button", { name: "权利要求增补" });
  fireEvent.pointerMove(trigger);
  act(() => vi.advanceTimersByTime(600));
  const panel = screen.getByRole("dialog", { name: "权利要求书增补编号说明" });
  expect(panel.textContent).toContain("为权利要求书中已登记的关键词补上遗漏的附图标记编号");
  expect(panel.textContent).toContain("支撑杆(2)");
  expect(panel.textContent).toContain("不是权利要求条号");
  expect(panel.textContent).not.toContain("紫色");
  expect(panel.querySelector(".lucide-circle-plus")).not.toBeNull();
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(trigger.hasAttribute("title")).toBe(false);
  fireEvent.click(within(panel).getByRole("switch"));
  expect(panel.querySelector(".supplement-number-help__details")).toBeNull();
  fireEvent.pointerMove(screen.getByRole("button", { name: "说明书增补" }));
  act(() => vi.advanceTimersByTime(600));
  expect(
    screen.getByRole("dialog", { name: "增补编号说明" }).classList.contains("compact-panel"),
  ).toBe(true);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.pointerMove(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("disabled claims supplement button never opens the old small tooltip", () => {
  vi.useFakeTimers();
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot">
        <button type="button" disabled className="patent-book-tools__supplement-claims-numbers">
          增补编号
        </button>
      </div>
    </>,
  );
  fireEvent.pointerMove(screen.getByRole("button", { name: "增补编号" }));
  act(() => vi.advanceTimersByTime(600));
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("supplement number help shows purple keyword-and-number example and preserves the action", () => {
  vi.useFakeTimers();
  setFloatingHelpDetailed(true);
  const supplement = vi.fn();
  render(
    <>
      <ToolActionTooltips
        settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "supplement-reference-numbers": "F9" }}
      />
      <div className="patent-global-function-rail-slot">
        <button
          type="button"
          className="patent-book-tools__supplement-reference-numbers"
          onClick={supplement}
        >
          增补编号
        </button>
      </div>
    </>,
  );
  const trigger = screen.getByRole("button", { name: "增补编号" });
  fireEvent.pointerMove(trigger);
  act(() => vi.advanceTimersByTime(600));
  const panel = screen.getByRole("dialog", { name: "增补编号说明" });
  expect(panel.textContent).toContain("快捷键：F9");
  expect(panel.textContent).toContain("附图标记已登记");
  expect(panel.textContent).toContain("增补的关键词与编号一起显示为紫色");
  const after = within(panel).getByRole("region", { name: "增补后示意" });
  expect(after.querySelectorAll("em")).toHaveLength(2);
  fireEvent.click(within(panel).getByRole("switch"));
  expect(panel.querySelector(".supplement-number-help__details")).toBeNull();
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
  expect(supplement).toHaveBeenCalledTimes(1);
});
