import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useDialogDrag } from "./use-dialog-drag";
import { useSurfaceResizeMotion } from "./use-surface-resize-motion";

afterEach(() => vi.restoreAllMocks());
test("restoring a moving surface preserves its saved position while its painted size shrinks", () => {
  sessionStorage.setItem(
    "patent-workbench.dialog-position.resize-regression",
    '{"left":400,"top":100}',
  );
  let width = 400;
  let height = 200;
  let paintedWidth = width;
  let paintedHeight = height;
  const motion = { playState: "running", cancel: vi.fn() };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, width, height),
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => paintedWidth);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => paintedHeight);
  const original = HTMLElement.prototype.animate;
  HTMLElement.prototype.animate = ((frames: Keyframe[]) => {
    paintedWidth = Number.parseFloat(String(frames[0]?.width));
    paintedHeight = Number.parseFloat(String(frames[0]?.height));
    motion.playState = "running";
    return motion;
  }) as unknown as HTMLElement["animate"];
  function MovingSurface({ maximized }: { maximized: boolean }) {
    const drag = useDialogDrag<HTMLDivElement>({
      positionKey: "resize-regression",
      memory: "session",
      movable: !maximized,
    });
    useSurfaceResizeMotion(drag.surfaceRef, maximized);
    return <div data-testid="moving" ref={drag.surfaceRef} style={drag.style} />;
  }
  try {
    const view = render(<MovingSurface maximized={false} />);
    width = window.innerWidth;
    height = window.innerHeight;
    view.rerender(<MovingSurface maximized />);
    motion.playState = "finished";
    width = 400;
    height = 200;
    view.rerender(<MovingSurface maximized={false} />);
    fireEvent(window, new Event("resize"));
    expect(view.getByTestId("moving").style.left).toBe("400px");
    expect(view.getByTestId("moving").style.top).toBe("100px");
    expect(
      JSON.parse(
        sessionStorage.getItem("patent-workbench.dialog-position.resize-regression") ?? "null",
      ),
    ).toEqual({ left: 400, top: 100 });
    view.unmount();
  } finally {
    HTMLElement.prototype.animate = original;
    sessionStorage.removeItem("patent-workbench.dialog-position.resize-regression");
  }
});
function Surface({ maximized }: { maximized: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useSurfaceResizeMotion(ref, maximized);
  return <div ref={ref} />;
}
test("animates maximize/restore while pointer-driven size updates stay immediate", () => {
  let bounds = new DOMRect(50, 50, 800, 500);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => bounds);
  const cancel = vi.fn();
  const animate = vi.fn((..._args: unknown[]) => ({ cancel }));
  const original = HTMLElement.prototype.animate;
  HTMLElement.prototype.animate = animate as unknown as HTMLElement["animate"];
  try {
    const view = render(<Surface maximized={false} />);
    bounds = new DOMRect(30, 20, 850, 550);
    view.rerender(<Surface maximized={false} />);
    expect(animate).not.toHaveBeenCalled();
    bounds = new DOMRect(0, 0, 1000, 800);
    view.rerender(<Surface maximized />);
    expect(animate.mock.calls[0]?.[1]).toEqual({ duration: 400, easing: "ease-in-out" });
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { translate: "30px 20px", width: "850px", height: "550px" },
      { translate: "0 0", width: "1000px", height: "800px" },
    ]);
    view.unmount();
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    HTMLElement.prototype.animate = original;
  }
});

test("an ordinary render during resize does not replace the settled target with a halfway size", () => {
  let bounds = new DOMRect(0, 0, 800, 500);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => bounds);
  const motion = { cancel: vi.fn(), playState: "running" };
  const animate = vi.fn((_frames: Keyframe[], ..._args: unknown[]) => motion);
  const original = HTMLElement.prototype.animate;
  HTMLElement.prototype.animate = animate as unknown as HTMLElement["animate"];
  try {
    const view = render(<Surface maximized={false} />);
    bounds = new DOMRect(0, 0, 1000, 800);
    view.rerender(<Surface maximized />);
    bounds = new DOMRect(0, 0, 900, 650);
    view.rerender(<Surface maximized />);
    motion.playState = "finished";
    bounds = new DOMRect(0, 0, 800, 500);
    view.rerender(<Surface maximized={false} />);
    expect(animate.mock.calls.at(-1)?.[0]?.[0]).toMatchObject({ width: "1000px", height: "800px" });
  } finally {
    HTMLElement.prototype.animate = original;
  }
});

test("right-anchored panels resize without adding a second horizontal displacement and reverse from painted width", () => {
  let bounds = new DOMRect(857, 132, 399, 500);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => bounds);
  const cancel = vi.fn();
  const animate = vi.fn((_frames: Keyframe[], ..._args: unknown[]) => ({
    cancel,
    playState: "running",
  }));
  const original = HTMLElement.prototype.animate;
  HTMLElement.prototype.animate = animate as unknown as HTMLElement["animate"];
  function AnchoredPanel({ expanded }: { expanded: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useSurfaceResizeMotion(ref, expanded, { anchored: true });
    return <div ref={ref} />;
  }
  try {
    const view = render(<AnchoredPanel expanded={false} />);
    bounds = new DOMRect(532, 132, 724, 500);
    view.rerender(<AnchoredPanel expanded />);
    expect(animate.mock.calls[0]?.[0]?.[0]).toMatchObject({ translate: "0 0", width: "399px" });
    bounds = new DOMRect(696, 132, 560, 500);
    cancel.mockImplementation(() => {
      bounds = new DOMRect(857, 132, 399, 500);
    });
    view.rerender(<AnchoredPanel expanded={false} />);
    expect(animate.mock.calls[1]?.[0]).toEqual([
      { translate: "0 0", width: "560px", height: "500px" },
      { translate: "0 0", width: "399px", height: "500px" },
    ]);
    expect(animate.mock.calls[1]?.[1]).toEqual({ duration: 400, easing: "ease-in-out" });
    view.unmount();
  } finally {
    HTMLElement.prototype.animate = original;
  }
});
