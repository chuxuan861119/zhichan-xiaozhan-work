import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const destination = process.argv[2];
if (!destination)
  throw new Error("Usage: node tools/harmony-probe/prepare.mjs <new-output-directory>");
const output = resolve(destination);
await mkdir(output, { recursive: false });
await build({
  entryPoints: {
    "library-database": resolve(root, "src/main/library/library-database.ts"),
    "image-importer": resolve(root, "src/main/assets/image-importer.ts"),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: 'import { createRequire as createProbeRequire } from "node:module"; const require = createProbeRequire(import.meta.url);',
  },
  target: "node22",
  external: ["sharp"],
  outdir: output,
  outExtension: { ".js": ".mjs" },
});
await copyFile(resolve(here, "main.cjs"), resolve(output, "main.cjs"));
await copyFile(resolve(here, "ohos-entry.cjs"), resolve(output, "ohos-entry.cjs"));
await writeFile(
  resolve(output, "package.json"),
  JSON.stringify(
    {
      name: "zhichan-harmony-dependency-probe",
      version: "0.1.0",
      private: true,
      main: "main.cjs",
      dependencies: { sharp: "0.35.3", "write-file-atomic": "7.0.0" },
    },
    null,
    2,
  ),
);
console.log(
  `Prepared ${output}. Install target-compatible native dependencies before target execution.`,
);
