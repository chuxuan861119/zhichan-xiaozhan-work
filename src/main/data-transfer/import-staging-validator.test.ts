import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import type { TransferManifest, TransferManifestEntry } from "../../shared/data-transfer/model.js";
import type { AssetDescriptor } from "../../shared/document/model.js";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { writePatdoc } from "../documents/patdoc-writer.js";
import { decodeEnvelope, encodeEnvelope, hashJson } from "../library/edit-journal.js";
import { createLibraryRuntime } from "../library/library-runtime.js";
import { decodeBytes, decodeJson, encodeBytes, encodeJson } from "../library/plaintext-codec.js";
import {
  CURRENT_SCHEMA_VERSION,
  V6_SCIENTIFIC_CHART_STATEMENTS,
  V10_PATENT_TEMPLATE_STATEMENTS,
  validateSchemaV10,
  validateSchemaV11,
  validateSchemaV12,
  validateSchemaV13,
  validateSchemaV14,
} from "../library/schema.js";
import { ImportStagingValidator } from "./import-staging-validator.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function storedAsset(): StoredAsset {
  const original = Uint8Array.from([1, 2, 3, 4]);
  const preview = Uint8Array.from([9, 8, 7]);
  const descriptor: AssetDescriptor = {
    assetId: "22222222-2222-4222-8222-222222222222",
    kind: "image",
    originalName: "polymer-structure.png",
    mediaType: "image/png",
    extension: "png",
    byteLength: original.byteLength,
    sha256: createHash("sha256").update(original).digest("hex").toUpperCase(),
    widthPx: 12,
    heightPx: 8,
    previewByteLength: preview.byteLength,
    previewSha256: createHash("sha256").update(preview).digest("hex").toUpperCase(),
  };
  return { descriptor, original, preview };
}

function documentAsset(): StoredAsset {
  const original = Uint8Array.from([5, 6, 7, 8]);
  const preview = Uint8Array.from([1, 3, 5]);
  const descriptor: AssetDescriptor = {
    assetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    kind: "image",
    originalName: "document-image.png",
    mediaType: "image/png",
    extension: "png",
    byteLength: original.byteLength,
    sha256: createHash("sha256").update(original).digest("hex").toUpperCase(),
    widthPx: 10,
    heightPx: 10,
    previewByteLength: preview.byteLength,
    previewSha256: createHash("sha256").update(preview).digest("hex").toUpperCase(),
  };
  return { descriptor, original, preview };
}

function chemicalAsset(): StoredAsset {
  const original = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><path d="M10 40h100"/></svg>',
  );
  const preview = Uint8Array.from(original);
  const descriptor: AssetDescriptor = {
    assetId: "44444444-4444-4444-8444-444444444444",
    kind: "chemical-preview",
    originalName: "chemical-structure.svg",
    mediaType: "image/svg+xml",
    extension: "svg",
    byteLength: original.byteLength,
    sha256: createHash("sha256").update(original).digest("hex").toUpperCase(),
    widthPx: 120,
    heightPx: 80,
    previewByteLength: preview.byteLength,
    previewSha256: createHash("sha256").update(preview).digest("hex").toUpperCase(),
  };
  return { descriptor, original, preview };
}

async function hash(path: string): Promise<{ bytes: number; sha256: string }> {
  const value = await readFile(path);
  return { bytes: value.byteLength, sha256: createHash("sha256").update(value).digest("hex") };
}

async function manifestEntry(
  root: string,
  logicalPath: string,
  ordinal: number,
): Promise<TransferManifestEntry> {
  const digest = await hash(join(root, ...logicalPath.split("/")));
  return {
    ordinal,
    logicalPath,
    kind:
      logicalPath === "library/library.sqlite3"
        ? "database"
        : logicalPath.startsWith("library/assets/")
          ? "asset"
          : logicalPath.startsWith("legacy-drafts/")
            ? "legacy-draft"
            : logicalPath === "portable-settings.json"
              ? "settings"
              : "verification",
    compression: "stored",
    originalBytes: digest.bytes,
    compressedBytes: digest.bytes,
    sha256: digest.sha256,
    chunkCount: 1,
  };
}

