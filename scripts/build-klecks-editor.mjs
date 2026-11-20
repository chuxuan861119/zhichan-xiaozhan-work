import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { generatePsdWorker } from "./generate-klecks-psd-worker.mjs";

/** Dedicated production entry; deliberately excludes host-probe and upstream application UI. */
export async function buildKlecksEditor(outputDirectory = "out/design-editor") {
  const output = resolve(outputDirectory);
  await generatePsdWorker(true);
  execFileSync(process.execPath, ["src/languages/generate.js", "build"], {
    cwd: resolve("vendor/klecks"),
    stdio: "inherit",
    windowsHide: true,
  });
  await mkdir(output, { recursive: true });
  const result = await build({
    entryPoints: ["vendor/klecks/src/host-editor.ts"],
    outfile: resolve(output, "editor.js"),
    bundle: true,
    platform: "browser",
    target: "chrome130",
    format: "iife",
    minify: true,
    metafile: true,
    legalComments: "eof",
  });
  if (
    Object.keys(result.metafile.inputs).some(
      (path) => path.includes("host-probe") || /-probe\.[jt]sx?$/.test(path),
    )
  ) {
    throw new Error("Production editor contains test probe code");
  }
  await copyFile("vendor/klecks/src/host-editor.html", resolve(output, "index.html"));
  await copyFile("vendor/klecks/LICENSE", resolve(output, "Klecks-LICENSE.txt"));
  await copyFile("vendor/klecks/UPSTREAM.md", resolve(output, "Klecks-UPSTREAM.md"));
  return result.metafile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildKlecksEditor();
  console.log("Standalone editor canvas built: out/design-editor");
}
