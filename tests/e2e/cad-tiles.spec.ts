import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";
import sharp from "sharp";

async function failureFixture(page: import("@playwright/test").Page) {
  const compiled = await build({
    entryPoints: [resolve("tests/e2e/fixtures/cad-tiles.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    plugins: [
      {
        name: "worker-url",
        setup(b) {
          b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: "worker" }));
          b.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
            contents: 'export default ""',
            loader: "js",
          }));
        },
      },
    ],
  });
  await page.setContent(
    '<style>body{margin:0}.drawing-vector-preview{position:absolute;inset:0}</style><div id="root" style="position:relative;width:900px;height:700px;overflow:hidden"></div>',
  );
  await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
}

test("persistent tile failure stops requests, retains overview, and recovers after reopening", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage();
    await failureFixture(page);
    await page.evaluate(() => (window as any).cadTilesProbe.corrupt());
    await expect
      .poll(() => page.evaluate(() => (window as any).cadTilesProbe.stats().errors.length))
      .toBe(1);
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => (window as any).cadTilesProbe.stats());
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => (window as any).cadTilesProbe.stats());
    expect(after.requests.length).toBe(before.requests.length);
    expect(after.requests.length).toBeLessThanOrEqual(4);
    expect(after.errors).toHaveLength(1);
    expect(
      await page
        .getByRole("img", { name: "图纸总览" })
        .first()
        .evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0),
    ).toBe(true);
    await page.evaluate(() => (window as any).cadTilesProbe.close());
    await expect
      .poll(() => page.evaluate(() => (window as any).cadTilesProbe.stats().cache.running))
      .toBe(0);
    await page.evaluate(() => (window as any).cadTilesProbe.reopen());
    await expect
      .poll(() => page.locator("[data-drawing-tiles]").first().getAttribute("data-drawing-frames"))
      .not.toBe("0");
    await page.evaluate(() => (window as any).cadTilesProbe.close());
    await expect
      .poll(() => page.evaluate(() => (window as any).cadTilesProbe.stats().cache.entries))
      .toBe(0);
  } finally {
    await browser.close();
  }
});

test("temporary tile contention retries with a delay and restores detail without an error", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage();
    await failureFixture(page);
    await page.evaluate(() => (window as any).cadTilesProbe.busy(2));
    await expect
      .poll(() => page.locator("[data-drawing-tiles]").first().getAttribute("data-drawing-frames"))
      .not.toBe("0");
    expect((await page.evaluate(() => (window as any).cadTilesProbe.stats())).errors).toEqual([]);
    await page.evaluate(() => (window as any).cadTilesProbe.close());
    await expect
      .poll(() => page.evaluate(() => (window as any).cadTilesProbe.stats().cache.running))
      .toBe(0);
  } finally {
    await browser.close();
  }
});

