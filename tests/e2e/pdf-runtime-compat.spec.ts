import path from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "vite";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

test("PDF preview and drawing import work without newer Map APIs", async ({ page }) => {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      assetsInlineLimit: 0,
      lib: {
        entry: path.resolve("tests/fixtures/pdf-compat-browser.mjs"),
        name: "PdfCompatFixture",
        formats: ["iife"],
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const files = new Map<string, string | Uint8Array>();
  let fixture = "";
  for (const output of outputs) {
    if (!("output" in output)) continue;
    for (const item of output.output) {
      if (item.type === "chunk") fixture += item.code;
      else files.set(`/${item.fileName}`, item.source);
    }
  }
  await page.route("http://pdf-compat.test/**", async (route) => {
    const key = new URL(route.request().url()).pathname;
    if (key === "/")
      return route.fulfill({ contentType: "text/html", body: "<canvas id='page'></canvas>" });
    const body = files.get(key);
    if (!body) return route.fulfill({ status: 404, body: "Missing fixture asset" });
    return route.fulfill({
      contentType: "text/javascript",
      body: typeof body === "string" ? body : Buffer.from(body),
    });
  });
  await page.addInitScript(() => {
    Reflect.deleteProperty(Map.prototype, "getOrInsertComputed");
    Reflect.deleteProperty(WeakMap.prototype, "getOrInsertComputed");
  });
  await page.goto("http://pdf-compat.test/");
  await page.addScriptTag({ content: fixture });
  const resultPages = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        pdfCompat: {
          createPdfPageRenderer: () => {
            open(bytes: Uint8Array): Promise<{ totalPages: number }>;
            render(
              canvas: HTMLCanvasElement,
              request: {
                pageNumber: number;
                zoom: { mode: "fit-page" };
                container: { width: number; height: number };
              },
            ): Promise<unknown>;
            close(): void;
          };
          pdfDocument(
            bytes: Uint8Array,
          ): Promise<{ task: { destroy(): Promise<void> }; doc: { numPages: number } }>;
        };
      }
    ).pdfCompat;
    const bytes = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >> endobj\n4 0 obj << /Length 0 >> stream\n\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF",
    );
    const renderer = api.createPdfPageRenderer();
    try {
      const opened = await renderer.open(bytes);
      const canvas = document.querySelector<HTMLCanvasElement>("canvas");
      if (!canvas) throw new Error("Missing PDF canvas");
      await renderer.render(canvas, {
        pageNumber: 1,
        zoom: { mode: "fit-page" },
        container: { width: 200, height: 200 },
      });
      const drawing = await api.pdfDocument(bytes);
      try {
        return [opened.totalPages, drawing.doc.numPages];
      } finally {
        await drawing.task.destroy();
      }
    } finally {
      renderer.close();
    }
  });
  expect(resultPages).toEqual([1, 1]);
});
