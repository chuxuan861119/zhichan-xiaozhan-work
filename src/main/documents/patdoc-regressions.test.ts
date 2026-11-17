import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import yauzl from "yauzl";
import yazl from "yazl";
import { createPatdocFidelityPayload } from "../../../tests/fixtures/patdoc-fidelity.js";
import { createBlankDocument } from "../../shared/document/defaults.js";
import type { BlockNode, InlineFigureNode, ParagraphNode } from "../../shared/document/model.js";
import { CanonicalPatentSchema } from "../../shared/patent/model.js";
import { AssetStore } from "../library/asset-store.js";
import type { LibraryDatabase } from "../library/library-database.js";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import { LibraryService } from "../library/library-service.js";
import { importPatdocPayload } from "../library/register-library-ipc.js";
import { FileService } from "./file-service.js";
import { MAX_JSON_BYTES, type PatdocPayload, type PatentPatdocPayload } from "./patdoc-format.js";
import { readPatdoc } from "./patdoc-reader.js";
import { writePatdoc } from "./patdoc-writer.js";

vi.mock("electron", () => ({ dialog: {}, ipcMain: {}, BrowserWindow: {} }));

const roots: string[] = [];
const databases: LibraryDatabase[] = [];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").toUpperCase();

function requireFixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Incomplete test fixture");
  return value;
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patdoc-regression-"));
  roots.push(root);
  return root;
}

async function services() {
  const root = await createRoot();
  const prepared = await new LibraryMigrationService(root).prepare();
  if (prepared.status !== "ready") throw new Error("Synthetic library unavailable");
  databases.push(prepared.database);
  return {
    database: prepared.database,
    library: new LibraryService({ database: prepared.database }),
    assetStore: new AssetStore({ root, database: prepared.database }),
  };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function wrapParagraph(paragraph: ParagraphNode, context: string): BlockNode {
  switch (context) {
    case "heading":
      return { ...paragraph, type: "heading", level: 1 };
    case "list":
      return {
        id: randomUUID(),
        type: "bullet-list",
        items: [{ id: randomUUID(), content: [paragraph] }],
      };
    case "table":
      return {
        id: randomUUID(),
        type: "table",
        columnWidthsMm: [60],
        rows: [
          {
            id: randomUUID(),
            cells: [
              {
                id: randomUUID(),
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
      };
    default:
      return paragraph;
  }
}

async function rewriteArchiveJson<T>(
  source: string,
  target: string,
  entryName: string,
  mutate: (value: T) => void,
): Promise<void> {
  const entries = await new Promise<Map<string, Buffer>>((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("Missing archive"));
      const result = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(result));
      zip.on("entry", (entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error ?? new Error("Missing entry"));
          const chunks: Buffer[] = [];
          stream.on("error", reject);
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            result.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    });
  });
  const value: T = JSON.parse(requireFixture(entries.get(entryName)).toString("utf8"));
  mutate(value);
  const updated = Buffer.from(`${JSON.stringify(value)}\n`);
  entries.set(entryName, updated);
  const manifest = JSON.parse(requireFixture(entries.get("manifest.json")).toString("utf8"));
  const reference = entryName === "patent.json" ? manifest.patent : manifest.document;
  Object.assign(reference, { sha256: hash(updated), byteLength: updated.length });
  entries.set("manifest.json", Buffer.from(`${JSON.stringify(manifest)}\n`));
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = createWriteStream(target, { flags: "wx" });
    output.on("error", reject);
    output.on("close", resolve);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(output);
    for (const [path, bytes] of entries) zip.addBuffer(bytes, path);
    zip.end();
  });
}

test("single-document PATDOC reports its valid archive type instead of corruption", async () => {
  const path = join(await createRoot(), "standalone.patdoc");
  const files = new FileService();
  expect(
    (
      await files.saveDocument(path, {
        document: createBlankDocument("合法独立文档"),
        settings: {},
        editorState: {},
        assets: [],
      })
    ).ok,
  ).toBe(true);
  expect((await files.openDocument(path)).ok).toBe(true);
  expect(await files.openPatent(path)).toMatchObject({
    ok: false,
    error: { code: "PATDOC_DOCUMENT_ONLY", message: expect.stringContaining("单文档") },
  });
});

