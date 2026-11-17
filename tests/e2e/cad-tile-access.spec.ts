import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { packDrawingTiles } from "../../src/main/assets/drawing-tiles.js";
import { writePatdoc } from "../../src/main/documents/patdoc-writer.js";
import { drawingProjectFixture } from "../../src/shared/drawing-markup/test-fixture.js";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { CanonicalPatentSchema } from "../../src/shared/patent/model.js";
import { expect, test } from "./helpers/workbench.js";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").toUpperCase();
test("installed drawing resources are readable only from their owning document window", async ({
  workbench,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "cad-tile-access-"));
  const tileId = randomUUID(),
    sourceId = randomUUID();
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 1000000 750000"><rect width="1000000" height="750000" fill="white"/><circle cx="500000" cy="375000" r="200000" fill="none" stroke="black" stroke-width="2000"/></svg>',
  );
  const rectangle = { x: 0, y: 0, width: 400, height: 300 };
  await writeFile(join(directory, "tile-0.svg"), svg);
  await writeFile(
    join(directory, "index.json"),
    JSON.stringify({
      version: 1,
      width: 400,
      height: 300,
      tier: "large",
      primitives: 1,
      tiles: [
        {
          id: "tile-0",
          core: rectangle,
          render: rectangle,
          byteLength: svg.length,
          sha256: hash(svg),
        },
      ],
    }),
  );
  const packed = await packDrawingTiles(directory);
  const raw = await readFile(resolve("tests/fixtures/cad/sample_AC1032.dwg"));
  const common = {
    widthPx: 400,
    heightPx: 300,
    previewByteLength: packed.preview.length,
    previewSha256: hash(packed.preview),
  };
  const descriptors = [
    {
      ...common,
      assetId: sourceId,
      kind: "drawing-source",
      originalName: "synthetic.dwg",
      mediaType: "image/vnd.dwg",
      extension: "dwg",
      byteLength: raw.length,
      sha256: hash(raw),
    },
    {
      ...common,
      assetId: tileId,
      kind: "drawing-tiles",
      originalName: "synthetic.cadtiles",
      mediaType: "application/vnd.zxw.cad-tiles+zip",
      extension: "cadtiles",
      byteLength: packed.container.length,
      sha256: hash(packed.container),
    },
  ];
  const patent = CanonicalPatentSchema.parse({
    ...createBlankPatent({ patentType: "invention", name: "分块图纸验收" }),
    assets: descriptors,
    drawingProjects: [
      {
        ...drawingProjectFixture(sourceId),
        baseAssetId: tileId,
        sourceKind: "dwg",
        width: 400,
        height: 300,
        baseFragments: undefined,
        // This fixture tests tile ownership, not the image fixture's frozen
        // detail sources (which cannot refer to a DWG as an image).
        annotations: [],
        detailViews: [],
        regions: [],
      },
    ],
  });
  const path = join(directory, "synthetic.patdoc");
  await writePatdoc(path, {
    patent,
    assets: patent.assets.map((d) => ({
      descriptor: d,
      original: d.assetId === sourceId ? raw : packed.container,
      preview: packed.preview,
    })),
  });
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.patentApi));
    await app.evaluate(
      ({ dialog }, path) =>
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        }),
      path,
    );
    const opened = await page.evaluate(() => window.patentApi.patents.importPatdoc());
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) throw Error(opened.error.message);
    if (!opened.value) throw Error("Synthetic import was cancelled");
    const sessionId = opened.value.sessionId;
    const installedTileId = opened.value.patent.drawingProjects[0]!.baseAssetId;
    const result = await page.evaluate(
      async ({ sessionId, tileId }) => {
        const index = await window.patentApi.assets.readDrawingSource(sessionId, tileId);
        const tile = await window.patentApi.assets.readDrawingTile(sessionId, tileId, "tile-0");
        const raster = await window.patentApi.assets.readDrawingTile(sessionId, tileId, "tile-0", {
          region: { x: 50, y: 50, width: 200, height: 100 },
          width: 400,
          height: 200,
          strokeScale: 2,
          minimumPixels: 0.65,
        });
        const concurrent = await Promise.all(
          Array.from({ length: 4 }, () =>
            window.patentApi.assets.readDrawingTile(sessionId, tileId, "tile-0"),
          ),
        );
        const other = await window.patentApi.assets.readDrawingTile(
          sessionId,
          "00000000-0000-4000-8000-000000000099",
          "tile-0",
        );
        return {
          index: index.ok ? JSON.parse(new TextDecoder().decode(index.value)) : index,
          tile: tile.ok ? Array.from(tile.value) : tile,
          raster: raster.ok ? Array.from(raster.value.slice(0, 8)) : raster,
          concurrent: concurrent.map((v) => v.ok),
          other,
        };
      },
      { sessionId, tileId: installedTileId },
    );
    expect(result.index.version).toBe(1);
    expect(result.tile).toEqual(Array.from(svg));
    expect(result.concurrent).toEqual([true, true, true, true]);
    expect(result.other.ok).toBe(false);
    expect(result.raster).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const preload = resolve(
      dirname(process.env.PATENT_WORKBENCH_E2E_APP_ENTRY ?? "out/main/index.js"),
      "../preload/index.cjs",
    );
    const denied = await app.evaluate(
      async ({ BrowserWindow }, { sessionId, tileId, preload }) => {
        const first = BrowserWindow.getAllWindows()[0]!;
        const second = new BrowserWindow({
          show: false,
          alwaysOnTop: false,
          webPreferences: {
            preload,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        });
        try {
          await second.loadURL(first.webContents.getURL());
          return await second.webContents.executeJavaScript(
            `window.patentApi.assets.readDrawingTile(${JSON.stringify(sessionId)},${JSON.stringify(tileId)},"tile-0")`,
          );
        } finally {
          second.destroy();
        }
      },
      { sessionId, tileId: installedTileId, preload },
    );
    expect(denied.ok).toBe(false);
    await page.evaluate((sessionId) => window.patentApi.patents.release(sessionId), sessionId);
    const afterClose = await page.evaluate(
      ({ sessionId, tileId }) =>
        window.patentApi.assets.readDrawingTile(sessionId, tileId, "tile-0"),
      { sessionId, tileId: installedTileId },
    );
    expect(afterClose.ok).toBe(false);
    await page.reload();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    const article = page.getByRole("article", {
      name: opened.value.patent.name ?? "分块图纸验收",
      exact: true,
    });
    await article.dblclick();
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
    await expect(workspace.locator("[data-drawing-tiles]").first()).toHaveAttribute(
      "data-drawing-tiles",
      "1",
    );
    await expect
      .poll(async () =>
        Number(
          await workspace
            .locator("[data-drawing-frames]")
            .first()
            .getAttribute("data-drawing-frames"),
        ),
      )
      .toBeGreaterThan(0);
    // Import can surface the backup setup reminder after the document opens.
    // Resolve that explicit close guard before asking the application to exit.
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    await expect(page.getByRole("region", { name: "CAD实体编辑", exact: true }).getByRole("button", { name: "直线", exact: true })).toBeEnabled({ timeout: 60000 });
    await expect(workspace).toHaveAttribute("data-cad-pending", "false");
    await page.evaluate(() => window.patentApi.settings.update({ closeToTray: false }));
    const closed = app.waitForEvent("close", { timeout: 30_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.isDestroyed())?.close());
    await closed;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
