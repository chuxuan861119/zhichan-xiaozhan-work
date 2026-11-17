import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/** Only canonicalize Apple's system aliases; library-internal link checks remain strict. */
export function canonicalSystemPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const absolute = resolve(path);
  if (platform !== "darwin") return absolute;
  const alias = /^\/(var|tmp|etc)(?:\/|$)/u.exec(absolute);
  if (!alias) return absolute;
  const prefix = `/${alias[1]}`;
  return join(realpathSync.native(prefix), absolute.slice(prefix.length));
}
