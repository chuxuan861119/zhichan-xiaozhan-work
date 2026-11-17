import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { ToolActionTooltips, toolActionDetails, tooltipPosition } from "./tool-action-tooltips";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.referenceMarkDragging;
  vi.useRealTimers();
});

function hover(button: HTMLElement) {
  fireEvent.pointerMove(button);
  act(() => vi.advanceTimersByTime(400));
}

test("explicitly silent CAD header controls do not show hover or focus tooltips", () => {
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot">
        <div data-tool-tooltip="off">
          <button type="button">CAD工具</button>
          <button type="button">附图标记</button>
        </div>
        <button type="button" data-tool-tooltip="off">
          收起功能栏
        </button>
        <button type="button">固定</button>
      </div>
    </>,
  );
  for (const name of ["CAD工具", "附图标记", "收起功能栏"]) {
    const button = screen.getByRole("button", { name });
    hover(button);
    fireEvent.focusIn(button);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole("tooltip")).toBeNull();
  }
  hover(screen.getByRole("button", { name: "固定" }));
  expect(screen.getByRole("tooltip")).toBeDefined();
});

test.each([
  ["选区格式", "加粗", false],
  ["选区格式", "打开文字颜色菜单", false],
  ["图片工具", "图片右对齐", false],
  ["表格工具", "删除列", true],
])("%s mini tools show compact accessible names for %s", (toolbar, label, disabled) => {
  const view = render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="editor-menu-surface" role="menu">
        <div className="editor-mini-format" role="toolbar" aria-label={toolbar}>
          <button type="button" aria-label={label} title={label} disabled={disabled}>
            <svg />
          </button>
        </div>
      </div>
    </>,
  );
  const button = screen.getByRole("button", { name: label });
  hover(button);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip.textContent).toBe(label);
  expect(tooltip.classList.contains("tool-action-tooltip--compact")).toBe(true);
  expect(document.body.contains(tooltip)).toBe(true);
  expect(tooltip.closest(".editor-menu-surface")).toBeNull();
  expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
  expect(button.hasAttribute("title")).toBe(false);
  view.unmount();
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(button.hasAttribute("aria-describedby")).toBe(false);
});

test.each(["win32", "darwin", "openharmony"])(
  "shared hints format fixed and configured keys on %s",
  (platform) => {
    vi.stubGlobal("documentFontPlatform", platform);
    const bar = document.createElement("div");
    bar.className = "tool-bar";
    const button = document.createElement("button");
    bar.append(button);
    button.setAttribute("aria-label", "重做");
    expect(toolActionDetails(button, DEFAULT_SHORTCUT_SETTINGS, "").shortcut).toBe(
      platform === "darwin" ? "⌘+⇧+Z" : "Ctrl+Y / Ctrl+Shift+Z",
    );
    button.setAttribute("aria-label", "顺序编号");
    expect(
      toolActionDetails(
        button,
        { ...DEFAULT_SHORTCUT_SETTINGS, "assign-reference-number": "Control+Alt+K" },
        "",
      ).shortcut,
    ).toBe(platform === "darwin" ? "⌃+⌥+K" : "Ctrl+Alt+K");
  },
);

test("chemical toolbar hints cover icons and disabled buttons after 120ms inside dialogs", () => {
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div role="dialog">
        <div className="ketcher-editor-shell">
          <div data-testid="top-toolbar">
            <button type="button" disabled title="复制" aria-label="复制">
              <svg data-testid="copy-icon" />
            </button>
          </div>
        </div>
      </div>
    </>,
  );
  const button = screen.getByRole("button", { name: "复制" });
  fireEvent.pointerMove(screen.getByTestId("copy-icon"));
  act(() => vi.advanceTimersByTime(119));
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("tooltip").textContent).toContain("复制");
  expect(button.hasAttribute("title")).toBe(false);
  fireEvent.pointerOut(button, { relatedTarget: document.body });
  act(() => vi.advanceTimersByTime(400));
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(button.title).toBe("复制");
});

test("rail edge handle has no redundant tooltip", () => {
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot">
        <button
          type="button"
          className="patent-global-function-rail__collapsed-toggle"
          aria-label="展开功能栏"
        >
          功能栏
        </button>
      </div>
    </>,
  );
  hover(screen.getByRole("button", { name: "展开功能栏" }));
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("toolbar tooltip describes the action and real shortcut without native duplication", () => {
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="tool-bar">
        <button type="button" title="粗体（Ctrl+B）" aria-label="粗体">
          B
        </button>
      </div>
    </>,
  );
  const button = screen.getByRole("button");
  hover(button);
  expect(screen.getByRole("tooltip").textContent).toContain("Ctrl+B");
  expect(screen.getByRole("tooltip").textContent).toContain("加粗");
  expect(button.hasAttribute("title")).toBe(false);
  fireEvent.pointerMove(document.body);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(button.title).toBe("粗体（Ctrl+B）");
});

