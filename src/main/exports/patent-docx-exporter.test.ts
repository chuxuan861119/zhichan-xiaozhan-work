import { createHash } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { type ParagraphNode, TableNodeSchema, type TextMark } from "../../shared/document/model.js";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { normalizeDrawingBooks } from "../../shared/patent/drawing-content.js";
import {
  PATENT_BOOK_LABELS,
  type PatentBookKind,
  type PatentType,
} from "../../shared/patent/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import type { PatentPatdocPayload } from "../documents/patdoc-format.js";
import { readPatdoc } from "../documents/patdoc-reader.js";
import { writePatdoc } from "../documents/patdoc-writer.js";
import { convertParsedWordDocument } from "../docx-import/docx-canonical-converter.js";
import { readDocxPackageBuffer } from "../docx-import/docx-package-reader.js";
import { parseWordprocessingDocument } from "../docx-import/wordprocessingml-parser.js";
import { createPatentDocxPackage, savePatentDocxToPath } from "./patent-docx-exporter.js";
import { renderPatentPrintHtml } from "./patent-print-template.js";
import { renderPrintHtml } from "./print-template.js";

test.each(["single", "combined"] as const)(
  "%s patent DOCX uses black heading styles",
  async (mode) => {
    const aggregate = patent();
    const result = await createPatentDocxPackage({
      patent: aggregate,
      mode,
      bookKind: "description",
    });
    const styles = xmlText(await readZipEntries(result.buffer), "word/styles.xml");
    for (const level of [1, 2, 3]) {
      const style = styles.match(
        new RegExp(`<w:style[^>]*w:styleId="Heading${level}"[\\s\\S]*?</w:style>`),
      )?.[0];
      expect(style).toContain('<w:color w:val="000000"');
      expect(style).not.toMatch(/w:themeColor=/u);
    }
  },
);

test.each(["single", "combined"] as const)(
  "complex intersecting spans retain cell content through %s DOCX",
  async (mode) => {
    const aggregate = patent();
    const book = aggregate.books.find((item) => item.kind === "description");
    if (!book) throw new Error("Missing book");
    const cell = (text: string, rowSpan = 1, colSpan = 1) => ({
      id: crypto.randomUUID(),
      rowSpan,
      colSpan,
      horizontalAlignment: "left",
      verticalAlignment: "top",
      borderStyle: "single",
      content: [paragraph(text)],
    });
    const table = TableNodeSchema.parse({
      id: crypto.randomUUID(),
      type: "table",
      columnWidthsMm: [20, 30, 40],
      layoutMode: "fit-page",
      rows: [
        { id: crypto.randomUUID(), cells: [cell("甲", 3), cell("乙", 1, 2)] },
        { id: crypto.randomUUID(), cells: [cell("丙"), cell("丁", 2)] },
        { id: crypto.randomUUID(), cells: [cell("戊")] },
      ],
    });
    book.document.content = [table];
    const result = await createPatentDocxPackage({
      patent: aggregate,
      mode,
      bookKind: "description",
    });
    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(result.buffer, "spans.docx"),
    );
    const imported = convertParsedWordDocument(parsed, {
      title: "复杂合并",
      mode: "formal-book",
      bookKind: "description",
    });
    const restored = imported.document.content.find((node) => node.type === "table");
    expect(TableNodeSchema.safeParse(restored).success).toBe(true);
    const summarize = (value: typeof table) =>
      value.rows.map((row) =>
        row.cells.map((item) => ({
          rowSpan: item.rowSpan,
          colSpan: item.colSpan,
          text: item.content
            .flatMap((p) => p.content.map((inline) => (inline.type === "text" ? inline.text : "")))
            .join(""),
        })),
      );
    if (!restored) throw new Error("Missing restored table");
    expect(summarize(restored)).toEqual(summarize(table));
  },
);

