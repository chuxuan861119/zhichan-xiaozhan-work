import { act, fireEvent, render } from "@testing-library/react";
import { useDialogDrag } from "./use-dialog-drag";

type DragHarnessProps = {
  positionKey?: string;
  stackable?: boolean;
  memory?: "persistent" | "session" | "none";
  movable?: boolean;
};

function DragHarness({
  positionKey = "test-dialog",
  stackable = false,
  memory = "persistent",
  movable = true,
}: DragHarnessProps) {
  const drag = useDialogDrag<HTMLDivElement>({ positionKey, stackable, memory, movable });
  return (
    <div
      data-testid={`${positionKey}-layer`}
      style={drag.layerStyle}
      onPointerDownCapture={drag.bringToFront}
    >
      <div
        ref={drag.surfaceRef}
        data-testid={`${positionKey}-surface`}
        style={{ width: 400, height: 200, ...drag.style }}
      >
        <header data-testid={`${positionKey}-titlebar`} ref={drag.titleBarRef} />
      </div>
    </div>
  );
}

describe("useDialogDrag", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
  });

  it("does not read or write position memory and resets when dragging is disabled", () => {
    localStorage.setItem("patent-workbench.dialog-position.test-dialog", '{"left":333,"top":222}');
    const view = render(<DragHarness memory="none" />);
    const surface = view.getByTestId("test-dialog-surface");
    expect(surface.style.left).toBe("");
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 80, 400, 200));
    fireEvent.pointerDown(view.getByTestId("test-dialog-titlebar"), {
      button: 0,
      clientX: 120,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 220, clientY: 200, pointerId: 1 });
    expect(surface.style.left).toBe("200px");
    view.rerender(<DragHarness memory="none" movable={false} />);
    fireEvent.pointerMove(window, { buttons: 1, clientX: 500, clientY: 500, pointerId: 1 });
    expect(surface.style.position).toBe("");
    view.rerender(<DragHarness memory="none" />);
    expect(surface.style.left).toBe("");
    expect(localStorage.getItem("patent-workbench.dialog-position.test-dialog")).toBe(
      '{"left":333,"top":222}',
    );
    expect(sessionStorage.getItem("patent-workbench.dialog-position.test-dialog")).toBeNull();
  });

  it("moves a dialog from its current location and clamps it to the viewport", () => {
    const { getByTestId } = render(<DragHarness />);
    const surface = getByTestId("test-dialog-surface");
    const titlebar = getByTestId("test-dialog-titlebar");
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 80,
      left: 100,
      top: 80,
      right: 500,
      bottom: 280,
      width: 400,
      height: 200,
      toJSON: () => undefined,
    });

    fireEvent.pointerDown(titlebar, {
      button: 0,
      clientX: 140,
      clientY: 120,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 1100,
      clientY: 900,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, { clientX: 1100, clientY: 900, pointerId: 1 });

    expect(surface.style.position).toBe("fixed");
    expect(surface.style.left).toBe("624px");
    expect(surface.style.top).toBe("500px");
  });

  it("ignores non-primary pointer buttons", () => {
    const { getByTestId } = render(<DragHarness />);
    const surface = getByTestId("test-dialog-surface");
    const titlebar = getByTestId("test-dialog-titlebar");
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 80,
      left: 100,
      top: 80,
      right: 500,
      bottom: 280,
      width: 400,
      height: 200,
      toJSON: () => undefined,
    });

    act(() => {
      fireEvent.pointerDown(titlebar, {
        button: 2,
        clientX: 140,
        clientY: 120,
        pointerId: 2,
      });
      fireEvent.pointerMove(window, {
        buttons: 2,
        clientX: 300,
        clientY: 300,
        pointerId: 2,
      });
    });

    expect(surface.style.position).toBe("");
  });

  it("stops when mouse release was missed and on window blur", () => {
    const { getByTestId } = render(<DragHarness />);
    const surface = getByTestId("test-dialog-surface");
    const titlebar = getByTestId("test-dialog-titlebar");
    fireEvent.pointerDown(titlebar, {
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 10,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
    const position = surface.style.left;
    fireEvent.pointerMove(window, { buttons: 0, clientX: 300, clientY: 300, pointerId: 1 });
    expect(surface.style.left).toBe(position);
    fireEvent.pointerDown(titlebar, {
      button: 0,
      buttons: 1,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.blur(window);
    fireEvent.pointerMove(window, { buttons: 1, clientX: 500, clientY: 500, pointerId: 1 });
    expect(surface.style.left).toBe(position);
    fireEvent.pointerDown(titlebar, {
      button: 0,
      buttons: 1,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent(titlebar, new Event("lostpointercapture"));
    fireEvent.pointerMove(window, { buttons: 1, clientX: 500, clientY: 500, pointerId: 1 });
    expect(surface.style.left).toBe(position);
  });

  it.each(["persistent", "session"] as const)(
    "remembers the last position with %s memory",
    (memory) => {
      const first = render(<DragHarness memory={memory} />);
      const surface = first.getByTestId("test-dialog-surface");
      vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
        x: 100,
        y: 80,
        left: 100,
        top: 80,
        right: 500,
        bottom: 280,
        width: 400,
        height: 200,
        toJSON: () => undefined,
      });
      fireEvent.pointerDown(first.getByTestId("test-dialog-titlebar"), {
        button: 0,
        clientX: 140,
        clientY: 120,
        pointerId: 3,
      });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 240, clientY: 220, pointerId: 3 });
      fireEvent.pointerUp(window, { clientX: 240, clientY: 220, pointerId: 3 });
      first.unmount();

      const second = render(<DragHarness memory={memory} />);
      expect(second.getByTestId("test-dialog-surface").style.left).toBe("200px");
      expect(second.getByTestId("test-dialog-surface").style.top).toBe("180px");
      if (memory === "session") {
        expect(
          window.localStorage.getItem("patent-workbench.dialog-position.test-dialog"),
        ).toBeNull();
        second.unmount();
        window.sessionStorage.clear();
        const restarted = render(<DragHarness memory="session" />);
        expect(restarted.getByTestId("test-dialog-surface").style.position).toBe("");
      }
    },
  );

  it("ignores positions from previous runs for session-only dialogs", () => {
    window.localStorage.setItem(
      "patent-workbench.dialog-position.test-dialog",
      JSON.stringify({ left: 200, top: 180 }),
    );
    const view = render(<DragHarness memory="session" />);
    expect(view.getByTestId("test-dialog-surface").style.position).toBe("");
  });

  it("places the later modeless dialog on top and raises a clicked dialog", () => {
    const first = render(<DragHarness positionKey="first" stackable />);
    const second = render(<DragHarness positionKey="second" stackable />);
    const stackOrder = (element: HTMLElement) =>
      Number(element.style.getPropertyValue("--modeless-dialog-stack-order"));

    expect(stackOrder(second.getByTestId("second-layer"))).toBeGreaterThan(
      stackOrder(first.getByTestId("first-layer")),
    );

    fireEvent.pointerDown(first.getByTestId("first-surface"), { button: 0 });

    expect(stackOrder(first.getByTestId("first-layer"))).toBeGreaterThan(
      stackOrder(second.getByTestId("second-layer")),
    );

    second.unmount();
    expect(stackOrder(first.getByTestId("first-layer"))).toBe(1);

    const third = render(<DragHarness positionKey="third" stackable />);
    expect(stackOrder(third.getByTestId("third-layer"))).toBe(2);
  });
});
