import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useAssistantPanelBounds } from "./use-assistant-panel-bounds";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("tracks dual content bounds and restores single-pane defaults", () => {
  let resize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  let top = 180;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return {
      top: this.className === "status-bar" ? 700 : top,
      bottom: 700,
      height: 520,
    } as DOMRect;
  });
  function Fixture({ dual }: { dual: boolean }) {
    const ref = useAssistantPanelBounds(dual);
    return (
      <div ref={ref} data-testid="shell">
        <div className="dual-document-pane__body" />
        <div className="status-bar" />
      </div>
    );
  }
  const view = render(<Fixture dual />);
  const shell = view.getByTestId("shell");
  expect(shell.style.getPropertyValue("--assistant-panel-top")).toBe("196px");
  top = 210;
  resize();
  expect(shell.style.getPropertyValue("--assistant-panel-top")).toBe("226px");
  expect(shell.style.getPropertyValue("--assistant-panel-bottom")).toBe(
    `${window.innerHeight - 700 + 16}px`,
  );
  view.rerender(<Fixture dual={false} />);
  expect(shell.style.getPropertyValue("--assistant-panel-top")).toBe("");
  expect(shell.style.getPropertyValue("--assistant-panel-bottom")).toBe("");
});
