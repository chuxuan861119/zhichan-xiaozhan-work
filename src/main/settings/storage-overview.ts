import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function inspectStorageFolder(path: string | null) {
  if (!path) return { path, bytes: null, partial: false };
  let bytes = 0;
  let partial = false;
  let visited = 0;
  const deadline = Date.now() + 3000;
  const queue = [path];
  while (queue.length) {
    if (++visited > 20_000 || Date.now() > deadline) {
      partial = true;
      break;
    }
    const current = queue.pop();
    if (!current) break;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        partial = true;
        continue;
      }
      if (info.isFile()) bytes += info.size;
      else if (info.isDirectory()) {
        const entries = await readdir(current);
        if (queue.length + entries.length > 20_000) {
          partial = true;
          break;
        }
        queue.push(...entries.map((name) => join(current, name)));
      }
    } catch {
      partial = true;
    }
  }
  return { path, bytes, partial };
}
