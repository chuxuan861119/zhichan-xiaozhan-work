import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { setFloatingHelpDetailed } from "./floating-help";
import { ToolActionTooltips } from "./tool-action-tooltips";

beforeEach(() => {
  vi.useFakeTimers();
  setFloatingHelpDetailed(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("shows the approved detailed quick-check help and custom shortcut", () => {
  render(
    <>
      <ToolActionTooltips settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "check-problems": "F7" }} />
      <div className="patent-global-function-rail-slot">
        <button
          type="button"
          className="patent-book-tools__problem-check-button"
          title="本地检查（F7）"
        >
          本地检查
        </button>
      </div>
    </>,
  );
  fireEvent.pointerMove(screen.getByRole("button", { name: "本地检查" }));
  act(() => vi.advanceTimersByTime(600));
  const panel = screen.getByRole("dialog", { name: "本地检查说明" });
  expect(panel.textContent).toContain("检查当前专利，找出文字、编号与标点等常见格式性问题");
  expect(panel.textContent).toContain("全文检查");
  expect(panel.textContent).toContain("快捷键：F7");
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("switches quick-check help to its compact content without changing the button", () => {
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot">
        <button type="button" className="patent-book-tools__problem-check-button">
          本地检查
        </button>
      </div>
    </>,
  );
  const button = screen.getByRole("button", { name: "本地检查" });
  fireEvent.pointerMove(button);
  act(() => vi.advanceTimersByTime(600));
  const panel = screen.getByRole("dialog", { name: "本地检查说明" });
  fireEvent.click(screen.getByRole("switch", { name: "详细介绍" }));
  expect(screen.getByRole("switch", { name: "详细介绍" }).getAttribute("aria-checked")).toBe(
    "false",
  );
  expect(panel.querySelector(".quick-details")).toBeNull();
  expect(panel.textContent).toContain("检查当前专利，找出文字、编号与标点等常见格式性问题");
  expect(button.isConnected).toBe(true);
});

test("closes the previous help panel before opening another one", () => {
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot">
        <button type="button" className="patent-book-tools__clear-extra-formatting">
          清除多余格式
        </button>
        <button type="button" className="patent-book-tools__problem-check-button">
          本地检查
        </button>
      </div>
    </>,
  );
  const clearButton = screen.getByRole("button", { name: "清除多余格式" });
  const quickButton = screen.getByRole("button", { name: "本地检查" });
  fireEvent.pointerMove(clearButton);
  act(() => vi.advanceTimersByTime(600));
  const clearPanel = screen.getByRole("dialog", { name: "清除多余格式说明" });
  expect(clearPanel).toBeDefined();
  fireEvent.click(within(clearPanel).getByRole("switch", { name: "详细介绍" }));
  fireEvent.pointerMove(quickButton);
  act(() => vi.advanceTimersByTime(600));
  expect(screen.queryByRole("dialog", { name: "清除多余格式说明" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "本地检查说明" })).toBeDefined();
});

test("uses one detail preference for every help panel", () => {
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot">
        <button type="button" className="patent-book-tools__clear-extra-formatting">
          清除多余格式
        </button>
        <button type="button" className="patent-book-tools__problem-check-button">
          本地检查
        </button>
      </div>
    </>,
  );
  const clearButton = screen.getByRole("button", { name: "清除多余格式" });
  const quickButton = screen.getByRole("button", { name: "本地检查" });
  fireEvent.pointerMove(clearButton);
  act(() => vi.advanceTimersByTime(600));
  fireEvent.click(screen.getByRole("switch", { name: "详细介绍" }));
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.pointerMove(quickButton);
  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByRole("switch", { name: "详细介绍" }).getAttribute("aria-checked")).toBe(
    "false",
  );
  expect(
    screen
      .getByRole("dialog", { name: "本地检查说明" })
      .querySelector(".quick-check-help__details"),
  ).toBeNull();
});
