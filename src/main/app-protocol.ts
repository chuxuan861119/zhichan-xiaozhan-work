import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";
import { resolveAppResource } from "./app-protocol-path.js";
import { isAllowedRendererUrl } from "./security.js";

export const APP_SCHEME = "patent-app";

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
export function installAppProtocol(
  rendererRoot: string,
  target = protocol,
  options: { editorRoot?: string; developmentRendererUrl?: string | undefined } = {},
): void {
  const { editorRoot, developmentRendererUrl } = options;
  const editorParentOrigin =
    developmentRendererUrl && isAllowedRendererUrl(developmentRendererUrl, false)
      ? new URL(developmentRendererUrl).origin
      : "patent-app://app";
  target.handle(APP_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const resource = resolveAppResource(request.url, rendererRoot, editorRoot);
    if (!resource) {
      return new Response("Not Found", { status: 404 });
    }
    const filePath = resource.path;

    try {
      const fileStat = await stat(filePath);

      if (!fileStat.isFile()) {
        return new Response("Not Found", { status: 404 });
      }

      const headers: Record<string, string> = {
        "Content-Type": mimeType(filePath),
        "Cache-Control": "no-cache",
        "Content-Length": String(fileStat.size),
        "X-Content-Type-Options": "nosniff",
      };
      // The engine has its own origin and cannot embed a privileged case page.
      headers["Content-Security-Policy"] = resource.editor
        ? `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${editorParentOrigin}`
        : "frame-ancestors 'none'";

      if (resource.editor && extname(filePath).toLowerCase() === ".html") {
        const html = (await readFile(filePath, "utf8")).replace(
          "<head>",
          `<head><meta name="klecks-parent-origin" content="${editorParentOrigin}">`,
        );
        headers["Content-Length"] = String(Buffer.byteLength(html));
        return new Response(request.method === "HEAD" ? null : html, {
          status: 200,
          headers,
        });
      }

      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }

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
