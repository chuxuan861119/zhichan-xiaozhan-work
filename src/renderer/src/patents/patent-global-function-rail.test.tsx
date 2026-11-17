import { act, fireEvent, render, screen } from "@testing-library/react";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { ShortcutProvider, useShortcutAction } from "../app/shortcut-dispatcher";
import { DualColumnContext } from "./dual-column-context";
import { PatentFunctionRailScope } from "./function-rail/function-rail-context";
import { PatentGlobalFunctionRail } from "./patent-global-function-rail";
import { ReferenceMarkPanel } from "./reference-marks/reference-mark-panel";

test("hiding an overlay rail preserves its tool component and draft DOM", () => {
  const tree = (active: boolean) => (
    <PatentFunctionRailScope scopeKey="cad-session-retention" initialSpace="constrained" initialUserIntent="pinned">
      <div hidden={!active}>
        <PatentGlobalFunctionRail bookKind="description-drawings" title="CAD">
          <input aria-label="未完成工具参数" defaultValue="草稿" />
        </PatentGlobalFunctionRail>
      </div>
    </PatentFunctionRailScope>
  );
  const view = render(tree(true));
  const field = screen.getByLabelText("未完成工具参数");
  fireEvent.change(field, { target: { value: "尚未确认" } });
  view.rerender(tree(false));
  view.rerender(tree(true));
  expect(screen.getByLabelText("未完成工具参数")).toBe(field);
  expect((field as HTMLInputElement).value).toBe("尚未确认");
});

test("dual-column edge handle preserves the panel's page-side DOM", () => {
  render(
    <PatentFunctionRailScope scopeKey="dual-edge">
      <DualColumnContext.Provider value={true}>
        <div data-testid="pages">
          <PatentGlobalFunctionRail bookKind="claims" title="测试">
            <button type="button">工具</button>
          </PatentGlobalFunctionRail>
        </div>
      </DualColumnContext.Provider>
    </PatentFunctionRailScope>,
  );
  const toggle = screen.getByRole("button", { name: "展开功能栏" });
  expect(toggle.closest(".patent-function-rail-edge-host")).not.toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByRole("complementary").closest('[data-testid="pages"]')).not.toBeNull();
  expect(
    screen.getByRole("button", { name: "展开功能栏" }).closest(".patent-function-rail-edge-host"),
  ).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "收起功能栏" }));
  expect(
    screen.getByRole("button", { name: "展开功能栏" }).closest(".patent-function-rail-edge-host"),
  ).not.toBeNull();
});

test("an inactive retained book cannot close the active book's hovered rail", () => {
  vi.useFakeTimers();
  try {
    render(
      <PatentFunctionRailScope scopeKey="retained-hover">
        <div className="patent-book-transition-surface" data-active="false" hidden>
          <PatentGlobalFunctionRail bookKind="claims" title="权利要求书">
            <button type="button">旧工具</button>
          </PatentGlobalFunctionRail>
        </div>
        <div className="patent-book-transition-surface" data-active="true">
          <PatentGlobalFunctionRail bookKind="description" title="说明书">
            <button type="button">当前工具</button>
          </PatentGlobalFunctionRail>
        </div>
      </PatentFunctionRailScope>,
    );
    const handle = screen.getByRole("button", { name: "展开功能栏" });
    fireEvent.click(handle);
    fireEvent.pointerMove(handle);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("complementary", { name: "说明书全局功能栏" })).toBeDefined();
    expect(screen.getByRole("button", { name: "当前工具" })).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});

vi.mock("./function-rail/use-function-rail-measurement", () => ({
  useFunctionRailMeasurement: () => {},
}));
vi.mock("./function-rail/use-rail-visible-height", () => ({ useRailVisibleHeight: () => {} }));

function openRail() {
  render(
    <PatentFunctionRailScope scopeKey="animation">
      <PatentGlobalFunctionRail bookKind="claims" title="测试">
        <button type="button">工具</button>
      </PatentGlobalFunctionRail>
    </PatentFunctionRailScope>,
  );
  fireEvent.click(screen.getByRole("button", { name: "展开功能栏" }));
  return screen.getByRole("complementary");
}

