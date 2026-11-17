import type { BrowserWindow, PowerMonitor } from "electron";

type Window = Pick<
  BrowserWindow,
  | "isDestroyed"
  | "isVisible"
  | "isMinimized"
  | "isFocused"
  | "getChildWindows"
  | "on"
  | "removeListener"
>;
type Power = Pick<PowerMonitor, "getSystemIdleState" | "on" | "removeListener">;
/** Reads only our windows and the system lock state; idle time and input are not collected. */
export class UsageActivity {
  private suspended = false;
  private locked = false;
  private disposed = false;
  private windows = new Set<Window>();
  private readonly powerListeners: Array<[string, () => void]>;
  constructor(
    private readonly root: () => Window | undefined,
    private readonly power: Power,
    private readonly changed: (active: boolean) => void,
    private readonly platform: string = process.platform,
    private readonly readHarmonyActivity?: () => Promise<{ active: boolean; locked: boolean }>,
  ) {
    this.powerListeners = [
      [
        "suspend",
        () => {
          this.suspended = true;
          this.changed(false);
        },
      ],
      [
        "resume",
        () => {
          this.suspended = false;
          this.update();
        },
      ],
      [
        "lock-screen",
        () => {
          this.locked = true;
          this.changed(false);
        },
      ],
      [
        "unlock-screen",
        () => {
          this.locked = false;
          this.update();
        },
      ],
      [
        "user-did-resign-active",
        () => {
          this.locked = true;
          this.changed(false);
        },
      ],
      [
        "user-did-become-active",
        () => {
          this.locked = false;
          this.update();
        },
      ],
    ];
    if (["openharmony", "ohos"].includes(platform)) this.powerListeners.splice(2);
    for (const [event, listener] of this.powerListeners)
      this.power.on(event as "suspend", listener);
  }
  foreground(): boolean | Promise<boolean> {
    if (
      !["darwin", "win32", "openharmony", "ohos"].includes(this.platform) ||
      this.disposed ||
      this.suspended ||
      this.locked
    )
      return false;
    const root = this.root();
    if (!root || root.isDestroyed() || !root.isVisible() || root.isMinimized()) return false;
    if (["openharmony", "ohos"].includes(this.platform)) {
      if (!this.readHarmonyActivity) return false;
      const generation = this.generation;
      return this.readHarmonyActivity()
        .then(
          (state) =>
            generation === this.generation &&
            !this.disposed &&
            !this.suspended &&
            state.active === true &&
            state.locked === false &&
            this.windowsFocused(),
        )
        .catch(() => false);
    }
    try {
      const lockState = this.power.getSystemIdleState(60);
      if (lockState !== "active" && lockState !== "idle") return false;
    } catch {
      return false;
    }
    return this.windowsFocused();
  }
  private windowsFocused() {
    const root = this.root();
    if (!root || root.isDestroyed() || !root.isVisible() || root.isMinimized()) return false;
    const owned = [root, ...root.getChildWindows()];
    for (const window of owned) this.bind(window);
    return owned.some(
      (window) =>
        !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocused(),
    );
  }
  private generation = 0;
  private update = () => {
    const generation = ++this.generation;
    if (this.disposed) return;
    const active = this.foreground();
    if (typeof active === "boolean") this.changed(active);
    else
      void active.then((value) => {
        if (!this.disposed && generation === this.generation) this.changed(value);
      });
  };
  bind(window: Window) {
    if (this.disposed || this.windows.has(window)) return;
    this.windows.add(window);
    for (const event of ["focus", "blur", "show", "hide", "minimize", "restore", "closed"])
      window.on(event as "focus", this.update);
  }
  refresh() {
    this.update();
  }
  dispose() {
    this.disposed = true;
    for (const [event, listener] of this.powerListeners)
      this.power.removeListener(event as "suspend", listener);
    for (const window of this.windows) {
      for (const event of ["focus", "blur", "show", "hide", "minimize", "restore", "closed"])
        window.removeListener(event as "focus", this.update);
    }
    this.windows.clear();
  }
}