test("rail tooltips use configured shortcuts and do not assign Ctrl+C to copying a mark list", () => {
  render(
    <>
      <ToolActionTooltips
        settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "assign-reference-number": "Alt+F2" }}
      />
      <div className="patent-global-function-rail-slot">
        <button type="button">顺序编号</button>
        <button type="button" title="复制附图标记">
          复制
        </button>
      </div>
    </>,
  );
  hover(screen.getByRole("button", { name: "顺序编号" }));
  expect(screen.getByRole("tooltip").textContent).toContain("Alt+F2");
  hover(screen.getByRole("button", { name: "复制" }));
  expect(screen.getByRole("tooltip").textContent).toContain("复制附图标记");
  expect(screen.getByRole("tooltip").textContent).not.toContain("快捷键");
  expect(screen.getByRole("tooltip").textContent).not.toContain("Ctrl+C");
});

test("disabled and dynamically inserted rail buttons work; Escape and removal dismiss the tooltip", () => {
  const view = render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot" />
    </>,
  );
  const button = document.createElement("button");
  button.disabled = true;
  button.textContent = "删除行";
  button.title = "请先选中表格";
  document.querySelector(".patent-global-function-rail-slot")?.append(button);
  hover(button);
  expect(screen.getByRole("tooltip").textContent).toContain("请先选中表格");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.pointerMove(document.body);
  hover(button);
  view.unmount();
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("unrelated buttons and modal controls are excluded; keyboard focus is supported", () => {
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <button type="button">其他</button>
      <div className="tool-bar">
        <button type="button">打印</button>
        <div role="dialog">
          <button type="button">确认</button>
        </div>
      </div>
    </>,
  );
  hover(screen.getByRole("button", { name: "其他" }));
  expect(screen.queryByRole("tooltip")).toBeNull();
  hover(screen.getByRole("button", { name: "确认" }));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focusIn(screen.getByRole("button", { name: "打印" }));
  act(() => vi.advanceTimersByTime(400));
  expect(screen.getByRole("tooltip").textContent).toContain("打印");
});

test("each mark/explanation copy and fill action only shows its own function", () => {
  for (const [className, noun] of [
    ["reference-mark-panel", "附图标记"],
    ["drawing-explanation-rail", "附图说明"],
  ] as const) {
    const parent = document.createElement("div");
    parent.className = className;
    const button = document.createElement("button");
    parent.append(button);
    for (const label of ["复制", "填入说明书"]) {
      button.textContent = label;
      const details = toolActionDetails(button, DEFAULT_SHORTCUT_SETTINGS, "");
      expect(details.shortcut).toBe("");
      expect(details.description).toContain(noun);
    }
  }
});

test("configurable actions without a binding explicitly report it is not set", () => {
  const button = document.createElement("button");
  button.textContent = "顺序编号";
  expect(toolActionDetails(button, DEFAULT_SHORTCUT_SETTINGS, "").shortcut).toBe("暂未设置快捷键");
  button.textContent = "更多工具";
  expect(toolActionDetails(button, DEFAULT_SHORTCUT_SETTINGS, "").shortcut).toBe("");
});

test("tooltip stays inside the right and bottom viewport edges", () => {
  const anchor = { left: 780, top: 560, bottom: 590 } as DOMRect;
  expect(tooltipPosition(anchor, 200, 70, 800, 600)).toEqual({ left: 592, top: 482 });
});

test("changing shortcut settings dismisses stale content and uses the new binding", () => {
  const ui = (shortcut: string | null) => (
    <>
      <ToolActionTooltips
        settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "assign-reference-number": shortcut }}
      />
      <div className="patent-global-function-rail-slot">
        <button type="button">顺序编号</button>
      </div>
    </>
  );
  const view = render(ui("Alt+F2"));
  hover(screen.getByRole("button"));
  expect(screen.getByRole("tooltip").textContent).toContain("Alt+F2");
  view.rerender(ui("Alt+F3"));
  expect(screen.queryByRole("tooltip")).toBeNull();
  hover(screen.getByRole("button"));
  expect(screen.getByRole("tooltip").textContent).toContain("Alt+F3");
});

test("editor focus restoration does not cancel a stationary pointer tooltip", () => {
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="tool-bar">
        <button type="button">新建</button>
      </div>
      <textarea aria-label="正文" />
    </>,
  );
  fireEvent.pointerMove(screen.getByRole("button"));
  fireEvent.focusIn(screen.getByRole("textbox"));
  act(() => vi.advanceTimersByTime(400));
  expect(screen.getByRole("tooltip").textContent).toContain("新建专利");
  fireEvent.focusOut(screen.getByRole("textbox"));
  expect(screen.getByRole("tooltip")).toBeDefined();
});

test("does not show a number tooltip while reference marks are being dragged", () => {
  render(
    <>
      <ToolActionTooltips settings={DEFAULT_SHORTCUT_SETTINGS} />
      <div className="patent-global-function-rail-slot reference-mark-panel">
        <button type="button" className="reference-mark-panel__drag-handle" title="拖动调整位置">
          2
        </button>
      </div>
    </>,
  );
  document.documentElement.dataset.referenceMarkDragging = "true";
  hover(screen.getByRole("button"));
  expect(screen.queryByRole("tooltip")).toBeNull();
});
