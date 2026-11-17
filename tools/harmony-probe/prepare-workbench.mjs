import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { adaptWorkbenchStartup } from "./workbench-startup-adapter.mjs";

const [sourceArg, builtArg, appArg] = process.argv.slice(2);
const mode = process.argv[5];
if (mode && mode !== "--interactive") throw new Error("Unknown preparation mode");
if (!appArg)
  throw new Error(
    "Usage: prepare-workbench.mjs <isolated-source> <electron-vite-output> <probe-app>",
  );
const [source, built, app] = [sourceArg, builtArg, appArg].map((value) => resolve(value));
const here = dirname(fileURLToPath(import.meta.url));
function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error(`Expected one adapter anchor: ${anchor}`);
  return source.replace(anchor, replacement);
}
const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
if (manifest.name !== "zhichan-harmony-dependency-probe")
  throw new Error("Not an isolated probe app");
const info = JSON.parse(await readFile(join(built, "main/build-info.json"), "utf8"));
await mkdir(join(app, "workbench/main"), { recursive: true });
await mkdir(join(app, "workbench/main/assets"), { recursive: true });
await cp(join(built, "renderer"), join(app, "workbench/renderer"), { recursive: true });
await cp(join(built, "preload"), join(app, "workbench/preload"), { recursive: true });
await build({
  entryPoints: {
    index: join(source, "src/main/index.ts"),
    "print-font-worker": join(source, "src/main/exports/print-font-worker.ts"),
  },
  outdir: join(app, "workbench/main"),
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  define: {
    __APPLICATION_BUILD_INFO__: JSON.stringify(info),
    "import.meta.url": "__harmonyImportMetaUrl",
  },
  banner: {
    js: 'const __harmonyImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  plugins: [
    {
      name: "harmony-diagnostic-adapters",
      setup(build) {
        const aliases = {
          "node:sqlite": "sqlite-adapted.cjs",
          "write-file-atomic": "atomic-adapted.cjs",
          sharp: "sharp-adapted.cjs",
        };
        build.onResolve({ filter: /^(node:sqlite|write-file-atomic|sharp)$/ }, (args) => ({
          path: `../../${aliases[args.path]}`,
          external: true,
        }));
        build.onResolve({ filter: /\?asset$/ }, (args) => ({
          path: resolve(args.resolveDir, args.path.slice(0, -6)),
          namespace: "harmony-asset",
        }));
        build.onLoad({ filter: /.*/, namespace: "harmony-asset" }, async (args) => {
          const bytes = await readFile(args.path);
          const name =
            createHash("sha256").update(bytes).digest("hex").slice(0, 12) +
            "-" +
            basename(args.path);
          await writeFile(join(app, "workbench/main/assets", name), bytes);
          return {
            contents: `module.exports = require("node:path").join(__dirname,"assets",${JSON.stringify(name)});`,
            loader: "js",
          };
        });
        build.onLoad({ filter: /content-search-worker\.ts$/ }, async (args) => ({
          contents: replaceOnce(
            await readFile(args.path, "utf8"),
            'loadModule("node:sqlite")',
            'loadModule(process.env.PATENT_HARMONY_SQLITE_MODULE || "node:sqlite")',
          ),
          loader: "ts",
        }));
        build.onLoad({ filter: /src\/main\/index\.ts$/ }, async (args) => {
          const original = await readFile(args.path, "utf8");
          const contents = adaptWorkbenchStartup(original);
          return { contents, loader: "ts" };
        });
      },
    },
  ],
});
await cp(join(source, "resources"), join(dirname(app), "resources"), { recursive: true });
const cadRuntime = process.env.HARMONY_CAD_WASM_ROOT;
if (cadRuntime) {
  const cadManifest = JSON.parse(await readFile(join(cadRuntime, "manifest.json"), "utf8"));
  if (cadManifest.target !== "wasm32-offline") throw new Error("Not an offline CAD runtime");
  for (const [file, expected] of Object.entries(cadManifest.files)) {
    if (file.includes("..") || file.startsWith("/")) throw new Error("Invalid CAD resource path");
    const actual = createHash("sha256")
      .update(await readFile(join(cadRuntime, file)))
      .digest("hex");
    if (actual !== expected) throw new Error(`CAD resource checksum mismatch: ${file}`);
  }
  await cp(cadRuntime, join(dirname(app), "resources/drawing-converter/wasm"), { recursive: true });
}

await cp(join(source, "node_modules/katex"), join(app, "node_modules/katex"), { recursive: true });
await copyFile(join(here, "workbench-smoke.cjs"), join(app, "workbench-smoke.cjs"));
await copyFile(join(here, "workbench-flow.cjs"), join(app, "workbench-flow.cjs"));
await copyFile(join(here, "workbench-interactive.cjs"), join(app, "workbench-interactive.cjs"));
if (mode === "--interactive") {
  const provenance = JSON.parse(await readFile(join(source, "harmony-source.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(provenance.commit)) throw new Error("Missing source commit");
  await writeFile(join(app, "interactive-source.json"), JSON.stringify(provenance, null, 2));
}
manifest.main = mode === "--interactive" ? "workbench-interactive.cjs" : "workbench-smoke.cjs";
await writeFile(join(app, "package.json"), JSON.stringify(manifest, null, 2));
