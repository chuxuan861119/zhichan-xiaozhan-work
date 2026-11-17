import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";
import sharp from "sharp";

type DrawingView = { x: number; y: number; width: number; height: number };

type ProbeWindow = Window & {
  cadProbe: {
    pan(view: DrawingView): void;
    render(zoom: number, ratio: number, nested?: boolean): void;
    circle(ratio: number): Promise<number[]>;
    output(ratio: number, nested?: boolean, crop?: number): Promise<number[]>;
  };
};

for (const deviceScaleFactor of [1, 1.5]) {
  test(`detail strokes stay thin through ratio changes and deep canvas zoom at DPR ${deviceScaleFactor}`, async () => {
    const compiled = await build({
      entryPoints: [resolve("tests/e2e/fixtures/cad-preview-regression.tsx")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      plugins: [
        {
          name: "worker-url",
          setup(b) {
            b.onResolve({ filter: /\?url$/ }, (args) => ({
              path: args.path,
              namespace: "worker-url",
            }));
            b.onLoad({ filter: /.*/, namespace: "worker-url" }, () => ({
              contents: 'export default ""',
              loader: "js",
            }));
          },
        },
      ],
    });
    const browser = await chromium.launch({
      ...(process.platform === "win32" ? { channel: "msedge" } : {}),
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
        deviceScaleFactor,
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setContent(
        '<style>body{margin:0}.drawing-vector-preview{position:absolute;inset:0}</style><div id="root" style="position:relative;width:900px;height:700px;overflow:hidden"></div>',
      );
      await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
      for (const [zoom, ratio, nested] of [
        [1, 1, false],
        [1, 6, false],
        [1, 30, false],
        [10, 6, false],
        [1000, 6, false],
        [1000, 30, true],
        [1, 1, false],
      ] as const) {
        await page.evaluate(
          ({ zoom, ratio, nested }) =>
            (window as unknown as ProbeWindow).cadProbe.render(zoom, ratio, nested),
          { zoom, ratio, nested },
        );
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
        await expect(page.locator(".drawing-vector-preview")).toHaveAttribute(
          "data-render-state",
          "ready",
        );
        await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
        const { data, info } = await sharp(await page.screenshot({ scale: "css" }))
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        let dark = 0;
        for (let y = 320; y < 380; y++) {
          dark += (255 - data[(y * info.width + 450) * info.channels]!) / 255;
        }

        expect(dark, `zoom=${zoom}, ratio=${ratio}, nested=${nested}`).toBeGreaterThan(0.5);
        expect(dark, `zoom=${zoom}, ratio=${ratio}, nested=${nested}`).toBeLessThanOrEqual(2.5);
      }
      // Ordinary animation must reuse the decoded image; swapping Blob URLs
      // on every tick produces visible flashes even if settled screenshots pass.
      await page.evaluate(() => (window as unknown as ProbeWindow).cadProbe.render(1, 6));
      await expect(page.locator(".drawing-vector-preview")).toHaveAttribute(
        "data-render-state",
        "ready",
      );
      const stableSource = await page.locator("img").getAttribute("src");
      for (let tick = 1; tick <= 12; tick++) {
        await page.evaluate(
          (t) => (window as unknown as ProbeWindow).cadProbe.render(1 + t / 30, 6 + t / 20),
          tick,
        );
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
        expect(await page.locator("img").getAttribute("src")).toBe(stableSource);
        expect(
          await page
            .locator("img")
            .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
        ).toBe(true);
      }
      for (const [ratio, crop] of [
        [1, 1],
        [6, 1],
        [30, 1],
        [30, 4],
        [30, 10],
      ]) {
        const bytes = await page.evaluate(
          ([r, c]) => (window as unknown as ProbeWindow).cadProbe.output(r!, false, c),
          [ratio, crop],
        );
        const { data, info } = await sharp(Buffer.from(bytes))
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect(Math.abs(info.width - Math.round((100 / 25.4) * 300))).toBeLessThanOrEqual(4);
        // At the centre column, only the source/detail horizontal line may form a long dark run.
        let maxRun = 0,
          run = 0;
        for (let y = 0; y < info.height; y++) {
          if (data[(y * info.width + Math.floor(info.width * 0.85)) * info.channels]! < 100) {
            run++;
            maxRun = Math.max(maxRun, run);
          } else run = 0;
        }
        expect(maxRun, `export ratio=${ratio}, crop=${crop}`).toBeLessThanOrEqual(4);
      }
      const circleWeights: number[] = [];
      for (const ratio of [1, 3, 6.6]) {
        const bytes = await page.evaluate(
          (r) => (window as unknown as ProbeWindow).cadProbe.circle(r),
          ratio,
        );
        const { data, info } = await sharp(Buffer.from(bytes))
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect(Math.abs(info.width - info.height)).toBeLessThanOrEqual(2);
        let ink = 0;
        for (let x = 0; x < 30; x++)
          ink +=
            (255 - data[(Math.floor(info.height / 2) * info.width + x) * info.channels]!) / 255;
        circleWeights.push(ink);
      }
      expect(Math.max(...circleWeights) - Math.min(...circleWeights)).toBeLessThan(0.35);
      expect(Math.max(...circleWeights)).toBeLessThan(1.8);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
}

test("transformed CAD pans inside cached overscan without another tile decode", async () => {
  const compiled = await build({
    entryPoints: [resolve("tests/e2e/fixtures/cad-preview-regression.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    plugins: [
      {
        name: "worker-url",
        setup(b) {
          b.onResolve({ filter: /\?url$/ }, (args) => ({
            path: args.path,
            namespace: "worker-url",
          }));
          b.onLoad({ filter: /.*/, namespace: "worker-url" }, () => ({
            contents: 'export default ""',
            loader: "js",
          }));
        },
      },
    ],
  });
  const browser = await chromium.launch({
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(
      '<style>body{margin:0;background:white}.drawing-vector-preview{position:absolute;inset:0}</style><div id="root" style="position:relative;width:900px;height:700px;overflow:hidden"></div>',
    );
    const script = compiled.outputFiles[0];
    if (!script) throw Error("CAD preview fixture did not compile");
    await page.addScriptTag({ content: script.text });
    const view = { x: 499.99, y: 400, width: 1.08, height: 0.864 };
    await page.evaluate((view) => (window as unknown as ProbeWindow).cadProbe.pan(view), view);
    await expect(page.locator(".drawing-vector-preview")).toHaveAttribute(
      "data-render-state",
      "ready",
    );
    const centroid = async () => {
      const { data, info } = await sharp(await page.screenshot({ scale: "css" }))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let count = 0,
        xTotal = 0,
        yTotal = 0;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          if ((data[(y * info.width + x) * info.channels] ?? 255) < 100) {
            count++;
            xTotal += x;
            yTotal += y;
          }
        }
      }
      expect(count).toBeGreaterThan(100);
      return { x: xTotal / count, y: yTotal / count };
    };
    const before = await centroid();
    await page.evaluate(() => {
      const state = window as unknown as { finishCadDecode?: () => void };
      const original = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function () {
        await original.call(this);
        await new Promise<void>((resolve) => {
          state.finishCadDecode = resolve;
        });
      };
    });
    await page.evaluate((view) => (window as unknown as ProbeWindow).cadProbe.pan(view), {
      ...view,
      x: view.x + 0.1,
      y: view.y - 0.05,
    });
    await expect(page.locator(".drawing-vector-preview")).toHaveAttribute(
      "data-render-state",
      "ready",
    );
    const pending = await centroid();
    const scale = Math.min(900 / view.width, 700 / view.height);
    // Thresholded raster edges can round differently at fractional pixel positions.
    expect(Math.abs(pending.x - (before.x - 0.1 * scale))).toBeLessThan(1);
    expect(Math.abs(pending.y - (before.y + 0.05 * scale))).toBeLessThan(1);
    await page.waitForTimeout(200);
    expect(
      await page.evaluate(() =>
        Boolean((window as unknown as { finishCadDecode?: () => void }).finishCadDecode),
      ),
    ).toBe(false);
    const after = await centroid();
    expect(Math.abs(after.x - pending.x)).toBeLessThan(1);
    expect(Math.abs(after.y - pending.y)).toBeLessThan(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
