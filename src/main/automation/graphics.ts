import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain } from "electron";
import { z } from "zod";
import {
  AUTOMATION_DRAWING_TILE_CHANNEL,
  type AutomationDrawingTileLease,
  type AutomationGraphicRequest,
  type AutomationGraphicResult,
} from "../../shared/automation/graphics.js";
import { AutomationError } from "../../shared/automation/protocol.js";

const resultSchema = z
  .object({
    data: z.string().max(70 * 1024 * 1024),
    width: z.number().int().positive().max(20000),
    height: z.number().int().positive().max(20000),
    mediaType: z.enum(["image/png", "image/jpeg", "image/svg+xml"]),
    pageId: z.string().min(1).max(500).optional(),
    totalPages: z.number().int().positive().optional(),
    outputWidthMm: z.number().min(10).max(165).optional(),
  })
  .strict();

const tileLeases = new Map<
  number,
  { lease: AutomationDrawingTileLease; signal: AbortSignal; running: boolean }
>();
let tileBridgeInstalled = false;
function installTileBridge() {
  if (tileBridgeInstalled) return;
  ipcMain.handle(AUTOMATION_DRAWING_TILE_CHANNEL, async (event, id: unknown) => {
    const held = tileLeases.get(event.sender.id);
    if (
      !held ||
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      typeof id !== "string" ||
      !held.lease.index.tiles.some((tile) => tile.id === id)
    )
      throw new AutomationError("SCOPE_DENIED", "图纸分块不可访问。");
    held.signal.throwIfAborted();
    if (held.running) throw new AutomationError("OPERATION_IN_PROGRESS", "图纸读取繁忙。");
    held.running = true;
    try {
      const bytes = await held.lease.readTile(id);
      held.signal.throwIfAborted();
      if (tileLeases.get(event.sender.id) !== held)
        throw new AutomationError("CANCELLED", "图纸读取已结束。");
      return bytes;
    } finally {
      held.running = false;
    }
  });
  tileBridgeInstalled = true;
}

/** Hidden, sandboxed renderer. Tiles are leased only to this task's main frame. */
export async function renderAutomationGraphic(
  request: AutomationGraphicRequest,
  signal: AbortSignal,
  tiles?: AutomationDrawingTileLease,
): Promise<AutomationGraphicResult> {
  signal.throwIfAborted();
  if (request.kind === "drawing" && request.tiledIndex && !tiles)
    throw new AutomationError("RENDER_FAILED", "分块图纸读取服务不可用。");
  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      ...(tiles
        ? { preload: fileURLToPath(new URL("../preload/automation-tiles.cjs", import.meta.url)) }
        : {}),
    },
  });
  if (tiles) {
    installTileBridge();
    tileLeases.set(window.webContents.id, { lease: tiles, signal, running: false });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new AutomationError("CANCELLED", "绘图渲染已取消。"));
    signal.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => reject(new AutomationError("TIMEOUT", "绘图渲染超时。")), 60_000);
    window.webContents.once("render-process-gone", () =>
      reject(new AutomationError("RENDER_FAILED", "绘图渲染进程退出。")),
    );
  });
  try {
    const rendered = (async () => {
      // The bundled editor only trusts the application origin, including during development.
      const url =
        request.kind !== "flowchart" && process.env.ELECTRON_RENDERER_URL
          ? new URL(
              "automation-render.html",
              `${process.env.ELECTRON_RENDERER_URL.replace(/\/$/u, "")}/`,
            ).href
          : "patent-app://app/automation-render.html";
      await window.loadURL(url);
      signal.throwIfAborted();
      return window.webContents.executeJavaScript(
        `window.automationRender(${JSON.stringify(request)})`,
        false,
      );
    })();
    const result = z
      .union([resultSchema, z.object({ error: z.string().min(1).max(1000) }).strict()])
      .parse(await Promise.race([rendered, stopped]));
    signal.throwIfAborted();
    if ("error" in result) throw new AutomationError("RENDER_FAILED", result.error);
    return result;
  } catch (error) {
    if (error instanceof AutomationError) throw error;
    throw new AutomationError("RENDER_FAILED", "图形生成失败，请检查页码、选区和源文件。");
  } finally {
    tileLeases.delete(window.webContents.id);
    signal.removeEventListener("abort", abort);
    if (timeout) clearTimeout(timeout);
    if (!window.isDestroyed()) window.destroy();
  }
}
