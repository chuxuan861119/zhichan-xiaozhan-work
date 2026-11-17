import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { usesInstalledResources } from "./platform/resource-layout.js";

export const STARTUP_SPLASH_STATUSES = [
  "正在准备工作台",
  "正在打开本地专利库",
  "正在检查数据安全状态",
  "正在加载编辑器",
  "启动仍在继续，请稍候",
] as const;

export type StartupSplashStatus = (typeof STARTUP_SPLASH_STATUSES)[number];

type SplashWindow = Pick<
  BrowserWindow,
  "destroy" | "isDestroyed" | "loadFile" | "loadURL" | "show" | "webContents"
>;

export type StartupSplash = Readonly<{
  show(): Promise<void>;
  setStatus(status: StartupSplashStatus): void;
  closeAfterMainReady(): Promise<void>;
  close(): void;
}>;

type StartupSplashOptions = Readonly<{
  createWindow?: () => SplashWindow;
  splashHtmlPath?: () => string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

const MINIMUM_VISIBLE_MS = 1_500;
const LONG_STARTUP_MS = 12_000;

export function createStartupSplash(options: StartupSplashOptions = {}): StartupSplash {
  const createWindow = options.createWindow ?? createBrowserWindow;
  const splashHtmlPath = options.splashHtmlPath ?? resolveSplashHtmlPath;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let window: SplashWindow | undefined;
  let shownAt: number | undefined;
  let closed = false;
  let longStartupTimer: ReturnType<typeof setTimeout> | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    if (longStartupTimer !== undefined) clearTimeout(longStartupTimer);
    if (window && !window.isDestroyed()) window.destroy();
  };

  const setStatus = (status: StartupSplashStatus) => {
    if (closed || !window || window.isDestroyed()) return;
    void window.webContents.executeJavaScript(
      `window.setStartupStatus(${JSON.stringify(status)});`,
    );
  };

  return {
    async show() {
      if (closed || window) return;
      window = createWindow();
      await window.loadFile(splashHtmlPath());
      shownAt = now();
      window.show();
      setStatus("正在准备工作台");
      longStartupTimer = setTimeout(() => setStatus("启动仍在继续，请稍候"), LONG_STARTUP_MS);
    },
    setStatus,
    async closeAfterMainReady() {
      if (closed) return;
      const elapsed = shownAt === undefined ? MINIMUM_VISIBLE_MS : now() - shownAt;
      if (elapsed < MINIMUM_VISIBLE_MS) await sleep(MINIMUM_VISIBLE_MS - elapsed);
      if (window && !window.isDestroyed()) {
        try {
          const reduced = await window.webContents.executeJavaScript(
            "document.body.dataset.motion = 'exit'; matchMedia('(prefers-reduced-motion: reduce)').matches",
          );
          if (!reduced) await sleep(400);
        } catch {
          // A destroyed splash renderer must never prevent opening the workbench.
        }
      }
      close();
    },
    close,
  };
}

function createBrowserWindow(): SplashWindow {
  return new BrowserWindow({
    // 1032 × 615 is the approved artwork aspect ratio.
    width: 517,
    height: 308,
    center: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    transparent: true,
    hasShadow: false,
    roundedCorners: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

export function resolveStartupSplashPath(
  isPackaged: boolean,
  platform: string,
  resourcesPath: string,
  moduleDirectory: string,
): string {
  return usesInstalledResources(isPackaged, platform)
    ? join(resourcesPath, "resources", "startup-splash.html")
    : join(moduleDirectory, "../../resources/startup-splash.html");
}
function resolveSplashHtmlPath(): string {
  return resolveStartupSplashPath(
    app.isPackaged,
    process.platform,
    process.resourcesPath,
    __dirname,
  );
}
