import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createBlankDocument } from "../../shared/document/defaults.js";
import type {
  AssetDescriptor,
  CanonicalDocument,
  FigureNode,
} from "../../shared/document/model.js";
import type { DraftSummary } from "../../shared/ipc/contract.js";
import type { AppResult } from "../../shared/ipc/result.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import type { AssetOwner, StoredAsset } from "../assets/asset-store.js";
import type { PatdocPayload, PatentPatdocPayload } from "../documents/patdoc-format.js";
import { LegacyDraftMigrationService } from "./legacy-draft-migration.js";
import type { OpenedLibraryDocument } from "./library-service.js";

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function openedDocument(
  title: string,
  libraryDocumentId = testUuid(101),
  document: CanonicalDocument = createBlankDocument(title),
): OpenedLibraryDocument {
  return {
    libraryDocumentId,
    sessionId: testUuid(201),
    revision: 0,
    document: structuredClone(document),
    editorState: {},
    saveState: "saved",
  };
}

function assetDescriptor(
  assetId = testUuid(401),
  original = Uint8Array.from([1, 2, 3]),
  preview = Uint8Array.from([4, 5, 6]),
): AssetDescriptor {
  return {
    assetId,
    kind: "image",
    originalName: "figure.png",
    mediaType: "image/png",
    extension: "png",
    byteLength: original.byteLength,
    sha256: sha256(original),
    widthPx: 10,
    heightPx: 10,
    previewByteLength: preview.byteLength,
    previewSha256: sha256(preview),
  };
}

function storedAsset(assetId = testUuid(401)): StoredAsset {
  const original = Uint8Array.from([1, 2, 3]);
  const preview = Uint8Array.from([4, 5, 6]);
  return {
    descriptor: assetDescriptor(assetId, original, preview),
    original,
    preview,
  };
}

function memoryDraftService(drafts: Array<{ summary: DraftSummary; payload: PatdocPayload }>) {
  return {
    list: vi.fn(async () => drafts.map((draft) => draft.summary)),
    open: vi.fn(async (draftId: string) => {
      const draft = drafts.find((candidate) => candidate.summary.draftId === draftId);
      if (!draft) throw new Error("missing draft");
      return structuredClone(draft.payload);
    }),
  };
}

function draftSummary(document: CanonicalDocument, displayName = document.title): DraftSummary {
  return {
    draftId: document.documentId,
    documentId: document.documentId,
    displayName,
    originalPath: null,
    savedAt: "2026-08-01T02:07:04.000Z",
  };
}

async function snapshotDirectory(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile())
        snapshot[relative(root, path)] = Buffer.from(await readFile(path)).toString("base64");
    }
  }
  await walk(root);
  return snapshot;
}