test("tiled CAD remains visible during rapid pan/zoom and exports complete unvisited geometry", async () => {
  const compiled = await build({
    entryPoints: [resolve("tests/e2e/fixtures/cad-tiles.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    plugins: [
      {
        name: "worker-url",
        setup(b) {
          b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: "worker" }));
          b.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
            contents: 'export default ""',
            loader: "js",
          }));
        },
      },
    ],
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const failures: string[] = [];
    page.on("pageerror", (e) => failures.push(e.message));
    await page.setContent(
      '<style>body{margin:0}.drawing-vector-preview{position:absolute;inset:0}</style><div id="root" style="position:relative;width:900px;height:700px;overflow:hidden"></div>',
    );
    await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
    // Export before exploring the four source quadrants.
    for (const [dpi, complex] of [
      [300, false],
      [600, false],
      [300, true],
    ] as const) {
      const normal = await page.evaluate(
        async ({ dpi, complex }) =>
          Array.from(await (window as any).cadTilesProbe.output(false, dpi, complex)),
        { dpi, complex },
      );
      const tiled = await page.evaluate(
        async ({ dpi, complex }) =>
          Array.from(await (window as any).cadTilesProbe.output(true, dpi, complex)),
        { dpi, complex },
      );
      const a = await sharp(Buffer.from(normal as number[]))
        .removeAlpha()
        .raw()
        .toBuffer();
      const b = await sharp(Buffer.from(tiled as number[]))
        .removeAlpha()
        .raw()
        .toBuffer();
      expect(b.length).toBe(a.length);
      let changed = 0;
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 20) changed++;
      let totalDiff = 0;
      for (let i = 0; i < a.length; i++) totalDiff += Math.abs(a[i]! - b[i]!);
      expect(changed / a.length, `dpi=${dpi}, complex=${complex}`).toBeLessThan(0.004);
      expect(totalDiff / a.length).toBeLessThan(0.25);
      const stats = await page.evaluate(() => (window as any).cadTilesProbe.stats());
      expect(new Set(stats.requests).size).toBe(4);
    }
    for (let tick = 0; tick < 50; tick++) {
      const zoom = tick % 5 === 0 ? 20 : 1 + (tick % 7);
      await page.evaluate(
        ({ zoom, tick }) =>
          (window as any).cadTilesProbe.render(
            { x: 400 + (tick % 2 ? 40 : -40), y: 300, width: 1000 / zoom, height: 800 / zoom },
            2 + tick / 20,
          ),
        { zoom, tick },
      );
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      const overviews = page.getByRole("img", { name: "图纸总览" });
      expect(await overviews.count()).toBeGreaterThan(0);
      expect(
        await overviews
          .first()
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      ).toBe(true);
    }
    const stats = await page.evaluate(() => (window as any).cadTilesProbe.stats());
    expect(stats.maxActive).toBeLessThanOrEqual(3); // Two preview decodes plus one sequential export.
    expect(stats.errors).toEqual([]);
    expect(stats.cache.reservedBytes).toBeLessThanOrEqual(192 * 1024 * 1024);
    expect(stats.cache.running).toBeLessThanOrEqual(2);
    expect(failures).toEqual([]);
    await page.evaluate(() =>
      (window as any).cadTilesProbe.render({ x: 400, y: 300, width: 100, height: 80 }),
    );
    await expect
      .poll(async () =>
        Number(
          await page.locator("[data-drawing-tiles]").first().getAttribute("data-drawing-frames"),
        ),
      )
      .toBeGreaterThan(0);
    await page.evaluate(() => (window as any).cadTilesProbe.corrupt());
    await expect(
      page.evaluate(() => (window as any).cadTilesProbe.output(true, 300)),
    ).rejects.toThrow(/损坏/u);
    await page.evaluate(() => (window as any).cadTilesProbe.close());
    await expect
      .poll(() => page.evaluate(() => (window as any).cadTilesProbe.stats().cache.entries))
      .toBe(0);
    await expect
      .poll(() => page.evaluate(() => (window as any).cadTilesProbe.stats().cache.running))
      .toBe(0);
  } finally {
    await browser.close();
  }
});

test("high zoom tile previews retain working resolution on a Retina viewport", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1500, height: 1000 },
      deviceScaleFactor: 2,
    });
    await failureFixture(page);
    await page.evaluate(() => {
      const root = document.getElementById("root")!;
      root.style.width = "1400px";
      root.style.height = "900px";
      (window as any).cadTilesProbe.render({ x: 450, y: 350, width: 100, height: 80 });
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).cadTilesProbe.stats().cache.running))
      .toBe(0);
    await expect
      .poll(() => page.locator("[data-drawing-tiles]").first().locator('img[alt=""]').count())
      .toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const ratios = await page
          .locator("[data-drawing-tiles]")
          .first()
          .locator('img[alt=""]')
          .evaluateAll((images) =>
            images.map((e) => {
              const image = e as HTMLImageElement;
              const rect = e.getBoundingClientRect();
              return Math.min(image.naturalWidth / rect.width, image.naturalHeight / rect.height);
            }),
          );
        return ratios.length ? Math.min(...ratios) : 0;
      })
      .toBeGreaterThanOrEqual(1.4);
    await page.evaluate(() => (window as any).cadTilesProbe.close());
    await expect
      .poll(() => page.evaluate(() => (window as any).cadTilesProbe.stats().cache.entries))
      .toBe(0);
  } finally {
    await browser.close();
  }
});
