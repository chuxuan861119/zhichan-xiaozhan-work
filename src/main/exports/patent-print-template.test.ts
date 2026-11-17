import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import {
  PATENT_BOOK_LABELS,
  type PatentBookKind,
  type PatentType,
} from "../../shared/patent/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { DocxExportError } from "./docx-exporter.js";
import { renderPatentPrintHtml } from "./patent-print-template.js";

function paragraph(text: string) {
  return {
    id: crypto.randomUUID(),
    type: "paragraph" as const,
    attrs: {
      alignment: "left" as const,
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 12,
    },
    content: [{ type: "text" as const, text, marks: [] }],
  };
}

function patent(patentType: PatentType = "invention") {
  const aggregate = createBlankPatent({ patentType, name: "五书PDF导出测试" });
  for (const book of aggregate.books) {
    book.document.content = [paragraph(`${PATENT_BOOK_LABELS[book.kind]}正文`)];
  }
  return aggregate;
}

async function drawingAssets(): Promise<StoredAsset[]> {
  const fixtures = [
    {
      assetId: "00000000-0000-4000-8000-000000000401",
      name: "sample.png",
      mediaType: "image/png" as const,
      extension: "png" as const,
    },
    {
      assetId: "00000000-0000-4000-8000-000000000402",
      name: "sample.jpg",
      mediaType: "image/jpeg" as const,
      extension: "jpg" as const,
    },
  ];
  return Promise.all(
    fixtures.map(async (fixture) => {
      const original = await readFile(
        join(process.cwd(), "tests", "fixtures", "images", fixture.name),
      );
      const sha256 = createHash("sha256").update(original).digest("hex").toUpperCase();
      return {
        descriptor: {
          assetId: fixture.assetId,
          kind: "image" as const,
          originalName: fixture.name,
          mediaType: fixture.mediaType,
          extension: fixture.extension,
          byteLength: original.byteLength,
          sha256,
          widthPx: 32,
          heightPx: 24,
          previewByteLength: original.byteLength,
          previewSha256: sha256,
        },
        original: Uint8Array.from(original),
        preview: Uint8Array.from(original),
      };
    }),
  );
}

async function vectorImageAsset(svgOverride?: string): Promise<StoredAsset> {
  const original = svgOverride
    ? Buffer.from(svgOverride, "utf8")
    : await readFile(
        join(process.cwd(), "tests", "fixtures", "vector-image", "patent-black-output.svg"),
      );
  const preview = await readFile(
    join(process.cwd(), "tests", "fixtures", "vector-image", "patent-black-output.png"),
  );
  return {
    descriptor: {
      assetId: "00000000-0000-4000-8000-000000000409",
      kind: "vector-image",
      originalName: "实验曲线.svg",
      mediaType: "image/svg+xml",
      extension: "svg",
      byteLength: original.byteLength,
      sha256: createHash("sha256").update(original).digest("hex").toUpperCase(),
      widthPx: 1200,
      heightPx: 800,
      previewByteLength: preview.byteLength,
      previewSha256: createHash("sha256").update(preview).digest("hex").toUpperCase(),
    },
    original: Uint8Array.from(original),
    preview: Uint8Array.from(preview),
  };
}

function installDrawings(aggregate: ReturnType<typeof patent>, assets: readonly StoredAsset[]) {
  aggregate.assets = assets.map((asset) => structuredClone(asset.descriptor));
  aggregate.figures = assets.map((asset, index) => ({
    figureId: `00000000-0000-4000-8000-${(501 + index).toString().padStart(12, "0")}`,
    assetId: asset.descriptor.assetId,
    widthMm: 80 + index * 10,
  }));
  aggregate.abstractDrawingFigureId = aggregate.figures[1]?.figureId ?? null;
}

