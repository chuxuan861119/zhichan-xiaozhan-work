import { act, fireEvent, render, screen } from "@testing-library/react";
import { SpatialPresence } from "./spatial-presence";
import { SpatialPresetDisclosure } from "./spatial-preset-disclosure";

afterEach(() => vi.useRealTimers());

test("closing popovers become inert and reopening keeps the same content", () => {
  vi.useFakeTimers();
  const child = (
    <nav aria-label="导航">
      <button type="button">条目</button>
    </nav>
  );
  const view = render(<SpatialPresence>{child}</SpatialPresence>);
  const nav = screen.getByRole("navigation");
  view.rerender(<SpatialPresence>{null}</SpatialPresence>);
  expect(screen.queryByRole("navigation")).toBeNull();
  expect(nav.parentElement?.hasAttribute("inert")).toBe(true);
  act(() => vi.advanceTimersByTime(200));
  view.rerender(<SpatialPresence>{child}</SpatialPresence>);
  act(() => vi.advanceTimersByTime(280));
  expect(screen.getByRole("navigation")).toBe(nav);
  view.rerender(<SpatialPresence>{null}</SpatialPresence>);
  act(() => vi.advanceTimersByTime(420));
  expect(document.querySelector("nav")).toBeNull();
});

test("dropdown presence starts shared paint motion and cancels it after retained exit", () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const animate = vi.fn((..._args: unknown[]) => ({ cancel }));
  const original = HTMLElement.prototype.animate;
  HTMLElement.prototype.animate = animate as unknown as HTMLElement["animate"];
  try {
    const menu = <div role="menu">菜单</div>;
    const view = render(<SpatialPresence>{menu}</SpatialPresence>);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]?.[1]).toEqual({
      duration: 260,
      easing: "ease-in-out",
      fill: "both",
    });
    view.rerender(<SpatialPresence>{null}</SpatialPresence>);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="menu"]')?.parentElement?.hasAttribute("inert")).toBe(
      true,
    );
    act(() => vi.advanceTimersByTime(280));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(2);
    view.unmount();
  } finally {
    HTMLElement.prototype.animate = original;
  }
});

test("preset summary retains native open semantics and disables choices during exit", () => {
  vi.useFakeTimers();
  render(
    <SpatialPresetDisclosure className="polish-preset-disclosure" summary="常用需求">
      <button type="button">预设</button>
    </SpatialPresetDisclosure>,
  );
  expect(screen.queryByRole("button", { name: "预设" })).toBeNull();
  fireEvent.click(screen.getByText("常用需求"));
  expect(document.querySelector("details")?.open).toBe(true);
  expect(screen.getByRole("button", { name: "预设" })).toBeDefined();
  fireEvent.click(screen.getByText("常用需求"));
  expect(document.querySelector("details")?.open).toBe(true);
  expect(screen.getByText("常用需求").getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector(".spatial-collapse")?.hasAttribute("inert")).toBe(true);
  act(() => vi.advanceTimersByTime(420));
  expect(document.querySelector(".spatial-collapse")).toBeNull();
  expect(document.querySelector("details")?.open).toBe(false);
});

test("keeps a non-menu exit painted for the maximum spatial duration and disables interaction immediately", () => {
  vi.useFakeTimers();
  const view = render(
    <SpatialPresence>
      <button type="button">帮助</button>
    </SpatialPresence>,
  );
  view.rerender(<SpatialPresence>{null}</SpatialPresence>);
  expect(screen.queryByRole("button")).toBeNull();
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByText("帮助").isConnected).toBe(true);
  act(() => vi.advanceTimersByTime(120));
  expect(screen.queryByText("帮助")).toBeNull();
});

test("retains menus for their fixed duration and cancels a pending removal when reopened", () => {
  vi.useFakeTimers();
  const menu = <div role="menu">菜单</div>;
  const view = render(<SpatialPresence>{menu}</SpatialPresence>);
  view.rerender(<SpatialPresence>{null}</SpatialPresence>);
  act(() => vi.advanceTimersByTime(200));
  view.rerender(<SpatialPresence>{menu}</SpatialPresence>);
  act(() => vi.advanceTimersByTime(100));
  expect(screen.getByRole("menu")).toBeTruthy();
  view.rerender(<SpatialPresence>{null}</SpatialPresence>);
  act(() => vi.advanceTimersByTime(280));
  expect(screen.queryByText("菜单")).toBeNull();
});