test("saves a numbered DOCX copy when the selected target is locked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patent-docx-locked-"));
  try {
    const outputPath = join(directory, "说明书.docx");
    const fallbackPath = join(directory, "说明书 (1).docx");
    const lockedContents = Buffer.from("opened by Word", "utf8");
    await writeFile(outputPath, lockedContents);
    const writeAtomic = vi.fn(async (path: string, data: Buffer) => {
      if (path === outputPath) {
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
          code: "EPERM",
        });
      }
      await writeFile(path, data);
    });

    const report = await savePatentDocxToPath(
      outputPath,
      { patent: patent(), mode: "single", bookKind: "description" },
      [],
      writeAtomic,
    );

    expect(report.outputPath).toBe(fallbackPath);
    expect(report.issues).toContainEqual({
      severity: "warning",
      code: "EXPORT_FAILED",
      nodeId: null,
      message: "原目标文件正被其他程序占用，已自动另存为“说明书 (1).docx”。",
    });
    expect(await readFile(outputPath)).toEqual(lockedContents);
    expect((await readFile(fallbackPath)).subarray(0, 2).toString("utf8")).toBe("PK");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not replace an existing numbered DOCX copy when the selected target is locked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patent-docx-numbered-"));
  try {
    const outputPath = join(directory, "说明书.docx");
    const existingFallbackPath = join(directory, "说明书 (1).docx");
    const nextFallbackPath = join(directory, "说明书 (2).docx");
    const existingFallbackContents = Buffer.from("keep this copy", "utf8");
    await writeFile(existingFallbackPath, existingFallbackContents);
    const writeAtomic = vi.fn(async (path: string, data: Buffer) => {
      if (path === outputPath) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      await writeFile(path, data);
    });

    const report = await savePatentDocxToPath(
      outputPath,
      { patent: patent(), mode: "single", bookKind: "description" },
      [],
      writeAtomic,
    );

    expect(report.outputPath).toBe(nextFallbackPath);
    expect(await readFile(existingFallbackPath)).toEqual(existingFallbackContents);
    expect((await readFile(nextFallbackPath)).subarray(0, 2).toString("utf8")).toBe("PK");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fully spanned rows survive PATDOC, DOCX and print without phantom cells", async () => {
  const aggregate = patent();
  const book = aggregate.books.find((item) => item.kind === "description");
  if (!book) throw new Error("Missing book");
  const table = TableNodeSchema.parse({
    id: crypto.randomUUID(),
    type: "table",
    columnWidthsMm: [30, 30],
    rows: [
      {
        id: crypto.randomUUID(),
        cells: [
          {
            id: crypto.randomUUID(),
            rowSpan: 2,
            colSpan: 2,
            horizontalAlignment: "left",
            verticalAlignment: "top",
            borderStyle: "single",
            content: [paragraph("合并内容")],
          },
        ],
      },
      { id: crypto.randomUUID(), cells: [] },
    ],
  });
  expect(TableNodeSchema.safeParse({ ...table, rows: [table.rows[1]] }).success).toBe(false);
  book.document.content = [table];
  const dir = await mkdtemp(join(tmpdir(), "table-roundtrip-"));
  try {
    const path = join(dir, "merged.patdoc");
    await writePatdoc(path, { patent: aggregate, assets: [] });
    const loaded = await readPatdoc<PatentPatdocPayload>(path);
    expect(
      loaded.patent.books.find((item) => item.kind === "description")?.document.content,
    ).toEqual([table]);
    for (const mode of ["single", "combined"] as const) {
      const result = await createPatentDocxPackage({
        patent: loaded.patent,
        mode,
        bookKind: "description",
      });
      const parsed = await parseWordprocessingDocument(
        await readDocxPackageBuffer(result.buffer, "merged.docx"),
      );
      const imported = convertParsedWordDocument(parsed, {
        title: "合并",
        mode: "formal-book",
        bookKind: "description",
      });
      const restored = imported.document.content.find((node) => node.type === "table");
      expect(restored?.rows.map((row) => row.cells.length)).toEqual([1, 0]);
      expect(restored?.rows[0]?.cells[0]).toMatchObject({ rowSpan: 2, colSpan: 2 });
      expect(TableNodeSchema.safeParse(restored).success).toBe(true);
    }
    const html = await renderPrintHtml(book.document, [], { includeDocumentHeader: false });
    const print = new DOMParser().parseFromString(html, "text/html");
    expect(print.querySelectorAll("td")).toHaveLength(1);
    expect(print.querySelector("td")?.getAttribute("rowspan")).toBe("2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  ["fit-page", "single", 12, "exact"],
  ["fixed", "single", 12, "exact"],
  ["fit-page", "combined", 3, "at-least"],
  ["fixed", "combined", 3, "at-least"],
] as const)(
  "preserves %s table geometry and supported formatting through %s DOCX (%s mm %s)",
  async (layoutMode, mode, rowHeightMm, rowHeightRule) => {
    const aggregate = patent();
    const book = aggregate.books.find((item) => item.kind === "description");
    if (!book) throw new Error("Missing description");
    book.document.content = [
      {
        id: crypto.randomUUID(),
        type: "table",
        layoutMode,
        columnWidthsMm: [20, 40],
        headerRowCount: 1,
        rows: [
          {
            id: crypto.randomUUID(),
            rowHeightMm,
            rowHeightRule,
            cells: [20, 40].map(() => ({
              id: crypto.randomUUID(),
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "center",
              verticalAlignment: "bottom",
              borderStyle: "double",
              borderEdges: { top: "double", bottom: "none", left: "single", right: "double" },
              content: [
                {
                  ...paragraph("表格测试"),
                  attrs: { ...paragraph("").attrs, alignment: "center" },
                },
              ],
            })),
          },
        ],
      },
    ];
    const page = book.document.page;
    const expectedWidth =
      layoutMode === "fixed" ? 60 : page.widthMm - page.marginLeftMm - page.marginRightMm;
    const result = await createPatentDocxPackage({
      patent: aggregate,
      mode,
      bookKind: "description",
    });
    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(result.buffer, "table.docx"),
    );
    const imported = convertParsedWordDocument(parsed, {
      title: "表格",
      mode: "formal-book",
      bookKind: "description",
    });
    const table = imported.document.content.find((node) => node.type === "table");
    if (!table) throw new Error("Missing table");
    expect(table.layoutMode).toBe(layoutMode);
    expect(table.columnWidthsMm.reduce((sum, width) => sum + width, 0)).toBeCloseTo(
      expectedWidth,
      1,
    );
    expect(Number(table.columnWidthsMm[1]) / Number(table.columnWidthsMm[0])).toBeCloseTo(2, 2);
    expect(table.headerRowCount).toBe(1);
    expect(table.rows[0]?.rowHeightMm).toBeCloseTo(rowHeightMm, 1);
    expect(table.rows[0]?.rowHeightRule).toBe(rowHeightRule);
    expect(table.rows[0]?.cells[0]).toMatchObject({
      horizontalAlignment: "center",
      verticalAlignment: "bottom",
      borderEdges: { top: "double", bottom: "none", left: "single", right: "double" },
    });
    const html = await renderPrintHtml(book.document, [], { includeDocumentHeader: false });
    const printTable = new DOMParser().parseFromString(html, "text/html").querySelector("table");
    if (!printTable) throw new Error("Missing print table");
    expect(Number.parseFloat(printTable.style.width)).toBeCloseTo(expectedWidth, 2);
    expect(printTable.style.tableLayout).toBe("fixed");
    expect(printTable.querySelector("p")?.style.textAlign).toBe("center");
  },
);