async function fixture(
  unownedAsset = false,
  includeCad = false,
  linkedFlowchart = false,
): Promise<{
  stagingRoot: string;
  key: Buffer;
  manifest: TransferManifest;
  databasePath: string;
}> {
  const stagingRoot = await mkdtemp(join(tmpdir(), "import-validator-"));
  roots.push(stagingRoot);
  const libraryRoot = join(stagingRoot, "library");
  const key = randomBytes(32);
  const runtime = await createLibraryRuntime({
    libraryRoot,
    readOnly: false,
    runRecovery: true,
    startBackgroundSchedulers: true,
  });
  const createdPatent = await runtime.patents.create({
    name: "含化学结构节点",
    patentType: "invention",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  const flowchart = await runtime.flowcharts.create({
    patentId: createdPatent.patentId,
    expectedPatentRevision: 0,
    name: "流程图源",
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    pageCount: 1,
    lastPageId: "p1",
  });

  const chemical = chemicalAsset();
  const installedChemical = await runtime.assetStore.install(
    { kind: "patent", patentId: createdPatent.patentId },
    chemical,
  );
  const image = storedAsset();
  const installedImage = await runtime.assetStore.install(
    { kind: "patent", patentId: createdPatent.patentId },
    image,
  );
  const description = createdPatent.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("description fixture missing");
  const bookEdit = await runtime.patents.applyBookEdit({
    patentId: createdPatent.patentId,
    sessionId: createdPatent.sessionId,
    bookKind: "description",
    expectedRevision: flowchart.patentRevision,
    document: {
      ...description.document,
      content: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          type: "block-formula",
          source: "E = mc^2",
          formulaKind: "math",
        },
        {
          id: "77777777-7777-4777-8777-777777777777",
          type: "block-formula",
          source: String.raw`\ce{2H2 + O2 -> 2H2O}`,
          formulaKind: "chemistry",
        },
        {
          id: "66666666-6666-4666-8666-666666666666",
          type: "chemical-structure",
          ketSource: '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule"}}',
          editorMode: "molecule",
          previewAssetId: installedChemical.descriptor.assetId,
          widthMm: 80,
          alignment: "center",
        },
        {
          id: "88888888-8888-4888-8888-888888888888",
          type: "table",
          columnWidthsMm: [35],
          rows: [
            {
              id: "99999999-9999-4999-8999-999999999999",
              cells: [
                {
                  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                  rowSpan: 1,
                  colSpan: 1,
                  horizontalAlignment: "center",
                  verticalAlignment: "middle",
                  borderStyle: "single",
                  content: [
                    {
                      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                      type: "paragraph",
                      attrs: {
                        alignment: "left",
                        paragraphIndentMm: 0,
                        lineSpacing: 1.5,
                        defaultFontFamily: "SimSun",
                        defaultFontSizePt: 12,
                      },
                      content: [{ type: "text", text: "实验数据", marks: [] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    editorState: {},
    assets: [installedChemical.descriptor, installedImage.descriptor],
  });
  await runtime.patents.applyFigureEdit({
    patentId: createdPatent.patentId,
    sessionId: createdPatent.sessionId,
    expectedRevision: bookEdit.revision,
    ...(includeCad
      ? { drawingProjects: [drawingProjectFixture(installedImage.descriptor.assetId)] }
      : {}),
    figures: [
      {
        figureId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        assetId: installedImage.descriptor.assetId,
        widthMm: 80,
        ...(linkedFlowchart
          ? {
              flowchartLink: {
                projectId: flowchart.project.projectId,
                pageId: "p1",
                exportScope: "page" as const,
                selectedCellIds: [],
                borderMm: 2,
                exportedProjectRevision: flowchart.project.revision,
                exportedSourceSha256: flowchart.project.sourceSha256,
                renderProfileVersion: 1 as const,
              },
            }
          : {}),
      },
    ],
    abstractDrawingFigureId: null,
    assets: [installedChemical.descriptor, installedImage.descriptor],
  });
  const templateEditor = runtime.patentTemplates.openEditor({ patentType: "invention" });
  const templateSlot = templateEditor.catalog.invention.slots[0];
  if (!templateSlot) throw new Error("template slot fixture missing");
  const capturedTemplate = runtime.patentTemplates.capturePatent({
    sessionId: templateEditor.sessionId,
    patentId: createdPatent.patentId,
    expectedPatentRevision: bookEdit.revision + 1,
    targetPatentType: "invention",
    targetTemplateId: templateSlot.templateId,
  });
  templateSlot.name = "含结构式的自定义模板";
  templateSlot.claims = capturedTemplate.claims;
  templateSlot.description = capturedTemplate.description;
  templateSlot.abstract = capturedTemplate.abstract;
  templateEditor.catalog.invention.selection = {
    kind: "custom",
    templateId: templateSlot.templateId,
  };
  await runtime.patentTemplates.saveEditor({
    sessionId: templateEditor.sessionId,
    expectedRevision: templateEditor.catalog.revision,
    catalog: templateEditor.catalog,
    auxiliary: templateEditor.auxiliary,
  });
  runtime.patentTemplates.closeEditor({ sessionId: templateEditor.sessionId });
  await runtime.snapshots.create(createdPatent.patentId, "manual-create");
  const patentForDraft = await runtime.patents.loadForExport({
    patentId: createdPatent.patentId,
    sessionId: createdPatent.sessionId,
    expectedRevision: bookEdit.revision + 1,
  });
  const draftId = "33333333-3333-4333-8333-333333333333";
  const draftFileName = "20260816-000000.patdoc";
  const draftDirectory = join(stagingRoot, "legacy-drafts", draftId);
  await mkdir(draftDirectory, { recursive: true });
  await writePatdoc(join(draftDirectory, draftFileName), {
    patent: patentForDraft,
    assets: [chemical, image],
    flowcharts: patentForDraft.flowchartProjects.map((project) => ({
      projectId: project.projectId,
      source: runtime.flowcharts.exportBackup(createdPatent.patentId, project.projectId),
    })),
  });
  await writeFile(
    join(draftDirectory, "draft.json"),
    `${JSON.stringify({
      draftId,
      documentId: draftId,
      displayName: "历史草稿",
      originalPath: null,
      savedAt: "2026-08-16T00:00:00.000Z",
      fileName: draftFileName,
    })}\n`,
  );
  await runtime.patents.release(createdPatent.sessionId);
  const utilityPatent = await runtime.patents.create({
    name: "实用新型",
    patentType: "utility-model",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await runtime.patents.release(utilityPatent.sessionId);
  const trashedPatent = await runtime.patents.create({
    name: "无附图方法",
    patentType: "invention",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  await runtime.patents.setDrawingBooksEnabled({
    patentId: trashedPatent.patentId,
    sessionId: trashedPatent.sessionId,
    expectedRevision: 0,
    enabled: false,
  });
  await runtime.patents.release(trashedPatent.sessionId);
  await runtime.patents.moveToTrash(trashedPatent.patentId);
  const createdDocument = await runtime.library.create("普通文档");
  expect(createdDocument.sessionId).toBeTruthy();
  const firstDocumentBlock = createdDocument.document.content[0];
  if (firstDocumentBlock?.type !== "paragraph") throw new Error("document fixture missing");
  await runtime.library.applyEdit({
    libraryDocumentId: createdDocument.libraryDocumentId,
    sessionId: createdDocument.sessionId,
    operationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    baseRevision: 0,
    targetRevision: 1,
    modelVersion: 1,
    operations: [
      {
        type: "put-block",
        index: 0,
        block: {
          ...firstDocumentBlock,
          content: [{ type: "text", text: "普通文档修订内容", marks: [] }],
        },
      },
    ],
    editorState: {},
  });
  await runtime.assetStore.install(
    { kind: "library-document", libraryDocumentId: createdDocument.libraryDocumentId },
    documentAsset(),
  );
  const trashedDocument = await runtime.library.create("回收站普通文档");
  const trashedDocumentBlock = trashedDocument.document.content[0];
  if (trashedDocumentBlock?.type !== "paragraph") throw new Error("trash document fixture missing");
  await runtime.library.applyEdit({
    libraryDocumentId: trashedDocument.libraryDocumentId,
    sessionId: trashedDocument.sessionId,
    operationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    baseRevision: 0,
    targetRevision: 1,
    modelVersion: 1,
    operations: [
      {
        type: "put-block",
        index: 0,
        block: {
          ...trashedDocumentBlock,
          content: [{ type: "text", text: "回收站修订内容", marks: [] }],
        },
      },
    ],
    editorState: {},
  });
  await runtime.library.release(trashedDocument.sessionId);
  await runtime.library.moveToTrash(trashedDocument.libraryDocumentId);
  runtime.database.transaction((database) => {
    database
      .prepare("UPDATE patents SET deleted_at = ? WHERE patent_id = ?")
      .run("2020-01-01T00:00:00.000Z", trashedPatent.patentId);
  });
  runtime.database.checkpoint();
  if (unownedAsset)
    runtime.database.transaction((database) => {
      database
        .prepare("DELETE FROM document_assets WHERE asset_id = ?")
        .run(documentAsset().descriptor.assetId);
    });
  await runtime.close();

  await mkdir(join(stagingRoot, "verification"), { recursive: true });
  await writeFile(join(stagingRoot, "verification", "integrity-summary.json"), "{}\n");
  await writeFile(join(stagingRoot, "portable-settings.json"), "{}\n");
  const assetFiles = (await readdir(join(libraryRoot, "assets")))
    .filter((name) => name.endsWith(".asset"))
    .sort();
  if (assetFiles.length !== 4) throw new Error("asset fixtures missing");
  const draftFiles = (await readdir(join(stagingRoot, "legacy-drafts", draftId))).sort();
  const logicalPaths = [
    "library/library.sqlite3",
    ...assetFiles.map((name) => `library/assets/${name}`),
    ...draftFiles.map((name) => `legacy-drafts/${draftId}/${name}`),
    "portable-settings.json",
    "verification/integrity-summary.json",
  ];
  const entries = await Promise.all(
    logicalPaths.map((logicalPath, ordinal) => manifestEntry(stagingRoot, logicalPath, ordinal)),
  );
  const databasePath = join(libraryRoot, "library.sqlite3");
  const databaseSchemaFingerprint = await (async () => {
    const { LibraryDatabase } = await import("../library/library-database.js");
    using database = LibraryDatabase.openReadOnly(databasePath);
    const rows = database.read((connection) =>
      connection
        .prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
        WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`)
        .all(),
    );
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  })();
  const transferableBytes = entries
    .filter((entry) => ["database", "asset", "legacy-draft"].includes(entry.kind))
    .reduce((sum, entry) => sum + entry.originalBytes, 0);
  return {
    stagingRoot,
    key,
    databasePath,
    manifest: {
      packageFormatVersion: 2,
      packageId: "11111111-1111-4111-8111-111111111111",
      exportedByVersion: "1.0.0",
      minimumImporterVersion: "1.0.0",
      databaseSchemaVersion: CURRENT_SCHEMA_VERSION,
      databaseSchemaFingerprint,
      canonicalPatentFormatVersion: 1,
      exportedAt: "2026-08-16T00:00:00.000Z",
      cutoffAt: "2026-08-16T00:00:00.000Z",
      summary: {
        activePatents: 2,
        trashedPatents: 1,
        documents: 2,
        legacyDrafts: 1,
        snapshots: 6,
        assets: 4,
        flowchartProjects: 1,

        totalBytes: transferableBytes,
      },
      entries,
      portableSettingKeys: [],
      excludedMachineSettingCategories: [],
      totalOriginalBytes: entries.reduce((sum, entry) => sum + entry.originalBytes, 0),
      totalChunkCount: entries.length,
      payloadSha256: "0".repeat(64),
    },
  };
}

async function refreshManifestEntry(
  input: Awaited<ReturnType<typeof fixture>>,
  logicalPath: string,
): Promise<void> {
  const existing = input.manifest.entries.find((entry) => entry.logicalPath === logicalPath);
  if (!existing) throw new Error("manifest fixture entry missing");
  const replacement = await manifestEntry(input.stagingRoot, logicalPath, existing.ordinal);
  const entries = input.manifest.entries.map((entry) =>
    entry.logicalPath === logicalPath ? replacement : entry,
  );
  input.manifest = {
    ...input.manifest,
    entries,
    totalOriginalBytes: entries.reduce((sum, entry) => sum + entry.originalBytes, 0),
    totalChunkCount: entries.reduce((sum, entry) => sum + entry.chunkCount, 0),
    summary: {
      ...input.manifest.summary,
      totalBytes: entries
        .filter((entry) => ["database", "asset", "legacy-draft"].includes(entry.kind))
        .reduce((sum, entry) => sum + entry.originalBytes, 0),
    },
  };
}

async function mutateFixtureDatabase(
  input: Awaited<ReturnType<typeof fixture>>,
  mutate: (database: import("node:sqlite").DatabaseSync) => void,
): Promise<void> {
  const { LibraryDatabase } = await import("../library/library-database.js");
  {
    using database = LibraryDatabase.open(input.databasePath);
    database.transaction(mutate);
    database.checkpoint();
  }
  await refreshManifestEntry(input, "library/library.sqlite3");
}

type MutablePatentEdit = {
  operationId: string;
  patentId: string;
  baseRevision: number;
  targetRevision: number;
  storedRevision: number;
  payload: Record<string, unknown>;
};

async function rewriteAuthenticatedPatentEdit(
  input: Awaited<ReturnType<typeof fixture>>,
  order: "first" | "last",
  rewrite: (edit: MutablePatentEdit) => MutablePatentEdit,
): Promise<void> {
  await mutateFixtureDatabase(input, (database) => {
    const row = database
      .prepare(
        `SELECT e.operation_id, e.patent_id, e.base_revision, e.target_revision,
                e.payload, p.revision AS stored_revision
         FROM edit_log e
         JOIN patents p ON p.patent_id = e.patent_id
         ORDER BY e.target_revision ${order === "first" ? "ASC" : "DESC"}
         LIMIT 1`,
      )
      .get() as
      | {
          operation_id: string;
          patent_id: string;
          base_revision: number;
          target_revision: number;
          payload: Uint8Array;
          stored_revision: number;
        }
      | undefined;
    if (!row) throw new Error("patent edit fixture missing");
    const _context = `patent-edit:${row.patent_id}:${row.base_revision}:${row.target_revision}:${row.operation_id}`;
    const payload = decodeJson<Record<string, unknown>>(decodeEnvelope(row.payload));
    const changed = rewrite({
      operationId: row.operation_id,
      patentId: row.patent_id,
      baseRevision: row.base_revision,
      targetRevision: row.target_revision,
      storedRevision: row.stored_revision,
      payload,
    });
    const _nextContext = `patent-edit:${changed.patentId}:${changed.baseRevision}:${changed.targetRevision}:${changed.operationId}`;
    database
      .prepare(
        `UPDATE edit_log
         SET patent_id = ?, base_revision = ?, target_revision = ?, payload = ?, content_hash = ?
         WHERE operation_id = ?`,
      )
      .run(
        changed.patentId,
        changed.baseRevision,
        changed.targetRevision,
        encodeEnvelope(encodeJson(changed.payload)),
        hashJson(changed.payload),
        row.operation_id,
      );
  });
}

async function rewriteAuthenticatedPatentSnapshot(
  input: Awaited<ReturnType<typeof fixture>>,
  where: "revision-zero" | "replayed-revision",
  rewrite: (patent: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await mutateFixtureDatabase(input, (database) => {
    const row = database
      .prepare(
        `SELECT patent_id, revision, model_version, payload
         FROM snapshots
         WHERE ${
           where === "revision-zero"
             ? "revision = 0 AND patent_id = (SELECT patent_id FROM patents WHERE revision = 0 LIMIT 1)"
             : "revision > 0 AND EXISTS (SELECT 1 FROM edit_log e WHERE e.patent_id = snapshots.patent_id AND e.target_revision = snapshots.revision)"
}
         ORDER BY patent_id, revision
         LIMIT 1`,
      )
      .get() as
      | {
          patent_id: string;
          revision: number;
          model_version: number;
          payload: Uint8Array;
        }
      | undefined;
    if (!row) throw new Error("patent snapshot fixture missing");
    const _context = `patent-snapshot:${row.patent_id}:${row.revision}:${row.model_version}`;
    const raw = decodeJson<Record<string, unknown>>(decodeEnvelope(row.payload));
    const patent =
      row.model_version === 3 ? (raw.patent as Record<string, unknown> | undefined) : raw;
    if (!patent) throw new Error("patent snapshot payload missing");
    const nextPatent = rewrite(patent);
    const nextRaw = row.model_version === 3 ? { ...raw, patent: nextPatent } : nextPatent;
    database
      .prepare(
        `UPDATE snapshots SET payload = ?, content_hash = ?
         WHERE patent_id = ? AND revision = ?`,
      )
      .run(encodeEnvelope(encodeJson(nextRaw)), hashJson(nextRaw), row.patent_id, row.revision);
  });
}

async function corruptDocumentAssetBytes(
  input: Awaited<ReturnType<typeof fixture>>,
  target: "original" | "preview",
): Promise<void> {
  const descriptor = documentAsset().descriptor;
  const logicalPath = `library/assets/${descriptor.sha256}.asset`;
  const path = join(input.stagingRoot, ...logicalPath.split("/"));
  const encrypted = await readFile(path);
  const _context = `asset:${descriptor.sha256}:${descriptor.mediaType}:${descriptor.byteLength}`;
  const plain = decodeBytes(decodeEnvelope(encrypted));
  try {
    const source = Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
    const headerLengthOffset = Buffer.byteLength("PATASSET1\n");
    const headerEnd = headerLengthOffset + 4 + source.readUInt32BE(headerLengthOffset);
    const offset = target === "preview" ? headerEnd : headerEnd + descriptor.previewByteLength;
    source[offset] = (source[offset] ?? 0) ^ 0xff;
    await writeFile(path, encodeEnvelope(encodeBytes(plain)));
  } finally {
    plain.fill(0);
  }
  await refreshManifestEntry(input, logicalPath);
}

function validateFixture(input: Awaited<ReturnType<typeof fixture>>) {
  return new ImportStagingValidator().validate(input.stagingRoot, input.manifest);
}

describe("ImportStagingValidator", () => {
  test("validates a published linked flowchart image against its independent document snapshot", async () => {
    const input = await fixture(false, false, true);
    await expect(validateFixture(input)).resolves.toMatchObject({
      activePatents: 2,
      snapshots: 6,
      flowchartProjects: 1,
    });
    input.key.fill(0);
  });
  test("validates full saved CAD alongside document-only snapshots at the same journal revision", async () => {
    const input = await fixture(false, true);
    await expect(validateFixture(input)).resolves.toMatchObject({ activePatents: 2, snapshots: 6 });
    input.key.fill(0);
  });
  test("retains a manifest-declared asset whose owner cleanup was pending at export", async () => {
    const value = await fixture(true);
    await expect(
      new ImportStagingValidator().validate(value.stagingRoot, value.manifest),
    ).resolves.toMatchObject({ assets: value.manifest.summary.assets });
    expect(
      (await readdir(join(value.stagingRoot, "library", "assets"))).filter((name) =>
        name.endsWith(".asset"),
      ),
    ).toHaveLength(value.manifest.summary.assets);
  });
  test("validates schema, every registered domain, resources, manifest, and summary", async () => {
    const input = await fixture();
    const result = await validateFixture(input);
    expect(result).toMatchObject({
      activePatents: 2,
      trashedPatents: 1,
      documents: 2,
      snapshots: 6,
      assets: 4,
      flowchartProjects: 1,
    });
    const afterClose = await hash(input.databasePath);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await hash(input.databasePath)).toEqual(afterClose);
    const { LibraryDatabase } = await import("../library/library-database.js");
    using database = LibraryDatabase.openReadOnly(input.databasePath);
    expect(
      database.read(
        (connection) =>
          (
            connection
              .prepare("SELECT COUNT(*) AS count FROM patents WHERE deleted_at IS NOT NULL")
              .get() as { count: number }
          ).count,
      ),
    ).toBe(1);
    expect(
      database.read(
        (connection) =>
          connection
            .prepare(
              `SELECT s.name, p.selection_kind, COUNT(ta.asset_id) AS asset_count
               FROM patent_template_slots s
               JOIN patent_template_preferences p ON p.selected_template_id = s.template_id
               LEFT JOIN template_assets ta ON ta.template_id = s.template_id
               WHERE s.patent_type = 'invention' AND s.slot_index = 1
               GROUP BY s.name, p.selection_kind`,
            )
            .get() as { name: string; selection_kind: string; asset_count: number },
      ),
    ).toEqual({
      name: "含结构式的自定义模板",
      selection_kind: "custom",
      asset_count: 1,
    });
    input.key.fill(0);
  });

  test("rejects a custom template whose chemical preview ownership link is missing", async () => {
    const input = await fixture();
    await mutateFixtureDatabase(input, (database) => {
      database.prepare("DELETE FROM template_assets").run();
    });
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "template",
    });
    input.key.fill(0);
  });

  test("validates the fixed split library and user-data staging layout", async () => {
    const input = await fixture();
    const userDataRoot = await mkdtemp(join(tmpdir(), "import-validator-user-data-"));
    roots.push(userDataRoot);
    await rename(join(input.stagingRoot, "legacy-drafts"), join(userDataRoot, "legacy-drafts"));
    await rename(
      join(input.stagingRoot, "portable-settings.json"),
      join(userDataRoot, "portable-settings.json"),
    );
    await expect(
      new ImportStagingValidator().validate(
        { libraryRoot: input.stagingRoot, userDataRoot },
        input.manifest,
      ),
    ).resolves.toMatchObject({ activePatents: 2, legacyDrafts: 1 });
    input.key.fill(0);
  });

  test.each([10, 11, 12, 13, 14, CURRENT_SCHEMA_VERSION])(
    "revalidates installed layout after upgrading a version %s backup",
    async (version) => {
      const input = await fixture();
      if (version !== CURRENT_SCHEMA_VERSION) {
        await mutateFixtureDatabase(input, (database) => {
          database.exec("DROP TABLE automation_operations");
          if (version < 14) for (const sql of V6_SCIENTIFIC_CHART_STATEMENTS) database.exec(sql);
          if (version === 10 || version === 11) {
            for (const table of [
              "patent_template_slots",
              "patent_template_preferences",
              "template_assets",
            ]) {
              database.exec(
                `CREATE TEMP TABLE saved_${table} AS SELECT * FROM ${table}${table === "patent_template_slots" ? " WHERE slot_index <= 3" : ""}`,
              );
            }
            for (const table of [
              "template_assets",
              "patent_template_preferences",
              "patent_template_slots",
            ])
              database.exec(`DROP TABLE ${table}`);
            for (const sql of V10_PATENT_TEMPLATE_STATEMENTS) {
              if (!sql.startsWith("CREATE TABLE patent_template_auxiliary")) database.exec(sql);
            }
            for (const table of [
              "patent_template_slots",
              "patent_template_preferences",
              "template_assets",
            ])
              database.exec(`INSERT INTO ${table} SELECT * FROM saved_${table}`);
          }
          if (version === 10 || version === 12) {
            database.exec("DROP TABLE patent_import_reports");
            database.exec("DROP TABLE patent_auxiliary_documents");
          }
          database.exec(
            `UPDATE schema_migrations SET version = ${version} WHERE version = ${CURRENT_SCHEMA_VERSION}`,
          );
          const validateSchema =
            version === 10
              ? validateSchemaV10
              : version === 11
                ? validateSchemaV11
                : version === 12
                  ? validateSchemaV12
                  : version === 13
                    ? validateSchemaV13
                    : validateSchemaV14;
          expect(validateSchema(database)).toEqual({ ok: true });
          const rows = database
            .prepare(
              "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
            )
            .all();
          input.manifest = {
            ...input.manifest,
            databaseSchemaVersion: version,
            databaseSchemaFingerprint: createHash("sha256")
              .update(JSON.stringify(rows))
              .digest("hex"),
          };
        });
        await expect(
          new ImportStagingValidator().validate(input.stagingRoot, input.manifest),
        ).resolves.toMatchObject({ activePatents: 2 });
      }
      const installedParent = await mkdtemp(join(tmpdir(), "import-validator-installed-"));
      const installedRoot = join(installedParent, "Library");
      const userDataRoot = await mkdtemp(join(tmpdir(), "import-validator-installed-user-data-"));
      roots.push(installedParent, userDataRoot);
      await rename(join(input.stagingRoot, "library"), installedRoot);
      const installedDraftsRoot = join(userDataRoot, "drafts");
      await rename(join(input.stagingRoot, "legacy-drafts"), installedDraftsRoot);
      await rename(
        join(input.stagingRoot, "portable-settings.json"),
        join(userDataRoot, "portable-settings.json"),
      );
      const packagedDatabase = input.manifest.entries.find((entry) => entry.kind === "database");
      if (!packagedDatabase) throw new Error("database manifest entry missing");
      {
        using database = new DatabaseSync(join(installedRoot, "library.sqlite3"));
        database.exec("PRAGMA user_version = 9; PRAGMA user_version = 8");
      }
      const installedDatabaseIntegrity = await hash(join(installedRoot, "library.sqlite3"));
      expect(installedDatabaseIntegrity.sha256).not.toBe(packagedDatabase.sha256);

      await expect(
        new ImportStagingValidator().validate(
          {
            installed: true,
            libraryRoot: installedRoot,
            userDataRoot,
            packageRoot: input.stagingRoot,
            portableSettingsRoot: userDataRoot,
            legacyDraftsRoot: installedDraftsRoot,
            installedDatabaseIntegrity: {
              byteLength: installedDatabaseIntegrity.bytes,
              sha256: installedDatabaseIntegrity.sha256,
            },
          },
          input.manifest,
        ),
      ).resolves.toMatchObject({ activePatents: 2, legacyDrafts: 1 });
      await expect(hash(join(installedRoot, "library.sqlite3"))).resolves.toEqual(
        installedDatabaseIntegrity,
      );
      const installedLayout = {
        installed: true,
        libraryRoot: installedRoot,
        userDataRoot,
        packageRoot: input.stagingRoot,
        portableSettingsRoot: userDataRoot,
        legacyDraftsRoot: installedDraftsRoot,
        installedDatabaseIntegrity: {
          byteLength: installedDatabaseIntegrity.bytes,
          sha256: installedDatabaseIntegrity.sha256,
        },
      };
      await expect(
        new ImportStagingValidator().validate(
          {
            ...installedLayout,
            installedDatabaseIntegrity: {
              ...installedLayout.installedDatabaseIntegrity,
              sha256: "0".repeat(64),
            },
          },
          input.manifest,
        ),
      ).rejects.toMatchObject({ code: "PACKAGE_TAMPERED", category: "manifest" });
      for (const unsupportedVersion of [0, CURRENT_SCHEMA_VERSION + 1]) {
        await expect(
          new ImportStagingValidator().validate(installedLayout, {
            ...input.manifest,
            databaseSchemaVersion: unsupportedVersion,
          }),
        ).rejects.toMatchObject({ code: "PACKAGE_TAMPERED", category: "manifest" });
      }
      input.key.fill(0);
    },
  );

  test("rejects a replaced capable staging root instead of accepting the new directory", async () => {
    const input = await fixture();
    const metadata = await lstat(input.stagingRoot, { bigint: true });
    const capability = {
      root: input.stagingRoot,
      identity: {
        device: String(metadata.dev),
        inode: String(metadata.ino),
        birthtimeNs: String(metadata.birthtimeNs),
      },
    };
    const moved = `${input.stagingRoot}.moved`;
    roots.push(moved);
    await rename(input.stagingRoot, moved);
    await mkdir(input.stagingRoot);
    await expect(
      new ImportStagingValidator().validate(
        {
          libraryRoot: input.stagingRoot,
          userDataRoot: input.stagingRoot,
          libraryCapability: capability,
          userDataCapability: capability,
        },
        input.manifest,
      ),
    ).rejects.toMatchObject({ code: "PACKAGE_TAMPERED", category: "manifest" });
    input.key.fill(0);
  });

  test("rejects a replaced capable library child directory", async () => {
    const input = await fixture();
    const libraryRoot = join(input.stagingRoot, "library");
    const metadata = await lstat(libraryRoot, { bigint: true });
    const capability = {
      root: libraryRoot,
      identity: {
        device: String(metadata.dev),
        inode: String(metadata.ino),
        birthtimeNs: String(metadata.birthtimeNs),
      },
    };
    const moved = `${libraryRoot}.moved`;
    await rename(libraryRoot, moved);
    await mkdir(libraryRoot);
    await expect(
      new ImportStagingValidator().validate(
        {
          libraryRoot: input.stagingRoot,
          userDataRoot: input.stagingRoot,
          libraryDirectoryCapability: capability,
        },
        input.manifest,
      ),
    ).rejects.toMatchObject({ code: "PACKAGE_TAMPERED", category: "manifest" });
    input.key.fill(0);
  });

  test("rejects a split staging root reached through a link or junction", async () => {
    const input = await fixture();
    const parent = await mkdtemp(join(tmpdir(), "import-validator-linked-root-"));
    roots.push(parent);
    const linkedRoot = join(parent, "linked");
    await symlink(input.stagingRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(
      new ImportStagingValidator().validate(
        { libraryRoot: linkedRoot, userDataRoot: input.stagingRoot },
        input.manifest,
      ),
    ).rejects.toMatchObject({ code: "PACKAGE_TAMPERED", category: "manifest" });
    input.key.fill(0);
  });

  test("fails with a non-sensitive category when a manifest file changes", async () => {
    const input = await fixture();
    await writeFile(join(input.stagingRoot, "verification", "integrity-summary.json"), "tampered");
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "manifest",
    });
    input.key.fill(0);
  });

  test("rejects a manifest entry whose declared kind does not match its logical path", async () => {
    const input = await fixture();
    input.manifest = {
      ...input.manifest,
      entries: input.manifest.entries.map((entry) =>
        entry.kind === "settings" ? { ...entry, kind: "asset" as const } : entry,
      ),
    };
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "manifest",
    });
    input.key.fill(0);
  });

  test("rejects a manifest whose recorded database version disagrees with the frozen database", async () => {
    const input = await fixture();
    input.manifest = { ...input.manifest, databaseSchemaVersion: 6 };
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "manifest",
    });
    input.key.fill(0);
  });

  test("rejects a legacy key envelope as an unmanifested library artifact", async () => {
    const input = await fixture();
    await writeFile(join(input.stagingRoot, "library", "key-envelope.bin"), "forged-envelope");
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "manifest",
    });
    input.key.fill(0);
  });

  test("rejects a package when a declared resource is missing", async () => {
    const input = await fixture();
    const assetEntry = input.manifest.entries.find((entry) => entry.kind === "asset");
    if (!assetEntry) throw new Error("asset fixture missing");
    await rm(join(input.stagingRoot, ...assetEntry.logicalPath.split("/")));
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "manifest",
    });
    input.key.fill(0);
  });

  test("rejects a missing final normal-document edit log during real document opening", async () => {
    const input = await fixture();
    await mutateFixtureDatabase(input, (database) => {
      database.prepare("DELETE FROM document_edit_log WHERE target_revision = 1").run();
    });
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "document",
    });
    input.key.fill(0);
  });

  test("rejects a missing final trash-document edit log through the validation replay path", async () => {
    const input = await fixture();
    await mutateFixtureDatabase(input, (database) => {
      database
        .prepare(
          `DELETE FROM document_edit_log
           WHERE library_document_id = (
             SELECT library_document_id FROM documents WHERE deleted_at IS NOT NULL LIMIT 1
           ) AND target_revision = 1`,
        )
        .run();
    });
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "document",
    });
    input.key.fill(0);
  });

  test("rejects a damaged retained patent edit-log payload", async () => {
    const input = await fixture();
    await mutateFixtureDatabase(input, (database) => {
      database
        .prepare(
          "UPDATE edit_log SET payload = zeroblob(48) WHERE rowid = (SELECT rowid FROM edit_log ORDER BY rowid LIMIT 1)",
        )
        .run();
    });
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test("rejects an authenticated patent snapshot carrying another patent identity", async () => {
    const input = await fixture();
    await rewriteAuthenticatedPatentSnapshot(input, "revision-zero", (patent) => ({
      ...patent,
      patentId: "99999999-9999-4999-8999-999999999999",
    }));
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test("rejects an authenticated patent snapshot whose payload revision differs from its row", async () => {
    const input = await fixture();
    await rewriteAuthenticatedPatentSnapshot(input, "revision-zero", (patent) => ({
      ...patent,
      revision: 1,
    }));
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test("rejects an authenticated snapshot that diverges from edit replay at the same revision", async () => {
    const input = await fixture();
    await rewriteAuthenticatedPatentSnapshot(input, "replayed-revision", (patent) => ({
      ...patent,
      name: "分叉但认证有效的专利名称",
    }));
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test.each([undefined, 90] as const)(
    "compares omitted zero figure rotation semantically but rejects changed rotation %s",
    async (rotationDeg) => {
      const input = await fixture();
      await rewriteAuthenticatedPatentEdit(input, "last", (edit) => {
        const figures = edit.payload.figures as Array<Record<string, unknown>>;
        expect(figures).toHaveLength(1);
        const { rotationDeg: _previous, ...figure } = figures[0]!;
        return {
          ...edit,
          payload: {
            ...edit.payload,
            figures: [{ ...figure, ...(rotationDeg === undefined ? {} : { rotationDeg }) }],
          },
        };
      });
      if (rotationDeg === undefined)
        await expect(validateFixture(input)).resolves.toMatchObject({ activePatents: 2 });
      else
        await expect(validateFixture(input)).rejects.toMatchObject({
          code: "PACKAGE_TAMPERED",
          category: "patent",
        });
      input.key.fill(0);
    },
  );

  test("does not let a stored-revision snapshot hide a missing final patent edit", async () => {
    const input = await fixture();
    await mutateFixtureDatabase(input, (database) => {
      database
        .prepare(
          `DELETE FROM edit_log
           WHERE patent_id = (
             SELECT patent_id FROM snapshots WHERE revision > 0 ORDER BY revision DESC LIMIT 1
           )
           AND target_revision = (
             SELECT MAX(revision) FROM snapshots WHERE revision > 0
           )`,
        )
        .run();
    });
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test("rejects an authenticated patent edit whose payload schema is invalid", async () => {
    const input = await fixture();
    await rewriteAuthenticatedPatentEdit(input, "first", (edit) => ({
      ...edit,
      payload: { ...edit.payload, type: "unknown-edit" },
    }));
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test("rejects an authenticated patent edit whose revision chain is broken", async () => {
    const input = await fixture();
    await mutateFixtureDatabase(input, (database) => {
      database
        .prepare(
          `DELETE FROM edit_log
           WHERE patent_id = (
             SELECT patent_id FROM edit_log GROUP BY patent_id
             ORDER BY MAX(target_revision) DESC LIMIT 1
           )
           AND target_revision = (
             SELECT MAX(target_revision) - 1 FROM edit_log
           )`,
        )
        .run();
    });
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test("rejects an authenticated patent edit that repeats another revision claim", async () => {
    const input = await fixture();
    await rewriteAuthenticatedPatentEdit(input, "last", (edit) => ({
      ...edit,
      payload: { ...edit.payload, targetRevision: edit.baseRevision },
    }));
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test("rejects an authenticated patent edit beyond the stored patent revision", async () => {
    const input = await fixture();
    await rewriteAuthenticatedPatentEdit(input, "last", (edit) => ({
      ...edit,
      baseRevision: edit.storedRevision,
      targetRevision: edit.storedRevision + 1,
      payload: {
        ...edit.payload,
        baseRevision: edit.storedRevision,
        targetRevision: edit.storedRevision + 1,
      },
    }));
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test.each(["title", "snippet"] as const)(
    "rejects damaged normal-document %s metadata",
    async (column) => {
      const input = await fixture();
      await mutateFixtureDatabase(input, (database) => {
        database.prepare(`UPDATE documents SET ${column} = zeroblob(48)`).run();
      });
      await expect(validateFixture(input)).rejects.toMatchObject({
        code: "PACKAGE_TAMPERED",
        category: "document",
      });
      input.key.fill(0);
    },
  );

  test("rejects an unreadable active patent through the real PatentService.open path", async () => {
    const input = await fixture();
    await mutateFixtureDatabase(input, (database) => {
      database
        .prepare(
          "UPDATE patent_books SET document_json = zeroblob(48) WHERE patent_id = (SELECT patent_id FROM patents WHERE deleted_at IS NULL ORDER BY patent_id LIMIT 1)",
        )
        .run();
    });
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test("rejects a damaged trash-patent recovery snapshot", async () => {
    const input = await fixture();
    await mutateFixtureDatabase(input, (database) => {
      database
        .prepare(
          `UPDATE snapshots SET payload = zeroblob(48)
           WHERE patent_id = (SELECT patent_id FROM patents WHERE deleted_at IS NOT NULL LIMIT 1)`,
        )
        .run();
    });
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test("rejects damaged encrypted flowchart metadata", async () => {
    const input = await fixture();
    await mutateFixtureDatabase(input, (database) => {
      database.prepare("UPDATE patent_flowcharts SET metadata = zeroblob(48)").run();
    });
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "flowchart",
    });
    input.key.fill(0);
  });

  test("rejects an asset whose database descriptor disagrees with its encrypted descriptor", async () => {
    const input = await fixture();
    await mutateFixtureDatabase(input, (database) => {
      database.prepare("UPDATE assets SET width = width + 1").run();
    });
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "asset",
    });
    input.key.fill(0);
  });

  test.each(["original", "preview"] as const)(
    "rejects an asset whose authenticated %s bytes disagree with its descriptor hash",
    async (target) => {
      const input = await fixture();
      await corruptDocumentAssetBytes(input, target);
      await expect(validateFixture(input)).rejects.toMatchObject({
        code: "PACKAGE_TAMPERED",
        category: "asset",
      });
      input.key.fill(0);
    },
  );

  test("fails closed when encrypted canonical content is corrupted", async () => {
    const input = await fixture();
    const { LibraryDatabase } = await import("../library/library-database.js");
    {
      using database = LibraryDatabase.open(input.databasePath);
      database.transaction((connection) => {
        connection.prepare("UPDATE snapshots SET payload = zeroblob(48)").run();
      });
      database.checkpoint();
    }
    const databaseEntry = await manifestEntry(input.stagingRoot, "library/library.sqlite3", 0);
    const remainingEntries = input.manifest.entries.slice(1);
    input.manifest = {
      ...input.manifest,
      entries: [databaseEntry, ...remainingEntries],
      totalOriginalBytes:
        databaseEntry.originalBytes +
        remainingEntries.reduce((sum, entry) => sum + entry.originalBytes, 0),
      summary: {
        ...input.manifest.summary,
        totalBytes:
          databaseEntry.originalBytes +
          remainingEntries
            .filter((entry) => ["asset", "legacy-draft"].includes(entry.kind))
            .reduce((sum, entry) => sum + entry.originalBytes, 0),
      },
    };
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "patent",
    });
    input.key.fill(0);
  });

  test("rejects a damaged encrypted asset after its package hash is internally consistent", async () => {
    const input = await fixture();
    const genericAssetHash = documentAsset().descriptor.sha256;
    const assetEntry = input.manifest.entries.find(
      (entry) => entry.kind === "asset" && entry.logicalPath.endsWith(`${genericAssetHash}.asset`),
    );
    if (!assetEntry) throw new Error("asset fixture missing");
    await writeFile(join(input.stagingRoot, ...assetEntry.logicalPath.split("/")), "bad asset");
    await refreshManifestEntry(input, assetEntry.logicalPath);
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "asset",
    });
    input.key.fill(0);
  });

  test("rejects a damaged normal-document snapshot", async () => {
    const input = await fixture();
    const { LibraryDatabase } = await import("../library/library-database.js");
    {
      using database = LibraryDatabase.open(input.databasePath);
      database.transaction((connection) => {
        connection.prepare("UPDATE document_snapshots SET payload = zeroblob(48)").run();
      });
      database.checkpoint();
    }
    await refreshManifestEntry(input, "library/library.sqlite3");
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "document",
    });
    input.key.fill(0);
  });

  test("rejects a damaged historical draft after its package hash is internally consistent", async () => {
    const input = await fixture();
    const draftEntry = input.manifest.entries.find(
      (entry) => entry.kind === "legacy-draft" && entry.logicalPath.endsWith(".patdoc"),
    );
    if (!draftEntry) throw new Error("draft fixture missing");
    await writeFile(join(input.stagingRoot, ...draftEntry.logicalPath.split("/")), "bad draft");
    await refreshManifestEntry(input, draftEntry.logicalPath);
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "draft",
    });
    input.key.fill(0);
  });

  test("rejects a damaged retained flowchart source revision", async () => {
    const input = await fixture();
    const { LibraryDatabase } = await import("../library/library-database.js");
    {
      using database = LibraryDatabase.open(input.databasePath);
      database.transaction((connection) => {
        connection
          .prepare("UPDATE patent_flowchart_source_revisions SET source = zeroblob(48)")
          .run();
      });
      database.checkpoint();
    }
    await refreshManifestEntry(input, "library/library.sqlite3");
    await expect(validateFixture(input)).rejects.toMatchObject({
      code: "PACKAGE_TAMPERED",
      category: "flowchart",
    });
    input.key.fill(0);
  });
});