test.each(["paragraph", "heading", "list", "table"])(
  "standalone import independently copies conflicting inline images in %s and editor state",
  async (context) => {
    const { database, library, assetStore } = await services();
    const fixture = await createPatdocFidelityPayload();
    const archived = requireFixture(fixture.assets[0]);
    const existing = await library.create("已有图片");
    const replacement = randomUUID();
    archived.descriptor.assetId = replacement;
    await assetStore.install(
      { kind: "library-document", libraryDocumentId: existing.libraryDocumentId },
      { ...archived, descriptor: { ...archived.descriptor, assetId: replacement } },
    );
    const document = createBlankDocument("带行内图片的文档");
    document.assets = [archived.descriptor];
    const paragraph = document.content[0] as ParagraphNode;
    paragraph.content = [
      {
        type: "inline-figure",
        id: randomUUID(),
        assetId: archived.descriptor.assetId,
        widthMm: 30,
        alignment: "center",
      },
    ];
    document.content = [wrapParagraph(paragraph, context)];
    const imported = await importPatdocPayload(library, assetStore, {
      document,
      settings: {},
      assets: [archived],
      editorState: {
        selection: { from: 1, to: 1 },
        scrollTop: 123,
        content: [{ attrs: { assetId: archived.descriptor.assetId } }],
      },
    });
    const ownId = requireFixture(imported.document.assets[0]).assetId;
    expect(ownId).not.toBe(replacement);
    expect(imported.document.assets.map((asset) => asset.assetId)).toEqual([ownId]);
    expect(JSON.stringify(imported.document.content)).toContain(ownId);
    expect(JSON.stringify(imported.document.content)).not.toContain(archived.descriptor.assetId);
    expect(imported.editorState).toEqual({
      selection: { from: 1, to: 1 },
      scrollTop: 123,
      content: [{ attrs: { assetId: ownId } }],
    });
    // A fresh service must read persisted state, not an importer-only/session-only value.
    expect(
      (await new LibraryService({ database }).open(imported.libraryDocumentId)).editorState,
    ).toEqual(imported.editorState);
    expect((await assetStore.readAsset(ownId)).original).toEqual(archived.original);
    expect((await assetStore.readAsset(replacement)).preview).toEqual(archived.preview);
  },
);

test("standalone import without assets persists state across edits and reopen", async () => {
  const { database, library, assetStore } = await services();
  const document = createBlankDocument("编辑状态保存");
  const paragraph = document.content[0] as ParagraphNode;
  paragraph.content = [{ type: "text", text: "原正文", marks: [] }];
  const editorState = { selection: { from: 2, to: 2 }, scrollTop: 123 };
  const imported = await importPatdocPayload(library, assetStore, {
    document,
    settings: {},
    editorState,
    assets: [],
  });
  expect(imported.editorState).toEqual(editorState);
  expect(
    (await new LibraryService({ database }).open(imported.libraryDocumentId)).editorState,
  ).toEqual(editorState);
  const nextState = { selection: { from: 4, to: 4 }, scrollTop: 246 };
  await library.applyEdit({
    libraryDocumentId: imported.libraryDocumentId,
    sessionId: imported.sessionId,
    operationId: randomUUID(),
    baseRevision: 0,
    targetRevision: 1,
    modelVersion: 1,
    editorState: nextState,
    operations: [
      {
        type: "put-block",
        index: 0,
        block: { ...paragraph, content: [{ type: "text", text: "新正文", marks: [] }] },
      },
    ],
  });
  expect(
    (await new LibraryService({ database }).open(imported.libraryDocumentId)).editorState,
  ).toEqual(nextState);
});

test.each(["book", "auxiliary"])(
  "patent validation rejects missing and duplicate inline images in every %s context",
  async (scope) => {
    for (const context of ["paragraph", "heading", "list", "table"]) {
      const payload = await createPatdocFidelityPayload();
      const target =
        scope === "book"
          ? requireFixture(payload.patent.books[1]).document
          : requireFixture(payload.patent.auxiliaryDocuments[0]).document;
      const paragraph = createBlankDocument("行内图片校验").content[0] as ParagraphNode;
      const image: InlineFigureNode = {
        type: "inline-figure",
        id: randomUUID(),
        assetId: randomUUID(),
        widthMm: 30,
        alignment: "center",
      };
      paragraph.content = [image];
      target.content = [wrapParagraph(paragraph, context)];
      expect(
        CanonicalPatentSchema.safeParse(payload.patent).success,
        `${scope}/${context}: missing`,
      ).toBe(false);
      image.assetId = requireFixture(payload.assets[0]).descriptor.assetId;
      expect(
        CanonicalPatentSchema.safeParse(payload.patent).success,
        `${scope}/${context}: valid`,
      ).toBe(true);
      paragraph.content.push({ ...image });
      // wrapParagraph creates a new heading object, so refresh its content after adding the image.
      target.content = [wrapParagraph(paragraph, context)];
      expect(
        CanonicalPatentSchema.safeParse(payload.patent).success,
        `${scope}/${context}: duplicate`,
      ).toBe(false);
    }
  },
);