function paragraph(text: string, marks: TextMark[] = []) {
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
    content: [{ type: "text" as const, text, marks }],
  };
}

function patent(patentType: PatentType = "invention") {
  const aggregate = createBlankPatent({ patentType, name: "五书导出测试" });
  aggregate.patentId = "00000000-0000-4000-8000-000000000101";
  for (const book of aggregate.books) {
    book.document.content = [paragraph(`${PATENT_BOOK_LABELS[book.kind]}正文`)];
  }
  return aggregate;
}

test.each(["single", "combined"] as const)(
  "exports %s legacy tables with stale width counts without changing cells",
  async (mode) => {
    const aggregate = patent();
    const book = aggregate.books.find((item) => item.kind === "description");
    if (!book) throw new Error("Missing book");
    book.document.content = [
      {
        id: crypto.randomUUID(),
        type: "table",
        columnWidthsMm: Array(9).fill(29.898),
        rows: Array.from({ length: 6 }, (_, row) => ({
          id: crypto.randomUUID(),
          cells: Array.from({ length: 4 }, (_, column) => ({
            id: crypto.randomUUID(),
            rowSpan: 1,
            colSpan: 1,
            horizontalAlignment: "left",
            verticalAlignment: "top",
            borderStyle: "single",
            content: [paragraph(`单元格${row}-${column}`)],
          })),
        })),
      },
    ];
    const before = structuredClone(book.document);
    const result = await createPatentDocxPackage({
      patent: aggregate,
      mode,
      bookKind: "description",
    });
    const xml = xmlText(await readZipEntries(result.buffer), "word/document.xml");
    expect(xml.match(/<w:gridCol\b/gu)).toHaveLength(4);
    expect(xml.match(/<w:tc>/gu)).toHaveLength(24);
    expect(xml).toContain("单元格5-3");
    expect(book.document).toEqual(before);
  },
);

async function drawingAssets(): Promise<StoredAsset[]> {
  const fixtures = [
    {
      assetId: "00000000-0000-4000-8000-000000000201",
      name: "sample.png",
      mediaType: "image/png" as const,
      extension: "png" as const,
    },
    {
      assetId: "00000000-0000-4000-8000-000000000202",
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

async function vectorImageAsset(): Promise<StoredAsset> {
  const original = await readFile(
    join(process.cwd(), "tests", "fixtures", "vector-image", "patent-black-output.svg"),
  );
  const preview = await readFile(
    join(process.cwd(), "tests", "fixtures", "vector-image", "patent-black-output.png"),
  );
  return {
    descriptor: {
      assetId: "00000000-0000-4000-8000-000000000209",
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

async function unsafeVectorImageAsset(svg: string): Promise<StoredAsset> {
  const asset = await vectorImageAsset();
  const original = Buffer.from(svg, "utf8");
  return {
    ...asset,
    descriptor: {
      ...asset.descriptor,
      byteLength: original.byteLength,
      sha256: createHash("sha256").update(original).digest("hex").toUpperCase(),
    },
    original: Uint8Array.from(original),
  };
}

function installDrawings(aggregate: ReturnType<typeof patent>, assets: readonly StoredAsset[]) {
  aggregate.assets = assets.map((asset) => structuredClone(asset.descriptor));
  aggregate.figures = assets.map((asset, index) => ({
    figureId: `00000000-0000-4000-8000-${(301 + index).toString().padStart(12, "0")}`,
    assetId: asset.descriptor.assetId,
    widthMm: 80 + index * 10,
  }));
  aggregate.abstractDrawingFigureId = aggregate.figures[1]?.figureId ?? null;
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("DOCX ZIP could not be opened"));
      else resolveZip(zip);
    });
  });
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolveEntry, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("DOCX ZIP entry could not be read"));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolveEntry(Buffer.concat(chunks)));
    });
  });
}

