import { readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

/** Only these shared bundled UI assets are reachable outside an editor's root. */
export async function workbenchUiResource(
  pathname: string,
  directory: string,
): Promise<Response | null> {
  const mime =
    pathname === "/workbench-ui.js"
      ? "application/javascript; charset=utf-8"
      : pathname === "/workbench-ui.css"
        ? "text/css; charset=utf-8"
        : null;
  if (!mime) return null;
  const root = await realpath(directory);
  const file = await realpath(resolve(root, pathname.slice(1)));
  if (relative(root, file) !== pathname.slice(1)) throw new Error("UI resource outside bundle");
  return new Response(await readFile(file), {
    headers: {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
