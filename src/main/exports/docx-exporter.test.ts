import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IImageOptions } from "docx";
import sharp from "sharp";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { createBlankDocument } from "../../shared/document/defaults.js";
import { CanonicalDocumentSchema } from "../../shared/document/model.js";
import { tableRegressionDocument } from "../../shared/document/table-regression-fixture.js";
import { AssetStore } from "../assets/asset-store.js";
import { importImage } from "../assets/image-importer.js";
import { convertParsedWordDocument } from "../docx-import/docx-canonical-converter.js";
import { readDocxPackageBuffer } from "../docx-import/docx-package-reader.js";
import { parseWordprocessingDocument } from "../docx-import/wordprocessingml-parser.js";
import {
  createDocxPackage,
  DocxExportError,
  millimetresToPixels,
  saveDocxToPath,
} from "./docx-exporter.js";

test("heading styles stay black while explicit text colors remain unchanged", async () => {
  const document = createBlankDocument("标题颜色");
  const paragraph = document.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
  document.content = [1, 2, 3].map((level) => ({
    ...structuredClone(paragraph),
    id: crypto.randomUUID(),
    type: "heading" as const,
    level: level as 1 | 2 | 3,
    content: [{ type: "text" as const, text: `标题${level}`, marks: [] }],
  }));
  document.content.push({
    ...paragraph,
    content: [{ type: "text", text: "保留用户红字", marks: [{ type: "color", value: "#FF0000" }] }],
  });
  const store = new AssetStore();
  store.createSession("heading-colors");
  const output = await createDocxPackage({ sessionId: "heading-colors", document }, store);
  const entries = await readZipEntries(output.buffer);
  const styles = entries.get("word/styles.xml")?.toString("utf8") ?? "";
  for (const level of [1, 2, 3]) {
    const style = styles.match(
      new RegExp(`<w:style[^>]*w:styleId="Heading${level}"[\\s\\S]*?</w:style>`),
    )?.[0];
    expect(style).toContain('<w:color w:val="000000"');
    expect(style).not.toMatch(/w:themeColor=/u);
  }
  expect(entries.get("word/document.xml")?.toString("utf8")).toContain('<w:color w:val="FF0000"');
});

test("formula colors and sizes survive export without sharing cached formatting", async () => {
  const document = createBlankDocument("公式格式");
  const paragraph = document.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
  paragraph.attrs.defaultFontFamily = "KaiTi";
  paragraph.content = [
    {
      type: "text",
      text: "原文",
      marks: [{ type: "font-family", value: "FangSong" }, { type: "bold" }],
    },
    {
      type: "inline-formula",
      source: "x^2",
      formulaKind: "math",
      fontSizePt: 10.5,
      color: "#FF0000",
    },
    {
      type: "inline-formula",
      source: "x^2",
      formulaKind: "math",
      fontSizePt: 12,
      color: "#0000FF",
    },
  ];
  document.content.push({
    id: crypto.randomUUID(),
    type: "block-formula",
    source: "x^2",
    formulaKind: "math",
    fontSizePt: 18,
    color: "#123ABC",
    alignment: "right",
  });
  const store = new AssetStore();
  store.createSession("formula-colors");
  const output = await createDocxPackage({ sessionId: "formula-colors", document }, store);
  const xml =
    (await readZipEntries(output.buffer)).get("word/document.xml")?.toString("utf8") ?? "";
  const formulas = xml.match(/<m:oMath>.*?<\/m:oMath>/gu) ?? [];
  expect(formulas).toHaveLength(3);
  for (const [index, color] of ["FF0000", "0000FF", "123ABC"].entries())
    expect(formulas[index]).toContain(`<w:color w:val="${color}"`);
  expect(xml).toContain("原文");
  expect(xml).toContain(
    process.platform === "win32" ? 'w:eastAsia="FangSong"' : 'w:eastAsia="SimSun"',
  );
});

test("identical formula sources export distinct sizes without cache contamination", async () => {
  const document = createBlankDocument("公式字号导出");
  const paragraph = document.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
  paragraph.content = [
    { type: "text", text: "甲", marks: [{ type: "font-size", valuePt: 10.5 }] },
    { type: "inline-formula", source: "x^2", formulaKind: "math" },
    { type: "inline-formula", source: "x^2", formulaKind: "math", fontSizePt: 12 },
  ];
  document.content.push({
    type: "block-formula",
    id: crypto.randomUUID(),
    source: "x^2",
    formulaKind: "math",
    fontSizePt: 18,
  });
  const assetStore = new AssetStore();
  assetStore.createSession("formula-sizes");
  const result = await createDocxPackage({ sessionId: "formula-sizes", document }, assetStore);
  const entries = await readZipEntries(result.buffer);
  const xml = entries.get("word/document.xml")?.toString("utf8") ?? "";
  const formulas = xml.match(/<m:oMath>.*?<\/m:oMath>/gu) ?? [];
  expect(formulas).toHaveLength(3);
  for (const [index, size] of [21, 24, 36].entries())
    expect(formulas[index]).toContain(`<w:sz w:val="${size}"`);
});

test("exports unopened persisted image resources without loading unrelated CAD history", async () => {
  const sessionId = "lazy-docx";
  const fixture = await referenceAssetStore(sessionId);
  const stored = fixture.assetStore.list(sessionId);
  const readAsset = vi.fn(async (id: string) => {
    const asset = stored.find((item) => item.descriptor.assetId === id);
    if (!asset) throw new Error("unexpected resource read");
    return asset;
  });
  const lazy = new AssetStore({ persistent: { readAsset, install: vi.fn() } });
  lazy.createSession(sessionId);
  const result = await createDocxPackage({ sessionId, document: fixture.document }, lazy);
  const entries = await readZipEntries(result.buffer);
  expect([...entries.keys()].some((key) => key.startsWith("word/media/"))).toBe(true);
  expect(readAsset).toHaveBeenCalled();
});