test("uses standard header controls and the shared geometric close icon", () => {
  openRail();
  for (const name of ["固定", "收起功能栏"]) {
    const button = screen.getByRole("button", { name });
    expect(button.classList.contains("dialog-close-control")).toBe(true);
    expect(button.classList.contains("dialog-close-button")).toBe(true);
  }
  const close = screen.getByRole("button", { name: "收起功能栏" });
  expect(close.querySelector("svg.dialog-close-icon")).not.toBeNull();
  expect(close.textContent).not.toContain("✕");
});

test("custom CAD tabs occupy the original rail header alongside pin controls", () => {
  render(
    <PatentFunctionRailScope scopeKey="cad-header" initialSpace="constrained">
      <PatentGlobalFunctionRail
        bookKind="description-drawings"
        title="图纸工具"
        headerContent={<button type="button">CAD工具</button>}
      >
        <p>绘图工具内容</p>
      </PatentGlobalFunctionRail>
    </PatentFunctionRailScope>,
  );
  fireEvent.click(screen.getByRole("button", { name: "展开功能栏" }));
  const tab = screen.getByRole("button", { name: "CAD工具" });
  const pin = screen.getByRole("button", { name: "固定" });
  expect(tab.closest(".patent-global-function-rail__header")).toBe(pin.closest("header"));
  expect(tab.closest(".patent-global-function-rail__body")).toBeNull();
});

test("ordinary document rails remain non-draggable when pinned", () => {
  const rail = openRail();
  fireEvent.click(screen.getByRole("button", { name: "固定" }));
  fireEvent.pointerDown(rail.querySelector("header")!, { button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(window, { buttons: 1, clientX: 200, clientY: 200 });
  fireEvent.pointerUp(window);
  expect(rail.style.position).toBe("");
  expect(rail.getAttribute("data-draggable")).not.toBe("true");
});

test("pinned CAD header controls drag after a threshold without firing their click actions", () => {
  const select = vi.fn();
  render(
    <PatentFunctionRailScope scopeKey="cad-drag-controls" initialSpace="constrained">
      <PatentGlobalFunctionRail
        bookKind="description-drawings"
        title="图纸工具"
        draggableWhenPinned
        headerContent={
          <>
            <button type="button" onClick={select}>
              CAD工具
            </button>
            <button type="button" onClick={select}>
              附图标记
            </button>
          </>
        }
      >
        <p>绘图工具内容</p>
      </PatentGlobalFunctionRail>
    </PatentFunctionRailScope>,
  );
  fireEvent.click(screen.getByRole("button", { name: "展开功能栏" }));
  fireEvent.click(screen.getByRole("button", { name: "固定" }));
  const rail = screen.getByRole("complementary");
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 100, 280, 300));
  const tab = screen.getByRole("button", { name: "CAD工具" });
  fireEvent.pointerDown(tab, { button: 0, clientX: 450, clientY: 120, pointerId: 1 });
  fireEvent.pointerMove(window, { buttons: 1, clientX: 452, clientY: 122, pointerId: 1 });
  expect(rail.style.position).toBe("");
  fireEvent.pointerUp(tab, { pointerId: 1 });
  fireEvent.click(tab, { detail: 1 });
  expect(select).toHaveBeenCalledOnce();
  for (const name of ["CAD工具", "附图标记", "取消固定", "收起功能栏"]) {
    const control = screen.getByRole("button", { name });
    fireEvent.pointerDown(control, { button: 0, clientX: 450, clientY: 120, pointerId: 2 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 420, clientY: 135, pointerId: 2 });
    expect(rail.getAttribute("data-dragging")).toBe("true");
    fireEvent.pointerUp(window, { pointerId: 2 });
    fireEvent.click(control, { detail: 1 });
    expect(rail.getAttribute("data-draggable")).toBe("true");
    expect(rail.hasAttribute("inert")).toBe(false);
  }
  expect(select).toHaveBeenCalledOnce();
  expect(rail.style.left).toBe("280px");
  expect(rail.style.top).toBe("160px");
  expect(rail.style.maxHeight).toBe(
    "min(var(--rail-visible-height, 100vh), calc(100dvh - 160px - 12px))",
  );
  const close = screen.getByRole("button", { name: "收起功能栏" });
  expect(close.hasAttribute("title")).toBe(false);
  expect(close.closest("header")?.hasAttribute("title")).toBe(false);
  // A subsequent ordinary click still closes the palette.
  fireEvent.pointerDown(close, { button: 0, clientX: 450, clientY: 120, pointerId: 3 });
  fireEvent.pointerUp(close, { pointerId: 3 });
  fireEvent.click(close, { detail: 1 });
  expect(rail.hasAttribute("inert")).toBe(true);
});

