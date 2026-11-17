import { randomUUID } from "node:crypto";

type TrayWindow = {
  hide(): void;
  show(): void;
  restore(): void;
  focus(): void;
  close(): void;
  isMinimized(): boolean;
  isDestroyed(): boolean;
  showInactive?(): void;
};
export function createTrayController(options: {
  window: TrayWindow;
  available(): boolean;
  requestSave(token: string): void;
  updateStatus(text: string): void;
  notify(message: string): void;
  showIntro(): void;
}) {
  let enabled = true;
  let quitting = false;
  let hidden = false;
  let pending: string | null = null;
  let saveAgain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    if (options.window.isDestroyed()) return;
    hidden = false;
    if (options.window.isMinimized()) options.window.restore();
    options.window.show();
    options.window.focus();
    if (!pending) options.updateStatus("保存状态：在窗口中查看");
  };
  const alert = (message: string) => {
    hidden = false;
    if (!options.window.isDestroyed()) {
      if (options.window.showInactive) options.window.showInactive();
      else options.window.show();
    }
    options.notify(message);
  };
  const startSave = () => {
    pending = randomUUID();
    options.updateStatus("后台保存：正在保存…");
    timer = setTimeout(
      () => alert("后台保存耗时较长，请打开窗口检查。软件仍在运行，不会强制退出。"),
      30_000,
    );
    timer.unref?.();
    try {
      options.requestSave(pending);
    } catch {
      pending = null;
      clearTimeout(timer);
      options.updateStatus("后台保存：失败");
      alert("无法联系编辑界面，请打开窗口检查保存状态。");
    }
  };
  return {
    open,
    setEnabled(value: boolean) {
      enabled = value;
    },
    beginQuit() {
      quitting = true;
    },
    quit() {
      open();
      quitting = true;
      options.window.close();
    },
    cancelQuit() {
      quitting = false;
      alert("退出未完成，请在主窗口处理未保存内容。");
    },
    tryHide() {
      if (quitting || !enabled || !options.available()) return false;
      hidden = true;
      options.window.hide();
      options.showIntro();
      if (pending) saveAgain = true;
      else startSave();
      return true;
    },
    saved(token: string, ok: boolean) {
      if (token !== pending) return;
      pending = null;
      clearTimeout(timer);
      const repeat = saveAgain;
      saveAgain = false;
      if (ok && repeat) {
        startSave();
        return;
      }
      options.updateStatus(
        ok ? (hidden ? "后台保存：已完成" : "保存状态：在窗口中查看") : "后台保存：失败",
      );
      if (!ok) alert("后台保存未完成，请在主窗口检查并重试。未保存的内容仍保留在软件中。");
    },
    dispose() {
      clearTimeout(timer);
      pending = null;
    },
  };
}
