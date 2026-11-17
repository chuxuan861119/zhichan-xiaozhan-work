import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const app = readFileSync("resources/ipc-data-center/app.js", "utf8");
let context: ReturnType<typeof createContext>;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="statusDisplay"></div><input id="classificationInput">';
  (window as unknown as { workbenchUi: unknown }).workbenchUi = {
    paint: vi.fn(),
    replaceContent: (_el: HTMLElement, update: () => void) => update(),
    prefersReducedMotion: () => true,
    panelDuration: 400,
  };
  context = createContext({
    window,
    document,
    setTimeout,
    clearTimeout,
    requestAnimationFrame,
    console,
  });
  runInContext(readFileSync("resources/ipc-data-center/query-core.js", "utf8"), context);
  runInContext(app, context);
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});
test("query status changes immediately and cannot be overwritten by a delayed prior update", () => {
  runInContext("updateStatusDisplay('查询中'); updateStatusDisplay('已完成')", context);
  expect(document.getElementById("statusDisplay")!.textContent).toBe("已完成");
  vi.advanceTimersByTime(500);
  expect(document.getElementById("statusDisplay")!.textContent).toBe("已完成");
});
test("classification selection commits immediately with reduced motion and creates no flight particles", () => {
  runInContext("animateCodeToInput('A01B', {clientX: 10, clientY: 20})", context);
  expect((document.getElementById("classificationInput") as HTMLInputElement).value).toBe("A01B");
  expect(document.body.children.length).toBe(2);
});

test("closing and reopening sharing reuses the same panel and resets the previous selection", () => {
  runInContext("renderShareMenu()", context);
  const menu = document.getElementById("shareMenuBottom")!;
  const button = menu.querySelector<HTMLButtonElement>("#saveImageBtn")!;
  button.disabled = false;
  button.classList.add("scale-105");
  runInContext("hideShareMenu(); renderShareMenu()", context);
  expect(document.getElementById("shareMenuBottom")).toBe(menu);
  expect(menu.classList.contains("hidden")).toBe(false);
  expect(button.disabled).toBe(true);
  expect(button.classList.contains("scale-105")).toBe(false);
});
