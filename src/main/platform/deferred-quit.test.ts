import { installDeferredQuit } from "./deferred-quit.js";

test("disposable tutorial instances quit on the last native window close even on macOS", () => {
  const listeners = new Map<string, () => void>();
  const app = { on: (event: string, fn: () => void) => listeners.set(event, fn), quit: vi.fn() };
  installDeferredQuit(app, () => true, "darwin", true);
  listeners.get("window-all-closed")?.();
  expect(app.quit).toHaveBeenCalledOnce();
});

test("macOS resumes explicit quit after asynchronous save, while normal close and cancellation keep the app alive", () => {
  const listeners = new Map<string, () => void>();
  const app = { on: (event: string, fn: () => void) => listeners.set(event, fn), quit: vi.fn() };
  let ready = false;
  const state = installDeferredQuit(app, () => ready, "darwin");
  listeners.get("window-all-closed")?.();
  expect(app.quit).not.toHaveBeenCalled();
  ready = true;
  listeners.get("window-all-closed")?.();
  expect(app.quit).not.toHaveBeenCalled();
  listeners.get("before-quit")?.();
  state.cancel();
  listeners.get("window-all-closed")?.();
  expect(app.quit).not.toHaveBeenCalled();
  listeners.get("before-quit")?.();
  listeners.get("window-all-closed")?.();
  expect(app.quit).toHaveBeenCalledOnce();
});
