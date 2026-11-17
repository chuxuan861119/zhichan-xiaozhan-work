import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useSpatialViewMotion } from "./use-spatial-view-motion";

function View({ viewKey }: { viewKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useSpatialViewMotion(ref, viewKey);
  return (
    <div ref={ref}>
      <input aria-label="草稿" defaultValue="保留草稿" />
    </div>
  );
}

test("view changes reuse timing, cancel interrupted motion, and preserve mounted drafts", () => {
  const original = HTMLElement.prototype.animate;
  const cancel = vi.fn();
  const animate = vi.fn().mockReturnValue({ cancel });
  HTMLElement.prototype.animate = animate;
  try {
    const view = render(<View viewKey="first" />);
    const input = screen.getByLabelText("草稿");
    expect(animate).not.toHaveBeenCalled();
    view.rerender(<View viewKey="second" />);
    expect(animate).toHaveBeenCalledWith(expect.any(Array), {
      duration: 400,
      easing: "ease-in-out",
    });
    view.rerender(<View viewKey="third" />);
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("草稿")).toBe(input);
    view.rerender(<View viewKey="third" />);
    expect(animate).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
  } finally {
    HTMLElement.prototype.animate = original;
  }
});

test("the reduced motion setting suppresses view motion", () => {
  const original = HTMLElement.prototype.animate;
  const animate = vi.fn();
  HTMLElement.prototype.animate = animate;
  document.documentElement.dataset.reducedMotion = "true";
  try {
    const view = render(<View viewKey="first" />);
    view.rerender(<View viewKey="second" />);
    expect(animate).not.toHaveBeenCalled();
  } finally {
    delete document.documentElement.dataset.reducedMotion;
    HTMLElement.prototype.animate = original;
  }
});
