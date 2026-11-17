type QuitApplication = {
  on(event: "before-quit" | "window-all-closed", listener: () => void): unknown;
  quit(): void;
};

/** A save handshake cancels Electron's first quit. Resume only an explicit quit on macOS. */
export function installDeferredQuit(
  application: QuitApplication,
  ready: () => boolean,
  platform: NodeJS.Platform = process.platform,
  quitOnLastWindowClose = false,
) {
  let requested = false;
  application.on("before-quit", () => {
    requested = true;
  });
  application.on("window-all-closed", () => {
    if (ready() && (quitOnLastWindowClose || platform !== "darwin" || requested))
      application.quit();
  });
  return {
    cancel() {
      requested = false;
    },
  };
}