test.each([
  ["Source Han Serif CN", "SimSun"],
  ["HarmonyOS Sans SC", "SimSun"],
  ["PingFang SC", "SimSun"],
  ["FangSong", "FangSong"],
  ["KaiTi", "KaiTi"],
])("exports %s as %s without losing text or changing the source", async (font, expected) => {
  const document = createBlankDocument("字体互通");
  const paragraph = document.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
  paragraph.attrs.defaultFontFamily = font;
  paragraph.content = [
    {
      type: "text",
      text: "一种冷却机构，ABC 123 αβ，𠮷。",
      marks: [{ type: "font-family", value: font }, { type: "bold" }],
    },
  ];
  const before = structuredClone(document);
  const result = await createDocxPackage({ sessionId: "font-interop", document }, new AssetStore());
  const entries = await readZipEntries(result.buffer);
  const xml = entries.get("word/document.xml")?.toString("utf8") ?? "";
  expect(xml).toContain(`w:eastAsia="${process.platform === "darwin" ? "SimSun" : expected}"`);
  expect(xml).toContain("一种冷却机构，ABC 123 αβ，𠮷。");
  expect(xml).toContain("<w:b/>");
  expect(result.issues.filter((issue) => issue.code === "FONT_SUBSTITUTED")).toEqual([]);
  expect([...entries.keys()].some((name) => /word\/fonts\//u.test(name))).toBe(false);
  expect(document).toEqual(before);
  const imported = await parseWordprocessingDocument(
    await readDocxPackageBuffer(result.buffer, "fonts.docx"),
  );
  const restored = imported.blocks[0];
  if (restored?.type !== "paragraph") throw new Error("Missing imported paragraph");
  expect(
    restored.inlines
      .filter((run) => run.type === "text")
      .map((run) => run.text)
      .join(""),
  ).toBe("一种冷却机构，ABC 123 αβ，𠮷。");
});

test.each(["left", "center", "right"] as const)(
  "exports entire table alignment %s",
  async (tableAlignment) => {
    const document = createBlankDocument("表格位置");
    const paragraph = document.content[0]!;
    if (paragraph.type !== "paragraph") throw new Error("Missing paragraph");
    document.content = [
      {
        id: crypto.randomUUID(),
        type: "table",
        tableAlignment,
        layoutMode: "fixed",
        columnWidthsMm: [30],
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
                content: [paragraph],
              },
            ],
          },
        ],
      },
    ];
    const result = await createDocxPackage(
      { sessionId: "table-alignment", document },
      new AssetStore(),
    );
    const entries = await readZipEntries(result.buffer);
    const xml = entries.get("word/document.xml")?.toString("utf8") ?? "";
    expect(xml).toContain(`<w:jc w:val="${tableAlignment}"/>`);
  },
);

test("exports optional table annotations with numbering and excludes disabled content", async () => {
  const document = createBlankDocument("表格说明");
  const paragraph = document.content[0]!;
  if (paragraph.type !== "paragraph") throw new Error("Missing paragraph");
  paragraph.attrs.defaultFontSizePt = 14;
  paragraph.content = [
    { type: "text", text: "单元格正文", marks: [{ type: "font-size", valuePt: 18 }] },
  ];
  const table = {
    id: crypto.randomUUID(),
    type: "table" as const,
    columnWidthsMm: [30],
    rows: [
      {
        id: crypto.randomUUID(),
        cells: [
          {
            id: crypto.randomUUID(),
            rowSpan: 1,
            colSpan: 1,
            horizontalAlignment: "left" as const,
            verticalAlignment: "top" as const,
            borderStyle: "single" as const,
            content: [paragraph],
          },
        ],
      },
    ],
  };
  document.content = [
    {
      ...table,
      tableNameEnabled: false,
      tableName: "不导出",
      tableNoteEnabled: false,
      tableNote: "隐藏说明",
    },
    {
      ...table,
      id: crypto.randomUUID(),
      tableNameEnabled: true,
      tableName: "测试结果",
      tableNoteEnabled: true,
      tableNote: "平均值\n单位：秒",
    },
  ];
  const result = await createDocxPackage({ sessionId: "annotations", document }, new AssetStore());
  const xml =
    (await readZipEntries(result.buffer)).get("word/document.xml")?.toString("utf8") ?? "";
  expect(xml).toContain("表1 测试结果");
  expect(xml).toContain("平均值");
  expect(xml).toContain("单位：秒");
  expect(xml).not.toContain("不导出");
  expect(xml).not.toContain("隐藏说明");
  expect(xml).toContain("<w:keepNext/>");
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu)].map(
    (match) => match[0],
  );
  const name = paragraphs.find((item) => item.includes("表1 测试结果"));
  const note = paragraphs.find((item) => item.includes("平均值"));
  expect(name).toContain('<w:sz w:val="24"/>');
  expect(name).toContain('<w:jc w:val="center"/>');
  expect(name).toContain("<w:b/>");
  expect(note).toContain('<w:sz w:val="24"/>');
  expect(note).toContain('<w:jc w:val="left"/>');
  expect(note).not.toContain("<w:b/>");
  expect(paragraphs.find((item) => item.includes("单元格正文"))).toContain('<w:sz w:val="36"/>');
  expect(paragraph.content[0]).toMatchObject({
    type: "text",
    marks: [{ type: "font-size", valuePt: 18 }],
  });
});

test("list export uses hanging indentation instead of body first-line indentation", async () => {
  const document = createBlankDocument("列表缩进");
  const paragraph = document.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
  paragraph.attrs.paragraphIndentMm = 9.88;
  document.content = [
    {
      id: "00000000-0000-4000-8000-000000000801",
      type: "ordered-list",
      start: 3,
      items: [
        {
          id: "00000000-0000-4000-8000-000000000802",
          content: [
            paragraph,
            { ...structuredClone(paragraph), id: "00000000-0000-4000-8000-000000000803" },
          ],
        },
      ],
    },
  ];
  const result = await createDocxPackage({ sessionId: "list-indent", document }, new AssetStore());
  const entries = await readZipEntries(result.buffer);
  const xml = entries.get("word/document.xml")?.toString("utf8") ?? "";
  expect(xml).not.toContain("w:firstLine");
  expect(xml).toContain('w:left="840"');
  expect(xml).toContain('w:hanging="280"');
  expect(xml).toContain('<w:tab w:val="left" w:pos="840"/>');
  expect(xml.match(/<w:numPr>/gu)).toHaveLength(1);
});

