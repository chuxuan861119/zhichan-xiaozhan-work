import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { ClaimsToDescriptionPanel } from "../patents/claims-to-description-panel";
import { setFloatingHelpDetailed } from "./floating-help";
import { ToolActionTooltips } from "./tool-action-tooltips";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test("description and both chapter buttons share rich help without preparing a draft", () => {
  vi.useFakeTimers();
  setFloatingHelpDetailed(true);
  const prepare = vi.fn();
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot" data-function-rail-scope="right">
        <ClaimsToDescriptionPanel onPrepare={prepare} onCopied={vi.fn()} onFeedback={vi.fn()} />
      </div>
    </>,
  );
  const trigger = screen.getByRole("button", { name: "说明书" });
  fireEvent.pointerMove(trigger);
  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByRole("dialog", { name: "说明书说明" }).textContent).toContain("跳转后粘贴");
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
  for (const name of ["发明内容", "具体实施方式"]) {
    fireEvent.pointerMove(screen.getByRole("button", { name }));
    act(() => vi.advanceTimersByTime(600));
    const panel = screen.getByRole("dialog", { name: `${name}说明` });
    expect(panel.getAttribute("data-function-rail-owner")).toBe("right");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(panel.textContent).toContain("一种支撑装置，包括底座(1)，其特征在于");
    expect(screen.queryByRole("tooltip")).toBeNull();
  }
  const detailSwitch = within(screen.getByRole("dialog")).getByRole("switch");
  // A real click sends pointerdown before click; the parent menu must stay open.
  fireEvent.pointerDown(detailSwitch);
  fireEvent.click(detailSwitch);
  expect(screen.getByRole("button", { name: "具体实施方式" })).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "具体实施方式说明" })).toBeTruthy();
  fireEvent.keyDown(detailSwitch, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "具体实施方式" })).toBeTruthy();
  fireEvent.pointerMove(trigger);
  act(() => vi.advanceTimersByTime(600));
  const compact = screen.getByRole("dialog", { name: "说明书说明" });
  expect(within(compact).getByRole("switch").getAttribute("aria-checked")).toBe("false");
  expect(compact.querySelector(".description-help__details")).toBeNull();
  expect(prepare).not.toHaveBeenCalled();
});
