import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

type Ui = {
  observe(options: { selector: string; menuSelector?: string }): () => void;
  collapse(element: HTMLElement, open: boolean): void;
  replaceContent(element: HTMLElement, update: () => void, old?: HTMLElement): void;
  panelDuration: number;
  motionDuration(distance: number): number;
};
const source = readFileSync("resources/ui/workbench-ui.js", "utf8");
let ui: Ui;
let dispose: (() => void) | undefined;
let animate: ReturnType<typeof vi.fn>;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  document.documentElement.dataset.reducedMotion = "false";
  animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 20, 200, 100),
  );
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  runInThisContext(source);
  ui = (window as unknown as { workbenchUi: Ui }).workbenchUi;
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("embedded panels exit for 400ms without retaining interactive controls", async () => {
  document.body.innerHTML =
    '<div class="panel"><button id="original">确定</button><iframe></iframe></div>';
  const panel = document.querySelector<HTMLElement>(".panel")!;
  dispose = ui.observe({ selector: ".panel" });
  panel.remove();
  await flush();
  const ghost = document.querySelector<HTMLElement>('[data-workbench-paint="exit"]')!;
  expect(ghost.inert).toBe(true);
  expect(ghost.getAttribute("aria-hidden")).toBe("true");
  expect(ghost.querySelector("iframe,[id]")).toBeNull();
  vi.advanceTimersByTime(380);
  expect(ghost.isConnected).toBe(true);
  vi.advanceTimersByTime(40);
  expect(ghost.isConnected).toBe(false);
});

test("dropdowns use a fixed 260ms downward reveal and reopening removes the exit picture", async () => {
  document.body.innerHTML = '<div class="menu" role="menu"></div>';
  const menu = document.querySelector<HTMLElement>(".menu")!;
  dispose = ui.observe({ selector: ".menu" });
  expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 260, easing: "ease-in-out" });
  expect(animate.mock.calls[0]?.[0]?.[0]).toHaveProperty(
    "clipPath",
    "inset(-32px -32px 100% -32px)",
  );
  menu.hidden = true;
  await flush();
  expect(document.querySelector('[data-workbench-paint="exit"]')).not.toBeNull();
  menu.hidden = false;
  await flush();
  expect(document.querySelector('[data-workbench-paint="exit"]')).toBeNull();
});

test("ancestor visibility and reduced motion work without leaving a ghost", async () => {
  document.body.innerHTML = '<div id="parent"><div class="panel"></div></div>';
  dispose = ui.observe({ selector: ".panel" });
  document.getElementById("parent")!.style.display = "none";
  await flush();
  expect(document.querySelector('[data-workbench-paint="exit"]')).not.toBeNull();
  document.documentElement.dataset.reducedMotion = "true";
  await flush();
  expect(document.querySelector('[data-workbench-paint="exit"]')).toBeNull();
  animate.mockClear();
  document.getElementById("parent")!.style.display = "block";
  await flush();
  expect(animate).not.toHaveBeenCalled();
});

test("a quickly reopened collapse cannot be hidden by an old completion", () => {
  const panel = document.createElement("div");
  document.body.append(panel);
  panel.style.overflow = "auto";
  ui.collapse(panel, false);
  const old = animate.mock.results[0].value;
  ui.collapse(panel, true);
  old.onfinish();
  expect(panel.classList.contains("hidden")).toBe(false);
  expect(panel.inert).toBe(false);
  animate.mock.results[1].value.onfinish();
  expect(panel.style.overflow).toBe("auto");
});

test("larger dropdowns keep the original 260ms duration", () => {
  document.body.innerHTML = '<div class="menu" role="menu"></div>';
  let height = 200;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 200, height),
  );
  dispose = ui.observe({ selector: ".menu" });
  expect(animate.mock.calls.at(-1)?.[1]).toMatchObject({ duration: 260 });
  const frames = animate.mock.calls.at(-1)?.[0];
  expect(frames[1]).toMatchObject({ clipPath: "inset(-32px -32px -32px -32px)", offset: 0.9999 });
  dispose();
  height = 400;
  dispose = ui.observe({ selector: ".menu" });
  expect(animate.mock.calls.at(-1)?.[1]).toMatchObject({ duration: 260 });
});

