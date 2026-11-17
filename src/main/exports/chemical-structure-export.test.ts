import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import type { StoredAsset } from "../assets/asset-store.js";
import {
  chemicalStructureDegradationIssue,
  prepareChemicalStructureExport,
  prepareChemicalStructureJpeg,
  sanitizeExportSvg,
} from "./chemical-structure-export.js";

const nodeId = "00000000-0000-4000-8000-000000000881";
const previewAssetId = "00000000-0000-4000-8000-000000000882";

function structureNode(widthMm = 80, alignment: "left" | "center" | "right" = "center") {
  return {
    id: nodeId,
    type: "chemical-structure" as const,
    ketSource: "(ket) (atom C)",
    previewAssetId,
    widthMm,
    alignment,
  };
}

async function pngPreview(): Promise<Uint8Array> {
  return Uint8Array.from(
    await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.png")),
  );
}

async function svgPreviewAsset(
  overrides: Partial<
    Omit<StoredAsset["descriptor"], "kind" | "mediaType" | "extension" | "originalName">
  > = {},
  svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><path d="M0 0"/></svg>',
): Promise<StoredAsset> {
  const preview = await pngPreview();
  return {
    descriptor: {
      assetId: previewAssetId,
      kind: "chemical-preview",
      originalName: "structure.svg",
      mediaType: "image/svg+xml",
      extension: "svg",
      byteLength: Buffer.byteLength(svg),
      sha256: "A".repeat(64),
      widthPx: 32,
      heightPx: 24,
      previewByteLength: preview.byteLength,
      previewSha256: "B".repeat(64),
      ...overrides,
    },
    original: Uint8Array.from(Buffer.from(svg, "utf8")),
    preview,
  };
}

async function legacyPngAsset(): Promise<StoredAsset> {
  const preview = await pngPreview();
  return {
    descriptor: {
      assetId: previewAssetId,
      kind: "image",
      originalName: "structure.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: preview.byteLength,
      sha256: "A".repeat(64),
      widthPx: 32,
      heightPx: 24,
      previewByteLength: preview.byteLength,
      previewSha256: "B".repeat(64),
    },
    original: preview,
    preview,
  };
}

