import { app, type BrowserWindow, Notification } from "electron";
import { createAuthorizationAttention } from "./authorization-attention.js";

export function createElectronAuthorizationAttention(
  getWindow: () => BrowserWindow | undefined,
  openAuthorization: () => void,
) {
  return createAuthorizationAttention({
    isFocused: () => getWindow()?.isFocused() ?? false,
    openAuthorization,
    requestAttention: () => {
      if (process.platform === "darwin" && app.dock) {
        const dock = app.dock;
        const id = dock.bounce("critical");
        return () => {
          if (id >= 0) dock.cancelBounce(id);
        };
      }
      const window = getWindow();
      window?.flashFrame(true);
      return () => {
        if (window && !window.isDestroyed()) window.flashFrame(false);
      };
    },
    notify: (onClick) => {
      if (!Notification.isSupported()) return () => {};
      const notification = new Notification({
        title: "Agent CLI 需要你确认授权",
        body: "点击打开知产小栈Work，选择允许 Agent 操作的范围。未确认前任务会等待。",
      });
      notification.once("click", onClick);
      // Unsigned macOS builds or denied notifications retain the Dock/taskbar fallback.
      notification.once("failed", () => {});
      notification.show();
      return () => {
        notification.removeAllListeners();
        notification.close();
      };
    },
  });
}
