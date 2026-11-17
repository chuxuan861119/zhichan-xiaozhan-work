import { posix } from "node:path";
import { fileURLToPath } from "node:url";

/** Accept only local .patdoc files supplied by the Harmony file-opening ability. */
export function harmonyPatdocPath(input: string): string | null {
  if (input.length > 32_768 || input.includes("\0")) return null;
  try {
    let url = new URL(input);
    if (url.protocol === "zhichan-patdoc:") {
      if (
        url.hostname !== "open" ||
        url.pathname ||
        url.hash ||
        url.username ||
        url.password ||
        url.port
      )
        return null;
      if (
        [...url.searchParams.keys()].some((key) => key !== "uri") ||
        url.searchParams.getAll("uri").length !== 1
      )
        return null;
      url = new URL(url.searchParams.get("uri") ?? "");
    }
    if (
      url.protocol !== "file:" ||
      !["", "docs"].includes(url.hostname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    url.hostname = "";
    const path = fileURLToPath(url, { windows: false });
    return posix.isAbsolute(path) &&
      !path.includes("\0") &&
      posix.extname(path).toLowerCase() === ".patdoc"
      ? path
      : null;
  } catch {
    return null;
  }
}
