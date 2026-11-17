import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import sharp from "sharp";
import { expect, test, waitForMainWindow } from "./helpers/workbench.js";

test("production hidden renderer and its restricted preload export tiled CAD at 300 and 600 DPI", async ({
  workbench,
}) => {
  const modulePath = resolve(`out/main/graphics-acceptance-${process.pid}.cjs`);
  await build({
    stdin: {
      contents: `export {renderAutomationGraphic} from './src/main/automation/graphics.ts';export {drawingProjectFixture} from './src/shared/drawing-markup/test-fixture.ts';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    define: { "import.meta.url": JSON.stringify(pathToFileURL(modulePath).href) },
    packages: "external",
    outfile: modulePath,
  });
  const app = await workbench.launch();
  try {
    await waitForMainWindow(app, false);
    for (const dpi of [300, 600] as const) {
      const output = await app.evaluate(
        async ({ BrowserWindow }, input) => {
          const api = process.getBuiltinModule("module").createRequire(input.modulePath)(
            input.modulePath,
          );
          const body =
            '<rect width="1000000" height="800000" fill="white"/><path d="M0 400000H1000000 M500000 0V800000" stroke="black" stroke-width="1000"/><circle cx="500000" cy="400000" r="130000" fill="none" stroke="black" stroke-width="800"/>';
          const full = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="0 0 1000000 800000">${body}</svg>`,
          );
          const index = {
            version: 1,
            width: 1000,
            height: 800,
            tier: "large",
            primitives: 3,
            tiles: [] as any[],
          };
          const bytes = new Map<string, Uint8Array>();
          for (let y = 0; y < 2; y++)
            for (let x = 0; x < 2; x++) {
              const core = { x: x * 500, y: y * 400, width: 500, height: 400 };
              const left = Math.max(0, core.x - 8),
                top = Math.max(0, core.y - 8);
              const render = {
                x: left,
                y: top,
                width: Math.min(1000, core.x + 508) - left,
                height: Math.min(800, core.y + 408) - top,
              };
              const id = `tile-${index.tiles.length}`;
              const source = Buffer.from(
                `<svg xmlns="http://www.w3.org/2000/svg" width="${render.width}" height="${render.height}" viewBox="${render.x * 1000} ${render.y * 1000} ${render.width * 1000} ${render.height * 1000}">${body}</svg>`,
              );
              index.tiles.push({
                id,
                core,
                render,
                byteLength: source.length,
                sha256: "A".repeat(64),
              });
              bytes.set(id, source);
            }
          const project = {
            ...api.drawingProjectFixture("tiles"),
            sourceKind: "dwg",
            baseFragments: undefined,
            annotations: [],
            detailViews: [],
          };
          const region = {
            id: "all",
            name: "all",
            kind: "rectangle",
            points: [
              { x: 0, y: 0 },
              { x: 1000, y: 0 },
              { x: 1000, y: 800 },
              { x: 0, y: 800 },
            ],
          };
          const request = {
            kind: "drawing",
            source: full.toString("base64"),
            mediaType: "image/svg+xml",
            project,
            region,
            widthMm: 100,
            dpi: input.dpi,
            autoAdjustLabelSize: false,
          };
          const normal = await api.renderAutomationGraphic(request, new AbortController().signal);
          const reads: string[] = [];
          const tiled = await api.renderAutomationGraphic(
            {
              ...request,
              source: "",
              mediaType: "application/vnd.zxw.cad-tiles+zip",
              tiledIndex: index,
            },
            new AbortController().signal,
            {
              index,
              readTile: async (id: string) => {
                reads.push(id);
                return bytes.get(id)!;
              },
            },
          );
          let overlapError = "";
          try {
            await api.renderAutomationGraphic(
              {
                ...request,
                autoAdjustLabelSize: true,
                autoLabelScale: 1.5,
                project: {
                  ...project,
                  annotations: [
                    {
                      id: "one",
                      text: "12",
                      x: 350,
                      y: 120,
                      fontSize: 12,
                      lineWidth: 1,
                      points: [],
                    },
                    {
                      id: "two",
                      text: "13",
                      x: 366,
                      y: 120,
                      fontSize: 12,
                      lineWidth: 1,
                      points: [],
                    },
                  ],
                },
              },
              new AbortController().signal,
            );
          } catch (error) {
            overlapError = (error as Error).message;
          }
          return {
            normal,
            tiled,
            overlapError,
            reads,
            hidden: BrowserWindow.getAllWindows().every(
              (window) => !window.isVisible() && !window.isFocused(),
            ),
          };
        },
        { modulePath, dpi },
      );
      expect(output.hidden).toBe(true);
      expect(new Set(output.reads).size).toBe(4);
      expect(output.tiled.width).toBe(output.normal.width);
      expect(output.tiled.height).toBe(output.normal.height);
      expect(output.normal.outputWidthMm).toBe(100);
      expect(output.tiled.outputWidthMm).toBe(100);
      expect(output.overlapError).toMatch(/12.*13.*重叠/);
      const normal = await sharp(Buffer.from(output.normal.data, "base64"))
        .removeAlpha()
        .raw()
        .toBuffer();
      const tiled = await sharp(Buffer.from(output.tiled.data, "base64"))
        .removeAlpha()
        .raw()
        .toBuffer();
      let differences = 0;
      for (let i = 0; i < normal.length; i++)
        if (Math.abs(normal[i]! - tiled[i]!) > 20) differences++;
      expect(differences / normal.length).toBeLessThan(0.004);
    }
  } finally {
    await app.close();
  }
});
