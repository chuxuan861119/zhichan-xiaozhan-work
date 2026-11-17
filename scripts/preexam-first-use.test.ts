import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const root = "resources/ipc-data-center/";
const noticeKey = "preexamDataNoticeAcknowledged-v1";
const removeListeners: (() => void)[] = [];
function element(id: string) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found;
}
function unloadTool() {
  for (const remove of removeListeners.splice(0)) remove();
}

function loadTool(storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
  unloadTool();
  const body = readFileSync(`${root}index.html`, "utf8").match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!body) throw new Error("Tool body missing");
  document.body.innerHTML = body[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const context = createContext({
    document,
    localStorage: storage,
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame,
    addEventListener: vi.fn(),
    parent: { postMessage: vi.fn() },
    Worker: class {
      postMessage() {}
    },
    ResizeObserver: class {
      observe() {}
    },
    workbenchUi: {
      paint: vi.fn(),
      replaceContent: (_element: HTMLElement, update: () => void) => update(),
    },
  });
  context.window = context;
  const addListener = document.addEventListener.bind(document);
  const spy = vi
    .spyOn(document, "addEventListener")
    .mockImplementation((type, listener, options) => {
      addListener(type, listener, options);
      removeListeners.push(() => document.removeEventListener(type, listener, options));
    });
  try {
    for (const file of ["query-core.js", "app.js", "platform.js"])
      runInContext(readFileSync(root + file, "utf8"), context);
  } finally {
    spy.mockRestore();
  }
  runInContext(
    "setDatabaseInitializationState(false); protectionCenterDatabase = { 辽宁: { 辽宁省保护中心: { ipc: ['A61B'], locarno: ['23-03'] } } }",
    context,
  );
  return context;
}

beforeEach(() => localStorage.clear());
afterEach(unloadTool);

test("first center visit asks once, then proceeds and stays acknowledged across reloads", () => {
  let context = loadTool();
  runInContext("openProtectionCenterModal()", context);
  const notice = element("preexamDataNoticeModal");
  expect(notice.classList.contains("hidden")).toBe(false);
  expect(notice.textContent).toContain("预审数据库正在持续完善");
  expect(element("protectionCenterModal").classList.contains("hidden")).toBe(true);
  expect(localStorage.getItem(noticeKey)).toBeNull();
  element("acknowledgePreexamDataNotice").click();
  expect(notice.classList.contains("hidden")).toBe(true);
  expect(element("protectionCenterModal").classList.contains("hidden")).toBe(false);
  expect(localStorage.getItem(noticeKey)).toBe("1");
  context = loadTool();
  runInContext("openProtectionCenterModal()", context);
  expect(element("preexamDataNoticeModal").classList.contains("hidden")).toBe(true);
  expect(element("protectionCenterModal").classList.contains("hidden")).toBe(false);
});

test("preexam button and detail tab share the same first-use acknowledgement", () => {
  const context = loadTool();
  const query = vi.fn();
  context.queryPreExam = query;
  element("preExamBtn").click();
  expect(element("preexamDataNoticeModal").classList.contains("hidden")).toBe(false);
  expect(query).not.toHaveBeenCalled();
  element("acknowledgePreexamDataNotice").click();
  expect(query).toHaveBeenCalledTimes(1);
  runInContext("openProtectionCenterModal()", context);
  expect(element("preexamDataNoticeModal").classList.contains("hidden")).toBe(true);

  localStorage.clear();
  const fresh = loadTool();
  runInContext("switchIpcModalView('preExam')", fresh);
  expect(element("preexamDataNoticeModal").classList.contains("hidden")).toBe(false);
});

test("Escape dismisses the top notice without closing its underlying dialog", () => {
  const context = loadTool();
  runInContext(
    "openToolModal(document.getElementById('ipcDetailModal')); showPreexamDataNoticeOnce(() => {})",
    context,
  );
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(element("preexamDataNoticeModal").classList.contains("hidden")).toBe(true);
  expect(element("ipcDetailModal").classList.contains("hidden")).toBe(false);
});

test("blocked local storage still allows use and only shows once in the current session", () => {
  const context = loadTool({
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  });
  runInContext("openProtectionCenterModal()", context);
  element("acknowledgePreexamDataNotice").click();
  runInContext("closeProtectionCenterModal(); openProtectionCenterModal()", context);
  expect(element("preexamDataNoticeModal").classList.contains("hidden")).toBe(true);
  expect(element("protectionCenterModal").classList.contains("hidden")).toBe(false);
});
