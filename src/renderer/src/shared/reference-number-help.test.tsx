import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { setFloatingHelpDetailed } from "./floating-help";
import { ToolActionTooltips } from "./tool-action-tooltips";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test.each(["sequential", "custom"])(
  "description %s help shows bare numbering and embodiment scope",
  (mode) => {
    vi.useFakeTimers();
    setFloatingHelpDetailed(true);
    render(
      <>
        <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
        <div className="patent-global-function-rail-slot">
          <button type="button" data-numbering-help={mode} data-numbering-book-kind="description">
            编号操作
          </button>
        </div>
      </>,
    );
    fireEvent.pointerMove(screen.getByRole("button", { name: "编号操作" }));
    act(() => vi.advanceTimersByTime(600));
    const panel = screen.getByRole("dialog", {
      name: mode === "sequential" ? "顺序编号说明" : "自定义编号说明",
    });
    expect(panel.textContent).toContain("具体实施方式");
    expect(panel.querySelector(".keyword-block.recent")?.textContent).toBe(
      mode === "sequential" ? "限位块3" : "限位块10",
    );
    expect(panel.textContent).not.toContain("底座(1)");
    fireEvent.click(within(panel).getByRole("switch"));
    expect(panel.querySelector(".details")).toBeNull();
    expect(panel.textContent).toContain("具体实施方式");
  },
);
test("numbering help preserves approved examples and shares its preference without blocking custom input", () => {
  vi.useFakeTimers();
  setFloatingHelpDetailed(true);
  const start = vi.fn();
  const { rerender } = render(
    <>
      <ToolActionTooltips
        settings={{
          ...DEFAULT_SHORTCUT_SETTINGS,
          "assign-reference-number": "F7",
          "assign-custom-reference-number": "F8",
        }}
      />
      <div className="patent-global-function-rail-slot">
        <button type="button" data-numbering-help="sequential">
          顺序编号
        </button>
        <button type="button" data-numbering-help="custom" onClick={start}>
          自定义编号
        </button>
      </div>
    </>,
  );
  fireEvent.pointerMove(screen.getByRole("button", { name: "顺序编号" }));
  act(() => vi.advanceTimersByTime(600));
  let panel = screen.getByRole("dialog", { name: "顺序编号说明" });
  expect(panel.textContent).toContain("快捷键：F7");
  expect(panel.querySelector(".number-comparison")).not.toBeNull();
  expect(panel.querySelector(".keyword-block.recent")?.textContent).toBe("限位块(3)");
  fireEvent.click(within(panel).getByRole("switch"));
  const custom = screen.getByRole("button", { name: "自定义编号" });
  fireEvent.pointerMove(custom);
  act(() => vi.advanceTimersByTime(600));
  panel = screen.getByRole("dialog", { name: "自定义编号说明" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(panel.classList.contains("compact-panel")).toBe(true);
  expect(panel.textContent).toContain("快捷键：F8");
  fireEvent.click(within(panel).getByRole("switch"));
  expect(panel.querySelector(".custom-comparison .custom-value")?.textContent).toBe(
    "输入自定义编号10并确认",
  );
  expect(panel.querySelector(".keyword-block.recent")?.textContent).toBe("限位块(10)");
  fireEvent.pointerDown(custom);
  fireEvent.click(custom);
  expect(start).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot">
        <button type="button" data-numbering-help="custom" aria-expanded="true">
          自定义编号
        </button>
      </div>
    </>,
  );
  fireEvent.pointerMove(screen.getByRole("button", { name: "自定义编号" }));
  act(() => vi.advanceTimersByTime(600));
  expect(screen.queryByRole("dialog")).toBeNull();
});
