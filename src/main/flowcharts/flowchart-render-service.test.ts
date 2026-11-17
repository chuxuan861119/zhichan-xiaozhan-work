import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { DEFAULT_PAGE_SETTINGS } from "../../shared/document/defaults.js";
import type { FlowchartProjectDescriptor } from "../../shared/flowcharts/model.js";
import { type FlowchartRenderError, FlowchartRenderService } from "./flowchart-render-service.js";

const PROJECT: FlowchartProjectDescriptor = {
  projectId: "11111111-1111-4111-8111-111111111111",
  name: "控制流程",
  revision: 3,
  pageCount: 1,
  lastPageId: "page-1",
  sourceSha256: "A".repeat(64),
  createdAt: "2026-08-11T00:00:00.000Z",
  modifiedAt: "2026-08-11T00:00:00.000Z",
};

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect x="2" y="2" width="116" height="56" fill="#ffee00" stroke="#2468ff"/><text x="20" y="34" fill="#ff0000">开始</text></svg>';

test("renders one sanitized SVG into a verified PNG and issues a one-time preview token", async () => {
  const service = new FlowchartRenderService({ randomUUID });
  const preview = await service.render({
    patentId: "22222222-2222-4222-8222-222222222222",
    project: PROJECT,
    pageId: "page-1",
    exportScope: "page",
    selectedCellIds: [],
    borderMm: 2,
    svg: SVG,
    target: { kind: "new", insertIndex: 0 },
  });

  expect(preview.preview.slice(1, 4)).toEqual(Uint8Array.from([0x50, 0x4e, 0x47]));
  expect(preview.widthPx).toBeGreaterThan(120);
  expect(preview.heightPx).toBeGreaterThan(60);
  expect(preview.sanitizedSvg).toContain('fill="#FFFFFF"');
  expect(preview.sanitizedSvg).toContain('stroke="#000000"');

  const claimed = service.claim(preview.previewToken, {
    project: PROJECT,
    target: { kind: "new", insertIndex: 0 },
  });
  expect(claimed.asset.descriptor.kind).toBe("flowchart-preview");
  expect(claimed.asset.preview).toEqual(preview.preview);
  expect(claimed.link.pageId).toBe("page-1");
  expect(() =>
    service.claim(preview.previewToken, { project: PROJECT, target: claimed.target }),
  ).toThrowError(
    expect.objectContaining<Partial<FlowchartRenderError>>({ code: "PREVIEW_EXPIRED" }),
  );
});

test.each([
  { viewBoxWidth: 40, expectedWidthMm: 14.58 },
  { viewBoxWidth: 400, expectedWidthMm: 109.83 },
  { viewBoxWidth: 1_000, expectedWidthMm: 165 },
])(
  "fits a $viewBoxWidth px new figure to $expectedWidthMm mm without exceeding the page width",
  async ({ viewBoxWidth, expectedWidthMm }) => {
    const service = new FlowchartRenderService({ randomUUID });
    const preview = await service.render({
      patentId: "22222222-2222-4222-8222-222222222222",
      project: PROJECT,
      pageId: "page-1",
      exportScope: "page",
      selectedCellIds: [],
      borderMm: 2,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxWidth} 60"><rect width="${viewBoxWidth}" height="60"/></svg>`,
      target: { kind: "new", insertIndex: 0 },
    });

    expect(service.claim(preview.previewToken, { project: PROJECT }).outputWidthMm).toBe(
      expectedWidthMm,
    );
  },
);

test("preserves an explicit width when replacing an existing figure", async () => {
  const service = new FlowchartRenderService({ randomUUID });
  const preview = await service.render({
    patentId: "22222222-2222-4222-8222-222222222222",
    project: PROJECT,
    pageId: "page-1",
    exportScope: "page",
    selectedCellIds: [],
    borderMm: 2,
    outputWidthMm: 120,
    svg: SVG,
    target: {
      kind: "replace",
      figureId: "33333333-3333-4333-8333-333333333333",
      assetId: "44444444-4444-4444-8444-444444444444",
    },
  });

  expect(service.claim(preview.previewToken, { project: PROJECT }).outputWidthMm).toBe(120);
});