describe("legacy draft migration", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "patent-legacy-migration-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("imports a valid legacy draft and leaves source bytes unchanged", async () => {
    const payload = {
      document: createBlankDocument("未命名草稿"),
      settings: {},
      editorState: {},
      assets: [],
    };
    const summary = draftSummary(payload.document, "未命名草稿");
    const draftService = memoryDraftService([{ summary, payload }]);
    const before = await snapshotDirectory(root);
    const imported = openedDocument("未命名草稿", testUuid(101), payload.document);
    const library = {
      importDocument: vi.fn(async () => imported),
      open: vi.fn(async () => imported),
      release: vi.fn(async () => undefined),
      moveToTrash: vi.fn(async () => undefined),
      permanentlyDelete: vi.fn(async () => undefined),
    };

    const result = await new LegacyDraftMigrationService({ draftService, library }).importDraft(
      summary.draftId,
    );

    expect(result).toEqual(imported);
    expect(library.importDocument).toHaveBeenCalledWith(payload.document);
    expect(library.open).toHaveBeenCalledWith(imported.libraryDocumentId);
    expect(await snapshotDirectory(root)).toEqual(before);
  });

  test("imports the active book from a current patent draft payload with a remapped chemical preview", async () => {
    const legacyAsset = storedAsset(testUuid(410));
    const importedAsset = {
      descriptor: assetDescriptor(testUuid(411)),
      preview: Uint8Array.from([4, 5, 6]),
    };
    const patentPayload: PatentPatdocPayload = {
      patent: createBlankPatent({ patentType: "invention", name: "虚构专利历史草稿" }),
      assets: [legacyAsset],
    };
    const activeBook = patentPayload.patent.books.find(
      (book) => book.kind === patentPayload.patent.activeBookKind,
    );
    if (!activeBook) throw new Error("test patent has no active book");
    patentPayload.patent.assets = [legacyAsset.descriptor];
    const chemical = {
      id: testUuid(412),
      type: "chemical-structure" as const,
      ketSource: "(ket) (atom O)",
      previewAssetId: legacyAsset.descriptor.assetId,
      widthMm: 80,
      alignment: "center" as const,
    };
    activeBook.document.content = [chemical];
    const expectedDocument: CanonicalDocument = {
      ...activeBook.document,
      documentId: patentPayload.patent.patentId,
      title: patentPayload.patent.name ?? activeBook.document.title,
      patentType: patentPayload.patent.patentType,
      createdAt: patentPayload.patent.createdAt,
      modifiedAt: patentPayload.patent.modifiedAt,
      assets: patentPayload.patent.assets,
    };
    const remappedDocument = structuredClone(expectedDocument);
    remappedDocument.assets = [importedAsset.descriptor];
    remappedDocument.content = [
      {
        ...chemical,
        previewAssetId: importedAsset.descriptor.assetId,
      },
    ];
    const summary = draftSummary(expectedDocument, "虚构专利历史草稿.patdoc");
    const draftService = {
      list: vi.fn(async () => [summary]),
      open: vi.fn(async () => structuredClone(patentPayload)),
    };
    const created = openedDocument(expectedDocument.title, testUuid(102));
    const imported = openedDocument(expectedDocument.title, testUuid(102), remappedDocument);
    const library = {
      create: vi.fn(async () => created),
      importDocument: vi.fn(async () => {
        throw new Error("asset drafts must use create + replace");
      }),
      replaceInitialDocument: vi.fn(async () => imported),
      open: vi.fn(async () => imported),
      release: vi.fn(async () => undefined),
      moveToTrash: vi.fn(async () => undefined),
      permanentlyDelete: vi.fn(async () => undefined),
    };
    const assetStore = {
      install: vi.fn(async (_owner: AssetOwner, _asset: StoredAsset) => importedAsset),
    };

    const result = await new LegacyDraftMigrationService({
      draftService,
      library,
      assetStore,
    }).importDraft(summary.draftId);

    expect(result).toEqual(imported);
    expect(library.replaceInitialDocument).toHaveBeenCalledWith(
      created.libraryDocumentId,
      remappedDocument,
    );
  });

  test("copies legacy draft assets and rewrites figure and chemical references", async () => {
    const legacyAsset = storedAsset(testUuid(401));
    const importedAsset = {
      descriptor: assetDescriptor(testUuid(402)),
      preview: Uint8Array.from([4, 5, 6]),
    };
    const document = createBlankDocument("带图旧草稿");
    document.assets = [legacyAsset.descriptor];
    const figure: FigureNode = {
      id: testUuid(403),
      type: "figure",
      assetId: legacyAsset.descriptor.assetId,
      widthMm: 80,
      alignment: "center",
    };
    const chemical = {
      id: testUuid(404),
      type: "chemical-structure" as const,
      ketSource: "(ket) (atom O)",
      previewAssetId: legacyAsset.descriptor.assetId,
      widthMm: 80,
      alignment: "center" as const,
    };
    document.content = [figure, chemical];
    const payload = { document, settings: {}, editorState: {}, assets: [legacyAsset] };
    const summary = draftSummary(document, "带图旧草稿");
    const draftService = memoryDraftService([{ summary, payload }]);
    const created = openedDocument("带图旧草稿", testUuid(501));
    const remappedDocument = structuredClone(document);
    remappedDocument.assets = [importedAsset.descriptor];
    remappedDocument.content = [
      {
        ...figure,
        assetId: importedAsset.descriptor.assetId,
      },
      {
        ...chemical,
        previewAssetId: importedAsset.descriptor.assetId,
      },
    ];
    const replaced = openedDocument("带图旧草稿", created.libraryDocumentId, remappedDocument);
    const library = {
      create: vi.fn(async () => created),
      importDocument: vi.fn(async () => {
        throw new Error("asset drafts must use create + replace");
      }),
      replaceInitialDocument: vi.fn(async () => replaced),
      open: vi.fn(async () => replaced),
      release: vi.fn(async () => undefined),
      moveToTrash: vi.fn(async () => undefined),
      permanentlyDelete: vi.fn(async () => undefined),
    };
    const assetStore = {
      install: vi.fn(async (_owner: AssetOwner, _asset: StoredAsset) => importedAsset),
    };

    const result = await new LegacyDraftMigrationService({
      draftService,
      library,
      assetStore,
    }).importDraft(summary.draftId);

    expect(result).toEqual(replaced);
    expect(library.create).toHaveBeenCalledWith(document.title);
    expect(assetStore.install).toHaveBeenCalledOnce();
    const installCall = assetStore.install.mock.calls[0];
    expect(installCall?.[0]).toEqual({
      kind: "library-document",
      libraryDocumentId: created.libraryDocumentId,
    });
    expect(installCall?.[1].descriptor).toEqual(legacyAsset.descriptor);
    expect(Array.from(installCall?.[1].original ?? [])).toEqual(Array.from(legacyAsset.original));
    expect(Array.from(installCall?.[1].preview ?? [])).toEqual(Array.from(legacyAsset.preview));
    expect(library.replaceInitialDocument).toHaveBeenCalledWith(
      created.libraryDocumentId,
      remappedDocument,
    );
    expect(library.importDocument).not.toHaveBeenCalled();
    expect(library.open).toHaveBeenCalledWith(created.libraryDocumentId);
  });

  test("leaves no partial internal document when reread verification fails", async () => {
    const document = createBlankDocument("核对失败");
    const draft: DraftSummary = {
      draftId: document.documentId,
      documentId: document.documentId,
      displayName: "核对失败",
      originalPath: null,
      savedAt: "2026-08-01T02:07:04.000Z",
    };
    const draftService = {
      list: vi.fn(async () => [draft]),
      open: vi.fn(async () => ({ document, settings: {}, editorState: {}, assets: [] })),
    };
    const imported = openedDocument("核对失败", testUuid(301), document);
    const mismatched = openedDocument("不同内容", testUuid(301));
    const library = {
      importDocument: vi.fn(async () => imported),
      open: vi.fn(async () => mismatched),
      release: vi.fn(async () => undefined),
      moveToTrash: vi.fn(async () => undefined),
      permanentlyDelete: vi.fn(async () => undefined),
    };

    await expect(
      new LegacyDraftMigrationService({ draftService, library }).importDraft(draft.draftId),
    ).rejects.toThrow(/旧草稿导入核对失败/u);

    expect(library.release).toHaveBeenCalledWith(imported.sessionId);
    expect(library.moveToTrash).toHaveBeenCalledWith(imported.libraryDocumentId);
    expect(library.permanentlyDelete).toHaveBeenCalledWith(imported.libraryDocumentId);
  });

  test("lists only valid legacy draft candidates", async () => {
    const document = createBlankDocument("候选草稿");
    const validDraftService = memoryDraftService([
      {
        summary: draftSummary(document, "候选草稿"),
        payload: { document, settings: {}, editorState: {}, assets: [] },
      },
    ]);
    const importedDraftId = document.documentId;
    const state = {
      isImported: vi.fn(async (draftId: string) => draftId === importedDraftId),
      markImported: vi.fn(),
    };

    expect(
      await new LegacyDraftMigrationService({
        draftService: validDraftService,
        library: {
          importDocument: vi.fn(),
          open: vi.fn(),
          release: vi.fn(),
          moveToTrash: vi.fn(),
          permanentlyDelete: vi.fn(),
        },
        state,
      }).listCandidates(),
    ).toEqual([]);
    expect(validDraftService.open).not.toHaveBeenCalled();
  });

  test("returns structured IPC failures without deleting legacy drafts", async () => {
    const document = createBlankDocument("IPC 失败");
    const draft: DraftSummary = {
      draftId: document.documentId,
      documentId: document.documentId,
      displayName: "IPC 失败",
      originalPath: null,
      savedAt: "2026-08-01T02:07:04.000Z",
    };
    const draftService = {
      list: vi.fn(async () => [draft]),
      open: vi.fn(async () => {
        throw new Error("broken draft");
      }),
    };
    const migration = new LegacyDraftMigrationService({
      draftService,
      library: {
        importDocument: vi.fn(),
        open: vi.fn(),
        release: vi.fn(),
        moveToTrash: vi.fn(),
        permanentlyDelete: vi.fn(),
      },
    });

    const result: AppResult<OpenedLibraryDocument> = await migration.importDraftResult(
      draft.draftId,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CORRUPT_FILE");
  });

  test("normalizes unexpected native error codes during IPC migration", async () => {
    const document = createBlankDocument("未知错误码");
    const draft: DraftSummary = {
      draftId: document.documentId,
      documentId: document.documentId,
      displayName: "未知错误码",
      originalPath: null,
      savedAt: "2026-08-01T02:07:04.000Z",
    };
    const migration = new LegacyDraftMigrationService({
      draftService: {
        list: vi.fn(async () => [draft]),
        open: vi.fn(async () => {
          throw Object.assign(new Error("vendor-specific failure"), { code: "SOMETHING_ELSE" });
        }),
      },
      library: {
        importDocument: vi.fn(),
        open: vi.fn(),
        release: vi.fn(),
        moveToTrash: vi.fn(),
        permanentlyDelete: vi.fn(),
      },
    });

    const result = await migration.importDraftResult(draft.draftId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CORRUPT_FILE");
  });
});