describe("patent print template", () => {
  test("reports a missing chemical structure preview as MISSING_ASSET for PDF export", async () => {
    const aggregate = patent();
    const claims = aggregate.books.find((book) => book.kind === "claims");
    if (!claims) throw new Error("claims book missing");
    claims.document.content.push({
      id: "00000000-0000-4000-8000-000000000405",
      type: "chemical-structure",
      ketSource: '{"root":{"nodes":[]}}',
      previewAssetId: "00000000-0000-4000-8000-000000000499",
      widthMm: 40,
      alignment: "left",
    });

    await expect(
      renderPatentPrintHtml({ patent: aggregate, mode: "single", bookKind: "claims", assets: [] }),
    ).rejects.toMatchObject({
      name: DocxExportError.name,
      issues: [
        expect.objectContaining({
          severity: "error",
          code: "MISSING_ASSET",
          nodeId: "00000000-0000-4000-8000-000000000405",
        }),
      ],
    });
  });

  test.each(["combined", "single"] as const)(
    "renders %s patent chemistry through mhchem and saved structure PNG previews",
    async (mode) => {
      const aggregate = patent();
      const assets = await drawingAssets();
      const claims = aggregate.books.find((book) => book.kind === "claims");
      if (!claims) throw new Error("claims book missing");
      claims.document.content = [
        paragraph("化学式："),
        {
          id: "00000000-0000-4000-8000-000000000403",
          type: "block-formula",
          source: String.raw`\ce{SO4^2- + Ba^2+ -> BaSO4 v}`,
          formulaKind: "chemistry",
        },
        {
          id: "00000000-0000-4000-8000-000000000404",
          type: "chemical-structure",
          ketSource: '{"root":{"nodes":[]}}',
          previewAssetId: assets[0]?.descriptor.assetId ?? "",
          widthMm: 40,
          alignment: "right",
        },
      ];
      const beforeExport = structuredClone(aggregate);
      const assetsBeforeExport = structuredClone(assets);

      const html = await renderPatentPrintHtml(
        mode === "combined"
          ? { patent: aggregate, mode, assets }
          : { patent: aggregate, mode, bookKind: "claims", assets },
      );
      expect(html).toContain('class="katex"');
      expect(html).toContain('class="chemical-structure chemical-structure-right"');
      expect(html).toContain('style="width:40mm"');
      expect(html).toContain(
        ".chemical-structure { display: block; max-width: 100%; margin-top: 0.75em; margin-bottom: 0.75em; break-inside: avoid; page-break-inside: avoid; }",
      );
      expect(html).toContain(
        `data:image/png;base64,${Buffer.from(assets[0]?.preview ?? []).toString("base64")}`,
      );
      expect(aggregate).toEqual(beforeExport);
      expect(
        assets.map((asset) => ({
          descriptor: asset.descriptor,
          original: [...asset.original],
          preview: [...asset.preview],
        })),
      ).toEqual(
        assetsBeforeExport.map((asset) => ({
          descriptor: asset.descriptor,
          original: [...asset.original],
          preview: [...asset.preview],
        })),
      );
    },
  );

  test("renders combined five-book HTML in export order with section breaks, headers and page counters", async () => {
    const html = await renderPatentPrintHtml({ patent: patent(), mode: "combined", assets: [] });

    const bodyOrder = [
      "摘要正文",
      "摘要附图正文",
      "权利要求书正文",
      "说明书正文",
      "说明书附图正文",
    ].map((text) => html.indexOf(text));
    expect(bodyOrder.every((index) => index >= 0)).toBe(true);
    expect(bodyOrder).toEqual([...bodyOrder].sort((left, right) => left - right));
    expect(html.match(/class="patent-export-book"/gu)).toHaveLength(5);
    expect(html.match(/break-before:page/gu)?.length ?? 0).toBeGreaterThanOrEqual(1);
    for (const label of ["说明书摘要", "摘要附图", "权利要求书", "说明书", "说明书附图"]) {
      expect(html).toContain(`<header class="patent-export-header">${label}</header>`);
    }
    expect(html).toMatch(/@top-center\s*\{[^}]*border-bottom:\s*1px solid #000/u);
    expect(html).toContain("counter(page)");
    expect(html).toContain("@bottom-center { content: counter(page); margin-top: 3mm;");
  });

  test("never includes auxiliary document content in the formal five-book PDF HTML", async () => {
    const aggregate = patent();
    const source = aggregate.books.find((book) => book.kind === "description");
    if (!source) throw new Error("description book missing");
    aggregate.auxiliaryDocuments.push({
      auxiliaryDocumentId: crypto.randomUUID(),
      title: "实验记录",
      document: {
        ...structuredClone(source.document),
        documentId: crypto.randomUUID(),
        title: "实验记录",
        content: [paragraph("不得进入正式五书的其他文档内容")],
      },
      editorState: {},
      localRevision: 0,
      persistedRevision: 0,
      sourceFileName: null,
    });

    const html = await renderPatentPrintHtml({ patent: aggregate, mode: "combined", assets: [] });

    expect(html).not.toContain("不得进入正式五书的其他文档内容");
    expect(html.match(/class="patent-export-book"/gu)).toHaveLength(5);
  });

  test("omits disabled drawing books from combined PDF print HTML", async () => {
    const aggregate = patent();
    aggregate.drawingBooksEnabled = false;

    const html = await renderPatentPrintHtml({ patent: aggregate, mode: "combined", assets: [] });

    const bodyOrder = ["摘要正文", "权利要求书正文", "说明书正文"].map((text) =>
      html.indexOf(text),
    );
    expect(bodyOrder.every((index) => index >= 0)).toBe(true);
    expect(bodyOrder).toEqual([...bodyOrder].sort((left, right) => left - right));
    expect(html).not.toContain("摘要附图正文");
    expect(html).not.toContain("说明书附图正文");
    expect(html.match(/class="patent-export-book"/gu)).toHaveLength(3);
    expect(html).not.toContain('<header class="patent-export-header">摘要附图</header>');
    expect(html).not.toContain('<header class="patent-export-header">说明书附图</header>');
  });

  test("renders only the selected book for single-book PDF export", async () => {
    const html = await renderPatentPrintHtml({
      patent: patent(),
      mode: "single",
      bookKind: "claims" as PatentBookKind,
      assets: [],
    });

    expect(html).toContain("权利要求书正文");
    expect(html).toContain(`<header class="patent-export-header">权利要求书</header>`);
    expect(html).not.toContain("说明书正文");
    expect(html).not.toContain(`<header class="patent-export-header">说明书</header>`);
    expect(html).toMatch(/@top-center\s*\{[^}]*border-bottom:\s*1px solid #000/u);
  });

  test("renders Word-style 1.5 line spacing with an equivalent PDF line height", async () => {
    const html = await renderPatentPrintHtml({
      patent: patent(),
      mode: "single",
      bookKind: "claims",
      assets: [],
    });

    expect(html).toContain("line-height:2.025");
  });

  test("renders the selected abstract drawing and every description drawing from resolved PNG and JPEG bytes", async () => {
    const aggregate = patent();
    const assets = await drawingAssets();
    installDrawings(aggregate, assets);

    const html = await renderPatentPrintHtml({
      patent: aggregate,
      mode: "combined",
      assets,
    });
    const pngData = Buffer.from(assets[0]?.original ?? []).toString("base64");
    const jpegData = Buffer.from(assets[1]?.original ?? []).toString("base64");

    expect(html.split(`data:image/png;base64,${pngData}`).length - 1).toBe(1);
    expect(html.split(`data:image/jpeg;base64,${jpegData}`).length - 1).toBe(2);
    expect(html.match(/<figcaption>图1<\/figcaption>/gu)).toHaveLength(1);
    expect(html.match(/<figcaption>图2<\/figcaption>/gu)).toHaveLength(2);
    expect(html.indexOf("<figcaption>图2</figcaption>")).toBeLessThan(
      html.indexOf("权利要求书正文"),
    );
  });

  test("renders just one selected figure for a single abstract-drawing PDF", async () => {
    const aggregate = patent();
    const assets = await drawingAssets();
    installDrawings(aggregate, assets);

    const html = await renderPatentPrintHtml({
      patent: aggregate,
      mode: "single",
      bookKind: "abstract-drawing",
      assets,
    });

    expect(html).toContain("<figcaption>图2</figcaption>");
    expect(html).not.toContain("<figcaption>图1</figcaption>");
    expect(html.match(/<img /gu)).toHaveLength(1);
  });

  test("uses the sanitized SVG for print/PDF and the same figure for the abstract drawing", async () => {
    const aggregate = patent();
    const asset = await vectorImageAsset();
    installDrawings(aggregate, [asset]);
    aggregate.abstractDrawingFigureId = aggregate.figures[0]?.figureId ?? null;

    const html = await renderPatentPrintHtml({
      patent: aggregate,
      mode: "single",
      bookKind: "abstract-drawing",
      assets: [asset],
    });

    expect(html).toContain("data:image/svg+xml,");
    expect(html).toContain('style="width:80mm"');
    expect(html.match(/<img /gu)).toHaveLength(1);
    expect(html).toContain("<figcaption>图1</figcaption>");
  });

  test.each([
    [
      "external href",
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://bad.invalid/a.svg#x"/></svg>',
    ],
    [
      "CSS URL",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(data:image/svg+xml,bad)"/></svg>',
    ],
    [
      "dangling href fragment",
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="#missing"/></svg>',
    ],
    [
      "dangling xlink href fragment",
      '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="#missing"/></svg>',
    ],
    [
      "embedded style",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "file:///bad.css"; @font-face{src:url(bad)}</style></svg>',
    ],
    [
      "animation",
      '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="href" to="https://bad.invalid/a"/></svg>',
    ],
    [
      "embedded frame",
      '<svg xmlns="http://www.w3.org/2000/svg"><iframe src="file:///bad.html"/></svg>',
    ],
  ])("falls back to the saved PNG when a vector image contains %s", async (_label, svg) => {
    const aggregate = patent();
    const asset = await vectorImageAsset(svg);
    installDrawings(aggregate, [asset]);

    const html = await renderPatentPrintHtml({
      patent: aggregate,
      mode: "single",
      bookKind: "description-drawings",
      assets: [asset],
    });

    expect(html).not.toContain("data:image/svg+xml,");
    expect(html).not.toContain("bad.invalid");
    expect(html).not.toContain("file:///");
    expect(html).not.toContain("@import");
    expect(html).toContain(
      `data:image/png;base64,${Buffer.from(asset.preview).toString("base64")}`,
    );
  });

  test("keeps drawing figures as block boxes so Chromium does not fragment them across a book page break", async () => {
    const aggregate = patent();
    const assets = await drawingAssets();
    installDrawings(aggregate, assets);

    const html = await renderPatentPrintHtml({
      patent: aggregate,
      mode: "combined",
      assets,
    });

    expect(html).toContain(".figure { display: block;");
    expect(html).toContain("figcaption { display: block;");
  });
});