test.each(["left", "center", "right"] as const)(
  "retains %s alignment when exporting a block formula",
  async (alignment) => {
    const document = createBlankDocument("公式对齐导出");
    document.content = [
      {
        id: "00000000-0000-4000-8000-000000000899",
        type: "block-formula",
        source: "x^2",
        formulaKind: "math",
        alignment,
      },
    ];
    const result = await createDocxPackage(
      { sessionId: "formula-alignment", document },
      new AssetStore(),
    );
    const entries = await readZipEntries(result.buffer);
    const xml = entries.get("word/document.xml")?.toString("utf8");
    if (!xml) throw new Error("Missing DOCX document XML");
    const formulaIndex = xml.indexOf("<m:oMath>");
    const paragraph = xml.slice(
      xml.lastIndexOf("<w:p>", formulaIndex),
      xml.indexOf("</w:p>", formulaIndex),
    );
    expect(paragraph).toContain(`<w:jc w:val="${alignment}"/>`);
  },
);

const imagePreparationMetrics = vi.hoisted(() => ({
  largeImageRunConstructions: 0,
  largePreparedMediaHashes: 0,
  formulaFallbackRenders: 0,
  formulaPreparedMediaHashes: 0,
}));

vi.mock("docx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("docx")>();
  const byteLength = (data: IImageOptions["data"]): number =>
    typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  return {
    ...actual,
    ImageRun: class CountingImageRun extends actual.ImageRun {
      constructor(options: IImageOptions) {
        if (byteLength(options.data) >= 1024 * 1024) {
          imagePreparationMetrics.largeImageRunConstructions += 1;
        }
        super(options);
      }
    },
    hashedId: (data: Parameters<typeof actual.hashedId>[0]) => {
      if (typeof data !== "string" && data.byteLength >= 1024 * 1024) {
        imagePreparationMetrics.largePreparedMediaHashes += 1;
      }
      const binary = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      if (
        typeof binary !== "string" &&
        Buffer.from(binary)
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ) {
        imagePreparationMetrics.formulaPreparedMediaHashes += 1;
      }
      return actual.hashedId(data);
    },
  };
});

vi.mock("./formula-fallback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./formula-fallback.js")>();
  return {
    ...actual,
    renderFormulaFallback: async (source: string) => {
      imagePreparationMetrics.formulaFallbackRenders += 1;
      return actual.renderFormulaFallback(source);
    },
  };
});

async function referenceDocument() {
  return CanonicalDocumentSchema.parse(
    JSON.parse(
      await readFile(
        resolve(process.cwd(), "tests/fixtures/documents/export-reference.json"),
        "utf8",
      ),
    ),
  );
}

