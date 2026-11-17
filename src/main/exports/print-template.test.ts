import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { type CanonicalDocument, CanonicalDocumentSchema } from "../../shared/document/model.js";
import { tableRegressionDocument } from "../../shared/document/table-regression-fixture.js";
import { createDefaultPrintSettings } from "../../shared/printing/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { renderPrintHtml } from "./print-template.js";

test("print retains independent paragraph alignment and header emphasis without mutating content", async () => {
  const { document } = tableRegressionDocument();
  const original = structuredClone(document);
  const html = await renderPrintHtml(document, [], { includeDocumentHeader: false });
  const dom = new DOMParser().parseFromString(html, "text/html");
  const header = dom.querySelector("th");
  if (!header) throw new Error("Missing header");
  const paragraphs = header.querySelectorAll("p");
  expect(paragraphs[0]?.style.textAlign).toBe("center");
  expect(paragraphs[1]?.style.textAlign).toBe("right");
  expect(html).toMatch(/th\s*\{\s*font-weight:\s*(bold|700)/);
  expect(dom.querySelector('td[rowspan="2"]')).not.toBeNull();
  expect(dom.querySelector('td[colspan="2"]')).not.toBeNull();
  expect(document).toEqual(original);
});

test("print keeps distinct formula colors, size and exact source", async () => {
  const document = await referenceDocument();
  document.content = ["#FF0000", "#0000FF"].map((color) => ({
    id: crypto.randomUUID(),
    type: "block-formula" as const,
    source: "x^2",
    formulaKind: "math" as const,
    color,
    fontSizePt: 10.5,
    alignment: "right" as const,
  }));
  const html = await renderPrintHtml(document, []);
  expect(html).toContain("color: #FF0000");
  expect(html).toContain("color: #0000FF");
  expect(html).toContain("font-size: 10.5pt");
  expect(html).toContain("x^2");
});

test("print formulas retain explicit font size and do not add KaTeX enlargement", async () => {
  const document = await referenceDocument();
  document.content = [
    {
      type: "block-formula",
      id: crypto.randomUUID(),
      source: "x^2",
      formulaKind: "math",
      fontSizePt: 10.5,
    },
  ];
  const html = await renderPrintHtml(document, []);
  expect(html).toContain('style="text-align: center; font-size: 10.5pt"');
  expect(html).toContain("font-size: 1em");
});

test.each(["left", "center", "right"] as const)(
  "prints entire table aligned %s",
  async (tableAlignment) => {
    const document = await referenceDocument();
    const table = document.content.find((node) => node.type === "table");
    if (!table || table.type !== "table") throw new Error("Missing table fixture");
    table.tableAlignment = tableAlignment;
    table.layoutMode = "fixed";
    document.content = [table];
    const html = await renderPrintHtml(document, [], { includeDocumentHeader: false });
    expect(html).toContain(`margin-left: ${tableAlignment === "left" ? "0" : "auto"}`);
    expect(html).toContain(`margin-right: ${tableAlignment === "center" ? "auto" : "0"}`);
  },
);

test("prints optional table names sequentially and notes escaped, with hidden text excluded", async () => {
  const document = await referenceDocument();
  const table = document.content.find((node) => node.type === "table");
  if (!table || table.type !== "table") throw new Error("Missing table");
  const paragraph = table.rows[0]?.cells[0]?.content[0];
  if (!paragraph) throw new Error("Missing cell paragraph");
  paragraph.attrs.defaultFontSizePt = 18;
  document.content = [
    {
      ...table,
      tableNameEnabled: false,
      tableName: "隐藏名称",
      tableNoteEnabled: false,
      tableNote: "隐藏说明",
    },
    {
      ...table,
      id: crypto.randomUUID(),
      tableNameEnabled: true,
      tableName: "甲<乙",
      tableNoteEnabled: true,
      tableNote: "均值\n单位：秒",
    },
    { ...table, id: crypto.randomUUID(), tableNameEnabled: true, tableName: "第二组" },
  ];
  const html = await renderPrintHtml(document, [], { includeDocumentHeader: false });
  expect(html).toContain("表1 甲&lt;乙");
  expect(html).toContain("表2 第二组");
  expect(html).toContain("均值<br>单位：秒");
  expect(html).not.toContain("隐藏名称");
  expect(html).not.toContain("隐藏说明");
  const name = html.match(/<div class="table-name"[^>]*>/u)?.[0];
  const note = html.match(/<div class="table-note"[^>]*>/u)?.[0];
  expect(name).toMatch(/font-size:\s*12pt/u);
  expect(name).toMatch(/font-weight:\s*600/u);
  expect(name).toMatch(/text-align:\s*center/u);
  expect(note).toMatch(/font-size:\s*12pt/u);
  expect(note).toMatch(/text-align:\s*left/u);
  expect(paragraph.attrs.defaultFontSizePt).toBe(18);
  expect(html).toMatch(/font-size:\s*18pt/u);
});

test("print lists match the editor inset without repeating paragraph first-line indentation", async () => {
  const document = await referenceDocument();
  document.content = document.content.filter(
    (node) => node.type === "bullet-list" || node.type === "ordered-list",
  );
  const html = await renderPrintHtml(document, [], { includeDocumentHeader: false });
  expect(html).toContain("padding-inline-start: 3em");
  expect(html).toContain("li > p { text-indent: 0 !important;");
});

test.each(["left", "center", "right"] as const)(
  "prints a block formula aligned %s",
  async (alignment) => {
    const document = await referenceDocument();
    document.content = [
      {
        id: "00000000-0000-4000-8000-000000000898",
        type: "block-formula",
        source: String.raw`\frac{x}{2}`,
        formulaKind: "math",
        alignment,
      },
    ];
    const html = await renderPrintHtml(document, [], { includeDocumentHeader: false });
    expect(html).toContain(`class="block-formula" style="text-align: ${alignment}"`);
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("text-align: inherit");
  },
);

async function referenceDocument(): Promise<CanonicalDocument> {
  return CanonicalDocumentSchema.parse(
    JSON.parse(
      await readFile(
        resolve(process.cwd(), "tests/fixtures/documents/export-reference.json"),
        "utf8",
      ),
    ),
  );
}

async function referenceAssets(document: CanonicalDocument): Promise<StoredAsset[]> {
  const descriptor = document.assets[0];
  if (!descriptor) throw new Error("Reference fixture is missing its image descriptor");
  const original = Uint8Array.from(
    await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.png")),
  );
  return [{ descriptor, original, preview: Uint8Array.from(original) }];
}

describe("print template", () => {
  test("matches patent book header and body offsets without changing legacy documents", async () => {
    const document = await referenceDocument();
    document.content = [];
    const html = await renderPrintHtml(document, [], { patentBookLayout: true });
    expect(html).toContain(".patent-book-print-body { margin: 0; }");
    expect(html).toContain('class="patent-book-print-body"');
    expect(html).toContain("@top-center");
    expect(html).toContain("margin-top: 13mm");
    expect(html).not.toContain("transform: translateY");
    const legacy = await renderPrintHtml(document, []);
    expect(legacy).not.toContain("patent-book-print-body");
  });
  test("preserves blank lines, underlined spaces, and the document header without changing source data", async () => {
    const document = await referenceDocument();
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (!paragraph || paragraph.type !== "paragraph") throw new Error("Missing paragraph");
    document.content = [
      { ...paragraph, content: [{ type: "text", text: "      ", marks: [{ type: "underline" }] }] },
      { ...paragraph, id: "00000000-0000-4000-8000-000000000799", content: [] },
    ];
    const original = structuredClone(document);
    const html = await renderPrintHtml(document, []);
    expect(html).toContain("<u>      </u>");
    expect(html).toContain("white-space: pre-wrap");
    expect(html).toContain("><br></p>");
    expect(html).toContain(`<header class="document-print-header">${document.title}</header>`);
    expect(html).toContain("border-bottom: 1px solid #d9dde4");
    expect(document).toEqual(original);
    const combinedBookHtml = await renderPrintHtml(document, [], { includeDocumentHeader: false });
    expect(combinedBookHtml).not.toContain('<header class="document-print-header">');
  });
  test("renders a rotated inline image between surrounding text", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    const descriptor = document.assets[0];
    if (paragraph?.type !== "paragraph" || !descriptor) {
      throw new Error("Reference inline image fixture is incomplete");
    }
    paragraph.content = [
      { type: "text", text: "图片前", marks: [] },
      {
        id: "00000000-0000-4000-8000-000000000812",
        type: "inline-figure",
        assetId: descriptor.assetId,
        widthMm: 25,
        alignment: "center",
        rotationDeg: 90,
      },
      { type: "text", text: "图片后", marks: [] },
    ];

    const html = await renderPrintHtml(document, assets);

    expect(html).toContain("图片前");
    expect(html).toContain("图片后");
    expect(html).toContain('class="inline-figure"');
    expect(html).toMatch(/class="inline-figure"[^>]*vertical-align:baseline/);
    expect(html).toContain("width:25mm");
    expect(html).toContain(`aspect-ratio:${descriptor.heightPx / descriptor.widthPx}`);
    expect(html).toContain("rotate(90deg)");
    expect(html).toContain("data:image/png;base64,");
  });

  test("renders only escaped canonical content with self-contained print resources", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    document.title = `<img src=x onerror="alert(1)">`;
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    paragraph.content.unshift({
      type: "text",
      text: `<script src="https://attacker.invalid/x.js">bad</script>`,
      marks: [],
    });
    const figure = document.content.find((node) => node.type === "figure");
    if (figure?.type !== "figure") throw new Error("Reference figure is missing");
    figure.rotationDeg = 90;

    const html = await renderPrintHtml(document, assets);

    expect(html).toContain(
      `content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"`,
    );
    expect(html).toContain("&lt;script src=&quot;https://attacker.invalid/x.js&quot;&gt;");
    expect(html).toContain("aspect-ratio:0.6666666666666666");
    expect(html).toContain("rotate(90deg)");
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toMatch(/<script\b/iu);
    expect(html).not.toMatch(/<link\b/iu);
    const emittedTags = html.match(/<[^!][^>]*>/gu) ?? [];
    expect(emittedTags).not.toContainEqual(expect.stringMatching(/\son[a-z]+\s*=/iu));
    expect(html).not.toMatch(
      /\b(?:src|href)=["'](?:https?:|file:|javascript:)|url\(["']?(?:https?:|file:)/iu,
    );
    expect(html).not.toContain("contenteditable");
    expect(html).not.toContain("editor-paper");
  });

  test("keeps a reviewed reference digit without rendering its editor-only annotation", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    paragraph.content = [
      { type: "text", text: "根据权利要求", marks: [] },
      { type: "text", text: "2", marks: [{ type: "claim-reference-review" }] },
      { type: "text", text: "所述的装置", marks: [] },
    ];

    const html = await renderPrintHtml(document, assets);

    expect(html).toContain("根据权利要求2所述的装置");
    expect(html).not.toContain("claim-reference-review");
    expect(html).not.toContain("#d92d20");
  });

  test("renders text highlight as a background color style", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    paragraph.content = [
      { type: "text", text: "突出显示", marks: [{ type: "background-color", value: "#FFF2CC" }] },
    ];

    const html = await renderPrintHtml(document, assets);

    expect(html).toContain('style="background-color:#FFF2CC"');
  });

  test("uses model geometry, explicit page breaks, cohesive figures, and the installed KaTeX CSS", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const katexCss = await readFile(
      createRequire(import.meta.url).resolve("katex/dist/katex.min.css"),
      "utf8",
    );

    const html = await renderPrintHtml(document, assets);

    expect(html).toContain("@page { size: A4 portrait; margin: 25mm 15mm 15mm 25mm; }");
    expect(html).toContain("width: auto");
    expect(html).not.toContain("min-height: 297mm");
    expect(html).toContain('class="page-break"');
    expect(html).toContain("break-after: page");
    expect(html).toContain('class="figure figure-center"');
    expect(html).toContain("break-inside: avoid");
    expect(html).toContain(katexCss);
    expect(html).toContain("src:url(data:font/woff2;base64,");
  });

  test("repeats the title row and preserves each table-cell border edge", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const table = document.content.find((node) => node.type === "table");
    if (table?.type !== "table") throw new Error("Reference table is missing");
    table.headerRowCount = 1;
    const cell = table.rows[0]?.cells[0];
    if (!cell) throw new Error("Reference table cell is missing");
    cell.borderEdges = {
      top: "double",
      right: "none",
      bottom: "single",
      left: "double",
    };

    const html = await renderPrintHtml(document, assets);

    expect(html).toContain("<thead><tr>");
    expect(html).toContain("</thead><tbody><tr>");
    expect(html).toContain("border-top:3px double #000");
    expect(html).toContain("border-right:none");
    expect(html).toContain("border-bottom:1px solid #000");
    expect(html).toContain("border-left:3px double #000");
    expect(html).toContain("thead { display: table-header-group; }");
  });

  test("renders explicit table row heights with print-only rules", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const table = document.content.find((node) => node.type === "table");
    if (table?.type !== "table") throw new Error("Reference table is missing");
    const exactRow = table.rows[0];
    const atLeastRow = table.rows[1];
    if (!exactRow || !atLeastRow) throw new Error("Reference table is missing rows");
    exactRow.rowHeightMm = 12.7;
    exactRow.rowHeightRule = "exact";
    atLeastRow.rowHeightMm = 10;
    atLeastRow.rowHeightRule = "at-least";
    const cell = exactRow.cells[0];
    if (!cell || !cell.content[0]) throw new Error("Missing cell");
    cell.paddingMm = { top: 1, right: 3, bottom: 1, left: 2 };
    cell.content[0].attrs.spaceAfterPt = 6;

    const html = await renderPrintHtml(document, assets);

    expect(html).toContain('data-patent-row-height-rule="exact"');
    expect(html).toContain('data-patent-row-height-rule="at-least"');
    expect(html).toContain("--patent-row-height:12.7mm");
    expect(html).toContain("--patent-row-height:10mm");
    expect(html).toContain("padding:1mm 3mm 1mm 2mm");
    expect(html).toContain("margin-bottom:6pt");
    expect(html).toContain(
      'tr[data-patent-row-height-rule="at-least"] { height: var(--patent-row-height); }',
    );
    expect(html).toContain(
      'tr[data-patent-row-height-rule="exact"] { height: var(--patent-row-height); overflow: hidden; }',
    );
  });

  test("uses controlled layout settings for paper, orientation, and custom margins", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const layout = {
      ...createDefaultPrintSettings(document.page).layout,
      paperSize: "Letter" as const,
      orientation: "landscape" as const,
      scalePercent: 75,
      margins: {
        mode: "custom" as const,
        topMm: 10.5,
        rightMm: 12,
        bottomMm: 13.25,
        leftMm: 14,
      },
    };

    const html = await renderPrintHtml(document, assets, layout);

    expect(html).toContain("@page { size: Letter landscape; margin: 10.5mm 12mm 13.25mm 14mm; }");
    expect(html).toContain("width: auto");
    expect(html).not.toContain("min-height: 215.9mm");
    expect(html).not.toContain("scalePercent");
    expect(html).not.toContain("75%");
  });

  test("supports explicit borderless output without changing sanitized content rendering", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const layout = {
      ...createDefaultPrintSettings(document.page).layout,
      margins: { mode: "none" as const },
    };

    const html = await renderPrintHtml(document, assets, layout);

    expect(html).toContain("@page { size: A4 portrait; margin: 0mm 0mm 0mm 0mm; }");
    expect(html).toContain('class="figure figure-center"');
    expect(html).toContain("break-inside: avoid");
  });

  test("rejects layout values instead of concatenating untrusted CSS", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const layout = {
      ...createDefaultPrintSettings(document.page).layout,
      paperSize: "A4; margin: 0" as never,
    };

    await expect(renderPrintHtml(document, assets, layout)).rejects.toThrow();
  });

  test("uses trusted KaTeX markup, a local PNG fallback, and visible LaTeX as the final fallback", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    paragraph.content.push(
      { type: "inline-formula", source: "x^2+1", formulaKind: "math" },
      { type: "inline-formula", source: String.raw`\unsupportedA{x}`, formulaKind: "math" },
      { type: "inline-formula", source: String.raw`\unsupportedB{y}`, formulaKind: "math" },
    );
    const renderFallback = vi
      .fn()
      .mockResolvedValueOnce({
        png: Uint8Array.from([137, 80, 78, 71]),
        widthPx: 40,
        heightPx: 20,
        altText: String.raw`复杂公式（LaTeX）：\unsupportedA{x}`,
      })
      .mockRejectedValueOnce(new Error("fallback failed"));

    const html = await renderPrintHtml(document, assets, { renderFallback });

    expect(html).toContain('class="katex"');
    expect(html).toContain("data:image/png;base64,iVBORw==");
    expect(html).toContain('class="formula-source"');
    expect(html).toContain(String.raw`\unsupportedB{y}`);
    expect(renderFallback).toHaveBeenCalledTimes(2);
  });

  test("renders inline and block chemical equations with mhchem without invoking the fallback", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    paragraph.content.push({
      type: "inline-formula",
      source: String.raw`\ce{SO4^2- + Ba^2+ -> BaSO4 v}`,
      formulaKind: "chemistry",
    });
    document.content.push({
      id: "00000000-0000-4000-8000-000000000821",
      type: "block-formula",
      source: String.raw`\ce{H2 + O2 -> H2O}`,
      formulaKind: "chemistry",
    });
    const renderFallback = vi.fn();

    const html = await renderPrintHtml(document, assets, { renderFallback });

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="block-formula"');
    expect(renderFallback).not.toHaveBeenCalled();
  });

  test("renders chemical structures only from their saved PNG previews with layout-safe styling", async () => {
    const document = await referenceDocument();
    document.content = document.content.filter((node) => node.type !== "figure");
    const preview = Uint8Array.from(
      await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.png")),
    );
    const original = Uint8Array.from(
      await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.jpg")),
    );
    const previewAssetId = "00000000-0000-4000-8000-000000000827";
    document.content.push(
      ...(["left", "center", "right"] as const).map((alignment, index) => ({
        id: `00000000-0000-4000-8000-${(828 + index).toString().padStart(12, "0")}`,
        type: "chemical-structure" as const,
        ketSource: '{"root":{"nodes":[]}}',
        previewAssetId,
        widthMm: 40 + index * 10,
        alignment,
      })),
    );
    const assets = [
      ...(await referenceAssets(document)),
      {
        descriptor: {
          assetId: previewAssetId,
          kind: "image" as const,
          originalName: "structure.ket",
          mediaType: "image/jpeg" as const,
          extension: "jpg" as const,
          byteLength: original.byteLength,
          sha256: "A".repeat(64),
          widthPx: 32,
          heightPx: 24,
          previewByteLength: preview.byteLength,
          previewSha256: "B".repeat(64),
        },
        original,
        preview,
      },
    ];

    const html = await renderPrintHtml(document, assets);

    expect(html.match(/class="chemical-structure chemical-structure-/gu)).toHaveLength(3);
    expect(html).toContain(`data:image/png;base64,${Buffer.from(preview).toString("base64")}`);
    expect(html).not.toContain(Buffer.from(original).toString("base64"));
    expect(html).toContain('style="width:40mm"');
    expect(html).toContain('style="width:50mm"');
    expect(html).toContain('style="width:60mm"');
    expect(html).toContain(".chemical-structure { display: block;");
    expect(html).toContain("page-break-inside: avoid");
  });

  test("does not allow chemical source to inject arbitrary HTML into print output", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    paragraph.content.push({
      type: "inline-formula",
      source: String.raw`\ce{H2O <script>alert(1)</script>}`,
      formulaKind: "chemistry",
    });

    const html = await renderPrintHtml(document, assets);

    expect(html).not.toMatch(/<script\b/iu);
    expect(html).toContain("&lt;script&gt;");
  });

  test("memoizes exact duplicate formula fallbacks and renders distinct fallbacks sequentially", async () => {
    const document = await referenceDocument();
    const assets = await referenceAssets(document);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    const duplicate = String.raw`\unsupportedDuplicate{x}`;
    paragraph.content.push(
      { type: "inline-formula", source: duplicate, formulaKind: "math" },
      { type: "inline-formula", source: duplicate, formulaKind: "math" },
      { type: "inline-formula", source: String.raw`\unsupportedOther{y}`, formulaKind: "math" },
    );
    let active = 0;
    let maximumActive = 0;
    const renderFallback = vi.fn(async (source: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return {
        png: Uint8Array.from([137, 80, 78, 71]),
        widthPx: 40,
        heightPx: 20,
        altText: source,
      };
    });

    const html = await renderPrintHtml(document, assets, { renderFallback });

    expect(renderFallback).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(html.match(/class="formula-fallback"/gu)).toHaveLength(3);
  });

  test("fails instead of silently omitting a referenced image", async () => {
    const document = await referenceDocument();

    await expect(renderPrintHtml(document, [])).rejects.toThrow("附图资源不存在");
  });
});

test("prints uniform small runs using their effective baseline while keeping source data", async () => {
  const document = await referenceDocument();
  const paragraph = document.content.find((n) => n.type === "paragraph");
  if (!paragraph || paragraph.type !== "paragraph") throw new Error("Missing paragraph");
  paragraph.attrs.defaultFontSizePt = 14;
  paragraph.content = [
    { type: "text", text: "小字首行", marks: [{ type: "font-size", valuePt: 9 }] },
    { type: "hard-break" },
    { type: "text", text: "小字次行", marks: [{ type: "font-size", valuePt: 9 }] },
  ];
  document.content = [paragraph];
  const html = await renderPrintHtml(document, [], { includeDocumentHeader: false });
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  expect(parsed.querySelector("p")?.style.fontSize).toBe("9pt");
  expect(paragraph.attrs.defaultFontSizePt).toBe(14);
});
