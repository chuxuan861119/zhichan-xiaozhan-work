import type { Session } from "electron";
import { usesInstalledResources } from "./platform/resource-layout.js";

const DEVELOPMENT_RENDERER_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const OUTBOUND_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
export const OUTBOUND_URL_PATTERNS = [
  "http://*/*",
  "https://*/*",
  "ws://*/*",
  "wss://*/*",
] as const;

export function isAllowedRendererUrl(candidate: string, isPackaged: boolean): boolean {
  try {
    const parsed = new URL(candidate);

    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return false;
    }

    if (isPackaged) {
      return (
        parsed.protocol === "file:" &&
        parsed.hostname === "" &&
        parsed.pathname.toLowerCase().endsWith("/index.html")
      );
    }

    const port = Number(parsed.port);
    return (
      parsed.protocol === "http:" &&
      DEVELOPMENT_RENDERER_HOSTS.has(parsed.hostname) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535 &&
      parsed.pathname === "/"
    );
  } catch {
    return false;
  }
}

export function shouldCancelOutboundRequest(candidate: string, isPackaged: boolean): boolean {
  if (!isPackaged) return false;
  try {
    return OUTBOUND_PROTOCOLS.has(new URL(candidate).protocol);
  } catch {
    return false;
  }
}

export function shouldEnforceOfflinePolicy(
  isPackaged: boolean,
  testFlag = process.env.PATENT_WORKBENCH_TEST,
  platform: string = process.platform,
): boolean {
  return usesInstalledResources(isPackaged, platform) || testFlag === "1";
}

export function isAllowedPrintNavigationUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol === "patent-print:" &&
      parsed.hostname === "job" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      /^\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        parsed.pathname,
      )
    );
  } catch {
    return false;
  }
}

/** The diagram editor is an isolated, local-only iframe origin. */
export function isAllowedDiagramNavigationUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol === "patent-diagram:" &&
      parsed.hostname === "editor" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.pathname.startsWith("/")
    );
  } catch {
    return false;
  }
}

export function isDevToolsEnabled(flag = process.env.PATENT_WORKBENCH_DEVTOOLS): boolean {
  return flag === "1";
}

export function installOfflinePolicy(
  target: Pick<Session, "setPermissionRequestHandler" | "webRequest">,
  isPackaged: boolean,
): void {
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.webRequest.onBeforeRequest({ urls: [...OUTBOUND_URL_PATTERNS] }, (details, callback) =>
    callback({ cancel: shouldCancelOutboundRequest(details.url, isPackaged) }),
  );
}