test("invalidates the preview when the source revision or replacement target changes", async () => {
  const service = new FlowchartRenderService({ randomUUID });
  const preview = await service.render({
    patentId: "22222222-2222-4222-8222-222222222222",
    project: PROJECT,
    pageId: "page-1",
    exportScope: "selection",
    selectedCellIds: ["cell-1"],
    borderMm: 0,
    svg: SVG,
    target: {
      kind: "replace",
      figureId: "33333333-3333-4333-8333-333333333333",
      assetId: "44444444-4444-4444-8444-444444444444",
    },
  });

  expect(() =>
    service.claim(preview.previewToken, {
      project: { ...PROJECT, revision: 4 },
      target: {
        kind: "replace",
        figureId: "33333333-3333-4333-8333-333333333333",
        assetId: "44444444-4444-4444-8444-444444444444",
      },
    }),
  ).toThrowError(expect.objectContaining({ code: "STALE_SOURCE" }));

  expect(() =>
    service.claim(preview.previewToken, {
      project: PROJECT,
      target: {
        kind: "replace",
        figureId: "33333333-3333-4333-8333-333333333333",
        assetId: "55555555-5555-4555-8555-555555555555",
      },
    }),
  ).toThrowError(expect.objectContaining({ code: "STALE_TARGET" }));
});

test("rejects zero-size output before issuing a token", async () => {
  const service = new FlowchartRenderService({ randomUUID });
  await expect(
    service.render({
      patentId: "22222222-2222-4222-8222-222222222222",
      project: PROJECT,
      pageId: "page-1",
      exportScope: "page",
      selectedCellIds: [],
      borderMm: 0,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 0"><path d="M0 0"/></svg>',
      target: { kind: "new", insertIndex: 0 },
    }),
  ).rejects.toMatchObject({ code: "EMPTY_RENDER" });
});