test("a partially revealed embedded menu closes from its current paint with fixed timing", async () => {
  document.body.innerHTML = '<div class="menu" role="menu"></div>';
  const menu = document.querySelector<HTMLElement>(".menu")!;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 200, 400),
  );
  dispose = ui.observe({ selector: ".menu" });
  const computed = getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    element === menu
      ? ({
          ...computed(element),
          display: "block",
          visibility: "visible",
          opacity: "0.5",
          clipPath: "inset(-32px -32px calc(50% - 16px) -32px)",
        } as CSSStyleDeclaration)
      : computed(element),
  );
  menu.hidden = true;
  await flush();
  expect(animate.mock.calls.at(-1)?.[0]?.[0]).toMatchObject({
    opacity: "0.5",
    clipPath: "inset(-32px -32px calc(50% - 16px) -32px)",
  });
  expect(animate.mock.calls.at(-1)?.[1]).toMatchObject({ duration: 260 });
});

test("a menu reopened during its exit continues the ghost paint without flashing closed", async () => {
  document.body.innerHTML = '<div class="menu" role="menu"></div>';
  const menu = document.querySelector<HTMLElement>(".menu")!;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 200, 400),
  );
  dispose = ui.observe({ selector: ".menu" });
  menu.hidden = true;
  await flush();
  const computed = getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    element instanceof HTMLElement && element.dataset.workbenchPaint === "exit"
      ? ({
          ...computed(element),
          opacity: "0.5",
          clipPath: "inset(-32px -32px calc(50% - 16px) -32px)",
        } as CSSStyleDeclaration)
      : computed(element),
  );
  menu.hidden = false;
  await flush();
  expect(animate.mock.calls.at(-1)?.[0]?.[0]).toMatchObject({
    opacity: "0.5",
    clipPath: "inset(-32px -32px calc(50% - 16px) -32px)",
  });
  expect(animate.mock.calls.at(-1)?.[1]).toMatchObject({ duration: 260 });
});

test("panel duration stays fixed for both short and long travel", () => {
  expect(ui.panelDuration).toBe(400);
  expect(ui.motionDuration(6)).toBe(400);
  expect(ui.motionDuration(400)).toBe(400);
});

test("replacing a complete IPC surface paints all siblings and makes the old surface inert", () => {
  document.body.innerHTML = '<div id="result"><p>旧标题</p><button>旧操作</button></div>';
  const surface = document.getElementById("result")!;
  ui.replaceContent(
    surface,
    () => {
      surface.innerHTML = "<h3>新标题</h3><button>新操作</button>";
    },
    surface,
  );
  const ghost = document.querySelector<HTMLElement>('[data-workbench-paint="exit"]')!;
  expect(ghost.textContent).toBe("旧标题旧操作");
  expect(ghost.inert).toBe(true);
  expect(animate.mock.instances.at(-1)).toBe(surface);
  expect(surface.textContent).toBe("新标题新操作");
});

test("reversing a disclosure preserves its current opacity as well as its height", () => {
  const panel = document.createElement("div");
  document.body.append(panel);
  ui.collapse(panel, true);
  vi.spyOn(window, "getComputedStyle").mockReturnValue({ opacity: "0.4" } as CSSStyleDeclaration);
  ui.collapse(panel, false);
  expect(animate.mock.calls.at(-1)?.[0]?.[0]).toMatchObject({ height: "100px", opacity: "0.4" });
});

test("replacing content during its entry retains the painted opacity without flashing", () => {
  const surface = document.createElement("div");
  surface.innerHTML = "<p>旧状态</p>";
  document.body.append(surface);
  vi.spyOn(window, "getComputedStyle").mockReturnValue({ opacity: "0.25" } as CSSStyleDeclaration);
  ui.replaceContent(
    surface,
    () => {
      surface.textContent = "新状态";
    },
    surface,
  );
  expect(animate.mock.calls[0]?.[0]?.[0]).toMatchObject({ opacity: "0.25" });
});
