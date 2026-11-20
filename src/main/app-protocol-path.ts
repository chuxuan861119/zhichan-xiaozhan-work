import { isAbsolute, relative, resolve } from "node:path";

export const DESIGN_EDITOR_HOST = "editor";

/** Resolve only local, non-escaping resource paths for the two isolated origins. */
export function resolveAppResource(
  requestUrl: string,
  rendererRoot: string,
  editorRoot?: string,
): { path: string; editor: boolean } | null {
  try {
    const url = new URL(requestUrl);
    if (
      url.protocol !== "patent-app:" ||
      url.username ||
      url.password ||
      url.port ||
      (url.hostname !== "app" && url.hostname !== DESIGN_EDITOR_HOST)
    ) {
      return null;
    }
    const editor = url.hostname === DESIGN_EDITOR_HOST;
    const selectedRoot = editor ? editorRoot : rendererRoot;
    if (!selectedRoot) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("\\") || pathname.includes("\0")) return null;
    const root = resolve(selectedRoot);
    const path = resolve(root, `.${pathname}`);
    const within = relative(root, path);
    if (
      isAbsolute(within) ||
      within === ".." ||
      within.startsWith("../") ||
      within.startsWith("..\\")
    ) {
      return null;
    }
    return { path, editor };
  } catch {
    return null;
  }
}
