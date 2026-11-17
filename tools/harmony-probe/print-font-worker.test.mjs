import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("Harmony packaging builds the PDF font worker as a standalone CommonJS entry", async () => {
  const source = await readFile(join(root, "tools/harmony-probe/prepare-workbench.mjs"), "utf8");
  assert.match(
    source,
    /"print-font-worker":\s*join\(source,\s*"src\/main\/exports\/print-font-worker\.ts"\)/u,
  );
  assert.match(source, /outExtension:\s*\{\s*"\.js":\s*"\.cjs"\s*\}/u);
});

test("the compiled CommonJS font worker handles the Harmony platform without changing native font text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harmony-print-font-worker-"));
  let worker;
  try {
    const output = join(directory, "print-font-worker.cjs");
    await build({
      entryPoints: [join(root, "src/main/exports/print-font-worker.ts")],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      plugins: [
        {
          name: "local-font-assets",
          setup(builder) {
            builder.onLoad({ filter: /.*/, namespace: "font-asset" }, async (args) => ({
              contents: `module.exports = ${JSON.stringify(args.path)};`,
              loader: "js",
            }));
            builder.onResolve({ filter: /\?asset$/ }, (args) => ({
              path: resolve(args.resolveDir, args.path.slice(0, -6)),
              namespace: "font-asset",
            }));
          },
        },
      ],
    });
    worker = new Worker(output);
    const html =
      '<html><head></head><body><p style="font-family:SimSun">原文一支</p></body></html>';
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("font worker timed out")), 10_000);
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once("message", (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      worker.postMessage({ id: 1, html, platform: "openharmony" });
    });
    assert.equal(result.id, 1);
    assert.equal(result.error, undefined);
    assert.ok(result.html.endsWith(html.slice(html.indexOf("<body>"))));
    assert.ok(!result.html.includes("data:font/"));
    assert.ok(!result.html.includes("ZXWPDFSerif"));
  } finally {
    await worker?.terminate();
    await rm(directory, { recursive: true, force: true });
  }
});
