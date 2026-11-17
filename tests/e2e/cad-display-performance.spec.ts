import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";

type ProbeWindow = Window & {
  cadDisplayProbe: {
    metrics: { sourceBytes: number; posts: number; copiedBytes: number; postMs: number };
    begin(): void;
    move(x: number, y: number): void;
    end(x: number, y: number): void;
    zoom(factor: number): void;
    snap(i: number): unknown;
  };
};

for (const mode of ["normal", "4x CPU", "4x CPU / software graphics"]) {
  const constrained = mode !== "normal";
  // biome-ignore lint/correctness/noEmptyPattern: Each case launches its own headless graphics configuration.
  test(`@performance CAD retained display with 24000 paths (${mode})`, async ({}, testInfo) => {
    test.setTimeout(120000);
    const fixture = await build({
      entryPoints: [resolve("tests/e2e/fixtures/cad-display-performance.tsx")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      plugins: [
        {
          name: "pdf-worker-url",
          setup(b) {
            b.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "url" }));
            b.onLoad({ filter: /.*/, namespace: "url" }, () => ({ contents: 'export default ""' }));
          },
        },
      ],
    });
    const worker = await build({
      entryPoints: [resolve("src/renderer/src/drawing-markup/cad-svg-preview.worker.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
    });
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", request.url === "/" ? "text/html" : "text/javascript");
      response.end(
        request.url === "/"
          ? '<style>body{margin:0}.drawing-vector-preview{position:absolute;inset:0}</style><div id="root" style="position:relative;width:1000px;height:600px;overflow:hidden"></div><script type="module" src="/fixture.js"></script>'
          : request.url?.includes("cad-svg-preview.worker")
            ? worker.outputFiles[0]!.text
            : fixture.outputFiles[0]!.text,
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Fixture server unavailable");
    const browser = await chromium.launch({
      headless: true,
      ...(process.platform === "win32" ? { channel: "msedge" } : {}),
      ...(mode.includes("software")
        ? { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }
        : {}),
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 600 },
        deviceScaleFactor: 1.5,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      if (constrained)
        await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", {
          rate: 4,
        });
      await page.goto(`http://127.0.0.1:${address.port}`);
      await expect(page.locator('[data-render-state="ready"] img')).toBeVisible({ timeout: 60000 });
      await page.evaluate(() => (window as unknown as ProbeWindow).cadDisplayProbe.zoom(10));
      await expect(page.locator('[data-render-state="ready"] img')).toBeVisible({ timeout: 60000 });
      const measurements = await page.evaluate(async () => {
        const probe = (window as unknown as ProbeWindow).cadDisplayProbe;
        const gaps: number[] = [],
          zoomGaps: number[] = [],
          handlers: number[] = [],
          longTasks: number[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        observer.observe({ type: "longtask" });
        const frame = () => new Promise<number>((done) => requestAnimationFrame(done));
        let before = await frame();
        probe.begin();
        for (let i = 1; i <= 90; i++) {
          const start = performance.now();
          probe.move(i * 16, Math.sin(i / 10) * 60);
          handlers.push(performance.now() - start);
          const now = await frame();
          gaps.push(now - before);
          before = now;
        }
        probe.end(1440, Math.sin(9) * 60);
        for (let i = 1; i <= 30; i++) {
          probe.zoom(10 + i / 3);
          const now = await frame();
          zoomGaps.push(now - before);
          before = now;
        }
        await frame();
        const snaps: number[] = [];
        for (let i = 0; i < 60; i++) {
          const start = performance.now();
          probe.snap(i);
          snaps.push(performance.now() - start);
          await frame();
        }
        observer.disconnect();
        const quantile = (values: number[], p: number) =>
          [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
        return {
          ...probe.metrics,
          panP50: quantile(gaps, 0.5),
          panP95: quantile(gaps, 0.95),
          panMax: Math.max(...gaps),
          zoomP95: quantile(zoomGaps, 0.95),
          zoomMax: Math.max(...zoomGaps),
          handlerP95: quantile(handlers, 0.95),
          snapP95: quantile(snaps.slice(1), 0.95),
          snapCold: snaps[0],
          longTasks,
        };
      });
      console.log(JSON.stringify({ mode, ...measurements }));
      await expect(page.locator('[data-render-state="ready"] img')).toBeVisible();
      expect(
        await page.locator("[data-pan-preview-surface]").evaluate((el) => {
          const matrix = new DOMMatrix(getComputedStyle(el).transform);
          return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
        }),
      ).toEqual([1, 0, 0, 1, 0, 0]);
      expect(errors).toEqual([]);
      expect(measurements.copiedBytes).toBe(measurements.sourceBytes);
      expect(measurements.handlerP95).toBeLessThan(16.7);
      await testInfo.attach("cad-display-metrics", {
        body: JSON.stringify(measurements, null, 2),
        contentType: "application/json",
      });
    } finally {
      await browser.close();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    }
  });
}
