import { createSpatialFloatingPaintMotion } from "./spatial-floating-paint-motion";

test("plugin exits keep only inert paint and cancel it on reopening or disposal", () => {
  vi.useFakeTimers();
  const original = HTMLElement.prototype.animate;
  const cancel = vi.fn();
  const animate = vi.fn().mockReturnValue({ cancel });
  HTMLElement.prototype.animate = animate;
  const element = document.createElement("div");
  element.id = "menu";
  element.innerHTML = '<button id="item">格式</button>';
  const motion = createSpatialFloatingPaintMotion();
  try {
    motion.prepare();
    motion.enter(element);
    motion.enter(element);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(expect.any(Array), {
      duration: 400,
      easing: "ease-in-out",
    });
    motion.exit(element);
    const paint = document.querySelector<HTMLElement>('[data-spatial-paint="exit"]');
    expect(paint?.inert).toBe(true);
    expect(paint?.getAttribute("aria-hidden")).toBe("true");
    expect(paint?.querySelector("[id]")).toBeNull();
    vi.advanceTimersByTime(300);
    expect(paint?.isConnected).toBe(true);
    motion.prepare();
    expect(paint?.isConnected).toBe(false);
    motion.enter(element);
    motion.exit(element);
    vi.advanceTimersByTime(420);
    expect(document.querySelector('[data-spatial-paint="exit"]')).toBeNull();
    document.documentElement.dataset.reducedMotion = "true";
    motion.prepare();
    motion.enter(element);
    motion.exit(element);
    expect(document.querySelector('[data-spatial-paint="exit"]')).toBeNull();
  } finally {
    motion.dispose();
    delete document.documentElement.dataset.reducedMotion;
    HTMLElement.prototype.animate = original;
    vi.useRealTimers();
  }
});

test("selection toolbar exits from its current location and opacity", () => {
  const original = HTMLElement.prototype.animate;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;
  const element = document.createElement("div");
  const bounds = vi
    .spyOn(element, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(10, 20, 200, 40));
  const motion = createSpatialFloatingPaintMotion();
  try {
    motion.prepare();
    motion.enter(element);
    bounds.mockReturnValue(new DOMRect(80, 120, 200, 40));
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ opacity: "0.4" } as CSSStyleDeclaration);
    motion.exit(element);
    const paint = document.querySelector<HTMLElement>('[data-spatial-paint="exit"]');
    expect(paint?.style.left).toBe("80px");
    expect(paint?.style.top).toBe("120px");
    expect(animate.mock.calls.at(-1)?.[0]?.[0]).toMatchObject({ opacity: "0.4" });
  } finally {
    motion.dispose();
    HTMLElement.prototype.animate = original;
    vi.restoreAllMocks();
  }
});
