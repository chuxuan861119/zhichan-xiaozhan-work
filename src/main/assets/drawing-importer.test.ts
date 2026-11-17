import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { pngWithDensity } from "../../shared/drawing-markup/png-density.js";
import { importDrawing } from "./drawing-importer.js";
import { renderEditedImage } from "./image-output-service.js";

test("legacy DWG import also rejects files above 50 MiB before conversion", async () => {
  const bytes = Buffer.alloc(50 * 1024 * 1024 + 1);
  bytes.write("AC1032");
  await expect(
    importDrawing(
      {
        sessionId: randomUUID(),
        operationId: randomUUID(),
        originalName: "large.dwg",
        declaredMediaType: null,
        bytes,
      },
      "absent-runtime",
    ),
  ).rejects.toMatchObject({ code: "CAD_IMPORT_TOO_LARGE" });
});

test("DWG import preserves the actionable component error and the original bytes", async () => {
  const bytes = Buffer.from("AC1032  ");
  await expect(
    importDrawing(
      {
        sessionId: randomUUID(),
        operationId: randomUUID(),
        originalName: "missing.dwg",
        declaredMediaType: null,
        bytes,
      },
      "absent-runtime",
    ),
  ).rejects.toMatchObject({ code: "CAD_RUNTIME_UNAVAILABLE" });
  expect(bytes.toString()).toBe("AC1032  ");
});

test("cancels before starting a converter or creating staged assets", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    importDrawing(
      {
        sessionId: randomUUID(),
        operationId: randomUUID(),
        originalName: "cancelled.dwg",
        declaredMediaType: null,
        bytes: Buffer.from("AC1032  "),
      },
      "unused-runtime",
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test.runIf(Boolean(process.env.PATENT_DWG_TEST_FILE))(
  "converts a local DWG with the bundled runtime",
  async () => {
    const bytes = await readFile(process.env.PATENT_DWG_TEST_FILE!);
    try {
      const result = await importDrawing(
        {
          sessionId: randomUUID(),
          operationId: randomUUID(),
          originalName: "drawing.dwg",
          declaredMediaType: null,
          bytes,
        },
        resolve(process.env.PATENT_DWG_RUNTIME_ROOT ?? "resources/drawing-converter"),
      );
      expect(result.assets).toHaveLength(2);
      expect(result.assets[1]?.descriptor.kind).toBe("vector-image");
    } catch (error) {
      if (error instanceof Error) console.error(error.cause);
      throw error;
    }
  },
  120000,
);

test("keeps original raster bytes and an independently readable full resolution base", async () => {
  const bytes = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "white" },
  })
    .jpeg()
    .toBuffer();
  const result = await importDrawing(
    {
      sessionId: randomUUID(),
      operationId: randomUUID(),
      originalName: "drawing.jpg",
      declaredMediaType: null,
      bytes,
    },
    "unused-runtime",
  );
  expect(result.sourceKind).toBe("image");
  expect(result.assets).toHaveLength(2);
  expect(Buffer.from(result.assets[0]!.original)).toEqual(bytes);
  expect(await sharp(result.assets[1]!.original).metadata()).toMatchObject({
    width: 800,
    height: 600,
    format: "png",
  });
});
test("PNG output carries the selected DPI through image saving", async () => {
  const png = await sharp({
    create: { width: 1500, height: 750, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const bytes = pngWithDensity(png, 300);
  const saved = await renderEditedImage(bytes, { rotationDeg: 0, format: "png" });
  expect(await sharp(saved).metadata()).toMatchObject({ width: 1500, height: 750, density: 300 });
  expect(await sharp(pngWithDensity(bytes, 600)).metadata()).toMatchObject({ density: 600 });
});
test("rejects invalid source bytes without altering the supplied bytes", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  await expect(
    importDrawing(
      {
        sessionId: randomUUID(),
        operationId: randomUUID(),
        originalName: "bad.dwg",
        declaredMediaType: null,
        bytes,
      },
      "unused-runtime",
    ),
  ).rejects.toThrow();
  expect([...bytes]).toEqual([1, 2, 3]);
});
