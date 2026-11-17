import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MotionPresence } from "../app/motion-presence";
import { prefersReducedMotion } from "./motion-preference";
import { TransientFunctionRailSlot } from "./transient-function-rail-slot";

afterEach(() => {
  delete document.documentElement.dataset.reducedMotion;
  vi.unstubAllGlobals();
});

test("the explicit app switch takes priority over the system motion preference", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  expect(prefersReducedMotion()).toBe(false);
  document.documentElement.dataset.reducedMotion = "true";
  expect(prefersReducedMotion()).toBe(true);
  document.documentElement.dataset.reducedMotion = "false";
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  expect(prefersReducedMotion()).toBe(false);
  delete document.documentElement.dataset.reducedMotion;
  expect(prefersReducedMotion()).toBe(true);
});

test("a preference change releases exiting panels without waiting for their timer", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const paint = (open: boolean) => (
    <>
      <MotionPresence>{open ? <section>弹窗</section> : null}</MotionPresence>
      <TransientFunctionRailSlot open={open}>
        <section>工具面板</section>
      </TransientFunctionRailSlot>
    </>
  );
  const view = render(paint(true));
  view.rerender(paint(false));
  expect(screen.queryByText("弹窗")).not.toBeNull();
  expect(screen.queryByText("工具面板")).not.toBeNull();
  await act(async () => {
    document.documentElement.dataset.reducedMotion = "true";
  });
  expect(screen.queryByText("弹窗")).toBeNull();
  expect(screen.queryByText("工具面板")).toBeNull();
});
