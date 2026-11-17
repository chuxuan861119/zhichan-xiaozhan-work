const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { installDevWindowVisibility } = require("./dev-window-visibility.cjs");

for (const [url, expected] of [
  ["http://localhost:5173/", 1],
  ["patent-print://document/fixture", 0],
  ["about:blank", 0],
  ["http://localhost:5173/print.html", 0],
]) {
  test(`only show main renderer: ${url}`, async () => {
    const app = new EventEmitter();
    const webContents = new EventEmitter();
    webContents.getURL = () => url;
    let shows = 0;
    let focuses = 0;
    let callbacks = 0;
    installDevWindowVisibility(app, "http://localhost:5173", () => callbacks++);
    app.emit(
      "browser-window-created",
      {},
      {
        webContents,
        isDestroyed: () => false,
        show: () => shows++,
        focus: () => focuses++,
      },
    );
    webContents.emit("did-finish-load");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shows, expected);
    assert.equal(focuses, expected);
    assert.equal(callbacks, expected);
  });
}
