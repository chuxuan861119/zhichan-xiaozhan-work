// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";
import { AUTOMATION_DRAWING_TILE_CHANNEL } from "../../shared/automation/graphics.js";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";

const fixture = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  execute: vi.fn(),
  destroy: vi.fn(),
  handlers: new Map<string, (...args: any[]) => Promise<unknown>>(),
  contents: undefined as any,
  nextId: 100,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) =>
        fixture.handlers.set(channel, handler),
    },
    BrowserWindow: class {
      constructor(options: Record<string, unknown>) {
        fixture.options = options;
        fixture.contents = this.webContents;
      }
      webContents = Object.assign(new EventEmitter(), {
        id: fixture.nextId++,
        mainFrame: {},
        isDestroyed: () => false,
        setWindowOpenHandler: vi.fn(),
        executeJavaScript: fixture.execute,
      });
      loadURL = vi.fn(async () => undefined);
      isDestroyed = () => false;
      destroy = fixture.destroy;
    },
  };
});

import { renderAutomationGraphic } from "./graphics.js";

beforeEach(() => {
  fixture.execute.mockReset();
  fixture.destroy.mockReset();
});
test("renders without focus or a preload bridge and destroys the temporary window", async () => {
  fixture.execute.mockResolvedValue({
    data: "cG5n",
    width: 10,
    height: 10,
    mediaType: "image/png",
    totalPages: 1,
  });
  const result = await renderAutomationGraphic(
    { kind: "pdf-preview", source: "cGRm", pageNumber: 1 },
    new AbortController().signal,
  );
  expect(result.totalPages).toBe(1);
  expect(fixture.options).toMatchObject({
    show: false,
    focusable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  expect(
    (fixture.options?.webPreferences as Record<string, unknown> | undefined)?.preload,
  ).toBeUndefined();
  expect(fixture.destroy).toHaveBeenCalledOnce();
});
test("cancellation destroys a renderer that is still working", async () => {
  const started = new EventEmitter();
  fixture.execute.mockImplementation(() => {
    started.emit("start");
    return new Promise(() => {});
  });
  const ready = new Promise<void>((resolve) => started.once("start", resolve));
  const controller = new AbortController();
  const render = renderAutomationGraphic(
    { kind: "pdf-preview", source: "cGRm", pageNumber: 1 },
    controller.signal,
  );
  const rejected = expect(render).rejects.toMatchObject({ code: "CANCELLED" });
  await ready;
  controller.abort();
  await rejected;
  expect(fixture.destroy).toHaveBeenCalledOnce();
});

test("drawing bridge preserves physical output width and actionable label failures", async () => {
  const project = drawingProjectFixture("source");
  const request = {
    kind: "drawing" as const,
    source: "cG5n",
    mediaType: "image/png",
    project,
    region: project.regions[0]!,
    widthMm: 120,
    dpi: 300 as const,
    autoAdjustLabelSize: true,
    autoLabelScale: 1.5,
  };
  fixture.execute.mockResolvedValue({
    data: "anBlZw==",
    width: 1200,
    height: 2400,
    mediaType: "image/jpeg",
    outputWidthMm: 100,
  });
  await expect(
    renderAutomationGraphic(request, new AbortController().signal),
  ).resolves.toMatchObject({ outputWidthMm: 100 });
  fixture.execute.mockResolvedValue({ error: "自动调整后标号“12”与“13”重叠，请移动标号后重试。" });
  await expect(
    renderAutomationGraphic(request, new AbortController().signal),
  ).rejects.toMatchObject({
    code: "RENDER_FAILED",
    message: expect.stringMatching(/12.*13.*重叠/),
  });
  expect(fixture.destroy).toHaveBeenCalledTimes(2);
});

test("tile lease accepts only this renderer's main frame and tile, then revokes on cancellation", async () => {
  const project = drawingProjectFixture("tiles");
  const rect = { x: 0, y: 0, width: 1000, height: 800 };
  const index = {
    version: 1 as const,
    width: 1000,
    height: 800,
    tier: "large" as const,
    primitives: 1,
    tiles: [{ id: "tile-0", core: rect, render: rect, byteLength: 1, sha256: "A".repeat(64) }],
  };
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  fixture.execute.mockImplementation(() => {
    started();
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const readTile = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const render = renderAutomationGraphic(
    {
      kind: "drawing",
      source: "",
      mediaType: "application/vnd.zxw.cad-tiles+zip",
      project,
      region: project.regions[0]!,
      widthMm: 100,
      dpi: 300,
      autoAdjustLabelSize: false,
      tiledIndex: index,
    },
    controller.signal,
    { index, readTile },
  );
  const rejected = expect(render).rejects.toMatchObject({ code: "CANCELLED" });
  await ready;
  const handler = fixture.handlers.get(AUTOMATION_DRAWING_TILE_CHANNEL)!;
  const sender = fixture.contents;
  const event = { sender, senderFrame: sender.mainFrame };
  await expect(handler(event, "tile-0")).resolves.toEqual(new Uint8Array([1, 2, 3]));
  await expect(handler(event, "tile-1")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await expect(handler({ ...event, senderFrame: {} }, "tile-0")).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  await expect(
    handler({ sender: { ...sender, id: -1 }, senderFrame: sender.mainFrame }, "tile-0"),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  expect(readTile).toHaveBeenCalledOnce();
  expect(fixture.options).toMatchObject({
    webPreferences: { preload: expect.stringMatching(/automation-tiles\.cjs$/u) },
  });
  controller.abort();
  await rejected;
  await expect(handler(event, "tile-0")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
});