test("single-document writer rejects entry overflow before creating an archive", async () => {
  const path = join(await createRoot(), "too-many-assets.patdoc");
  const document = createBlankDocument("归档条目边界");
  const bytes = Uint8Array.from(await readFile(resolve("tests/fixtures/images/sample.png")));
  const assets: PatdocPayload["assets"] = Array.from({ length: 2047 }, (_, index) => ({
    descriptor: {
      assetId: randomUUID(),
      kind: "image",
      originalName: `${index}.png`,
      mediaType: "image/png",
      extension: "png",
      byteLength: bytes.length,
      sha256: hash(bytes),
      widthPx: 12,
      heightPx: 8,
      previewByteLength: bytes.length,
      previewSha256: hash(bytes),
    },
    original: bytes,
    preview: bytes,
  }));
  document.assets = assets.map((asset) => asset.descriptor);
  await expect(
    writePatdoc(path, { document, assets, settings: {}, editorState: {} }),
  ).rejects.toMatchObject({ code: "PATDOC_CAPACITY_LIMIT" });
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  // 2046 resources + three JSON entries + manifest = exactly 4096 entries.
  assets.pop();
  document.assets.pop();
  await writePatdoc(path, { document, assets, settings: {}, editorState: {} });
  expect((await readPatdoc<PatdocPayload>(path)).assets).toHaveLength(2046);
}, 20000);