async function readZipEntries(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await openZip(buffer);
  return new Promise((resolveEntries, reject) => {
    const entries = new Map<string, Buffer>();
    zip.on("error", reject);
    zip.on("entry", (entry: Entry) => {
      void readEntry(zip, entry)
        .then((bytes) => {
          entries.set(entry.fileName, bytes);
          zip.readEntry();
        })
        .catch(reject);
    });
    zip.on("end", () => resolveEntries(entries));
    zip.readEntry();
  });
}

function xmlText(entries: Map<string, Buffer>, path: string): string {
  return entries.get(path)?.toString("utf8") ?? "";
}

describe("patent DOCX export", () => {
  test.each(["table", "list"])(
    "round-trips a rotated image inside a %s through DOCX",
    async (container) => {
      const aggregate = patent();
      const asset = (await drawingAssets())[0];
      const book = aggregate.books.find((item) => item.kind === "description");
      if (!asset || !book) throw new Error("Missing fixture");
      asset.descriptor.widthPx = 12;
      asset.descriptor.heightPx = 8;
      aggregate.assets = [asset.descriptor];
      const text: ParagraphNode = paragraph("前");
      text.content.push(
        {
          id: crypto.randomUUID(),
          type: "inline-figure",
          assetId: asset.descriptor.assetId,
          widthMm: 25,
          alignment: "left",
          rotationDeg: 90,
        },
        { type: "text", text: "后", marks: [] },
      );
      book.document.content =
        container === "table"
          ? [
              TableNodeSchema.parse({
                id: crypto.randomUUID(),
                type: "table",
                columnWidthsMm: [50],
                rows: [
                  {
                    id: crypto.randomUUID(),
                    cells: [
                      {
                        id: crypto.randomUUID(),
                        rowSpan: 1,
                        colSpan: 1,
                        horizontalAlignment: "left",
                        verticalAlignment: "top",
                        borderStyle: "single",
                        content: [text],
                      },
                    ],
                  },
                ],
              }),
            ]
          : [
              {
                id: crypto.randomUUID(),
                type: "bullet-list",
                items: [{ id: crypto.randomUUID(), content: [text] }],
              },
            ];
      const result = await createPatentDocxPackage(
        { patent: aggregate, mode: "single", bookKind: "description" },
        [asset],
      );
      const parsed = await parseWordprocessingDocument(
        await readDocxPackageBuffer(result.buffer, "image.docx"),
      );
      const restored = convertParsedWordDocument(parsed, {
        title: "图片",
        mode: "formal-book",
        bookKind: "description",
        resolveImage: () => ({ assetId: asset.descriptor.assetId }),
      });
      const serialized = JSON.stringify(restored.document);
      expect(serialized).not.toContain("未导入");
      expect(serialized).toContain('"type":"inline-figure"');
      expect(serialized.indexOf('"text":"前"')).toBeLessThan(
        serialized.indexOf('"type":"inline-figure"'),
      );
      expect(serialized.indexOf('"text":"后"')).toBeGreaterThan(
        serialized.indexOf('"type":"inline-figure"'),
      );
      const entries = await readZipEntries(result.buffer);
      const media = [...entries.entries()].find(([path]) => path.endsWith(".png"))?.[1];
      expect(await sharp(media).metadata()).toMatchObject({ width: 8, height: 12 });
    },
  );

  test.each(["single", "combined"] as const)(
    "bakes drawing rotation into %s DOCX without changing source assets",
    async (mode) => {
      const aggregate = patent();
      const asset = (await drawingAssets())[0];
      if (!asset) throw new Error("Missing drawing");
      asset.descriptor.widthPx = 12;
      asset.descriptor.heightPx = 8;
      installDrawings(aggregate, [asset]);
      const figure = aggregate.figures[0];
      if (!figure) throw new Error("Missing figure");
      figure.rotationDeg = 90;
      const before = structuredClone(aggregate);
      const original = Uint8Array.from(asset.original);
      const result = await createPatentDocxPackage(
        { patent: aggregate, mode, bookKind: "description-drawings" },
        [asset],
      );
      const entries = await readZipEntries(result.buffer);
      const image = [...entries.entries()].find(([path]) => path.endsWith(".png"))?.[1];
      if (!image) throw new Error("Missing exported image");
      expect(await sharp(image).metadata()).toMatchObject({ width: 8, height: 12 });
      expect(xmlText(entries, "word/document.xml")).not.toContain('rot="5400000"');
      expect(aggregate).toEqual(before);
      expect(asset.original).toEqual(original);
    },
  );

  test("DOCX and PDF print content retain inserted JPEGs independently of editable drawing drafts", async () => {
    const aggregate = patent();
    const assets = await drawingAssets();
    const base = assets[0];
    const inserted = assets[1];
    if (!base || !inserted) throw new Error("drawing fixtures missing");
    installDrawings(aggregate, [inserted]);
    aggregate.assets.push(base.descriptor);
    const project = drawingProjectFixture(base.descriptor.assetId);
    for (const annotation of project.annotations) annotation.text = "UNPUBLISHED_MARKUP";
    aggregate.drawingProjects = [project];
    const before = structuredClone(aggregate);
    const result = await createPatentDocxPackage({ patent: aggregate, mode: "combined" }, assets);
    const entries = await readZipEntries(result.buffer);
    const media = [...entries].filter(
      ([path]) => path.startsWith("word/media/") && !path.endsWith("/"),
    );
    expect(media).toHaveLength(1);
    expect(await sharp(media[0]?.[1]).raw().toBuffer()).toEqual(
      await sharp(inserted.original).autoOrient().raw().toBuffer(),
    );
    expect(xmlText(entries, "word/document.xml")).not.toContain("UNPUBLISHED_MARKUP");
    const html = await renderPatentPrintHtml({ patent: aggregate, mode: "combined", assets });
    expect(html).toContain(
      `data:image/jpeg;base64,${Buffer.from(inserted.original).toString("base64")}`,
    );
    expect(html).not.toContain(Buffer.from(base.original).toString("base64"));
    expect(html).not.toContain("UNPUBLISHED_MARKUP");
    expect(aggregate).toEqual(before);
  });

  test.each(["combined", "single"] as const)(
    "exports %s patent chemical equations and structures as PNG graphics",
    async (mode) => {
      const aggregate = patent();
      const assets = await drawingAssets();
      const claims = aggregate.books.find((book) => book.kind === "claims");
      if (!claims) throw new Error("claims book missing");
      claims.document.content = [
        paragraph("化学式："),
        {
          id: "00000000-0000-4000-8000-000000000203",
          type: "block-formula",
          source: String.raw`\ce{(R)-CH3CH(OH)CO2H + nCH2=CH2 -> [-CH2-CH2-]_{n}}`,
          formulaKind: "chemistry",
        },
        {
          id: "00000000-0000-4000-8000-000000000204",
          type: "chemical-structure",
          ketSource: '{"root":{"nodes":[]}}',
          previewAssetId: assets[0]?.descriptor.assetId ?? "",
          widthMm: 40,
          alignment: "center",
        },
      ];
      const beforeExport = structuredClone(aggregate);
      const assetsBeforeExport = structuredClone(assets);

      const result = await createPatentDocxPackage(
        mode === "combined"
          ? { patent: aggregate, mode }
          : { patent: aggregate, mode, bookKind: "claims" },
        assets,
      );
      const entries = await readZipEntries(result.buffer);
      const documentXml = xmlText(entries, "word/document.xml");
      expect(documentXml).not.toContain("<m:oMath>");
      expect([...entries.keys()].some((path) => /^word\/media\/.*\.png$/u.test(path))).toBe(true);
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "CHEMISTRY_RENDERED_AS_IMAGE" }),
      ]);
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

  test("exports combined five-book DOCX in confirmed order with section headers and continuous page field", async () => {
    const result = await createPatentDocxPackage({ patent: patent(), mode: "combined" });
    const entries = await readZipEntries(result.buffer);
    const documentXml = xmlText(entries, "word/document.xml");
    const headerXml = [...entries.entries()]
      .filter(([path]) => /^word\/header\d+\.xml$/u.test(path))
      .map(([, bytes]) => bytes.toString("utf8"));
    const footerXml = [...entries.entries()]
      .filter(([path]) => /^word\/footer\d+\.xml$/u.test(path))
      .map(([, bytes]) => bytes.toString("utf8"));

    const bodyOrder = [
      "摘要正文",
      "摘要附图正文",
      "权利要求书正文",
      "说明书正文",
      "说明书附图正文",
    ].map((text) => documentXml.indexOf(text));
    expect(bodyOrder.every((index) => index >= 0)).toBe(true);
    expect(bodyOrder).toEqual([...bodyOrder].sort((left, right) => left - right));
    expect(documentXml.match(/<w:sectPr/gu)).toHaveLength(5);
    expect(documentXml).not.toContain('w:start="1"');

    for (const label of ["摘要", "摘要附图", "权利要求书", "说明书", "说明书附图"]) {
      expect(headerXml.some((xml) => xml.includes(label))).toBe(true);
    }
    expect(headerXml.every((xml) => xml.includes("<w:pBdr>"))).toBe(true);
    expect(footerXml.length).toBeGreaterThanOrEqual(1);
    expect(footerXml.some((xml) => xml.includes("PAGE"))).toBe(true);
  });

  test("never includes auxiliary document content in the formal five-book DOCX", async () => {
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

    const result = await createPatentDocxPackage({ patent: aggregate, mode: "combined" });
    const documentXml = xmlText(await readZipEntries(result.buffer), "word/document.xml");

    expect(documentXml).not.toContain("不得进入正式五书的其他文档内容");
    expect(documentXml.match(/<w:sectPr/gu)).toHaveLength(5);
  });

  test("omits disabled drawing books from a combined DOCX export", async () => {
    const aggregate = patent();
    aggregate.drawingBooksEnabled = false;

    const result = await createPatentDocxPackage({ patent: aggregate, mode: "combined" });
    const entries = await readZipEntries(result.buffer);
    const documentXml = xmlText(entries, "word/document.xml");
    const headerXml = [...entries.entries()]
      .filter(([path]) => /^word\/header\d+\.xml$/u.test(path))
      .map(([, bytes]) => bytes.toString("utf8"))
      .join("\n");

    const bodyOrder = ["摘要正文", "权利要求书正文", "说明书正文"].map((text) =>
      documentXml.indexOf(text),
    );
    expect(bodyOrder.every((index) => index >= 0)).toBe(true);
    expect(bodyOrder).toEqual([...bodyOrder].sort((left, right) => left - right));
    expect(documentXml).not.toContain("摘要附图正文");
    expect(documentXml).not.toContain("说明书附图正文");
    expect(documentXml.match(/<w:sectPr/gu)).toHaveLength(3);
    expect(headerXml).not.toContain("摘要附图");
    expect(headerXml).not.toContain("说明书附图");
  });

  test("exports one selected book with only that book header and page numbering from one", async () => {
    const result = await createPatentDocxPackage({
      patent: patent(),
      mode: "single",
      bookKind: "claims",
    });
    const entries = await readZipEntries(result.buffer);
    const documentXml = xmlText(entries, "word/document.xml");
    const headerXml = [...entries.entries()]
      .filter(([path]) => /^word\/header\d+\.xml$/u.test(path))
      .map(([, bytes]) => bytes.toString("utf8"))
      .join("\n");
    const footerXml = [...entries.entries()]
      .filter(([path]) => /^word\/footer\d+\.xml$/u.test(path))
      .map(([, bytes]) => bytes.toString("utf8"))
      .join("\n");

    expect(documentXml).toContain("权利要求书正文");
    expect(documentXml).not.toContain("说明书正文");
    expect(headerXml).toContain("权利要求书");
    expect(headerXml).not.toContain("说明书");
    expect(headerXml).toContain("<w:pBdr>");
    expect(footerXml).toContain("PAGE");
    expect(documentXml).toContain('w:start="1"');
  });

  test("embeds all description figures but only the selected abstract figure from real PNG and JPEG bytes", async () => {
    const aggregate = patent();
    const assets = await drawingAssets();
    installDrawings(aggregate, assets);

    const result = await createPatentDocxPackage({ patent: aggregate, mode: "combined" }, assets);
    const entries = await readZipEntries(result.buffer);
    const documentXml = xmlText(entries, "word/document.xml");
    const media = [...entries.entries()].filter(
      ([path]) => path.startsWith("word/media/") && path !== "word/media/",
    );

    expect(media.some(([, bytes]) => bytes.equals(Buffer.from(assets[0]?.original ?? [])))).toBe(
      true,
    );
    const orientedJpeg = await sharp(assets[1]?.original).autoOrient().png().toBuffer();
    expect(media.some(([, bytes]) => bytes.equals(orientedJpeg))).toBe(true);
    expect(documentXml.match(/<a:blip /gu)).toHaveLength(3);
    expect(documentXml.match(/图1/gu)).toHaveLength(1);
    expect(documentXml.match(/图2/gu)).toHaveLength(2);
    expect(documentXml.indexOf("图2")).toBeLessThan(documentXml.indexOf("权利要求书正文"));
    expect(documentXml.lastIndexOf("图1")).toBeGreaterThan(documentXml.indexOf("说明书正文"));
  });

  test("embeds a sanitized vector image SVG with its PNG fallback and preserves its aspect ratio", async () => {
    const aggregate = patent();
    const asset = await vectorImageAsset();
    installDrawings(aggregate, [asset]);
    aggregate.abstractDrawingFigureId = aggregate.figures[0]?.figureId ?? null;

    const result = await createPatentDocxPackage({ patent: aggregate, mode: "combined" }, [asset]);
    const entries = await readZipEntries(result.buffer);
    const media = [...entries.entries()].filter(([path]) => path.startsWith("word/media/"));
    const documentXml = xmlText(entries, "word/document.xml");

    expect(media.some(([, bytes]) => bytes.equals(Buffer.from(asset.original)))).toBe(true);
    expect(media.some(([, bytes]) => bytes.equals(Buffer.from(asset.preview)))).toBe(true);
    expect(documentXml).toContain("<asvg:svgBlip");
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/u.exec(documentXml);
    expect(extent).not.toBeNull();
    expect(Number(extent?.[1]) / Number(extent?.[2])).toBeCloseTo(1.5, 2);
    expect(documentXml.match(/图1/gu)).toHaveLength(2);
  });

  test("keeps the locked real renderer output as SVG in DOCX", async () => {
    const renderedSvg = await readFile(
      join(process.cwd(), "tests", "fixtures", "vector-image", "render-reference.svg"),
    );
    const asset = await vectorImageAsset();
    asset.original = Uint8Array.from(renderedSvg);
    asset.descriptor.byteLength = renderedSvg.byteLength;
    asset.descriptor.sha256 = createHash("sha256").update(renderedSvg).digest("hex").toUpperCase();
    const aggregate = patent();
    installDrawings(aggregate, [asset]);

    const result = await createPatentDocxPackage(
      { patent: aggregate, mode: "single", bookKind: "description-drawings" },
      [asset],
    );
    const entries = await readZipEntries(result.buffer);

    expect(xmlText(entries, "word/document.xml")).toContain("<asvg:svgBlip");
    expect([...entries.values()].some((bytes) => bytes.equals(renderedSvg))).toBe(true);
  });

  test("locks the black-white vector image fixture at a 1200 by 800 pixel canvas", async () => {
    const svgPath = join(
      process.cwd(),
      "tests",
      "fixtures",
      "vector-image",
      "patent-black-output.svg",
    );
    const pngPath = join(
      process.cwd(),
      "tests",
      "fixtures",
      "vector-image",
      "patent-black-output.png",
    );
    const svg = await readFile(svgPath, "utf8");
    const metadata = await sharp(pngPath).metadata();
    const stats = await sharp(pngPath).removeAlpha().stats();

    expect(svg).not.toMatch(/#[0-9a-f]{6}/iu);
    expect(svg).toContain('viewBox="0 0 1200 800"');
    expect(metadata).toMatchObject({ width: 1200, height: 800 });
    const colorChannels = stats.channels.slice(0, 3);
    expect(colorChannels.every((channel) => channel.min === 0 && channel.max === 255)).toBe(true);
    expect(new Set(colorChannels.map((channel) => channel.mean))).toHaveLength(1);
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
      "dangling local CSS fragment",
      '<svg xmlns="http://www.w3.org/2000/svg"><path clip-path="url(#missing)"/></svg>',
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
      '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" values="https://bad.invalid/a"/></svg>',
    ],
    [
      "embedded image",
      '<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="file:///bad.png"/></svg>',
    ],
  ])("does not advertise vector output when %s falls back to PNG", async (_label, svg) => {
    const aggregate = patent();
    const asset = await unsafeVectorImageAsset(svg);
    installDrawings(aggregate, [asset]);

    const result = await createPatentDocxPackage(
      { patent: aggregate, mode: "single", bookKind: "description-drawings" },
      [asset],
    );
    const entries = await readZipEntries(result.buffer);
    const documentXml = xmlText(entries, "word/document.xml");

    expect(documentXml).not.toContain("<asvg:svgBlip");
    expect(
      [...entries.entries()].some(([, bytes]) => bytes.equals(Buffer.from(asset.preview))),
    ).toBe(true);
    expect([...entries.values()].some((bytes) => bytes.equals(Buffer.from(asset.original)))).toBe(
      false,
    );
  });

  test("preserves rich text, tables, and formulas in patent book DOCX content", async () => {
    const aggregate = patent();
    const claims = aggregate.books.find((book) => book.kind === "claims");
    if (!claims) throw new Error("fixture");
    const paragraphA = paragraph("1. 一种环保回收装置，其特征在于：", [{ type: "bold" }]);
    const paragraphB = paragraph("表格单元格");
    claims.document.content = [
      paragraphA,
      {
        id: crypto.randomUUID(),
        type: "table",
        columnWidthsMm: [40],
        rows: [
          {
            id: crypto.randomUUID(),
            cells: [
              {
                id: crypto.randomUUID(),
                colSpan: 1,
                rowSpan: 1,
                verticalAlignment: "top",
                horizontalAlignment: "center",
                borderStyle: "single",
                content: [paragraphB],
              },
            ],
          },
        ],
      },
      {
        id: crypto.randomUUID(),
        type: "block-formula",
        source: String.raw`\sum_{i=1}^{n}x_i`,
        formulaKind: "math",
      },
    ];

    const result = await createPatentDocxPackage({
      patent: aggregate,
      mode: "single",
      bookKind: "claims",
    });
    const documentXml = xmlText(await readZipEntries(result.buffer), "word/document.xml");

    expect(documentXml).toContain("<w:b/>");
    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain('<w:jc w:val="center"/>');
    expect(documentXml).toMatch(/<m:oMath>/u);
    expect(documentXml).toContain("一种环保回收装置");
  });

  test("keeps reviewed reference digits while omitting their editor-only red underline", async () => {
    const aggregate = patent();
    const claims = aggregate.books.find((book) => book.kind === "claims");
    if (!claims) throw new Error("fixture");
    claims.document.content = [
      {
        ...paragraph("根据权利要求2所述的装置"),
        content: [
          { type: "text", text: "根据权利要求", marks: [] },
          { type: "text", text: "2", marks: [{ type: "claim-reference-review" }] },
          { type: "text", text: "所述的装置", marks: [] },
        ],
      },
    ];

    const result = await createPatentDocxPackage({
      patent: aggregate,
      mode: "single",
      bookKind: "claims",
    });
    const documentXml = xmlText(await readZipEntries(result.buffer), "word/document.xml");

    expect(documentXml).toContain("根据权利要求");
    expect(documentXml).toContain(">2<");
    expect(documentXml).toContain("所述的装置");
    expect(documentXml).not.toContain('w:color w:val="D92D20"');
    expect(documentXml).not.toContain("<w:u");
  });

  test("exports only the selected figure for a single abstract-drawing book", async () => {
    const aggregate = patent();
    const assets = await drawingAssets();
    installDrawings(aggregate, assets);

    const result = await createPatentDocxPackage(
      { patent: aggregate, mode: "single", bookKind: "abstract-drawing" },
      assets,
    );
    const entries = await readZipEntries(result.buffer);
    const documentXml = xmlText(entries, "word/document.xml");
    const media = [...entries.entries()].filter(
      ([path]) => path.startsWith("word/media/") && path !== "word/media/",
    );

    expect(media).toHaveLength(1);
    expect(await sharp(media[0]?.[1]).raw().toBuffer()).toEqual(
      await sharp(assets[1]?.original).autoOrient().raw().toBuffer(),
    );
    expect(documentXml).toContain("图2");
    expect(documentXml).not.toContain("图1");
  });

  test("reports a missing book kind for single-book export", async () => {
    const missing = patent();
    missing.books = missing.books.filter((book) => book.kind !== "abstract");

    await expect(
      createPatentDocxPackage({
        patent: missing,
        mode: "single",
        bookKind: "abstract" as PatentBookKind,
      }),
    ).rejects.toMatchObject({
      issues: [
        {
          severity: "error",
          code: "EXPORT_FAILED",
          nodeId: null,
        },
      ],
    });
  });

  test("verifies a temporary sibling package before reporting saved DOCX success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patent-docx-export-"));
    try {
      const outputPath = join(directory, "combined.docx");

      const report = await savePatentDocxToPath(outputPath, { patent: patent(), mode: "combined" });

      expect(report).toEqual({ format: "docx", outputPath, issues: [] });
      const entries = await readZipEntries(await readFile(outputPath));
      expect(entries.has("word/document.xml")).toBe(true);
      await expect(
        readdir(directory).then((names) => names.filter((name) => name.endsWith(".tmp"))),
      ).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not create an output file when patent DOCX validation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patent-docx-export-fail-"));
    try {
      const outputPath = join(directory, "missing.docx");
      const missing = patent();
      missing.books = missing.books.filter((book) => book.kind !== "claims");

      await expect(
        savePatentDocxToPath(outputPath, {
          patent: missing,
          mode: "single",
          bookKind: "claims",
        }),
      ).rejects.toMatchObject({
        issues: [
          {
            severity: "error",
            code: "EXPORT_FAILED",
            nodeId: null,
          },
        ],
      });
      await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test.each(["single", "combined"] as const)(
  "%s exports imported drawings once without dropping text or standalone images",
  async (mode) => {
    const aggregate = patent();
    const assets = await drawingAssets();
    installDrawings(aggregate, assets);
    const book = aggregate.books.find((item) => item.kind === "description-drawings");
    if (!book || !assets[0]) throw new Error("Missing drawing fixture");
    const image = (assetId: string) => ({
      id: crypto.randomUUID(),
      type: "figure" as const,
      assetId,
      widthMm: 80,
      alignment: "center" as const,
    });
    book.document.content = [
      paragraph("保留附图说明"),
      ...assets.map((asset) => image(asset.descriptor.assetId)),
      image(assets[0].descriptor.assetId),
    ];
    const before = structuredClone(aggregate);
    const result = await createPatentDocxPackage(
      { patent: aggregate, mode, bookKind: "description-drawings" },
      assets,
    );
    const xml = xmlText(await readZipEntries(result.buffer), "word/document.xml");
    expect((xml.match(/<w:drawing>/gu) ?? []).length).toBe(mode === "single" ? 3 : 4);
    expect(xml).toContain("保留附图说明");
    const html = await renderPatentPrintHtml({
      patent: aggregate,
      mode,
      bookKind: "description-drawings",
      assets,
    });
    expect((html.match(/<figure class="figure /gu) ?? []).length).toBe(mode === "single" ? 3 : 4);
    expect(html).toContain("保留附图说明");
    expect(aggregate).toEqual(before);
    aggregate.books = normalizeDrawingBooks(aggregate);
    aggregate.figures = [];
    aggregate.abstractDrawingFigureId = null;
    const deleted = await createPatentDocxPackage(
      { patent: aggregate, mode, bookKind: "description-drawings" },
      assets,
    );
    const deletedXml = xmlText(await readZipEntries(deleted.buffer), "word/document.xml");
    // Only the intentional standalone image survives deleting all canonical drawings.
    expect((deletedXml.match(/<w:drawing>/gu) ?? []).length).toBe(1);
    const deletedHtml = await renderPatentPrintHtml({
      patent: aggregate,
      mode,
      bookKind: "description-drawings",
      assets,
    });
    expect((deletedHtml.match(/<figure class="figure /gu) ?? []).length).toBe(1);
  },
);
