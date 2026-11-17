import { afterEach, expect, test, vi } from "vitest";
import { createDropdownMotion } from "./dropdown-motion";

afterEach(() => vi.restoreAllMocks());
test("a half-complete menu reverses from its current paint with the original 260ms duration", () => {
  const menu = document.createElement("div");
  vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 400));
  const animate = vi.fn((..._args: unknown[]) => ({ cancel: vi.fn() }));
  Object.defineProperty(menu, "animate", { value: animate });
  const motion = createDropdownMotion();
  motion.update(menu, true);
  expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 260 });
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    clipPath: "inset(-32px -32px calc(50% - 16px))",
    opacity: "0.5",
  } as CSSStyleDeclaration);
  motion.update(menu, false);
  expect(animate.mock.calls[1]?.[1]).toMatchObject({ duration: 260 });
  expect(animate.mock.calls[1]?.[0]).toEqual([
    { opacity: "0.5", clipPath: "inset(-32px -32px calc(50% - 16px))" },
    { opacity: 0, clipPath: "inset(-32px -32px 100% -32px)" },
  ]);
  motion.dispose();
});

test("a menu anchored above its trigger reveals upward and closes toward the trigger", () => {
  const menu = document.createElement("div");
  menu.style.setProperty("--dropdown-open-direction", "up");
  const animate = vi.fn((..._args: unknown[]) => ({ cancel: vi.fn() }));
  Object.defineProperty(menu, "animate", { value: animate });
  const motion = createDropdownMotion();
  motion.update(menu, true);
  expect(animate.mock.calls[0]?.[0]).toEqual([
    { opacity: "0", clipPath: "inset(100% -32px -32px -32px)" },
    { opacity: 1, clipPath: "inset(-32px -32px -32px -32px)", offset: 0.9999 },
    { opacity: 1, clipPath: "none" },
  ]);
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    clipPath: "none",
    opacity: "1",
    getPropertyValue: () => "up",
  } as unknown as CSSStyleDeclaration);
  motion.update(menu, false);
  expect(animate.mock.calls[1]?.[0]).toEqual([
    { opacity: "1", clipPath: "inset(-32px -32px -32px -32px)" },
    { opacity: 0, clipPath: "inset(100% -32px -32px -32px)" },
  ]);
  motion.dispose();
});
