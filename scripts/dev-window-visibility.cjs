// Only the interactive development renderer may be shown by the launcher.
function installDevWindowVisibility(app, rendererUrl, onMainLoaded) {
  const mainUrl = new URL(rendererUrl).href;
  app.on("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", async () => {
      if (window.isDestroyed() || window.webContents.getURL() !== mainUrl) return;
      window.show();
      window.focus();
      await onMainLoaded?.(window);
    });
  });
}
module.exports = { installDevWindowVisibility };
