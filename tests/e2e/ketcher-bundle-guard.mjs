import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const assetsDir = resolve(process.cwd(), "out/renderer/assets");
const assetFiles = (await readdir(assetsDir)).filter((file) => file.endsWith(".js"));
const filesWithUnresolvedRaphaelRequire = [];

for (const assetFile of assetFiles) {
  const source = await readFile(join(assetsDir, assetFile), "utf8");
  if (/\brequire\(["']raphael["']\)/u.test(source)) {
    filesWithUnresolvedRaphaelRequire.push(assetFile);
  }
}

if (filesWithUnresolvedRaphaelRequire.length > 0) {
  throw new Error(
    `Renderer bundle contains unresolved require("raphael"): ${filesWithUnresolvedRaphaelRequire.join(", ")}`,
  );
}

console.log('Ketcher renderer bundle contains no unresolved require("raphael").');
