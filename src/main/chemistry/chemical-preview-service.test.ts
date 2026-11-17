import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  type ChemicalPreviewError,
  MAX_CHEMICAL_PREVIEW_SVG_BYTES,
  rasterizeChemicalPreview,
  rasterizeChemicalStructureAsset,
} from "./chemical-preview-service.js";

const svg = (body: string, attributes = 'width="24" height="24"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;

describe("chemical preview rasterizer", () => {
  test("different output widths have distinct asset identities, preventing stale preview deduplication", async () => {
    const drawing = svg('<circle cx="12" cy="12" r="6"/>');
    const natural = await rasterizeChemicalStructureAsset(drawing);
    const replaced = await rasterizeChemicalStructureAsset(drawing, undefined, 87);
    expect(replaced.descriptor.sha256).not.toBe(natural.descriptor.sha256);
    expect(replaced.descriptor.widthPx).toBe(1028);
    const naturalAgain = await rasterizeChemicalStructureAsset(
      Buffer.from(replaced.original).toString("utf8"),
    );
    expect(naturalAgain.descriptor.sha256).toBe(natural.descriptor.sha256);
  });
  test("renders replacement structures from vectors at the retained figure width", async () => {
    const preview = await rasterizeChemicalPreview(svg('<circle cx="12" cy="12" r="6"/>'), 87);
    expect(preview.widthPx).toBe(Math.round((87 * 300) / 25.4));
    expect(preview.heightPx).toBe(preview.widthPx);
  });
  test("rasterizes a valid inline SVG as a transparent 300 DPI PNG", async () => {
    const preview = await rasterizeChemicalPreview(
      svg('<circle cx="12" cy="12" r="6" fill="#111"/>'),
    );
    const metadata = await sharp(preview.bytes).metadata();
    const pixels = await sharp(preview.bytes).raw().toBuffer();

    expect(preview.widthPx).toBe(96);
    expect(preview.heightPx).toBe(96);
    expect(metadata.format).toBe("png");
    expect(metadata.density).toBe(300);
    expect(pixels[3]).toBe(0);
  });

  test("allows same-document use and gradient references", async () => {
    await expect(
      rasterizeChemicalPreview(
        svg(`
          <defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
          <path id="bond" d="M2 12H22" stroke="url(#g)"/>
          <use href="#bond"/>
        `),
      ),
    ).resolves.toMatchObject({ widthPx: 96, heightPx: 96 });
  });

  test.each([
    ["script", svg("<script>alert(1)</script>")],
    ["foreignObject", svg("<foreignObject><div>unsafe</div></foreignObject>")],
    ["prefixed script", svg('<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>')],
    [
      "prefixed foreignObject",
      svg('<x:foreignObject xmlns:x="http://www.w3.org/2000/svg"><x:g/></x:foreignObject>'),
    ],
    ["event handler", svg('<path d="M0 0" onclick="alert(1)"/>')],
    ["external href", svg('<use href="https://example.com/bond.svg#bond"/>')],
    [
      "aliased external href",
      svg(
        '<use xmlns:link="http://www.w3.org/1999/xlink" link:href="https://example.com/bond.svg#bond"/>',
      ),
    ],
    ["external src", svg('<image src="file:///secret.png"/>')],
    ["data URL src", svg('<image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" />')],
    ["data URL image", svg('<image href="data:image/png;base64,iVBORw0KGgo=" />')],
    ["external CSS url", svg('<path style="fill:url(https://example.com/a.svg)"/>')],
    ["comment-obscured CSS url", svg('<path style="fill:u/**/rl(https://example.com/a.svg)"/>')],
    ["escaped CSS url", svg('<path style="fill:u\\72l(https://example.com/a.svg)"/>')],
    ["comment-obscured CSS import", svg('<style>@im/**/port "https://example.com/a.css";</style>')],
    ["escaped CSS import", svg('<style>@im\\70ort "https://example.com/a.css";</style>')],
    [
      "external stylesheet url",
      svg('<style>.bond { fill: url(https://example.com/a.svg); }</style><path class="bond"/>'),
    ],
    [
      "stylesheet processing instruction",
      '<?xml-stylesheet href="file:///unsafe.css"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    ],
    ["doctype", '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["entity declaration", '<!ENTITY unsafe "value"><svg xmlns="http://www.w3.org/2000/svg"/>'],
  ])("rejects %s without exposing SVG content", async (_label, input) => {
    await expect(rasterizeChemicalPreview(input)).rejects.toMatchObject({ code: "UNSAFE_SVG" });
  });

  test("rejects an empty SVG", async () => {
    await expect(rasterizeChemicalPreview("   ")).rejects.toMatchObject({
      code: "INVALID_SVG",
    });
  });

  test("rejects path-bomb SVGs that exceed the element budget", async () => {
    const body = Array.from({ length: 50_001 }, (_, index) => `<path d="M${index} 0h1"/>`).join("");
    const input = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">${body}</svg>`;

    await expect(rasterizeChemicalPreview(input)).rejects.toMatchObject({
      code: "UNSAFE_SVG",
    });
  });

  test("does not reject reasonably large structures", async () => {
    const body = Array.from({ length: 500 }, (_, index) => {
      const x = index % 20;
      const y = Math.floor(index / 20);
      return `<circle cx="${x * 100 + 10}" cy="${y * 100 + 10}" r="6" fill="#111"/><path d="M${x * 100 + 10} ${y * 100 + 10}h80"/>`;
    }).join("");
    const preview = await rasterizeChemicalPreview(
      `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2500">${body}</svg>`,
    );

    expect(preview.widthPx).toBe(3277);
    expect(preview.heightPx).toBe(4096);
  });

  test("builds a chemical preview asset with consistent hashes and dimensions", async () => {
    const input = svg('<circle cx="12" cy="12" r="6" fill="#111"/>');
    const asset = await rasterizeChemicalStructureAsset(input);
    const metadata = await sharp(asset.preview).metadata();

    expect(asset.descriptor.kind).toBe("chemical-preview");
    expect(asset.descriptor.extension).toBe("svg");
    expect(asset.descriptor.mediaType).toBe("image/svg+xml");
    expect(asset.descriptor.widthPx).toBe(metadata.width);
    expect(asset.descriptor.heightPx).toBe(metadata.height);
    expect(asset.descriptor.widthPx).toBe(96);
    expect(asset.descriptor.heightPx).toBe(96);
    const originalHash = createHash("sha256").update(asset.original).digest("hex").toUpperCase();
    const previewHash = createHash("sha256").update(asset.preview).digest("hex").toUpperCase();
    expect(asset.descriptor.sha256).toBe(originalHash);
    expect(asset.descriptor.previewSha256).toBe(previewHash);
    expect(asset.descriptor.byteLength).toBe(asset.original.byteLength);
    expect(asset.descriptor.previewByteLength).toBe(asset.preview.byteLength);
  });

  test("rejects oversized SVG input before parsing", async () => {
    const input = `${svg("")}${" ".repeat(MAX_CHEMICAL_PREVIEW_SVG_BYTES)}`;

    await expect(rasterizeChemicalPreview(input)).rejects.toMatchObject({ code: "SVG_TOO_LARGE" });
  });

  test("rejects malformed XML with a stable safe error", async () => {
    await expect(rasterizeChemicalPreview("<svg><path></svg>")).rejects.toMatchObject({
      code: "INVALID_SVG",
      message: "化学结构预览 SVG 无效。",
    } satisfies Partial<ChemicalPreviewError>);
  });

  test("rejects raster dimensions above 4096 pixels", async () => {
    await expect(
      rasterizeChemicalPreview(svg("", 'width="4097" height="1"')),
    ).rejects.toMatchObject({
      code: "DIMENSIONS_TOO_LARGE",
    });
  });
});