async function referenceAssetStore(sessionId: string) {
  const document = await referenceDocument();
  const original = Uint8Array.from(
    await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.png")),
  );
  const assetStore = new AssetStore();
  assetStore.createSession(sessionId);
  const descriptor = document.assets[0];
  if (!descriptor) throw new Error("Reference fixture is missing its image descriptor");
  assetStore.put(sessionId, { descriptor, original, preview: Uint8Array.from(original) });
  return { assetStore, document };
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

describe("canonical DOCX export", () => {
  test("exports a rotated inline image between surrounding text", async () => {
    const sessionId = "docx-inline-image";
    const { assetStore, document } = await referenceAssetStore(sessionId);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    const descriptor = document.assets[0];
    if (paragraph?.type !== "paragraph" || !descriptor) {
      throw new Error("Reference inline image fixture is incomplete");
    }
    paragraph.content = [
      { type: "text", text: "图片前", marks: [] },
      {
        id: "00000000-0000-4000-8000-000000000811",
        type: "inline-figure",
        assetId: descriptor.assetId,
        widthMm: 25,
        alignment: "center",
        rotationDeg: 90,
      },
      { type: "text", text: "图片后", marks: [] },
    ];
    document.content = [paragraph];

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const entries = await readZipEntries(result.buffer);
    const documentXml = entries.get("word/document.xml")?.toString("utf8") ?? "";
    const extent = documentXml.match(/<wp:extent cx="(\d+)" cy="(\d+)"/u);
    const expectedWidthPx = millimetresToPixels(25);
    const expectedHeightPx = millimetresToPixels(25 * (descriptor.widthPx / descriptor.heightPx));

    expect(documentXml).toContain("图片前");
    expect(documentXml).toContain("图片后");
    expect(documentXml.match(/<w:drawing>/gu)).toHaveLength(1);
    expect(extent?.slice(1)).toEqual([
      String(expectedWidthPx * 9525),
      String(expectedHeightPx * 9525),
    ]);
    expect([...entries.keys()].some((name) => /^word\/media\/.*\.png$/u.test(name))).toBe(true);
    const media = [...entries.entries()].find(([name]) =>
      /^word\/media\/.*\.png$/u.test(name),
    )?.[1];
    if (!media) throw new Error("Missing rotated media");
    expect(await sharp(media).metadata()).toMatchObject({
      width: descriptor.heightPx,
      height: descriptor.widthPx,
    });
    expect(documentXml).not.toContain('rot="5400000"');
    expect(result.issues).toEqual([]);
  });

  test("embeds inline and block chemical equations as PNG graphics with preserved-source warnings", async () => {
    const sessionId = "docx-chemical-equations";
    const { assetStore, document } = await referenceAssetStore(sessionId);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    paragraph.content.push({
      type: "inline-formula",
      source: String.raw`\ce{[Fe(CN)6]^3- + e^- -> [Fe(CN)6]^4-}`,
      formulaKind: "chemistry",
    });
    document.content.push({
      id: "00000000-0000-4000-8000-000000000824",
      type: "block-formula",
      source: String.raw`\ce{^{14}_{6}C -> ^{14}_{7}N + e^- + \bar{\nu}_e}`,
      formulaKind: "chemistry",
    });

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const entries = await readZipEntries(result.buffer);
    const documentXml = entries.get("word/document.xml")?.toString("utf8") ?? "";
    const pngMedia = [...entries.entries()].filter(([name]) =>
      /^word\/media\/.*\.png$/u.test(name),
    );

    expect(documentXml).not.toContain("<m:oMath>");
    expect(documentXml.match(/<w:drawing>/gu)).toHaveLength(3);
    expect(pngMedia).toHaveLength(3);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "CHEMISTRY_RENDERED_AS_IMAGE",
        nodeId: paragraph.id,
      }),
      expect.objectContaining({
        code: "CHEMISTRY_RENDERED_AS_IMAGE",
        nodeId: "00000000-0000-4000-8000-000000000824",
      }),
    ]);
  });

  test.each([12, 1600])(
    "exports a chemical structure (%i px) as a 300 DPI JPEG and fails when its preview is missing or corrupt",
    async (intrinsicWidth) => {
      const sessionId = "docx-chemical-structure";
      const { assetStore, document } = await referenceAssetStore(sessionId);
      document.content = document.content.filter((node) => node.type !== "figure");
      const preview = Uint8Array.from(
        await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.png")),
      );
      const original = Uint8Array.from(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${intrinsicWidth}" height="${(intrinsicWidth * 2) / 3}"><path d="M1 4h10" stroke="#000"/></svg>`,
          "utf8",
        ),
      );
      const previewAssetId = "00000000-0000-4000-8000-000000000825";
      assetStore.put(sessionId, {
        descriptor: {
          assetId: previewAssetId,
          kind: "chemical-preview",
          originalName: "structure.svg",
          mediaType: "image/svg+xml",
          extension: "svg",
          byteLength: original.byteLength,
          sha256: "A".repeat(64),
          widthPx: 32,
          heightPx: 24,
          previewByteLength: preview.byteLength,
          previewSha256: "B".repeat(64),
        },
        original,
        preview,
      });
      document.content.push({
        id: "00000000-0000-4000-8000-000000000826",
        type: "chemical-structure",
        ketSource: '{"root":{"nodes":[]}}',
        previewAssetId,
        widthMm: 40,
        alignment: "right",
      });

      const result = await createDocxPackage({ sessionId, document }, assetStore);
      const entries = await readZipEntries(result.buffer);
      const jpegMedia = [...entries.entries()].filter(([name]) =>
        /^word\/media\/.*\.jpg$/u.test(name),
      );
      expect(jpegMedia).toHaveLength(1);
      const jpegMetadata = await sharp(jpegMedia[0]?.[1]).metadata();
      expect(jpegMetadata).toMatchObject({
        format: "jpeg",
        density: 300,
        width: Math.round((40 * 300) / 25.4),
        height: Math.round(((40 * 8) / 12 / 25.4) * 300),
      });
      const corner = await sharp(jpegMedia[0]?.[1])
        .extract({ left: 471, top: 314, width: 1, height: 1 })
        .raw()
        .toBuffer();
      expect([...corner.subarray(0, 3)]).toEqual([255, 255, 255]);
      expect([...entries.keys()].some((name) => /^word\/media\/.*\.png$/u.test(name))).toBe(false);

      const corruptStore = new AssetStore();
      corruptStore.createSession(sessionId);
      const referenceDescriptor = document.assets[0];
      if (!referenceDescriptor) throw new Error("Reference asset descriptor is missing");
      corruptStore.put(sessionId, {
        descriptor: referenceDescriptor,
        original: preview,
        preview,
      });
      corruptStore.put(sessionId, {
        descriptor: {
          assetId: previewAssetId,
          kind: "image",
          originalName: "structure-preview.png",
          mediaType: "image/png",
          extension: "png",
          byteLength: preview.byteLength,
          sha256: "A".repeat(64),
          widthPx: 32,
          heightPx: 24,
          previewByteLength: 4,
          previewSha256: "B".repeat(64),
        },
        original: preview,
        preview: Uint8Array.from([0, 1, 2, 3]),
      });
      await expect(createDocxPackage({ sessionId, document }, corruptStore)).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            severity: "error",
            code: "MISSING_ASSET",
            nodeId: "00000000-0000-4000-8000-000000000826",
          }),
        ],
      });

      const missingDocument = structuredClone(document);
      const structure = missingDocument.content.find((node) => node.type === "chemical-structure");
      if (structure?.type !== "chemical-structure")
        throw new Error("Chemical structure is missing");
      structure.previewAssetId = "00000000-0000-4000-8000-000000000899";
      await expect(
        createDocxPackage({ sessionId, document: missingDocument }, assetStore),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            severity: "error",
            code: "MISSING_ASSET",
            nodeId: structure.id,
          }),
        ],
      });
    },
  );

  test("keeps multi-issue failure summaries within the preload contract limit", () => {
    const issues = Array.from({ length: 12 }, (_, index) => ({
      severity: "error" as const,
      code: "MISSING_ASSET" as const,
      nodeId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      message: `附图资源不存在：${"missing-asset".repeat(4)}-${index}`,
    }));

    const error = new DocxExportError(issues);

    expect(error.message.length).toBeLessThanOrEqual(500);
    expect(error.issues).toEqual(issues);
  });

  test("maps supported text, figures, tables, and page settings to local OOXML", async () => {
    const sessionId = "docx-export-test";
    const { assetStore, document } = await referenceAssetStore(sessionId);
    const table = document.content.find((node) => node.type === "table");
    if (table?.type !== "table") throw new Error("Reference table is missing");
    table.headerRowCount = 1;
    const firstCell = table.rows[0]?.cells[0];
    if (!firstCell) throw new Error("Reference table cell is missing");
    firstCell.borderEdges = {
      top: "double",
      right: "none",
      bottom: "single",
      left: "double",
    };

    const result = await createDocxPackage({ sessionId, document }, assetStore);

    expect(result.issues).toEqual([]);
    const entries = await readZipEntries(result.buffer);
    const documentXml = entries.get("word/document.xml")?.toString("utf8");
    const relationshipsXml = entries.get("word/_rels/document.xml.rels")?.toString("utf8");
    const numberingXml = entries.get("word/numbering.xml")?.toString("utf8");
    expect(documentXml).toBeDefined();
    expect(relationshipsXml).toBeDefined();
    expect(numberingXml).toBeDefined();
    if (!documentXml || !relationshipsXml || !numberingXml) return;

    expect(documentXml).toContain('<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/>');
    expect(documentXml).toContain(
      '<w:pgMar w:top="1417" w:right="850" w:bottom="850" w:left="1417"',
    );
    expect(documentXml).toMatch(
      /<w:rFonts (?=[^>]*w:ascii="SimSun")(?=[^>]*w:hAnsi="SimSun")(?=[^>]*w:eastAsia="SimSun")[^>]*\/>/u,
    );
    expect(documentXml).toContain('<w:sz w:val="24"/>');
    expect(documentXml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(documentXml).toContain("<w:b/>");
    expect(documentXml).toContain("<w:i/>");
    expect(documentXml).toContain('<w:u w:val="single"/>');
    expect(documentXml).toContain('<w:vertAlign w:val="subscript"/>');
    expect(documentXml).toContain('<w:vertAlign w:val="superscript"/>');
    expect(documentXml).toContain('<w:color w:val="1A2B3C"/>');
    expect(documentXml).toContain('<w:jc w:val="both"/>');
    expect(documentXml).toContain('<w:ind w:firstLine="567"/>');
    expect(documentXml).toContain('<w:br w:type="page"/>');
    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>');
    expect(documentXml).toContain("<w:tblHeader/>");
    expect(documentXml).toMatch(/<w:right\b(?=[^>]*w:val="none")[^>]*\/>/u);
    expect(documentXml).toContain('<w:gridSpan w:val="2"/>');
    expect(documentXml).toContain('<w:vMerge w:val="restart"/>');
    expect(documentXml).toContain('<w:vMerge w:val="continue"/>');
    expect(numberingXml).toContain('<w:numFmt w:val="bullet"/>');
    expect(numberingXml).toContain('<w:numFmt w:val="decimal"/>');
    expect(documentXml.match(/<w:numPr>/gu)).toHaveLength(2);

    expect(relationshipsXml).toContain(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    );
    expect(relationshipsXml).not.toMatch(/TargetMode=["']External["']/u);
    expect([...entries.keys()].some((name) => /^word\/media\/.*\.png$/u.test(name))).toBe(true);

    const drawingEnd = documentXml.indexOf("</w:drawing>");
    expect(drawingEnd).toBeGreaterThan(-1);
    expect(documentXml).not.toContain("图 1 参考附图");
  });

  test("maps explicit table row heights and rules to OOXML", async () => {
    const sessionId = "docx-table-row-height-test";
    const { assetStore, document } = await referenceAssetStore(sessionId);
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
    cell.paddingMm = { top: 1, right: 3, bottom: 1.5, left: 0 };
    cell.content[0].attrs.lineSpacing = 1.15;
    cell.content[0].attrs.spaceBeforePt = 0;
    cell.content[0].attrs.spaceAfterPt = 6;

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const entries = await readZipEntries(result.buffer);
    const documentXml = entries.get("word/document.xml")?.toString("utf8");

    expect(documentXml).toContain('<w:trHeight w:val="720" w:hRule="exact"/>');
    expect(documentXml).toContain('<w:trHeight w:val="567" w:hRule="atLeast"/>');
    expect(documentXml?.match(/<w:top w:type="dxa" w:w="57"\/>/gu)).toHaveLength(2);
    expect(documentXml).toContain('w:after="120"');
    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(result.buffer, "table.docx"),
    );
    const imported = parsed.blocks.find((block) => block.type === "table");
    if (imported?.type !== "table") throw new Error("Missing imported table");
    expect(imported.rows[0]?.cells[0]?.paddingMm?.right).toBeCloseTo(3, 1);
    expect(imported.rows[0]?.cells[0]?.paragraphs[0]).toMatchObject({
      lineSpacing: 1.15,
      spaceAfterPt: 6,
    });
  });

  test("maps text highlight to character shading", async () => {
    const sessionId = "docx-highlight-test";
    const { assetStore, document } = await referenceAssetStore(sessionId);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    paragraph.content = [
      { type: "text", text: "突出显示", marks: [{ type: "background-color", value: "#FFF2CC" }] },
    ];

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const entries = await readZipEntries(result.buffer);
    const documentXml = entries.get("word/document.xml")?.toString("utf8");

    expect(documentXml).toBeDefined();
    expect(documentXml).toMatch(/<w:shd[^>]*w:fill="FFF2CC"[^>]*\/>/u);
    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(result.buffer, "highlight.docx"),
    );
    const imported = convertParsedWordDocument(parsed, { title: "往返", mode: "auxiliary" });
    const restored = imported.document.content.find(
      (node) =>
        node.type === "paragraph" &&
        node.content.some((inline) => inline.type === "text" && inline.text === "突出显示"),
    );
    expect(restored?.type === "paragraph" ? restored.content : []).toContainEqual({
      type: "text",
      text: "突出显示",
      marks: expect.arrayContaining([{ type: "background-color", value: "#FFF2CC" }]),
    });
  });

  test("preserves underlined placeholder spaces in DOCX XML", async () => {
    const sessionId = "docx-underlined-space-test";
    const { assetStore, document } = await referenceAssetStore(sessionId);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    paragraph.content = [
      { type: "text", text: "技术方案是", marks: [] },
      { type: "text", text: " ".repeat(6), marks: [{ type: "underline" }] },
      { type: "text", text: "。", marks: [] },
    ];

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const documentXml = (await readZipEntries(result.buffer))
      .get("word/document.xml")
      ?.toString("utf8");

    expect(documentXml).toContain('<w:u w:val="single"/>');
    expect(documentXml).toContain(`<w:t xml:space="preserve">${" ".repeat(6)}</w:t>`);
  });

  test("exports native inline and block formulas while reporting one raster fallback", async () => {
    const sessionId = "docx-formula-test";
    const { assetStore, document } = await referenceAssetStore(sessionId);
    const paragraph = document.content.find((node) => node.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    paragraph.content.push(
      { type: "inline-formula", source: String.raw`\frac{a+b}{c}`, formulaKind: "math" },
      {
        type: "inline-formula",
        source: String.raw`\color{red}{x}`,
        formulaKind: "math",
      },
    );
    const blockId = "00000000-0000-4000-8000-000000000813";
    document.content.push({
      id: blockId,
      type: "block-formula",
      source: String.raw`\sum_{i=1}^{n}x_i`,
      formulaKind: "math",
    });

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const entries = await readZipEntries(result.buffer);
    const documentXml = entries.get("word/document.xml")?.toString("utf8");
    const relationshipsXml = entries.get("word/_rels/document.xml.rels")?.toString("utf8");

    expect(documentXml?.match(/<m:oMath>/gu)).toHaveLength(2);
    expect(documentXml).not.toContain("<undefined>");
    const fractionIndex = documentXml?.indexOf("<m:f>") ?? -1;
    const fractionParagraph = documentXml?.slice(
      documentXml.lastIndexOf("<w:p>", fractionIndex),
      documentXml.indexOf("</w:p>", fractionIndex),
    );
    expect(fractionParagraph).toContain("<m:f>");
    const naryIndex = documentXml?.indexOf("<m:nary>") ?? -1;
    const blockParagraph = documentXml?.slice(
      documentXml.lastIndexOf("<w:p>", naryIndex),
      documentXml.indexOf("</w:p>", naryIndex),
    );
    expect(blockParagraph).toContain('<w:jc w:val="center"/>');
    expect(documentXml).toContain(String.raw`复杂公式（LaTeX）：\color{red}{x}`);
    expect(
      relationshipsXml?.match(
        /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/image"/gu,
      ),
    ).toHaveLength(2);
    expect(relationshipsXml).not.toMatch(/TargetMode=["']External["']/u);
    expect([...entries.keys()].filter((name) => /^word\/media\/.*\.png$/u.test(name))).toHaveLength(
      2,
    );
    expect(result.issues).toEqual([
      {
        severity: "warning",
        code: "FORMULA_RASTERIZED",
        nodeId: paragraph.id,
        message: "公式已转换为图片，无法在 Word 公式编辑器中编辑。",
      },
    ]);
  });

  test("rejects a malformed formula instead of silently exporting a MathJax error image", async () => {
    const document = createBlankDocument("无效公式");
    document.content.push({
      id: "00000000-0000-4000-8000-000000000823",
      type: "block-formula",
      source: String.raw`\frac{a}{`,
      formulaKind: "math",
    });
    const assetStore = new AssetStore();
    assetStore.createSession("invalid-formula");
    await expect(
      createDocxPackage({ sessionId: "invalid-formula", document }, assetStore),
    ).rejects.toThrow(/公式/);
  });

  test("memoizes duplicate raster formulas while keeping placements and node warnings", async () => {
    const document = createBlankDocument("重复公式导出");
    const paragraph = document.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("Blank paragraph is missing");
    paragraph.id = "00000000-0000-4000-8000-000000000820";
    const source = String.raw`\color{red}{x}`;
    paragraph.content = [
      { type: "inline-formula", source, formulaKind: "math" },
      { type: "inline-formula", source, formulaKind: "math" },
    ];
    const blockIds = [
      "00000000-0000-4000-8000-000000000821",
      "00000000-0000-4000-8000-000000000822",
    ] as const;
    document.content.push(
      { id: blockIds[0], type: "block-formula", source, formulaKind: "math" },
      { id: blockIds[1], type: "block-formula", source, formulaKind: "math" },
    );
    const sessionId = "docx-duplicate-formula-test";
    const assetStore = new AssetStore();
    assetStore.createSession(sessionId);
    imagePreparationMetrics.formulaFallbackRenders = 0;
    imagePreparationMetrics.formulaPreparedMediaHashes = 0;

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const entries = await readZipEntries(result.buffer);
    const documentXml = entries.get("word/document.xml")?.toString("utf8");
    const relationshipsXml = entries.get("word/_rels/document.xml.rels")?.toString("utf8");

    expect(imagePreparationMetrics.formulaFallbackRenders).toBe(1);
    expect(imagePreparationMetrics.formulaPreparedMediaHashes).toBe(1);
    expect(documentXml?.match(/<w:drawing>/gu)).toHaveLength(4);
    expect(
      relationshipsXml?.match(
        /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/image"/gu,
      ),
    ).toHaveLength(1);
    expect(result.issues).toHaveLength(3);
    expect(result.issues.map((issue) => issue.nodeId)).toEqual([paragraph.id, ...blockIds]);
    expect(result.issues.every((issue) => issue.code === "FORMULA_RASTERIZED")).toBe(true);
  });

  test("fits a tall raster formula inside both printable page dimensions without distortion", async () => {
    const document = createBlankDocument("超高公式导出");
    const rows = Array.from({ length: 180 }, () => "x").join(String.raw`\\`);
    document.content.push({
      id: "00000000-0000-4000-8000-000000000823",
      type: "block-formula",
      source: `${String.raw`\color{red}{\begin{matrix}`}${rows}${String.raw`\end{matrix}}`}`,
      formulaKind: "math",
    });
    const sessionId = "docx-tall-formula-test";
    const assetStore = new AssetStore();
    assetStore.createSession(sessionId);

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const entries = await readZipEntries(result.buffer);
    const documentXml = entries.get("word/document.xml")?.toString("utf8");
    const extent = documentXml?.match(/<wp:extent cx="(\d+)" cy="(\d+)"/u);
    const png = [...entries.entries()].find(([name]) => /^word\/media\/.*\.png$/u.test(name))?.[1];
    if (!extent?.[1] || !extent[2] || !png) throw new Error("Formula drawing is missing");
    const displayedWidthPx = Number(extent[1]) / 9525;
    const displayedHeightPx = Number(extent[2]) / 9525;
    const metadata = await sharp(png).metadata();
    if (!metadata.width || !metadata.height) throw new Error("Formula PNG dimensions are missing");

    const printableWidthPx = millimetresToPixels(
      document.page.widthMm - document.page.marginLeftMm - document.page.marginRightMm,
    );
    const printableHeightPx = millimetresToPixels(
      document.page.heightMm - document.page.marginTopMm - document.page.marginBottomMm,
    );
    expect(displayedWidthPx).toBeLessThanOrEqual(printableWidthPx);
    expect(displayedHeightPx).toBeLessThanOrEqual(printableHeightPx);
    expect(displayedWidthPx / displayedHeightPx).toBeCloseTo(metadata.width / metadata.height, 2);
  });

  test("prepares one large stored asset once across several rendered widths", async () => {
    const sessionId = "docx-repeated-asset-test";
    const source = await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.png"));
    const original = Uint8Array.from(Buffer.concat([source, Buffer.alloc(1024 * 1024)]));
    const stored = await importImage({ originalName: "large-drawing.png", bytes: original });
    const document = await referenceDocument();
    const figure = document.content.find((node) => node.type === "figure");
    if (figure?.type !== "figure") throw new Error("Reference figure is missing");
    figure.assetId = stored.descriptor.assetId;
    figure.widthMm = 30;
    document.assets = [stored.descriptor];
    document.content.push(
      {
        ...structuredClone(figure),
        id: "00000000-0000-4000-8000-000000000728",
        widthMm: 40,
      },
      {
        ...structuredClone(figure),
        id: "00000000-0000-4000-8000-000000000729",
        widthMm: 50,
      },
    );
    const assetStore = new AssetStore();
    assetStore.createSession(sessionId);
    assetStore.put(sessionId, stored);
    const get = vi.spyOn(assetStore, "get");
    imagePreparationMetrics.largeImageRunConstructions = 0;
    imagePreparationMetrics.largePreparedMediaHashes = 0;

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const entries = await readZipEntries(result.buffer);
    const documentXml = entries.get("word/document.xml")?.toString("utf8");
    const relationshipsXml = entries.get("word/_rels/document.xml.rels")?.toString("utf8");

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(sessionId, figure.assetId);
    expect(imagePreparationMetrics.largeImageRunConstructions).toBe(0);
    expect(imagePreparationMetrics.largePreparedMediaHashes).toBe(1);
    expect(documentXml?.match(/<w:drawing>/gu)).toHaveLength(3);
    const extents = [...(documentXml?.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/gu) ?? [])].map(
      (match) => [match[1], match[2]],
    );
    const expectedExtents = [30, 40, 50].map((widthMm) => {
      const widthPx = millimetresToPixels(widthMm);
      const heightPx = millimetresToPixels(
        widthMm * (stored.descriptor.heightPx / stored.descriptor.widthPx),
      );
      return [(widthPx * 9525).toString(), (heightPx * 9525).toString()];
    });
    expect(extents).toEqual(expectedExtents);
    const relationshipReferences = documentXml?.match(/r:embed="rId\d+"/gu) ?? [];
    expect(relationshipReferences).toHaveLength(3);
    const docPropertyIds = [...(documentXml?.matchAll(/<wp:docPr id="(\d+)"/gu) ?? [])].map(
      (match) => match[1],
    );
    expect(new Set(docPropertyIds).size).toBe(3);
    expect(
      relationshipsXml?.match(
        /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/image"/gu,
      ),
    ).toHaveLength(1);
  });

  test("verifies a temporary sibling package before atomically reporting success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "docx-export-"));
    try {
      const outputPath = join(directory, "reference.docx");
      const sessionId = "docx-save-test";
      const { assetStore, document } = await referenceAssetStore(sessionId);

      const report = await saveDocxToPath(outputPath, { sessionId, document }, assetStore);

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

  test("prevents a success report when a referenced asset is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "docx-export-missing-"));
    try {
      const outputPath = join(directory, "missing.docx");
      const document = await referenceDocument();
      const assetStore = new AssetStore();
      const sessionId = "docx-missing-test";
      assetStore.createSession(sessionId);

      await expect(
        saveDocxToPath(outputPath, { sessionId, document }, assetStore),
      ).rejects.toMatchObject({
        issues: [
          {
            severity: "error",
            code: "MISSING_ASSET",
            nodeId: "00000000-0000-4000-8000-000000000710",
          },
        ],
      });
      await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("embeds TIFF originals with their actual package content type", {
    timeout: 15_000,
  }, async () => {
    const original = Uint8Array.from(
      await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.tiff")),
    );
    const stored = await importImage({ originalName: "drawing.tiff", bytes: original });
    const document = await referenceDocument();
    const figure = document.content.find((node) => node.type === "figure");
    if (figure?.type !== "figure") throw new Error("Reference figure is missing");
    figure.assetId = stored.descriptor.assetId;
    // The AssetStore is the byte/media authority even if renderer metadata is stale.
    const sessionId = "docx-tiff-test";
    const assetStore = new AssetStore();
    assetStore.createSession(sessionId);
    assetStore.put(sessionId, stored);

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const entries = await readZipEntries(result.buffer);
    const mediaEntry = [...entries.entries()].find(([name]) =>
      /^word\/media\/.*\.tiff$/u.test(name),
    );

    expect(mediaEntry?.[1]).toEqual(Buffer.from(original));
    expect(entries.get("[Content_Types].xml")?.toString("utf8")).toContain(
      '<Default Extension="tiff" ContentType="image/tiff"/>',
    );
  });

  test("substitutes fonts outside the DOCX compatibility set and reports the affected node", async () => {
    const sessionId = "docx-font-test";
    const { assetStore, document } = await referenceAssetStore(sessionId);
    const paragraph = document.content.find((node) => node.id.endsWith("702"));
    if (paragraph?.type !== "paragraph") throw new Error("Reference paragraph is missing");
    paragraph.content.push({
      type: "text",
      text: "未知字体",
      marks: [{ type: "font-family", value: "Unsupported Patent Font" }],
    });

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const entries = await readZipEntries(result.buffer);
    const documentXml = entries.get("word/document.xml")?.toString("utf8");

    expect(result.issues).toContainEqual({
      severity: "warning",
      code: "FONT_SUBSTITUTED",
      nodeId: paragraph.id,
      message: "字体“Unsupported Patent Font”已替换为“SimSun”。",
    });
    expect(documentXml).not.toContain("Unsupported Patent Font");
  });

  test("numbers only the first paragraph of each list item", async () => {
    const sessionId = "docx-list-test";
    const { assetStore, document } = await referenceAssetStore(sessionId);
    const list = document.content.find((node) => node.type === "bullet-list");
    if (list?.type !== "bullet-list") throw new Error("Reference list is missing");
    const firstItem = list.items[0];
    const firstParagraph = firstItem?.content[0];
    if (!firstItem || !firstParagraph) throw new Error("Reference list item is missing");
    firstItem.content.push({
      ...structuredClone(firstParagraph),
      id: "00000000-0000-4000-8000-000000000722",
      content: [{ type: "text", text: "同一列表项的续段", marks: [] }],
    });

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const documentXml = (await readZipEntries(result.buffer))
      .get("word/document.xml")
      ?.toString("utf8");

    expect(documentXml).toContain("同一列表项的续段");
    expect(documentXml?.match(/<w:numPr>/gu)).toHaveLength(2);
  });

  test("supports disjoint vertical merges including a trailing continuation", async () => {
    const sessionId = "docx-table-merge-test";
    const { assetStore, document } = await referenceAssetStore(sessionId);
    const table = document.content.find((node) => node.type === "table");
    if (table?.type !== "table") throw new Error("Reference table is missing");
    const first = table.rows[0]?.cells[0];
    const middle = table.rows[1]?.cells[0];
    const last = table.rows[1]?.cells[1];
    if (!first || !middle || !last) throw new Error("Reference table cells are missing");
    table.rows = [
      {
        id: table.rows[0]?.id ?? "00000000-0000-4000-8000-000000000723",
        cells: [
          { ...structuredClone(first), rowSpan: 2 },
          { ...structuredClone(middle), id: "00000000-0000-4000-8000-000000000724" },
          {
            ...structuredClone(last),
            id: "00000000-0000-4000-8000-000000000725",
            rowSpan: 2,
          },
        ],
      },
      {
        id: table.rows[1]?.id ?? "00000000-0000-4000-8000-000000000726",
        cells: [{ ...structuredClone(middle), id: "00000000-0000-4000-8000-000000000727" }],
      },
    ];

    const result = await createDocxPackage({ sessionId, document }, assetStore);
    const documentXml = (await readZipEntries(result.buffer))
      .get("word/document.xml")
      ?.toString("utf8");

    expect(documentXml?.match(/<w:vMerge w:val="restart"\/>/gu)).toHaveLength(2);
    expect(documentXml?.match(/<w:vMerge w:val="continue"\/>/gu)).toHaveLength(2);
  });

  test("rejects table spans that exceed the persisted grid", async () => {
    const sessionId = "docx-table-invalid-test";
    const { assetStore, document } = await referenceAssetStore(sessionId);
    const table = document.content.find((node) => node.type === "table");
    if (table?.type !== "table") throw new Error("Reference table is missing");
    const firstCell = table.rows[0]?.cells[0];
    if (!firstCell) throw new Error("Reference table cell is missing");
    firstCell.colSpan = 4;

    await expect(createDocxPackage({ sessionId, document }, assetStore)).rejects.toMatchObject({
      issues: [
        {
          severity: "error",
          code: "EXPORT_FAILED",
          nodeId: table.id,
        },
      ],
    });
  });
});

test("small text hard breaks inherit the effective size rather than the old paragraph default", async () => {
  const document = createBlankDocument("小字号行距");
  const paragraph = document.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
  paragraph.attrs.defaultFontSizePt = 14;
  paragraph.content = [
    { type: "text", text: "首行", marks: [{ type: "font-size", valuePt: 9 }] },
    { type: "hard-break" },
    { type: "text", text: "次行", marks: [{ type: "font-size", valuePt: 9 }] },
  ];
  const before = structuredClone(document);
  const result = await createDocxPackage({ sessionId: "small-font", document }, new AssetStore());
  const entries = await readZipEntries(result.buffer);
  const xml = entries.get("word/document.xml")?.toString("utf8") ?? "";
  expect(xml).toContain('<w:spacing w:line="360"');
  expect(xml).not.toContain('<w:sz w:val="28"/>');
  expect(xml.match(/<w:sz w:val="18"\/>/g)).toHaveLength(3);
  expect(document).toEqual(before);
});
test("DOCX retains individual cell paragraph alignment, merged widths and derived header emphasis", async () => {
  const { document } = tableRegressionDocument();
  const original = structuredClone(document);
  const result = await createDocxPackage(
    { sessionId: "table-regression", document },
    new AssetStore(),
  );
  const xml =
    (await readZipEntries(result.buffer)).get("word/document.xml")?.toString("utf8") ?? "";
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  const header = paragraphs.find((p) => p.includes("标题甲</w:t>"));
  const note = paragraphs.find((p) => p.includes("标题甲补充"));
  const body = paragraphs.find((p) => p.includes("跨行</w:t>"));
  expect(header).toContain('<w:jc w:val="center"/>');
  expect(note).toContain('<w:jc w:val="right"/>');
  expect(header).toContain("<w:b/>");
  expect(header).toContain("<w:i/>");
  expect(body).toContain('<w:b w:val="false"/>');
  expect(xml).toContain('<w:gridSpan w:val="2"/>');
  expect(xml).toContain('<w:vMerge w:val="restart"/>');
  expect(xml).toContain('<w:vMerge w:val="continue"/>');
  for (const width of [1134, 2268, 3402]) expect(xml).toContain(`<w:gridCol w:w="${width}"/>`);
  expect(document).toEqual(original);
});
