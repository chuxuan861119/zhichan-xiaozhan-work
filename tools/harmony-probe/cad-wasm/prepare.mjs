import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [frameworkArg, pythonArg, outputArg] = process.argv.slice(2);
if (!outputArg)
  throw new Error("Usage: prepare.mjs <built-dotnet-framework> <pyodide-cache> <new-output>");
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const [framework, python, output] = [frameworkArg, pythonArg, outputArg].map((resolvePath) =>
  resolve(resolvePath),
);
const pinned = JSON.parse(await readFile(join(here, "python-files.json"), "utf8"));
for (const [file, expected] of Object.entries(pinned.files)) {
  const hash = createHash("sha256")
    .update(await readFile(join(python, file)))
    .digest("hex");
  if (hash !== expected) throw new Error(`Python runtime checksum mismatch: ${file}`);
}
const dotnetFiles = await readdir(framework);
if (
  !dotnetFiles.includes("CadWasm.wasm") ||
  !dotnetFiles.includes("ACadSharp.Local.wasm") ||
  !dotnetFiles.some((name) => name.startsWith("dotnet.runtime.8.0.31."))
)
  throw new Error("Expected the documented .NET 8.0.31 CAD build");
const native = new WebAssembly.Module(await readFile(join(framework, "dotnet.native.wasm")));
const exports = new Set(WebAssembly.Module.exports(native).map((entry) => entry.name));
if (
  !exports.has("mono_aot_CadWasm_get_method") ||
  !exports.has("mono_aot_ACadSharp_Local_get_method")
)
  throw new Error(
    "Expected the published AOT CAD reader; interpreted builds are too slow for large drawings",
  );
if (
  !(await readFile(join(framework, "ACadSharp.Local.wasm"))).includes(
    Buffer.from("HarmonyImportRemovalHandlers"),
  )
)
  throw new Error(
    "Expected the optimized Harmony import reader; multicast table subscriptions are quadratic on Mono",
  );
await mkdir(output); // Never overwrite an existing runtime.
await mkdir(join(output, "dotnet"));
await mkdir(join(output, "python"));
for (const file of dotnetFiles.filter(
  (name) => !/\.(br|gz|map|pdb)$/.test(name) && name !== "package.json",
))
  await copyFile(join(framework, file), join(output, "dotnet", file));
await writeFile(join(output, "dotnet/package.json"), '{"type":"module"}\n');
for (const file of Object.keys(pinned.files))
  await copyFile(join(python, file), join(output, "python", file));
await writeFile(
  join(output, "python/pyodide-lock.json"),
  JSON.stringify({ info: pinned.info, packages: pinned.packages }),
);
await copyFile(join(here, "worker.mjs"), join(output, "worker.mjs"));
await copyFile(join(repo, "tools/drawing-converter/render_svg.py"), join(output, "render_svg.py"));
await copyFile(join(repo, "tools/drawing-converter/tiled_svg.py"), join(output, "tiled_svg.py"));
await copyFile(
  join(repo, "src/shared/document/fonts/SourceHanSerifCN-Regular.otf"),
  join(output, "font.otf"),
);
await cp(
  join(repo, "resources/licenses/source-han-serif"),
  join(output, "licenses/source-han-serif"),
  { recursive: true },
);
await cp(
  join(repo, "resources/drawing-converter/reader/licenses"),
  join(output, "licenses/reader"),
  { recursive: true },
);
await copyFile(join(here, "THIRD-PARTY.md"), join(output, "licenses/THIRD-PARTY.md"));
const files = {};
async function inventory(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await inventory(join(directory, entry.name), `${name}/`);
    else
      files[name] = createHash("sha256")
        .update(await readFile(join(directory, entry.name)))
        .digest("hex");
  }
}
await inventory(output);
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      target: "wasm32-offline",
      progressProtocol: 1,
      drawingTiles: 1,
      readerAot: true,
      readerRemovalEvents: 1,
      dotnet: "8.0.31",
      pyodide: pinned.pyodide,
      ezdxf: pinned.ezdxf,
      files,
    },
    null,
    2,
  ),
);
console.log(`Prepared offline CAD runtime: ${output}`);
