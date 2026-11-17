import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useReferenceMarkOrder } from "./use-reference-mark-order";

afterEach(() => vi.restoreAllMocks());
test.each([true, false])(
  "pointer drag previews and %s commits (otherwise Escape cancels)",
  (commit) => {
    let frame: FrameRequestCallback = () => {};
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const onCommit = vi.fn(() => ({ ok: true, message: "" }));
    function Harness() {
      const order = useReferenceMarkOrder(["a", "b"], onCommit);
      return (
        <>
          <div ref={order.listRef}>
            {order.order.map((id) => (
              <div key={id} data-reference-list-id={id}>
                <button type="button" onPointerDown={(event) => order.start(event, id, id)}>
                  {id}
                </button>
              </div>
            ))}
          </div>
          <span data-testid="ghost">{JSON.stringify(order.ghost)}</span>
        </>
      );
    }
    const view = render(<Harness />);
    const animate = vi.fn();
    for (const row of view.container.querySelectorAll<HTMLElement>("[data-reference-list-id]")) {
      row.animate = animate;
      Object.defineProperty(row, "offsetTop", {
        get: () => [...(row.parentElement?.children ?? [])].indexOf(row) * 50,
      });
      Object.defineProperty(row, "offsetHeight", { value: 50 });
      vi.spyOn(row, "getBoundingClientRect").mockImplementation(
        () => ({ top: row.offsetTop, left: 0, width: 200, height: 50 }) as DOMRect,
      );
    }
    const button = screen.getByRole("button", { name: "a" });
    button.setPointerCapture = vi.fn();
    button.hasPointerCapture = () => false;
    const pointer = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { pointerId: 1, button: 0, clientY: y });
      return event;
    };
    fireEvent(button, pointer("pointerdown", 10));
    fireEvent(window, pointer("pointermove", 85));
    expect(document.documentElement.dataset.referenceMarkDragging).toBe("true");
    act(() => frame(16));
    expect(JSON.parse(screen.getByTestId("ghost").textContent ?? "{}")).toMatchObject({
      id: "a",
      width: 200,
      height: 50,
    });
    expect(
      [...view.container.querySelectorAll("[data-reference-list-id]")].map((row) =>
        row.getAttribute("data-reference-list-id"),
      ),
    ).toEqual(["b", "a"]);
    expect(animate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ duration: 400, easing: "ease-in-out" }),
    );
    act(() => frame(32));
    if (commit) fireEvent(window, pointer("pointerup", 85));
    else fireEvent.keyDown(window, { key: "Escape" });
    expect(onCommit).toHaveBeenCalledTimes(commit ? 1 : 0);
    if (commit) expect(onCommit).toHaveBeenCalledWith(["b", "a"]);
    expect(JSON.parse(screen.getByTestId("ghost").textContent ?? "null")).toBeNull();
    expect(document.documentElement.dataset.referenceMarkDragging).toBeUndefined();
  },
);
