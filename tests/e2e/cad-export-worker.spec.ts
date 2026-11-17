import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";

test("worker CAD export and cooperative fallback produce identical files without mutating drafts", async () => {
  test.setTimeout(90_000);
  const worker = await build({
    entryPoints: [resolve("src/renderer/src/drawing-markup/drawing-pixels.worker.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  const compiled = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "ts",
      contents: `
      import { renderDrawing } from './src/renderer/src/drawing-markup/render';
      import { drawingProjectFixture } from './src/shared/drawing-markup/test-fixture';
      window.probe = async (dpi, auto, fallback) => {
        const p = drawingProjectFixture('00000000-0000-4000-8000-000000000901'); p.sourceKind = 'dwg';
        const before = JSON.stringify(p);
        const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="0 0 1000 800"><rect x="100" y="100" width="800" height="600" stroke="black" stroke-width="1" fill="none"/><circle cx="300" cy="300" r="40" stroke="black" fill="none"/></svg>');
        const r = {...p.regions[0], points:[{x:0,y:0},{x:1000,y:0},{x:1000,y:800},{x:0,y:800}]};
        const NativeWorker = window.Worker; let workers = 0, transfers = 0;
        window.Worker = fallback ? undefined : class extends NativeWorker {
          constructor(...args) { super(...args); workers++; }
          postMessage(...args) { transfers++; super.postMessage(...args); }
        };
        try { const out = await renderDrawing(p, r, bytes, 'image/svg+xml', 120, dpi, {autoAdjustLabelSize:auto});
          return {...out, bytes:Array.from(out.bytes), unchanged:JSON.stringify(p)===before, workers, transfers};
        } finally {window.Worker = NativeWorker;}
      };
    `,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    plugins: [
      {
        name: "worker-entry",
        setup(b) {
          b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: "stub" }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: 'export default ""',
            loader: "js",
          }));
          b.onLoad({ filter: /drawing-pixels\.ts$/ }, async (a) => ({
            contents: (await readFile(a.path, "utf8")).replace(
              'new URL("./drawing-pixels.worker.ts", import.meta.url)',
              'new URL("http://localhost/drawing-pixels.worker.js")',
            ),
            loader: "ts",
          }));
        },
      },
    ],
  });
  const browser = await chromium.launch({
    headless: true,
    // Use software painting so this byte-level comparison does not depend on GPU state.
    args: ["--disable-gpu"],
    ...(process.platform === "darwin"
      ? { channel: "chrome" }
      : process.platform === "win32"
        ? { channel: "msedge" }
        : {}),
  });
  try {
    const page = await browser.newPage();
    await page.route("http://localhost/**", (r) =>
      r.fulfill({
        body: r.request().url().endsWith(".js") ? worker.outputFiles[0]!.text : "<body/>",
        contentType: r.request().url().endsWith(".js") ? "text/javascript" : "text/html",
      }),
    );
    await page.goto("http://localhost/");
    await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
    for (const [dpi, auto] of [
      [300, false],
      [300, true],
      [600, true],
    ] as const) {
      const run = (fallback: boolean) =>
        page.evaluate(
          async ([dpi, auto, fallback]) =>
            (
              window as unknown as {
                probe(
                  dpi: number,
                  auto: boolean,
                  fallback: boolean,
                ): Promise<{
                  bytes: number[];
                  width: number;
                  height: number;
                  unchanged: boolean;
                  workers: number;
                  transfers: number;
                }>;
              }
            ).probe(dpi as number, auto as boolean, fallback as boolean),
          [dpi, auto, fallback],
        );
      const workerOutput = await run(false),
        fallback = await run(true);
      expect(workerOutput.unchanged && fallback.unchanged).toBe(true);
      expect(workerOutput.workers).toBe(1);
      expect(workerOutput.transfers).toBeGreaterThan(0);
      expect({
        bytes: workerOutput.bytes,
        width: workerOutput.width,
        height: workerOutput.height,
      }).toEqual({
        bytes: fallback.bytes,
        width: fallback.width,
        height: fallback.height,
      });
    }
  } finally {
    await browser.close();
  }
});
