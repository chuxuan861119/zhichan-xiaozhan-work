import { act, render } from "@testing-library/react";
import { createElement, useRef } from "react";
import { createPortal } from "react-dom";
import {
  measureDockedRailViewport,
  measureRailVisibleHeight,
  useRailVisibleHeight,
} from "./use-rail-visible-height";

test("an initially expanded rail remeasures after its portal host becomes available", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  function Probe({ target }: { target: HTMLElement | null }) {
    const ref = useRef<HTMLDivElement>(null);
    useRailVisibleHeight(ref, "overlay:true", target);
    const rail = createElement("div", {
      ref,
      "data-layout": "overlay",
      "data-testid": "measured-rail",
    });
    return target ? createPortal(rail, target) : rail;
  }
  const view = render(createElement(Probe, { target: null }));
  expect(
    view.getByTestId("measured-rail").style.getPropertyValue("--rail-visible-height"),
  ).not.toBe("");
  act(() => view.rerender(createElement(Probe, { target: host })));
  expect(
    view.getByTestId("measured-rail").style.getPropertyValue("--rail-visible-height"),
  ).not.toBe("");
  view.unmount();
  host.remove();
  vi.unstubAllGlobals();
});

test("docked scrolling fills the workspace including its padding at every page position", () => {
  const workspace = document.createElement("div");
  const slot = document.createElement("div");
  workspace.style.cssText = "overflow-y:auto;padding:20px";
  workspace.append(slot);
  document.body.append(workspace);
  Object.defineProperty(workspace, "clientHeight", { value: 600 });
  workspace.getBoundingClientRect = () => ({ top: 120 }) as DOMRect;
  vi.stubGlobal("innerHeight", 800);
  try {
    for (const top of [140, 120, 80, -300]) {
      slot.getBoundingClientRect = () => ({ top }) as DOMRect;
      expect(measureDockedRailViewport(slot)).toEqual({ offset: 120 - top, height: 600 });
    }
  } finally {
    workspace.remove();
    vi.unstubAllGlobals();
  }
});

test("reserves scrollport bottom padding so the sticky rail can return to its top", () => {
  const workspace = document.createElement("div");
  const slot = document.createElement("div");
  workspace.style.overflowY = "auto";
  workspace.style.paddingBottom = "20px";
  workspace.append(slot);
  document.body.append(workspace);
  Object.defineProperty(workspace, "clientHeight", { value: 600 });
  workspace.getBoundingClientRect = () => ({ top: 120 }) as DOMRect;
  slot.getBoundingClientRect = () => ({ top: 120 }) as DOMRect;
  vi.stubGlobal("innerHeight", 800);
  try {
    expect(measureRailVisibleHeight(slot)).toBe(568);
  } finally {
    workspace.remove();
    vi.unstubAllGlobals();
  }
});

test("does not expand the rail into offscreen space when the page has scrolled", () => {
  const workspace = document.createElement("div");
  const slot = document.createElement("div");
  workspace.style.overflowY = "auto";
  workspace.append(slot);
  document.body.append(workspace);
  Object.defineProperty(workspace, "clientHeight", { value: 600 });
  workspace.getBoundingClientRect = () => ({ top: 120 }) as DOMRect;
  slot.getBoundingClientRect = () => ({ top: -300 }) as DOMRect;
  vi.stubGlobal("innerHeight", 800);
  try {
    expect(measureRailVisibleHeight(slot)).toBe(588);
  } finally {
    workspace.remove();
    vi.unstubAllGlobals();
  }
});

test("keeps the rail above the clipped workspace bottom including a bottom gap", () => {
  const workspace = document.createElement("div");
  const slot = document.createElement("div");
  workspace.style.overflowY = "auto";
  workspace.append(slot);
  document.body.append(workspace);
  Object.defineProperty(workspace, "clientHeight", { value: 734 });
  workspace.getBoundingClientRect = () => ({ top: 112 }) as DOMRect;
  slot.getBoundingClientRect = () => ({ top: 132 }) as DOMRect;
  vi.stubGlobal("innerHeight", 872);
  try {
    expect(measureRailVisibleHeight(slot)).toBe(702);
  } finally {
    workspace.remove();
    vi.unstubAllGlobals();
  }
});
