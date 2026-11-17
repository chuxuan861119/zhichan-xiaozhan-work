import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";

export const APP_SCHEME = "patent-app";
const APP_HOST = "app";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function mimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Must be called BEFORE `app.whenReady()`. Registers the `patent-app` scheme
 * as a privileged custom protocol with Fetch API and CORS support, so that
 * Web Workers and `fetch()`-based WASM loading work in sandboxed renderers.
 */
export function registerAppProtocolScheme(
  register = (schemes: Electron.CustomScheme[]) => protocol.registerSchemesAsPrivileged(schemes),
): void {
  register([
    {
      scheme: APP_SCHEME,
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

/**
 * Must be called AFTER `app.whenReady()`. Maps `patent-app://app/*` requests
 * to files under `rendererRoot`, served with correct MIME types and caching headers.
 */
export function installAppProtocol(rendererRoot: string, target = protocol): void {
  const root = resolve(rendererRoot);

  target.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);

    // Only serve files under the app host
    if (url.host !== APP_HOST) {
      return new Response("Not Found", { status: 404 });
    }

    // Resolve the path relative to the renderer root, prevent traversal
    const relativePath = normalize(url.pathname.replace(/^\//, ""));
    const filePath = join(root, relativePath);

    // Ensure the resolved path stays within root
    if (!filePath.startsWith(root)) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const fileStat = await stat(filePath);

      if (!fileStat.isFile()) {
        return new Response("Not Found", { status: 404 });
      }

      const headers: Record<string, string> = {
        "Content-Type": mimeType(filePath),
        "Cache-Control": "no-cache",
        "Content-Length": String(fileStat.size),
      };

      // Use stream-based response for all files so WASM and large JS chunks
      // are served efficiently without buffering the full file in memory.
      const stream = createReadStream(filePath);
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 200,
        headers,
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  });
}
