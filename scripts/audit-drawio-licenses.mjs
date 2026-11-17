import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function generateDrawioEmbeddedNotices(root) {
  const materialRoot = join(root, "resources/licenses/drawio");
  const manifest = JSON.parse(await readFile(join(materialRoot, "DEPENDENCIES.json"), "utf8"));
  const bundlePaths = ["app/js/app.min.js", "app/js/extensions.min.js"];
  if (
    manifest.upstream !== "draw.io v30.0.4" ||
    JSON.stringify(manifest.bundles.map((entry) => entry.path)) !== JSON.stringify(bundlePaths)
  ) {
    throw new Error("draw.io embedded license inventory does not match the pinned runtime");
  }
  for (const bundle of manifest.bundles) {
    const bytes = await readFile(join(root, "resources/drawio", bundle.path));
    if (createHash("sha256").update(bytes).digest("hex") !== bundle.sha256)
      throw new Error(`draw.io embedded library versions changed; review licenses: ${bundle.path}`);
  }
  const bytes = await readFile(join(materialRoot, "EMBEDDED_DEPENDENCIES.txt"));
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.materials.sha256)
    throw new Error("draw.io embedded license material checksum mismatch");
  const text = bytes
    .toString("utf8")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trimEnd();
  return `\nDRAW.IO EMBEDDED DEPENDENCY NOTICES\n${text}\n`;
}