test("converts embedded raster pixels to monochrome in both stored SVG and PNG", async () => {
  const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } })
    .png()
    .toBuffer();
  const service = new FlowchartRenderService({ randomUUID });
  const preview = await service.render({
    patentId: "22222222-2222-4222-8222-222222222222",
    project: PROJECT,
    pageId: "page-1",
    exportScope: "page",
    selectedCellIds: [],
    borderMm: 0,
    outputWidthMm: 150,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="data:image/png;base64,${red.toString("base64")}" width="10" height="10"/></svg>`,
    target: { kind: "new", insertIndex: 0 },
  });
  const embedded = /base64,([^"']+)/u.exec(preview.sanitizedSvg)?.[1];
  expect(embedded).toBeTruthy();
  const stats = await sharp(Buffer.from(embedded ?? "", "base64")).stats();
  expect(stats.channels[0]?.mean).toBe(stats.channels[1]?.mean);
  expect(stats.channels[1]?.mean).toBe(stats.channels[2]?.mean);
});

test("allows an abandoned preview to be discarded immediately", async () => {
  const service = new FlowchartRenderService({ randomUUID });
  const preview = await service.render({
    patentId: "22222222-2222-4222-8222-222222222222",
    project: PROJECT,
    pageId: "page-1",
    exportScope: "page",
    selectedCellIds: [],
    borderMm: 0,
    svg: SVG,
    target: { kind: "new", insertIndex: 0 },
  });
  service.discard(preview.previewToken);
  expect(() => service.claim(preview.previewToken, { project: PROJECT })).toThrowError(
    expect.objectContaining({ code: "PREVIEW_EXPIRED" }),
  );
});

const boundedRequest = {
  patentId: "22222222-2222-4222-8222-222222222222",
  project: PROJECT,
  pageId: "page-1",
  exportScope: "page" as const,
  selectedCellIds: [],
  borderMm: 0,
  svg: SVG,
  target: { kind: "new" as const, insertIndex: 0 },
};

test("evicts the oldest preview at the retained count limit", async () => {
  const service = new FlowchartRenderService({ maxPreviews: 1 });
  const first = await service.render(boundedRequest);
  const second = await service.render(boundedRequest);
  expect(() => service.claim(first.previewToken, { project: PROJECT })).toThrowError(
    expect.objectContaining({ code: "PREVIEW_EXPIRED" }),
  );
  expect(
    service.claim(second.previewToken, { project: PROJECT }).asset.preview.byteLength,
  ).toBeGreaterThan(0);
});

test("rejects a preview larger than the cache budget", async () => {
  const service = new FlowchartRenderService({ maxPreviewBytes: 1 });
  await expect(service.render(boundedRequest)).rejects.toMatchObject({ code: "INVALID_PNG" });
});

test("limits parallel rendering and releases the slot after completion", async () => {
  const service = new FlowchartRenderService({ maxConcurrentRenders: 1 });
  const first = service.render(boundedRequest);
  await expect(service.render(boundedRequest)).rejects.toMatchObject({ code: "RENDER_BUSY" });
  service.discard((await first).previewToken);
  service.discard((await service.render(boundedRequest)).previewToken);
});

test("rejects huge SVG dimensions before allocating a bitmap", async () => {
  await expect(
    new FlowchartRenderService().render({
      ...boundedRequest,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000" viewBox="0 0 20000 20000"><rect width="20000" height="20000"/></svg>',
    }),
  ).rejects.toMatchObject({ code: "INVALID_PNG" });
});

test("evicts by bytes even below the count limit and reclaims discarded bytes", async () => {
  const measured = new FlowchartRenderService();
  const sample = await measured.render(boundedRequest);
  const bytes = Buffer.byteLength(sample.sanitizedSvg) + sample.preview.byteLength;
  measured.discard(sample.previewToken);
  const service = new FlowchartRenderService({ maxPreviews: 8, maxPreviewBytes: bytes + 1 });
  const first = await service.render(boundedRequest);
  const second = await service.render(boundedRequest);
  expect(() => service.claim(first.previewToken, { project: PROJECT })).toThrowError(
    expect.objectContaining({ code: "PREVIEW_EXPIRED" }),
  );
  service.discard(second.previewToken);
  const third = await service.render(boundedRequest);
  expect(
    service.claim(third.previewToken, { project: PROJECT }).asset.preview.byteLength,
  ).toBeGreaterThan(0);
});

test("returns a frozen insertion width and rasterizes its SVG at print resolution", async () => {
  const service = new FlowchartRenderService();
  const preview = await service.render({ ...boundedRequest, borderMm: 2 });
  expect(preview.outputWidthMm).toBeCloseTo(35.75, 2);
  expect(preview.widthPx).toBe(Math.round((preview.outputWidthMm * 300) / 25.4));
  expect(service.claim(preview.previewToken, { project: PROJECT }).outputWidthMm).toBe(
    preview.outputWidthMm,
  );
});

test("also sizes SVGs that declare dimensions without a viewBox", async () => {
  const preview = await new FlowchartRenderService().render({
    ...boundedRequest,
    borderMm: 2,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120px" height="60px"><rect width="120" height="60"/></svg>',
  });
  expect(preview.outputWidthMm).toBe(35.75);
  expect(preview.widthPx).toBe(Math.round((35.75 * 300) / 25.4));
});

test.each([0, 90, 180, 270] as const)(
  "fits an oversized diagram before preview at rotation %i",
  async (rotationDeg) => {
    const service = new FlowchartRenderService();
    const preview = await service.render({
      ...boundedRequest,
      borderMm: 2,
      drawingPage: DEFAULT_PAGE_SETTINGS,
      rotationDeg,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"><rect width="1000" height="500"/></svg>',
    });
    const quarterTurn = rotationDeg === 90 || rotationDeg === 270;
    const widthPx = quarterTurn ? preview.heightPx : preview.widthPx;
    const heightPx = quarterTurn ? preview.widthPx : preview.heightPx;
    expect(preview.outputWidthMm).toBe(quarterTurn ? 102 : 146.6);
    expect(widthPx).toBe(Math.round((preview.outputWidthMm * 300) / 25.4));
    expect((heightPx * preview.outputWidthMm) / widthPx).toBeLessThan(200.1);
    expect(service.claim(preview.previewToken, { project: PROJECT }).outputWidthMm).toBe(
      preview.outputWidthMm,
    );
  },
);

test("rejects a page with no room for the requested margin", async () => {
  const service = new FlowchartRenderService();
  await expect(
    service.render({
      ...boundedRequest,
      borderMm: 20,
      drawingPage: { ...DEFAULT_PAGE_SETTINGS, widthMm: 90 },
    }),
  ).rejects.toMatchObject({ code: "INVALID_PNG" });
});
