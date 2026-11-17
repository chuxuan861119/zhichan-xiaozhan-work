import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { app, protocol } from "electron";
import { usesInstalledResources } from "../platform/resource-layout.js";

import { workbenchUiResource } from "../workbench-ui-resources.js";

export const DRAWIO_EDITOR_SCHEME = "patent-diagram";
export const DRAWIO_EDITOR_HOST = "editor";
const createDrawioCsp = (allowDevelopmentFrameAncestors: boolean): string =>
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; frame-ancestors patent-app://app patent-diagram://editor${allowDevelopmentFrameAncestors ? " http://localhost:* http://127.0.0.1:*" : ""}; base-uri 'none'; form-action 'none'`;
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}
function isChildPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("..") && !path.includes(":");
}

export function createDrawioProtocolHandler(
  editorRoot: string,
  options: { allowDevelopmentFrameAncestors?: boolean } = {},
): (request: Request) => Promise<Response> {
  const root = resolve(editorRoot);
  const contentSecurityPolicy = createDrawioCsp(options.allowDevelopmentFrameAncestors === true);
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (
        url.protocol !== `${DRAWIO_EDITOR_SCHEME}:` ||
        url.host !== DRAWIO_EDITOR_HOST ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return notFound();
      const sharedUi = await workbenchUiResource(url.pathname, resolve(root, "../../ui"));
      if (sharedUi) return sharedUi;
      const requested = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (!isChildPath(root, requested)) return notFound();
      const mime = MIME_TYPES[extname(requested).toLowerCase()];
      if (!mime) return notFound();
      const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(requested)]);
      if (!isChildPath(resolvedRoot, resolvedFile)) return notFound();
      const fileStat = await stat(resolvedFile);
      if (!fileStat.isFile()) return notFound();
      return new Response(
        Readable.toWeb(createReadStream(resolvedFile)) as unknown as ReadableStream,
        {
          headers: {
            "Content-Type": mime,
            "Content-Length": String(fileStat.size),
            "Cache-Control": "no-store",
            "Content-Security-Policy": contentSecurityPolicy,
          },
        },
      );
    } catch {
      return notFound();
    }
  };
}

export function registerDrawioProtocolScheme(
  register = (schemes: Electron.CustomScheme[]) => protocol.registerSchemesAsPrivileged(schemes),
): void {
  register([
    {
      scheme: DRAWIO_EDITOR_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        allowServiceWorkers: false,
        stream: true,
      },
    },
  ]);
}

export function resolveDrawioEditorRoot(environment: {
  isPackaged: boolean;
  resourcesPath: string;
  cwd: string;
  platform?: string;
}): string {
  return usesInstalledResources(environment.isPackaged, environment.platform ?? process.platform)
    ? resolve(environment.resourcesPath, "resources", "drawio", "app")
    : resolve(environment.cwd, "resources", "drawio", "app");
}

export function installDrawioProtocol(
  editorRoot = resolveDrawioEditorRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
    platform: process.platform,
  }),
): void {
  protocol.handle(
    DRAWIO_EDITOR_SCHEME,
    createDrawioProtocolHandler(editorRoot, {
      allowDevelopmentFrameAncestors: !usesInstalledResources(app.isPackaged, process.platform),
    }),
  );
}
