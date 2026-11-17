import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";

type Probe = (
  auto: boolean,
  factor: number,
  margin: number,
  dpi: number,
  raster: boolean,
  hairline?: boolean,
  partial?: boolean,
  edgeLabels?: boolean,
  edgeDetails?: boolean,
) => Promise<{
  labels: { font: number; line: number; scale: number; inside: boolean; text: string }[];
  width: number;
  height: number;
  decodedWidth: number;
  unchanged: boolean;
  darkestEdge: number;
  darkPixels: number;
}>;

test("export auto sizing follows the cropped graphic, not white margins, source scale or DPI", async () => {
  const compiled = await build({
    entryPoints: [resolve("tests/e2e/fixtures/cad-auto-label-size.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
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
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent("<body></body>");
    await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
    const run = (args: Parameters<Probe>) =>
      page.evaluate(
        (args) => (window as unknown as { autoLabelProbe: Probe }).autoLabelProbe(...args),
        args,
      );
    for (const raster of [false, true]) {
      const details = await run([true, 1, 0, 300, raster, false, false, false, true]);
      expect(details.labels.slice(-4).every((label) => label.inside)).toBe(true);
      const edges = await run([true, 1, 0, 300, raster, false, false, true]);
      expect(edges.labels.some((label) => label.text === "OUTSIDE")).toBe(false);
      expect(edges.labels.slice(-2).every((label) => label.inside)).toBe(true);
      const normal = await run([true, 1, 0, 300, raster]);
      const cropped = await run([true, 1, 120, 300, raster]);
      const scaled = await run([true, 2, 0, 300, raster]);
      const dense = await run([true, 1, 0, 600, raster]);
      const manual = await run([false, 1, 0, 300, raster]);
      const partial = await run([true, 1, 0, 300, raster, false, true]);
      for (const result of [normal, cropped, scaled, dense, manual]) {
        expect(result.unchanged).toBe(true);
        expect(result.width).toBe(result.decodedWidth);
        expect(result.labels.length).toBeGreaterThan(0);
      }
      const label = normal.labels[0]!;
      for (const result of [normal, cropped, scaled, dense, partial]) {
        const final = result.labels.at(-1)!;
        expect((final.font * final.scale * 120) / result.width).toBeCloseTo(7, 1);
        expect((final.line * final.scale * 120) / result.width).toBeCloseTo(
          raster ? 0.25 : 0.18,
          2,
        );
      }
      expect(Math.abs(cropped.labels[0]!.font / label.font - 1)).toBeLessThan(0.02);
      expect(Math.abs(scaled.labels[0]!.font / label.font - 2)).toBeLessThan(0.03);
      expect(Math.abs(dense.labels[0]!.font / label.font - 1)).toBeLessThan(0.02);
      expect(label.font / label.line).toBeCloseTo(raster ? 28 : 7 / 0.18, 3);
      expect(manual.labels[0]!.font).toBe(60);
      expect(normal.width).toBeGreaterThan(1300);
    }
    for (const dpi of [300, 600]) {
      for (const auto of [false, true]) {
        const cad = await run([auto, 1, 0, dpi, false, true]);
        expect(cad.darkestEdge).toBeLessThan(40);
        expect(cad.darkPixels).toBeGreaterThan(0);
        expect(cad.darkPixels).toBeLessThanOrEqual(dpi === 300 ? 3 : 5);
      }
    }
    const photo = await run([true, 1, 0, 300, true, true]);
    expect(photo.darkestEdge).toBeGreaterThan(150);
    for (const dpi of [300, 600]) {
      const nativeStrokes = await page.evaluate(
        (density) =>
          (
            window as unknown as {
              nativeStrokeProbe: (dpi: number) => Promise<{ runs: number[]; ink: number[] }>;
            }
          ).nativeStrokeProbe(density),
        dpi,
      );
      expect(nativeStrokes.runs).toHaveLength(2);
      expect(nativeStrokes.ink[1]).toBeGreaterThan(nativeStrokes.ink[0]!);
      if (dpi === 600) expect(nativeStrokes.runs[1]).toBeGreaterThan(nativeStrokes.runs[0]!);
    }
    await run([true, 1, 0, 300, false, true]);
    await page.screenshot({ path: test.info().outputPath("automatic-labels.png") });
  } finally {
    await browser.close();
  }
});
