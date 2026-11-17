import type { BrowserWindow } from "electron";
import { beforeEach, expect, test, vi } from "vitest";
import { createElectronAuthorizationAttention } from "./authorization-attention-electron.js";

const native = vi.hoisted(() => ({
  supported: true,
  bounce: vi.fn(() => 12),
  cancelBounce: vi.fn(),
  show: vi.fn(),
  close: vi.fn(),
  notifications: [] as Array<{
    options: { title: string; body: string };
    emit(event: string): boolean;
  }>,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Notification extends EventEmitter {
    static isSupported() {
      return native.supported;
    }
    constructor(public options: { title: string; body: string }) {
      super();
      native.notifications.push(this);
    }
    show = native.show;
    close = native.close;
  }
  return {
    Notification,
    app: { dock: { bounce: native.bounce, cancelBounce: native.cancelBounce } },
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  native.supported = true;
  native.notifications.length = 0;
});
function fixture() {
  const window = { isFocused: () => false, isDestroyed: () => false, flashFrame: vi.fn() };
  const open = vi.fn();
  return {
    window,
    open,
    attention: createElectronAuthorizationAttention(() => window as unknown as BrowserWindow, open),
  };
}
test("native notification opens authorization only on click and is withdrawn on resolution", () => {
  const f = fixture();
  f.attention.update([{ pairId: "one", expiresAt: Date.now() + 30000 }]);
  expect(native.show).toHaveBeenCalledTimes(1);
  expect(native.notifications[0]?.options.title).toBe("Agent CLI 需要你确认授权");
  expect(f.open).not.toHaveBeenCalled();
  native.notifications[0]?.emit("failed");
  expect(f.open).not.toHaveBeenCalled();
  native.notifications[0]?.emit("click");
  expect(f.open).toHaveBeenCalledTimes(1);
  f.attention.update([]);
  expect(native.close).toHaveBeenCalledTimes(1);
  if (process.platform === "darwin") expect(native.cancelBounce).toHaveBeenCalledWith(12);
  else expect(f.window.flashFrame).toHaveBeenLastCalledWith(false);
  native.notifications[0]?.emit("click");
  expect(f.open).toHaveBeenCalledTimes(1);
  f.attention.dispose();
});
test("unsupported notifications retain the native icon reminder without opening a window", () => {
  native.supported = false;
  const f = fixture();
  f.attention.update([{ pairId: "one", expiresAt: Date.now() + 30000 }]);
  expect(native.show).not.toHaveBeenCalled();
  if (process.platform === "darwin") expect(native.bounce).toHaveBeenCalledWith("critical");
  else expect(f.window.flashFrame).toHaveBeenCalledWith(true);
  expect(f.open).not.toHaveBeenCalled();
  f.attention.dispose();
});
