import { act, render, screen } from "@testing-library/react";
import { TransientFunctionRailSlot } from "./transient-function-rail-slot";

test("smoothly retains a transient rail panel while it collapses and cancels removal when reopened", () => {
  vi.useFakeTimers();
  const panel = <section aria-label="临时工具">内容</section>;
  const view = render(<TransientFunctionRailSlot open={false}>{panel}</TransientFunctionRailSlot>);

  expect(screen.queryByLabelText("临时工具")).toBeNull();

  view.rerender(<TransientFunctionRailSlot open>{panel}</TransientFunctionRailSlot>);
  const slot = document.querySelector<HTMLElement>(".function-rail-transient-slot");
  if (!slot) throw new Error("transient rail slot missing");
  expect(slot.getAttribute("data-motion")).toBe("enter");
  expect(screen.getByLabelText("临时工具")).toBeDefined();

  view.rerender(<TransientFunctionRailSlot open={false}>{null}</TransientFunctionRailSlot>);
  expect(slot.getAttribute("data-motion")).toBe("exit");
  expect(slot.hasAttribute("inert")).toBe(true);
  expect(slot.getAttribute("aria-hidden")).toBe("true");
  expect(slot.querySelector('[aria-label="临时工具"]')).not.toBeNull();

  act(() => vi.advanceTimersByTime(100));
  view.rerender(<TransientFunctionRailSlot open>{panel}</TransientFunctionRailSlot>);
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByLabelText("临时工具")).toBeDefined();

  view.rerender(<TransientFunctionRailSlot open={false}>{null}</TransientFunctionRailSlot>);
  act(() => vi.advanceTimersByTime(400));
  expect(document.querySelector(".function-rail-transient-slot")).not.toBeNull();
  act(() => vi.advanceTimersByTime(20));
  expect(document.querySelector(".function-rail-transient-slot")).toBeNull();
  vi.useRealTimers();
});