test("single-document writer checks per-resource capacity before opening the target", async () => {
  const path = join(await createRoot(), "oversized-resource.patdoc");
  const preview = Uint8Array.from(
    await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
      .png()
      .toBuffer(),
  );
  const original = new Uint8Array(50 * 1024 * 1024 + 1);
  original.set(preview);
  const descriptor = {
    assetId: randomUUID(),
    kind: "image" as const,
    originalName: "large.png",
    mediaType: "image/png" as const,
    extension: "png" as const,
    byteLength: original.length,
    sha256: hash(original),
    widthPx: 1,
    heightPx: 1,
    previewByteLength: preview.length,
    previewSha256: hash(preview),
  };
  const document = createBlankDocument("资源容量边界");
  document.assets = [descriptor];
  await expect(
    writePatdoc(path, {
      document,
      settings: {},
      editorState: {},
      assets: [{ descriptor, original, preview }],
    }),
  ).rejects.toMatchObject({ code: "PATDOC_CAPACITY_LIMIT" });
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["settings", "editorState"] as const)(
  "single-document writer caps %s JSON",
  async (key) => {
    const path = join(await createRoot(), "oversized-json.patdoc");
    const payload: PatdocPayload = {
      document: createBlankDocument("JSON 容量边界"),
      assets: [],
      settings: {},
      editorState: {},
    };
    payload[key] = { value: "a".repeat(MAX_JSON_BYTES) };
    await expect(writePatdoc(path, payload)).rejects.toMatchObject({
      code: "PATDOC_CAPACITY_LIMIT",
    });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["standalone", "auxiliary"])(
  "reader rejects a checksummed %s archive with a missing inline image",
  async (kind) => {
    const root = await createRoot();
    const source = join(root, "valid.patdoc");
    const target = join(root, "broken.patdoc");
    if (kind === "auxiliary") {
      await writePatdoc(source, await createPatdocFidelityPayload());
    } else {
      await writePatdoc(source, {
        document: createBlankDocument("无资源文档"),
        assets: [],
        settings: {},
        editorState: {},
      });
    }
    await rewriteArchiveJson<PatentPatdocPayload["patent"] | PatdocPayload["document"]>(
      source,
      target,
      kind === "auxiliary" ? "patent.json" : "document.json",
      (value) => {
        const content =
          "auxiliaryDocuments" in value
            ? requireFixture(value.auxiliaryDocuments[0]).document.content
            : value.content;
        (content[0] as ParagraphNode).content.push({
          type: "inline-figure",
          id: randomUUID(),
          assetId: randomUUID(),
          widthMm: 30,
          alignment: "center",
        });
      },
    );
    await expect(readPatdoc(target)).rejects.toMatchObject({ code: "INVALID_ARCHIVE" });
  },
);

test("standalone writer rejects a missing inline image before touching the target", async () => {
  const path = join(await createRoot(), "missing-inline.patdoc");
  const document = createBlankDocument("缺失图片");
  (document.content[0] as ParagraphNode).content = [
    {
      type: "inline-figure",
      id: randomUUID(),
      assetId: randomUUID(),
      widthMm: 30,
      alignment: "center",
    },
  ];
  await expect(
    writePatdoc(path, { document, assets: [], settings: {}, editorState: {} }),
  ).rejects.toMatchObject({ code: "INVALID_ARCHIVE" });
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("imported editor state survives rename, is scoped to its document, and is removed on deletion", async () => {
  const { database, library } = await services();
  const document = createBlankDocument("初始名称");
  (document.content[0] as ParagraphNode).content = [{ type: "text", text: "保留正文", marks: [] }];
  const editorState = { scrollTop: 123, selection: { from: 2, to: 2 } };
  const imported = await library.importDocument(document, undefined, editorState);
  await library.rename({
    libraryDocumentId: imported.libraryDocumentId,
    operationId: randomUUID(),
    expectedRevision: 0,
    title: "新名称",
  });
  const renamed = await library.open(imported.libraryDocumentId);
  expect(renamed.editorState).toEqual(editorState);
  const other = await library.create("其他文档");
  expect((await library.open(other.libraryDocumentId)).editorState).toEqual({});
  await library.release(imported.sessionId);
  await library.release(renamed.sessionId);
  await library.moveToTrash(imported.libraryDocumentId);
  await library.permanentlyDelete(imported.libraryDocumentId);
  expect(
    database.read((db) =>
      db
        .prepare("SELECT value FROM library_state WHERE key = ?")
        .get(`document-editor-state:${imported.libraryDocumentId}`),
    ),
  ).toBeUndefined();
});

test("editor state and document writes roll back together when persistence fails", async () => {
  const { database, library } = await services();
  const imported = await library.importDocument(createBlankDocument("事务原文"), undefined, {
    scrollTop: 10,
  });
  database.transaction((db) =>
    db.exec(
      "CREATE TEMP TRIGGER reject_document_state BEFORE INSERT ON library_state WHEN NEW.key LIKE 'document-editor-state:%' BEGIN SELECT RAISE(ABORT, 'state write failed'); END",
    ),
  );
  await expect(
    library.importDocument(createBlankDocument("不应落库"), undefined, { scrollTop: 20 }),
  ).rejects.toThrow("state write failed");
  await expect(
    library.replaceInitialDocument(imported.libraryDocumentId, createBlankDocument("不应替换"), {
      scrollTop: 30,
    }),
  ).rejects.toThrow("state write failed");
  const paragraph = imported.document.content[0] as ParagraphNode;
  await expect(
    library.applyEdit({
      libraryDocumentId: imported.libraryDocumentId,
      sessionId: imported.sessionId,
      operationId: randomUUID(),
      baseRevision: 0,
      targetRevision: 1,
      modelVersion: 1,
      editorState: { scrollTop: 40 },
      operations: [
        {
          type: "put-block",
          index: 0,
          block: { ...paragraph, content: [{ type: "text", text: "不应写入", marks: [] }] },
        },
      ],
    }),
  ).rejects.toThrow("state write failed");
  const reopened = await library.open(imported.libraryDocumentId);
  expect(reopened.revision).toBe(0);
  expect(reopened.document.content).toEqual(imported.document.content);
  expect(reopened.document.title).toBe("事务原文");
  expect(reopened.editorState).toEqual({ scrollTop: 10 });
  expect(await library.list("active", true)).toHaveLength(1);
});

test("library state persistence is compatible with legacy documents without state", async () => {
  const { database, library } = await services();
  const created = await library.create("旧文档");
  expect(
    (await new LibraryService({ database }).open(created.libraryDocumentId)).editorState,
  ).toEqual({});
});
