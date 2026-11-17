// @vitest-environment node
import { EventEmitter } from "node:events";
import type { BrowserWindow, PowerMonitor } from "electron";
import { expect, test, vi } from "vitest";
import { UsageActivity } from "./usage-activity.js";

class Window extends EventEmitter {
  visible = true;
  minimized = false;
  focused = true;
  destroyed = false;
  children: Window[] = [];
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  isFocused() {
    return this.focused;
  }
  isDestroyed() {
    return this.destroyed;
  }
  getChildWindows() {
    return this.children as unknown as BrowserWindow[];
  }
}

test.each(["openharmony", "ohos"])(
  "%s queries native lock/display state instead of unsupported idle APIs",
  async (platform) => {
    const root = new Window();
    const power = Object.assign(new EventEmitter(), {
      getSystemIdleState: vi.fn(() => {
        throw Error("unsupported");
      }),
    });
    let result = { active: true, locked: false };
    const read = vi.fn(async () => result);
    const activity = new UsageActivity(
      () => root as unknown as BrowserWindow,
      power as unknown as PowerMonitor,
      vi.fn(),
      platform,
      read,
    );
    try {
      expect(await activity.foreground()).toBe(true);
      result = { active: true, locked: true };
      expect(await activity.foreground()).toBe(false);
      result = { active: false, locked: false };
      expect(await activity.foreground()).toBe(false);
      result = { active: true, locked: false };
      root.focused = false;
      expect(await activity.foreground()).toBe(false);
      root.focused = true;
      read.mockRejectedValueOnce(Error("native error"));
      expect(await activity.foreground()).toBe(false);
      power.emit("suspend");
      expect(await activity.foreground()).toBe(false);
      power.emit("resume");
      expect(await activity.foreground()).toBe(true);
      expect(power.getSystemIdleState).not.toHaveBeenCalled();
    } finally {
      activity.dispose();
    }
  },
);

test("a late native result cannot resume a disposed tracker", async () => {
  const root = new Window(),
    power = Object.assign(new EventEmitter(), { getSystemIdleState: () => "unknown" });
  let resolve!: (value: { active: boolean; locked: boolean }) => void;
  const activity = new UsageActivity(
    () => root as unknown as BrowserWindow,
    power as unknown as PowerMonitor,
    vi.fn(),
    "ohos",
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = activity.foreground();
  activity.dispose();
  resolve({ active: true, locked: false });
  expect(await pending).toBe(false);
});
test("our visible focused windows count as a union; lock, sleep and missing lock capability pause", () => {
  const root = new Window();
  const power = Object.assign(new EventEmitter(), { getSystemIdleState: vi.fn(() => "active") });
  const changed = vi.fn();
  const activity = new UsageActivity(
    () => root as unknown as BrowserWindow,
    power as unknown as PowerMonitor,
    changed,
    "darwin",
  );
  activity.bind(root as unknown as BrowserWindow);
  expect(activity.foreground()).toBe(true);
  root.focused = false;
  root.emit("blur");
  expect(changed).toHaveBeenLastCalledWith(false);
  const child = new Window();
  root.children.push(child);
  expect(activity.foreground()).toBe(true);
  root.minimized = true;
  expect(activity.foreground()).toBe(false);
  root.minimized = false;
  power.emit("lock-screen");
  expect(activity.foreground()).toBe(false);
  power.emit("unlock-screen");
  expect(activity.foreground()).toBe(true);
  power.emit("suspend");
  expect(activity.foreground()).toBe(false);
  power.emit("resume");
  expect(activity.foreground()).toBe(true);
  power.getSystemIdleState.mockReturnValue("unknown");
  expect(activity.foreground()).toBe(false);
  power.getSystemIdleState.mockReturnValue("idle");
  expect(activity.foreground()).toBe(true);
  activity.dispose();
  changed.mockClear();
  root.emit("focus");
  power.emit("resume");
  expect(changed).not.toHaveBeenCalled();
});
