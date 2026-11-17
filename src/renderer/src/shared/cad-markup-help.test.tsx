import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { setFloatingHelpDetailed } from "./floating-help";
import { ToolActionTooltips } from "./tool-action-tooltips";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test("CAD toolbar and drawing rail share detailed and concise help without intercepting launch", () => {
  vi.useFakeTimers();
  setFloatingHelpDetailed(true);
  const launch = vi.fn();
  render(
    <>
      <ToolActionTooltips
        settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "insert-marked-drawing": "F8" }}
      />
      <div className="tool-bar">
        <button type="button" aria-label="CAD标号" onClick={launch}>
          CAD标号
        </button>
      </div>
      <div className="patent-global-function-rail-slot">
        <button type="button" className="cad-markup-entry" onClick={launch}>
          CAD标号
        </button>
      </div>
    </>,
  );
  const [toolbar, rail] = screen.getAllByRole("button", { name: "CAD标号" });
  if (!toolbar || !rail) throw new Error("entry missing");
  fireEvent.pointerMove(toolbar);
  act(() => vi.advanceTimersByTime(600));
  const detailed = screen.getByRole("dialog", { name: "CAD标号说明" });
  expect(detailed.textContent).toContain("DWG、DXF、PDF");
  expect(detailed.textContent).toContain("绘图与修改");
  expect(detailed.textContent).toContain("导出 DWG/DXF");
  expect(detailed.textContent).not.toContain("Ctrl + 框选 / 圈选");
  expect(detailed.textContent).toContain("插入附图快捷键：F8");
  expect(within(detailed).getByRole("img", { name: "标号与选区示意" })).toBeDefined();
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(within(detailed).getByRole("switch", { name: "详细介绍" }));
  expect(screen.queryByRole("img", { name: "标号与选区示意" })).toBeNull();
  fireEvent.pointerMove(rail);
  act(() => vi.advanceTimersByTime(600));
  const concise = screen.getByRole("dialog", { name: "CAD标号说明" });
  expect(within(concise).getByRole("switch").getAttribute("aria-checked")).toBe("false");
  expect(concise.textContent).toContain("绘制和编辑 CAD 图纸");
  fireEvent.pointerDown(rail);
  fireEvent.click(rail);
  expect(launch).toHaveBeenCalledOnce();
});