describe("chemical structure export preparation", () => {
  test("rejects an excessive output size before allocating a raster", async () => {
    await expect(
      prepareChemicalStructureJpeg({
        svg: null,
        png: await pngPreview(),
        widthMm: 165,
        heightMm: 1_000_000,
      }),
    ).rejects.toThrow("输出尺寸过大");
  });
  test("exports a large valid SVG at the requested physical size without over-rasterizing", async () => {
    const result = await prepareChemicalStructureJpeg({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600"><path stroke="black" d="M0 0L1600 1600"/></svg>',
      png: await pngPreview(),
      widthMm: 80,
      heightMm: 80,
    });
    expect(result.widthPx).toBe(945);
    expect(result.heightPx).toBe(945);
    expect((await sharp(result.bytes).metadata()).density).toBe(300);
  });
  test("picks the sanitized SVG for vector-aware output and clamps the width", async () => {
    const stored = await svgPreviewAsset();
    const prepared = await prepareChemicalStructureExport(structureNode(200), stored, {
      contentWidthMm: 146,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("fixture");
    expect(prepared.media.svg).toContain("<svg");
    expect(prepared.media.pngWidthPx).toBe(12);
    expect(prepared.media.pngHeightPx).toBe(8);
    expect(prepared.media.widthMm).toBe(146);
    expect(prepared.media.heightMm).toBeCloseTo((146 * 8) / 12, 5);
    expect(
      chemicalStructureDegradationIssue(structureNode(200), stored, prepared.media),
    ).toBeNull();
  });

  test("falls back to PNG for a legacy image preview without reporting an issue", async () => {
    const stored = await legacyPngAsset();
    const prepared = await prepareChemicalStructureExport(structureNode(80), stored, {
      contentWidthMm: 146,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("fixture");
    expect(prepared.media.svg).toBeNull();
    expect(chemicalStructureDegradationIssue(structureNode(80), stored, prepared.media)).toBeNull();
  });

  test("reports a degradation warning only when a chemical preview SVG cannot be embedded", async () => {
    const stored = await svgPreviewAsset(
      {},
      '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
    );
    const prepared = await prepareChemicalStructureExport(structureNode(80), stored, {
      contentWidthMm: 146,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("fixture");
    expect(prepared.media.svg).toBeNull();
    expect(chemicalStructureDegradationIssue(structureNode(80), stored, prepared.media)).toEqual({
      severity: "warning",
      code: "CHEMISTRY_RENDERED_AS_IMAGE",
      nodeId,
      message: expect.stringContaining("降级为 JPEG"),
    });
  });

  test("reports MISSING_ASSET when the preview resource is absent", async () => {
    const prepared = await prepareChemicalStructureExport(structureNode(80), undefined, {
      contentWidthMm: 146,
    });

    expect(prepared).toEqual({
      ok: false,
      issue: {
        severity: "error",
        code: "MISSING_ASSET",
        nodeId,
        message: expect.stringContaining("不存在"),
      },
    });
  });

  test("exports the PNG fallback when a stored SVG is malformed", async () => {
    const stored = await svgPreviewAsset({}, '<svg xmlns="http://www.w3.org/2000/svg"><path');
    const prepared = await prepareChemicalStructureExport(structureNode(), stored, {
      contentWidthMm: 146,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("fixture");
    expect(prepared.media.svg).toBeNull();
    const result = await prepareChemicalStructureJpeg(prepared.media);
    expect((await sharp(result.bytes).metadata()).format).toBe("jpeg");
    expect(
      chemicalStructureDegradationIssue(structureNode(), stored, prepared.media)?.severity,
    ).toBe("warning");
  });

  test("falls back when valid XML cannot be rasterized within the image limit", async () => {
    const stored = await svgPreviewAsset(
      {},
      '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"/>',
    );
    const prepared = await prepareChemicalStructureExport(structureNode(), stored, {
      contentWidthMm: 146,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("fixture");
    expect(prepared.media.svg).toBeNull();
    await expect(prepareChemicalStructureJpeg(prepared.media)).resolves.toMatchObject({
      widthPx: 945,
    });
  });

  test("reports MISSING_ASSET when the preview bytes are not a valid PNG", async () => {
    const stored = await svgPreviewAsset();
    stored.preview = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
    const prepared = await prepareChemicalStructureExport(structureNode(80), stored, {
      contentWidthMm: 146,
    });

    expect(prepared).toEqual({
      ok: false,
      issue: {
        severity: "error",
        code: "MISSING_ASSET",
        nodeId,
        message: expect.stringContaining("已损坏"),
      },
    });
  });

  test("shrinks oversized structures to fit the page height while keeping the aspect ratio", async () => {
    const stored = await svgPreviewAsset(
      {},
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="2000"/>',
    );
    const prepared = await prepareChemicalStructureExport(structureNode(146), stored, {
      contentWidthMm: 146,
      contentHeightMm: 50,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("fixture");
    expect(prepared.media.heightMm).toBeLessThanOrEqual(50);
    expect(prepared.media.widthMm / prepared.media.heightMm).toBeCloseTo(12 / 8, 5);
  });
});

describe("sanitizeExportSvg", () => {
  test("accepts a plain structure SVG", () => {
    expect(
      sanitizeExportSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><path d="M0 0"/></svg>',
      ),
    ).toBe(true);
  });

  test.each([
    ["malformed XML", '<svg xmlns="http://www.w3.org/2000/svg"><path'],
    ["non-SVG XML", '<html xmlns="http://www.w3.org/2000/svg"/>'],
    ["namespaced script", '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script/></s:svg>'],
    [
      "aliased xlink reference",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:link="http://www.w3.org/1999/xlink"><image link:href="https://example.com/image.png"/></svg>',
    ],
    [
      "CSS import",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.com/x";</style></svg>',
    ],
    [
      "escaped CSS URL",
      String.raw`<svg xmlns="http://www.w3.org/2000/svg"><style>path{fill:u\72l(https://example.com/x)}</style></svg>`,
    ],
    ["doctype", '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["script", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    [
      "foreignObject",
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>unsafe</div></foreignObject></svg>',
    ],
    [
      "processing instruction",
      '<?xml-stylesheet href="x"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    ],
    ["event handler", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    [
      "external image URL",
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/leak.png"/></svg>',
    ],
    [
      "external CSS URL",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>path{fill:url(https://example.com/x)}</style></svg>',
    ],
    ["empty", ""],
    ["whitespace", "   "],
  ])("rejects %s", (_label, input) => {
    expect(sanitizeExportSvg(input)).toBe(false);
  });

  test("rejects oversized SVG sources", () => {
    expect(sanitizeExportSvg(`<svg>${"x".repeat(2 * 1024 * 1024 + 1)}</svg>`)).toBe(false);
  });
});
