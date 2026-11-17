import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Browser, chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";

type ProbeResult = {
  returned: boolean;
  error: string | null;
  unchanged: boolean;
  sourceUnchanged: boolean;
  reads: string[];
  texts: string[];
  jpegCalls: number;
  pixels: null | {
    width: number;
    height: number;
    red: number;
    blue: number;
    black: number;
    labelInk: number;
    titleInk: number;
    detailRingInk: number;
    overlayLineInk: number;
    detailCenter: number[];
  };
};
let browser: Browser;
let compiledScript: string;
let scannerScript: string;
let pdfWorkerScript: string;

test.beforeAll(async () => {
  const scanner = await build({
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
        import { createDetailView } from './src/shared/drawing-markup/detail-view';
        import { DrawingProjectSchema } from './src/shared/drawing-markup/model';
        import { drawingProjectFixture } from './src/shared/drawing-markup/test-fixture';

        const sourceAsset = '00000000-0000-4000-8000-000000000901';
        const overlayAsset = '00000000-0000-4000-8000-000000000902';
        const frozenAsset = '00000000-0000-4000-8000-000000000903';
        const svg = (body) => '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="0 0 1000 800">' + body + '</svg>';
        const redSvg = svg('<rect width="1000" height="800" fill="#ff0000"/>');
        const overlaySvg = svg('<path d="M100 100H450 M700 300H800" fill="none" stroke="#0000ff" stroke-width="8"/>');
        const editedBodySvg = svg('<rect width="1000" height="800" fill="white"/><rect x="1" y="1" width="998" height="798" fill="none" stroke="black" stroke-width="2"/><rect x="700" y="280" width="100" height="30" fill="#0000ff"/>');
        const encode = (value) => new TextEncoder().encode(value);

        function redPdf() {
          const stream = '1 0 0 rg\\n0 0 1000 800 re f\\n';
          const objects = [
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 800] /Resources << >> /Contents 4 0 R >>',
            '<< /Length ' + stream.length + ' >>\\nstream\\n' + stream + 'endstream',
          ];
          let file = '%PDF-1.4\\n';
          const offsets = [0];
          for (let index = 0; index < objects.length; index++) {
            offsets.push(file.length);
            file += (index + 1) + ' 0 obj\\n' + objects[index] + '\\nendobj\\n';
          }
          const xref = file.length;
          file += 'xref\\n0 5\\n0000000000 65535 f \\n';
          for (const offset of offsets.slice(1)) file += String(offset).padStart(10, '0') + ' 00000 n \\n';
          file += 'trailer\\n<< /Size 5 /Root 1 0 R >>\\nstartxref\\n' + xref + '\\n%%EOF\\n';
          return encode(file);
        }

        async function redRaster() {
          const url = URL.createObjectURL(new Blob([redSvg], { type: 'image/svg+xml' }));
          const image = new Image();
          try {
            image.src = url;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = 1000; canvas.height = 800;
            canvas.getContext('2d').drawImage(image, 0, 0);
            const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Missing raster fixture')), 'image/png'));
            return new Uint8Array(await blob.arrayBuffer());
          } finally { image.src = ''; URL.revokeObjectURL(url); }
        }

        async function decodePixels(bytes, dpi, detail) {
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
          const image = new Image();
          try {
            image.src = url;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let red = 0, blue = 0, black = 0;
            for (let index = 0; index < pixels.length; index += 4) {
              const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
              if (r > 180 && g < 80 && b < 80) red++;
              if (b > 160 && r < 90 && g < 120) blue++;
              if (r < 70 && g < 70 && b < 70) black++;
            }
            const scale = Math.round(120 / 25.4 * dpi) / 1000;
            const ink = (x, y, width, height, blue = false) => {
              const left = Math.max(0, Math.floor(1 + (x - width / 2) * scale));
              const top = Math.max(0, Math.floor(1 + (y - height / 2) * scale));
              const right = Math.min(canvas.width, Math.ceil(1 + (x + width / 2) * scale));
              const bottom = Math.min(canvas.height, Math.ceil(1 + (y + height / 2) * scale));
              let count = 0;
              for (let row = top; row < bottom; row++) for (let column = left; column < right; column++) {
                const index = (row * canvas.width + column) * 4;
                if (blue
                  ? pixels[index + 2] > 160 && pixels[index] < 90 && pixels[index + 1] < 120
                  : pixels[index] < 70 && pixels[index + 1] < 70 && pixels[index + 2] < 70) count++;
              }
              return count;
            };
            const center = context.getImageData(Math.round(1 + detail.center.x * scale), Math.round(1 + detail.center.y * scale), 1, 1).data;
            return {
              width: canvas.width, height: canvas.height, red, blue, black,
              labelInk: ink(500, 600, 70, 50),
              titleInk: ink(detail.title.x, detail.title.y, 60, 40),
              detailRingInk: ink(detail.center.x + detail.radius * detail.ratio, detail.center.y, 12, 30),
              overlayLineInk: ink(275, 100, 340, 25, true),
              detailCenter: Array.from(center).slice(0, 3),
            };
          } finally { image.src = ''; URL.revokeObjectURL(url); }
        }

        window.cadUnifiedOutputProbe = async (kind, dpi, auto = false, failedRead = false) => {
          const project = drawingProjectFixture(sourceAsset);
          project.sourceKind = kind === 'body' ? 'dwg' : kind;
          project.width = 1000; project.height = 800;
          project.baseFragments = undefined;
          project.annotations = [{ id: 'label', text: '12', x: 500, y: 600, fontSize: 28, lineWidth: 1, points: [] }];
          project.detailViews = [];
          project.cad = {
            version: 1, engine: 'cadcraft', engineVersion: 'a'.repeat(40),
            assetId: '00000000-0000-4000-8000-000000000904',
            mapping: { originX: 0, originY: 800, scale: 1 }, unified: 1,
            ...(kind === 'body' ? {} : { overlayAssetId: overlayAsset, backgroundSize: [1000, 800] }),
          };
          const detail = createDetailView(project, { x: 250, y: 450 }, 35, { x: 750, y: 300 }, 'A', 2, 28, 1, 'native-detail');
          project.detailViews = [detail];
          if (kind === 'body') {
            project.cad.objects = [{ id: detail.id, kind: 'detail', body: ['AB'] }];
            detail.cadSource = { ...project.cad, baseAssetId: frozenAsset, width: 1000, height: 800 };
          }
          const region = { id: 'all', name: '图1', kind: 'rectangle', points: [{x:0,y:0},{x:1000,y:0},{x:1000,y:800},{x:0,y:800}] };
          project.regions = [region];
          DrawingProjectSchema.parse(project);
          const source = kind === 'body' ? encode(editedBodySvg) : kind === 'pdf' ? redPdf() : await redRaster();
          const originalSource = source.slice();
          const before = JSON.stringify(project);
          const reads = [], texts = [];
          let jpegCalls = 0, returned = false, error = null, pixels = null;
          const fillText = CanvasRenderingContext2D.prototype.fillText;
          const toBlob = HTMLCanvasElement.prototype.toBlob;
          CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
            texts.push(String(text));
            return maxWidth === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, maxWidth);
          };
          HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
            if (type === 'image/jpeg') jpegCalls++;
            return toBlob.call(this, callback, type, quality);
          };
          try {
            const output = await renderDrawing(project, region, source, kind === 'body' ? 'image/svg+xml' : kind === 'pdf' ? 'application/pdf' : 'image/png', 120, dpi, {
              autoAdjustLabelSize: auto,
              readCadDetail: async (assetId) => {
                reads.push(assetId);
                if (failedRead) throw new Error('Native overlay resource unavailable');
                if (assetId === overlayAsset) return encode(overlaySvg);
                if (assetId === frozenAsset) return encode(redSvg);
                throw new Error('Unexpected fixture asset ' + assetId);
              },
            });
            pixels = await decodePixels(output.bytes, dpi, detail);
            returned = true;
          } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
          finally {
            CanvasRenderingContext2D.prototype.fillText = fillText;
            HTMLCanvasElement.prototype.toBlob = toBlob;
          }
          return { returned, error, pixels, texts, reads, jpegCalls,
            unchanged: JSON.stringify(project) === before,
            sourceUnchanged: source.length === originalSource.length && source.every((value, index) => value === originalSource[index]),
          };
        };
      `,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    plugins: [
      {
        name: "export-worker-routes",
        setup(builder) {
          builder.onResolve({ filter: /\?url$/ }, (args) => ({
            path: args.path,
            namespace: "worker-url",
          }));
          builder.onLoad({ filter: /.*/, namespace: "worker-url" }, () => ({
            contents: 'export default "http://localhost/pdf.worker.mjs"',
            loader: "js",
          }));
          builder.onLoad({ filter: /drawing-pixels\.ts$/ }, async (args) => ({
            contents: (await readFile(args.path, "utf8")).replace(
              'new URL("./drawing-pixels.worker.ts", import.meta.url)',
              'new URL("http://localhost/drawing-pixels.worker.js")',
            ),
            loader: "ts",
          }));
        },
      },
    ],
  });
  const script = compiled.outputFiles[0]?.text;
  const scannerOutput = scanner.outputFiles[0]?.text;
  if (!script || !scannerOutput) throw new Error("Missing compiled export probe");
  compiledScript = script;
  scannerScript = scannerOutput;
  pdfWorkerScript = await readFile(
    resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
    "utf8",
  );
  browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu"],
    ...(process.platform === "darwin"
      ? { channel: "chrome" }
      : process.platform === "win32"
        ? { channel: "msedge" }
        : {}),
  });
});

test.afterAll(async () => {
  await browser?.close();
});

async function probe(kind: "image" | "pdf" | "body", dpi = 300, auto = false, failedRead = false) {
  const page = await browser.newPage();
  try {
    await page.route("http://localhost/**", (route) => {
      const url = route.request().url();
      return route.fulfill({
        body: url.endsWith("pdf.worker.mjs")
          ? pdfWorkerScript
          : url.endsWith("drawing-pixels.worker.js")
            ? scannerScript
            : "<body/>",
        contentType: url.endsWith(".js") || url.endsWith(".mjs") ? "text/javascript" : "text/html",
      });
    });
    await page.goto("http://localhost/");
    await page.addScriptTag({ content: compiledScript });
    return await page.evaluate(
      ([kind, dpi, auto, failedRead]) =>
        (
          window as unknown as {
            cadUnifiedOutputProbe(
              kind: string,
              dpi: number,
              auto: boolean,
              failedRead: boolean,
            ): Promise<ProbeResult>;
          }
        ).cadUnifiedOutputProbe(
          kind as string,
          dpi as number,
          auto as boolean,
          failedRead as boolean,
        ),
      [kind, dpi, auto, failedRead],
    );
  } finally {
    await page.close();
  }
}

function expectHybrid(result: ProbeResult) {
  expect(result.error).toBeNull();
  expect(result.returned).toBe(true);
  expect(result.unchanged).toBe(true);
  expect(result.sourceUnchanged).toBe(true);
  expect(result.jpegCalls).toBe(1);
  expect(result.reads).toContain("00000000-0000-4000-8000-000000000902");
  expect(result.texts).toEqual(expect.arrayContaining(["12", "A", "2:1"]));
  if (!result.pixels) throw new Error("Missing decoded JPEG pixels");
  expect(result.pixels.red).toBeGreaterThan(100_000);
  expect(result.pixels.blue).toBeGreaterThan(1_000);
  expect(result.pixels.labelInk).toBeGreaterThan(30);
  expect(result.pixels.titleInk).toBeGreaterThan(20);
  expect(result.pixels.detailRingInk).toBeGreaterThan(20);
  expect(result.pixels.overlayLineInk).toBeGreaterThan(1_000);
  expect(result.pixels.detailCenter[2]).toBeGreaterThan(160);
  expect(result.pixels.detailCenter[0]).toBeLessThan(90);
}

for (const dpi of [300, 600]) {
  test(`hybrid raster and native SVG retain both colors, labels and details at ${dpi} DPI`, async () => {
    const result = await probe("image", dpi);
    expectHybrid(result);
    console.info("Hybrid raster export pixels", dpi, JSON.stringify(result.pixels));
  });
}

test("hybrid actual PDF and native SVG retain the backdrop and annotations", async () => {
  const result = await probe("pdf");
  expectHybrid(result);
  console.info("Hybrid PDF export pixels", JSON.stringify(result.pixels));
});

test("automatic label formatting retains hybrid geometry without changing the project", async () => {
  const result = await probe("image", 300, true);
  expectHybrid(result);
});

test("materialized native detail body is not overwritten by an old frozen source", async () => {
  const result = await probe("body");
  expect(result.error).toBeNull();
  expect(result.returned).toBe(true);
  expect(result.unchanged).toBe(true);
  expect(result.sourceUnchanged).toBe(true);
  expect(result.reads).toEqual([]);
  if (!result.pixels) throw new Error("Missing materialized detail JPEG pixels");
  expect(result.pixels.blue).toBeGreaterThan(1_000);
  expect(result.pixels.red).toBe(0);
  expect(result.pixels.detailCenter[2]).toBeGreaterThan(160);
  expect(result.pixels.detailCenter[0]).toBeLessThan(90);
  expect(result.pixels.labelInk).toBeGreaterThan(30);
  console.info("Native detail export pixels", JSON.stringify(result.pixels));
});

test("a native overlay asset read failure rejects before generating any partial JPEG", async () => {
  const result = await probe("image", 300, false, true);
  expect(result.error).toBe("Native overlay resource unavailable");
  expect(result.returned).toBe(false);
  expect(result.pixels).toBeNull();
  expect(result.jpegCalls).toBe(0);
  expect(result.unchanged).toBe(true);
  expect(result.sourceUnchanged).toBe(true);
  expect(result.reads).toEqual(["00000000-0000-4000-8000-000000000902"]);
});
