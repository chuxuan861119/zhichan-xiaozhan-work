import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FloatingHelp } from "./floating-help";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("a focused switch survives resize-induced pointerout but real pointer movement still dismisses", () => {
  vi.useFakeTimers();
  render(
    <>
      <button type="button" className="help-target">
        功能
      </button>
      <FloatingHelp
        target=".help-target"
        ariaLabel="功能说明"
        className="help"
        renderPanel={(_, toggle) => (
          <button type="button" onClick={toggle}>
            详细介绍
          </button>
        )}
      />
    </>,
  );
  fireEvent.pointerMove(screen.getByRole("button", { name: "功能" }));
  act(() => vi.advanceTimersByTime(600));
  const control = screen.getByRole("button", { name: "详细介绍" });
  act(() => control.focus());
  fireEvent(control, new MouseEvent("pointermove", { bubbles: true, clientX: 10, clientY: 20 }));
  fireEvent.click(control);
  fireEvent(
    control,
    new MouseEvent("pointerout", {
      bubbles: true,
      relatedTarget: document.body,
      clientX: 10,
      clientY: 20,
    }),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent(
    control,
    new MouseEvent("pointerout", {
      bubbles: true,
      relatedTarget: document.body,
      clientX: 100,
      clientY: 200,
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("help preserves menu state and only removes its own description", () => {
  vi.useFakeTimers();
  const view = render(
    <>
      <button
        type="button"
        className="help-target"
        aria-expanded="false"
        aria-controls="menu"
        aria-describedby="existing"
      >
        说明书
      </button>
      <FloatingHelp
        target=".help-target"
        ariaLabel="功能说明"
        className="help"
        renderPanel={() => "说明"}
      />
    </>,
  );
  const button = screen.getByRole("button");
  fireEvent.pointerMove(button);
  act(() => vi.advanceTimersByTime(600));
  const panel = screen.getByRole("dialog");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(button.getAttribute("aria-controls")).toBe("menu");
  expect(button.getAttribute("aria-describedby")).toBe(`existing ${panel.id}`);
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-describedby", `existing ${panel.id} another`);
  fireEvent.pointerOut(button, { relatedTarget: document.body });
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(button.getAttribute("aria-controls")).toBe("menu");
  expect(button.getAttribute("aria-describedby")).toBe("existing another");
  view.unmount();
});
