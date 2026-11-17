import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const destination = process.argv[2];
if (!destination) throw new Error("Pass the isolated probe app directory");
const output = resolve(destination);
const manifest = JSON.parse(await readFile(resolve(output, "package.json"), "utf8"));
if (manifest.name !== "zhichan-harmony-dependency-probe") throw new Error("Not a probe directory");
await build({
  entryPoints: [resolve(here, "../../node_modules/write-file-atomic/lib/index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  alias: { "signal-exit": resolve(here, "atomic-exit.cjs") },
  outfile: resolve(output, "atomic-adapted.cjs"),
});
await copyFile(resolve(here, "compat-main.cjs"), resolve(output, "compat-main.cjs"));
await copyFile(resolve(here, "sharp-adapted.cjs"), resolve(output, "sharp-adapted.cjs"));
await copyFile(resolve(here, "sqlite-adapted.cjs"), resolve(output, "sqlite-adapted.cjs"));
await mkdir(resolve(output, "fonts"), { recursive: true });
for (const name of ["SourceHanSerifCN-Regular.otf", "SourceHanSerifCN-SemiBold.otf"])
  await copyFile(
    resolve(here, "../../src/shared/document/fonts", name),
    resolve(output, "fonts", name),
  );
await build({
  entryPoints: {
    "formula-fallback": resolve(here, "../../src/main/exports/formula-fallback.ts"),
    "chemical-structure-export": resolve(
      here,
      "../../src/main/exports/chemical-structure-export.ts",
    ),
    "adapted-library-database": resolve(here, "../../src/main/library/library-database.ts"),
    "adapted-schema": resolve(here, "../../src/main/library/schema.ts"),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [
    {
      name: "probe-sharp-adapter",
      setup(build) {
        build.onResolve({ filter: /^sharp$/ }, () => ({
          path: "./sharp-adapted.cjs",
          external: true,
        }));
        build.onResolve({ filter: /^node:sqlite$/ }, () => ({
          path: "./sqlite-adapted.cjs",
          external: true,
        }));
      },
    },
  ],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  outdir: output,
  outExtension: { ".js": ".mjs" },
});
