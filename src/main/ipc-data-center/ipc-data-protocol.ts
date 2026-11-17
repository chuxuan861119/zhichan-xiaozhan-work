import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { app, protocol } from "electron";
import { usesInstalledResources } from "../platform/resource-layout.js";

import { workbenchUiResource } from "../workbench-ui-resources.js";

const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; frame-ancestors patent-app://app http://localhost:* http://127.0.0.1:*; base-uri 'none'; form-action 'none'";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
function child(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== "" && !part.startsWith("..") && !isAbsolute(part) && !part.includes(":");
}
export function createIpcDataProtocolHandler(directory: string) {
  const root = resolve(directory);
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (
        url.protocol !== "patent-ipc:" ||
        url.host !== "center" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid resource");
      const sharedUi = await workbenchUiResource(url.pathname, resolve(root, "../ui"));
      if (sharedUi) return sharedUi;
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      const mime = MIME[extname(path)];
      if (!mime || !child(root, path)) throw new Error("Invalid resource path");
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
      if (!child(realRoot, realFile)) throw new Error("Resource outside bundle");
      const info = await stat(realFile);
      if (!info.isFile()) throw new Error("Invalid resource type");
      return new Response(Readable.toWeb(createReadStream(realFile)) as unknown as ReadableStream, {
        headers: {
          "Content-Type": mime,
          "Content-Length": String(info.size),
          "Content-Security-Policy": CSP,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  };
}
export function resolveIpcDataRoot(env: {
  isPackaged: boolean;
  resourcesPath: string;
  cwd: string;
  platform?: string;
}): string {
  return usesInstalledResources(env.isPackaged, env.platform ?? process.platform)
    ? resolve(env.resourcesPath, "resources/ipc-data-center")
    : resolve(env.cwd, "resources/ipc-data-center");
}
export function registerIpcDataScheme(
  register = (schemes: Electron.CustomScheme[]) => protocol.registerSchemesAsPrivileged(schemes),
): void {
  register([
    {
      scheme: "patent-ipc",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        allowServiceWorkers: false,
        stream: true,
      },
    },
  ]);
}
export function installIpcDataProtocol(): void {
  protocol.handle(
    "patent-ipc",
    createIpcDataProtocolHandler(
      resolveIpcDataRoot({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        cwd: process.cwd(),
      }),
    ),
  );
}
