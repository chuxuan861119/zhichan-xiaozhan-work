import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { useLibraryListMotion } from "./use-library-list-motion";

function List({ layout }: { layout: string }) {
  const ref = useRef<HTMLElement>(null);
  const capture = useLibraryListMotion(ref, layout);
  return (
    <section ref={ref}>
      <button type="button" onClick={() => capture()}>
        准备切换
      </button>
      <article data-library-item-key="same-patent">
        <input defaultValue="保留内容" />
      </article>
    </section>
  );
}

test("interrupted changes resume from the visible position and never retain an older animation", () => {
  const originalAnimate = HTMLElement.prototype.animate;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const cancel = vi.fn();
  const animate = vi.fn().mockImplementation(() => ({ cancel, onfinish: null }));
  let left = 0;
  HTMLElement.prototype.animate = animate;
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left, top: 0, right: left + 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
  try {
    const view = render(<List layout="single" />);
    const input = view.container.querySelector("input");
    fireEvent.click(view.getByText("准备切换"));
    left = 220;
    view.rerender(<List layout="double" />);
    expect(animate.mock.calls.at(-1)?.[0][0].transform).toBe("translate(-220px, 0px)");
    left = 70; // Current painted position part way through the first transition.
    fireEvent.click(view.getByText("准备切换"));
    expect(cancel).toHaveBeenCalledOnce();
    left = 0;
    view.rerender(<List layout="single" />);
    expect(animate.mock.calls.at(-1)?.[0][0].transform).toBe("translate(70px, 0px)");
    expect(view.container.querySelector("input")).toBe(input);
    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});

test("passive updates and application reduced motion do not replay stale positions", () => {
  const original = HTMLElement.prototype.animate;
  const animate = vi.fn();
  HTMLElement.prototype.animate = animate;
  try {
    const view = render(<List layout="single" />);
    view.rerender(<List layout="double" />);
    expect(animate).not.toHaveBeenCalled();
    document.documentElement.dataset.reducedMotion = "true";
    fireEvent.click(view.getByText("准备切换"));
    view.rerender(<List layout="single" />);
    expect(animate).not.toHaveBeenCalled();
  } finally {
    delete document.documentElement.dataset.reducedMotion;
    HTMLElement.prototype.animate = original;
  }
});

test("measures only cards reported near the viewport and disconnects on unmount", () => {
  let notify: IntersectionObserverCallback = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  const view = render(<List layout="single" />);
  const card = view.container.querySelector("article");
  if (!card) throw new Error("Missing patent card");
  const rect = vi.spyOn(card, "getBoundingClientRect");
  try {
    fireEvent.click(view.getByText("准备切换"));
    expect(rect).not.toHaveBeenCalled();
    notify(
      [{ target: card, isIntersecting: true } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    fireEvent.click(view.getByText("准备切换"));
    expect(rect).toHaveBeenCalledOnce();
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  } finally {
    rect.mockRestore();
    vi.unstubAllGlobals();
  }
});
