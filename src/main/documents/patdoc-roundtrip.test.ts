import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBlankDocument } from "../../shared/document/defaults.js";
import {
  type AssetDescriptor,
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type ParagraphNode,
  type PatentBookDocument,
  type TextMark,
} from "../../shared/document/model.js";
import { tableRegressionDocument } from "../../shared/document/table-regression-fixture.js";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import {
  CANONICAL_PATENT_FORMAT_VERSION,
  type CanonicalPatent,
  PATENT_BOOK_LABELS,
  PATENT_BOOK_ORDER,
  type PatentBookKind,
} from "../../shared/patent/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { ManifestSchema, type PatdocPayload, type PatentPatdocPayload } from "./patdoc-format.js";
import { probePatdocFormatVersion, readPatdoc } from "./patdoc-reader.js";
import { writePatdoc } from "./patdoc-writer.js";

test("PATDOC preserves merged table widths, annotations, header semantics and independent paragraph formatting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patdoc-table-regression-"));
  const { document } = tableRegressionDocument();
  const payload: PatdocPayload = { document, settings: {}, editorState: {}, assets: [] };
  try {
    const path = join(directory, "table.patdoc");
    await writePatdoc(path, payload);
    expect(await readPatdoc<PatdocPayload>(path)).toEqual(payload);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PATDOC retains formula sizes, colors, text formatting and exact source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patdoc-formula-size-"));
  const document = createBlankDocument("公式字号");
  const paragraph = document.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
  paragraph.attrs.defaultFontFamily = "KaiTi";
  paragraph.attrs.spaceBeforePt = 6;
  paragraph.attrs.spaceAfterPt = 8;
  paragraph.content = [
    {
      type: "text",
      text: "原文，𠮷 αβ",
      marks: [{ type: "font-family", value: "FangSong" }, { type: "bold" }],
    },
    {
      type: "inline-formula",
      source: String.raw`\ce{2H2 + O2 -> 2H2O}`,
      formulaKind: "chemistry",
      fontSizePt: 10.5,
      color: "#123ABC",
    },
  ];
  document.content.push({
    type: "block-formula",
    id: crypto.randomUUID(),
    source: String.raw`\frac{x^2}{2}`,
    formulaKind: "math",
    fontSizePt: 12,
    color: "#FF0000",
    alignment: "right",
  });
  const payload: PatdocPayload = { document, settings: {}, editorState: {}, assets: [] };
  try {
    const path = join(directory, "formula.patdoc");
    await writePatdoc(path, payload);
    expect(await readPatdoc<PatdocPayload>(path)).toEqual(payload);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  "SimSun",
  "FangSong",
  "KaiTi",
  "Source Han Serif CN",
  "HarmonyOS Sans SC",
  "PingFang SC",
])("PATDOC preserves %s and every text code point", async (font) => {
  const directory = await mkdtemp(join(tmpdir(), "patdoc-font-"));
  const document = createBlankDocument("字体保存");
  const paragraph = document.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
  paragraph.attrs.defaultFontFamily = font;
  paragraph.content = [
    { type: "text", text: "正文，ABC 123 αβ，𠮷。", marks: [{ type: "font-family", value: font }] },
  ];
  const payload: PatdocPayload = { document, settings: {}, editorState: {}, assets: [] };
  const path = join(directory, "font.patdoc");
  try {
    await writePatdoc(path, payload);
    expect(await readPatdoc<PatdocPayload>(path)).toEqual(payload);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").toUpperCase();

function paragraph(index: number, text: string, marks: TextMark[] = []): ParagraphNode {
  return {
    id: uuid(index),
    type: "paragraph",
    attrs: {
      alignment: "left",
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 12,
    },
    content: [{ type: "text", text, marks }],
  };
}

function bookDocument(kind: PatentBookKind, index: number, text: string): PatentBookDocument {
  return {
    formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
    documentId: uuid(index),
    title: PATENT_BOOK_LABELS[kind],
    createdAt: "2026-07-31T00:00:00.000Z",
    modifiedAt: "2026-07-31T01:00:00.000Z",
    page: {
      widthMm: 210,
      heightMm: 297,
      marginTopMm: 25,
      marginRightMm: 15,
      marginBottomMm: 15,
      marginLeftMm: 25,
    },
    content: [paragraph(index + 100, text)],
  };
}

async function patentPayload(): Promise<PatentPatdocPayload> {
  const original = Uint8Array.from(
    await readFile(resolve(process.cwd(), "tests/fixtures/images/sample.png")),
  );
  const preview = Uint8Array.from(original);
  const descriptor: AssetDescriptor = {
    assetId: uuid(501),
    kind: "image",
    originalName: "附图.png",
    mediaType: "image/png",
    extension: "png",
    byteLength: original.byteLength,
    sha256: hash(original),
    widthPx: 12,
    heightPx: 8,
    previewByteLength: preview.byteLength,
    previewSha256: hash(preview),
  };
  const patent: CanonicalPatent = {
    formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
    patentId: uuid(500),
    name: "复杂专利",
    customer: null,
    patentType: "invention",
    createdAt: "2026-07-31T00:00:00.000Z",
    modifiedAt: "2026-07-31T01:00:00.000Z",
    revision: 7,
    drawingBooksEnabled: true,
    activeBookKind: "description",
    books: PATENT_BOOK_ORDER.map((kind, index) => ({
      bookId: uuid(510 + index),
      kind,
      document: bookDocument(kind, 520 + index, `${PATENT_BOOK_LABELS[kind]}正文`),
      editorState: { selection: { from: index, to: index } },
      localRevision: 7,
      persistedRevision: 7,
    })),
    auxiliaryDocuments: [],
    docxImportReport: null,
    figures: [{ figureId: uuid(700), assetId: descriptor.assetId, widthMm: 100 }],
    abstractDrawingFigureId: uuid(700),
    assets: [descriptor],

    flowchartProjects: [],
    drawingProjects: [],
    referenceMarks: [],
    referenceMarkSettings: { synchronizedEditingEnabled: false },
  };
  const assets: StoredAsset[] = [{ descriptor, original, preview }];
  return { patent, assets };
}

describe("patdoc package round-trip", () => {
  let directory = "";
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "patdoc-roundtrip-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("preserves a DWG original larger than 50 MiB through export and reimport", async () => {
    const payload = await patentPayload();
    const source = payload.assets[0];
    if (!source) throw new Error("Missing source");
    source.original = new Uint8Array(51 * 1024 * 1024);
    source.original.set(new TextEncoder().encode("AC1032 synthetic source"));
    Object.assign(source.descriptor, {
      kind: "drawing-source",
      mediaType: "image/vnd.dwg",
      extension: "dwg",
      originalName: "large.dwg",
      byteLength: source.original.length,
      sha256: hash(source.original),
    });
    payload.patent.figures = [];
    payload.patent.abstractDrawingFigureId = null;
    const project = drawingProjectFixture(source.descriptor.assetId);
    project.sourceKind = "dwg";
    payload.patent.drawingProjects = [project];
    const path = join(directory, "large-dwg.patdoc");
    await writePatdoc(path, payload);
    const restored = await readPatdoc<PatentPatdocPayload>(path);
    expect(restored.patent.drawingProjects).toEqual(payload.patent.drawingProjects);
    expect(restored.assets[0]?.descriptor).toEqual(source.descriptor);
    const restoredSource = restored.assets[0];
    if (!restoredSource) throw new Error("Missing restored source");
    expect(hash(restoredSource.original)).toBe(hash(source.original));
  }, 15000);

  test("archive accepts a 100 MiB DWG original while retaining limits on other originals and previews", () => {
    const asset = {
      assetId: uuid(501),
      original: `assets/${uuid(501)}/original.dwg`,
      preview: `assets/${uuid(501)}/preview.png`,
      originalSha256: "A".repeat(64),
      originalByteLength: 100 * 1024 * 1024,
      previewSha256: "A".repeat(64),
      previewByteLength: 1,
    };
    expect(ManifestSchema.shape.assets.safeParse([asset]).success).toBe(true);
    expect(
      ManifestSchema.shape.assets.safeParse([
        { ...asset, originalByteLength: asset.originalByteLength + 1 },
      ]).success,
    ).toBe(false);
    expect(
      ManifestSchema.shape.assets.safeParse([
        { ...asset, original: asset.original.replace(".dwg", ".png") },
      ]).success,
    ).toBe(false);
    expect(
      ManifestSchema.shape.assets.safeParse([{ ...asset, previewByteLength: 50 * 1024 * 1024 + 1 }])
        .success,
    ).toBe(false);
  });

  test("preserves explicit table spacing and margins without introducing them on legacy cells", async () => {
    const payload = await patentPayload();
    const book = payload.patent.books[1];
    if (!book) throw new Error("Missing book");
    const p = paragraph(951, "单元格");
    p.attrs = {
      ...p.attrs,
      lineSpacing: 1.15,
      spaceBeforePt: 0,
      spaceAfterPt: 6,
    };
    book.document.content = [
      {
        id: uuid(952),
        type: "table",
        columnWidthsMm: [40, 90],
        layoutMode: "fixed",
        rows: [
          {
            id: uuid(953),
            cells: [
              {
                id: uuid(954),
                rowSpan: 1,
                colSpan: 1,
                horizontalAlignment: "left",
                verticalAlignment: "top",
                borderStyle: "single",
                paddingMm: { top: 1, right: 3, bottom: 0, left: 2 },
                content: [p],
              },
              {
                id: uuid(955),
                rowSpan: 1,
                colSpan: 1,
                horizontalAlignment: "left",
                verticalAlignment: "top",
                borderStyle: "single",
                content: [paragraph(956, "旧默认")],
              },
            ],
          },
        ],
      },
    ];
    const path = join(directory, "table-format.patdoc");
    await writePatdoc(path, payload);
    const restored = await readPatdoc<PatentPatdocPayload>(path);
    expect(restored.patent.books[1]?.document).toEqual(book.document);
  });

  test.each([false, true])(
    "preserves optional table annotations and their visibility %s",
    async (enabled) => {
      const payload = await patentPayload();
      const book = payload.patent.books[1]!;
      book.document.content = [
        {
          id: uuid(960),
          type: "table",
          columnWidthsMm: [40],
          tableNameEnabled: enabled,
          tableName: "测试结果",
          tableNoteEnabled: enabled,
          tableNote: "均值\n单位：秒",
          rows: [
            {
              id: uuid(961),
              cells: [
                {
                  id: uuid(962),
                  rowSpan: 1,
                  colSpan: 1,
                  horizontalAlignment: "left",
                  verticalAlignment: "top",
                  borderStyle: "single",
                  content: [paragraph(963, "数据")],
                },
              ],
            },
          ],
        },
      ];
      const path = join(directory, "table-annotations.patdoc");
      await writePatdoc(path, payload);
      const restored = await readPatdoc<PatentPatdocPayload>(path);
      expect(restored.patent.books[1]?.document).toEqual(book.document);
    },
  );

  test.each([undefined, "left", "center", "right"] as const)(
    "preserves formula alignment %s across PATDOC write and reopen",
    async (alignment) => {
      const payload = await patentPayload();
      const claims = payload.patent.books.find((book) => book.kind === "claims");
      if (!claims) throw new Error("Missing claims book");
      claims.document.content = [
        {
          id: uuid(900),
          type: "block-formula",
          source: String.raw`\frac{x^2}{2}`,
          formulaKind: "math",
          ...(alignment ? { alignment } : {}),
        },
      ];
      const path = join(directory, "formula-alignment.patdoc");
      await writePatdoc(path, payload);
      const restored = await readPatdoc<PatentPatdocPayload>(path);
      expect(
        restored.patent.books.find((book) => book.kind === "claims")?.document.content,
      ).toEqual(claims.document.content);
    },
  );

  test("preserves the whole patent, five books, and resource bytes", async () => {
    const payload = await patentPayload();
    payload.patent.drawingProjects = [
      drawingProjectFixture(
        payload.patent.figures[0]?.assetId ?? "00000000-0000-4000-8000-000000000001",
      ),
    ];
    payload.patent.drawingProjects[0]!.nextLabel = "43";
    payload.patent.drawingProjects[0]!.repeatLabel = true;
    const region = payload.patent.drawingProjects[0]!.regions[0]!;
    region.output = {
      widthMm: 95,
      dpi: 600,
      mode: "uniform",
      labelHeightMm: 3.5,
      leaderWidthMm: 0.18,
    };
    region.bodyNodeId = uuid(902);
    region.bodyAssetId = payload.patent.figures[0]!.assetId;
    payload.patent.figures = payload.patent.figures.map((figure) => ({
      ...figure,
      rotationDeg: 90,
    }));
    const path = join(directory, "complex.patdoc");

    await writePatdoc(path, payload);
    const restored = await readPatdoc<PatentPatdocPayload>(path);

    expect(restored.patent).toEqual(payload.patent);
    expect(restored.patent.books.map((book) => book.kind)).toEqual(PATENT_BOOK_ORDER);
    expect(restored.assets).toEqual(payload.assets);
  });

  test("preserves a pending reference-mark review across save and reopen", async () => {
    const payload = await patentPayload();
    const referenceMarkId = uuid(750);
    payload.patent.referenceMarks = [{ referenceMarkId, number: 2, keyword: "新箱体" }];
    payload.patent.referenceMarkSettings = {
      synchronizedEditingEnabled: true,
      pendingReview: {
        referenceMarkId,
        ownerBookKind: "description",
        previousNumber: 1,
        previousKeyword: "箱体",
        number: 2,
        keyword: "新箱体",
        counts: { claims: 2, description: 3, abstract: 1 },
        createdAt: "2026-09-01T01:02:03.000Z",
      },
    };
    const path = join(directory, "pending-reference-review.patdoc");

    await writePatdoc(path, payload);
    const restored = await readPatdoc<PatentPatdocPayload>(path);

    expect(restored.patent.referenceMarkSettings.pendingReview).toEqual(
      payload.patent.referenceMarkSettings.pendingReview,
    );
  });

  test("writes version 9 manifests", async () => {
    const path = join(directory, "version-8.patdoc");

    await writePatdoc(path, await patentPayload());

    await expect(probePatdocFormatVersion(path)).resolves.toEqual({
      kind: "current",
      version: "9",
    });
  });

  test("preserves disabled drawing-book state in a PATDOC round-trip", async () => {
    const payload = await patentPayload();
    payload.patent.drawingBooksEnabled = false;
    payload.patent.activeBookKind = "description";
    payload.patent.figures = [];
    payload.patent.abstractDrawingFigureId = null;
    const path = join(directory, "drawings-disabled.patdoc");

    await writePatdoc(path, payload);
    const restored = await readPatdoc<PatentPatdocPayload>(path);

    expect(restored.patent.drawingBooksEnabled).toBe(false);
    expect(restored.patent.activeBookKind).toBe("description");
  });

  test("preserves a standalone document in a PATDOC round-trip", async () => {
    const path = join(directory, "standalone.patdoc");
    const patentArchive = await patentPayload();
    const document = createBlankDocument("独立文档");
    document.assets = patentArchive.assets.map((asset) => asset.descriptor);
    const payload: PatdocPayload = {
      document,
      settings: { spellcheck: true },
      editorState: { selection: { anchor: 1, head: 1 } },
      assets: patentArchive.assets,
    };

    await writePatdoc(path, payload);
    const restored = await readPatdoc<PatdocPayload>(path);

    expect(restored).toEqual(payload);
  });

  test("preserves claim reference review semantics in a PATDOC round-trip", async () => {
    const payload = await patentPayload();
    const claims = payload.patent.books.find((book) => book.kind === "claims");
    if (!claims) throw new Error("claims book missing");
    claims.document.content = [
      {
        ...paragraph(900, "根据权利要求2所述的装置"),
        content: [
          { type: "text", text: "根据权利要求", marks: [] },
          {
            type: "text",
            text: "2",
            marks: [{ type: "claim-reference-review" }],
          },
          { type: "text", text: "所述的装置", marks: [] },
        ],
      },
    ];
    const path = join(directory, "review-mark.patdoc");

    await writePatdoc(path, payload);
    const restored = await readPatdoc<PatentPatdocPayload>(path);
    const restoredClaims = restored.patent.books.find((book) => book.kind === "claims");

    expect(restoredClaims?.document.content[0]).toMatchObject({
      type: "paragraph",
      content: expect.arrayContaining([
        expect.objectContaining({
          text: "2",
          marks: [{ type: "claim-reference-review" }],
        }),
      ]),
    });
  });
});