test("hides an inert rail after exit without unmounting its tools", () => {
  vi.useFakeTimers();
  try {
    const rail = openRail();
    fireEvent.click(screen.getByRole("button", { name: "收起功能栏" }));
    expect(rail.isConnected).toBe(true);
    expect(rail.hasAttribute("inert")).toBe(true);
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    act(() => vi.advanceTimersByTime(600));
    expect(rail.hidden).toBe(false);
    act(() => vi.advanceTimersByTime(20));
    expect(rail.isConnected).toBe(true);
    expect(rail.hidden).toBe(true);
    expect(rail.style.display).toBe("none");
  } finally {
    vi.useRealTimers();
  }
});

test("keeps tool shortcuts registered while the rail is collapsed", () => {
  const action = vi.fn();
  function Tool() {
    useShortcutAction("clear-extra-formatting", true, () => {
      action();
      return true;
    });
    return <button type="button">快捷工具</button>;
  }
  render(
    <ShortcutProvider settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "clear-extra-formatting": "F9" }}>
      <PatentFunctionRailScope scopeKey="collapsed-shortcuts">
        <PatentGlobalFunctionRail bookKind="claims" title="测试">
          <Tool />
        </PatentGlobalFunctionRail>
      </PatentFunctionRailScope>
    </ShortcutProvider>,
  );
  expect(screen.queryByRole("button", { name: "快捷工具" })).toBeNull();
  fireEvent.keyDown(window, { key: "F9", code: "F9" });
  expect(action).toHaveBeenCalledOnce();
});

test("a custom-number shortcut reveals its input in a collapsed rail", () => {
  render(
    <ShortcutProvider
      settings={{ ...DEFAULT_SHORTCUT_SETTINGS, "assign-custom-reference-number": "F10" }}
    >
      <PatentFunctionRailScope scopeKey="custom-number">
        <PatentGlobalFunctionRail bookKind="claims" title="测试">
          <ReferenceMarkPanel
            patent={createBlankPatent({ patentType: "invention", name: "快捷编号" })}
            missingReferenceMarkIds={new Set()}
            onAssignReferenceNumber={vi.fn()}
            onSetSynchronizedEditing={() => ({ ok: true, message: "" })}
            onEdit={() => ({ ok: true, message: "" })}
            onCancel={() => ({ ok: true, message: "" })}
          />
        </PatentGlobalFunctionRail>
      </PatentFunctionRailScope>
    </ShortcutProvider>,
  );
  fireEvent.keyDown(window, { key: "F10", code: "F10" });
  const input = screen.getByRole("textbox", { name: "自定义编号数字" });
  expect(document.activeElement).toBe(input);
  fireEvent.click(screen.getByRole("button", { name: "取消自定义编号" }));
  expect(screen.queryByRole("textbox", { name: "自定义编号数字" })).toBeNull();
});

test("reopening cancels pending removal", () => {
  vi.useFakeTimers();
  try {
    const rail = openRail();
    fireEvent.click(screen.getByRole("button", { name: "收起功能栏" }));
    fireEvent.click(screen.getByRole("button", { name: "展开功能栏" }));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("complementary")).toBe(rail);
    expect(rail.hasAttribute("inert")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("replays the downward entry when a retained patent page becomes active again", () => {
  const originalAnimate = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;
  const renderRail = (active: boolean) => (
    <PatentFunctionRailScope scopeKey="retained-page" initialSpace="fits">
      <div className="patent-book-transition-surface" data-active={active}>
        <PatentGlobalFunctionRail bookKind="claims" title="测试">
          <button type="button">工具</button>
        </PatentGlobalFunctionRail>
      </div>
    </PatentFunctionRailScope>
  );

  try {
    const view = render(renderRail(true));
    expect(animate).not.toHaveBeenCalled();

    view.rerender(renderRail(false));
    view.rerender(renderRail(true));

    expect(animate).toHaveBeenCalledWith(
      [
        {
          opacity: 0,
          clipPath: "inset(-32px -32px 100% -32px)",
          transform: "translateY(-8px)",
        },
        {
          opacity: 1,
          clipPath: "inset(-32px -32px -32px -32px)",
          transform: "translateY(0)",
        },
      ],
      { duration: 600, easing: "ease-in-out" },
    );
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
  }
});
