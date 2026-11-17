import { type CanonicalDocument, CanonicalDocumentSchema } from "../../shared/document/model.js";
import type { DraftSummary } from "../../shared/ipc/contract.js";
import {
  type AppErrorCode,
  AppErrorCodeSchema,
  type AppResult,
  normalizeAppError,
} from "../../shared/ipc/result.js";
import type { PersistentAssetStore, StoredAsset } from "../assets/asset-store.js";
import { toDocumentPatdocPayload } from "../documents/file-service.js";
import type { PatdocPayload, PatentPatdocPayload } from "../documents/patdoc-format.js";
import type { DraftService } from "../drafts/draft-service.js";
import type { OpenedLibraryDocument } from "./library-service.js";

type LegacyDraftMigrationLibrary = {
  importDocument(document: CanonicalDocument): Promise<OpenedLibraryDocument>;
  create?(title?: string): Promise<OpenedLibraryDocument>;
  replaceInitialDocument?(
    libraryDocumentId: string,
    document: CanonicalDocument,
  ): Promise<OpenedLibraryDocument>;
  open(libraryDocumentId: string): Promise<OpenedLibraryDocument>;
  release(sessionId: string): Promise<void>;
  moveToTrash(libraryDocumentId: string): Promise<void>;
  permanentlyDelete(libraryDocumentId: string): Promise<void>;
};

type LegacyDraftMigrationState = {
  isImported(draftId: string): Promise<boolean>;
  markImported(draftId: string, libraryDocumentId: string): Promise<void>;
};

export type LegacyDraftMigrationOptions = {
  draftService: Pick<DraftService, "list"> & {
    open(draftId: string): Promise<PatdocPayload | PatentPatdocPayload>;
  };
  library: LegacyDraftMigrationLibrary;
  assetStore?: Pick<PersistentAssetStore, "install">;
  state?: LegacyDraftMigrationState;
};

export class LegacyDraftMigrationError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function documentsMatch(first: CanonicalDocument, second: CanonicalDocument): boolean {
  return (
    stableJson(CanonicalDocumentSchema.parse(first)) ===
    stableJson(CanonicalDocumentSchema.parse(second))
  );
}

async function ignoreFailure(operation: Promise<unknown>): Promise<void> {
  await operation.catch(() => undefined);
}

function migrationFailure(error: unknown): AppResult<never> {
  if (error instanceof LegacyDraftMigrationError) {
    return { ok: false, error: normalizeAppError({ code: error.code, message: "normalized" }) };
  }
  const rawCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
      ? (error as { code: string }).code
      : "CORRUPT_FILE";
  const code = AppErrorCodeSchema.safeParse(rawCode).success
    ? (rawCode as AppErrorCode)
    : "CORRUPT_FILE";
  return { ok: false, error: normalizeAppError({ code, message: "normalized" }) };
}

export class LegacyDraftMigrationService {
  private readonly draftService: LegacyDraftMigrationOptions["draftService"];
  private readonly library: LegacyDraftMigrationLibrary;
  private readonly assetStore: Pick<PersistentAssetStore, "install"> | undefined;
  private readonly state: LegacyDraftMigrationState | undefined;

  constructor(options: LegacyDraftMigrationOptions) {
    this.draftService = options.draftService;
    this.library = options.library;
    this.assetStore = options.assetStore;
    this.state = options.state;
  }

  async listCandidates(): Promise<DraftSummary[]> {
    const drafts = await this.draftService.list();
    const candidates: DraftSummary[] = [];
    for (const draft of drafts) {
      if (await this.state?.isImported(draft.draftId)) continue;
      candidates.push(draft);
    }
    return candidates;
  }

  async importDraft(draftId: string): Promise<OpenedLibraryDocument> {
    const candidate = (await this.listCandidates()).find((draft) => draft.draftId === draftId);
    if (!candidate) {
      throw new LegacyDraftMigrationError("NOT_FOUND", "Legacy draft not found.");
    }
    const payload = await this.draftService.open(candidate.draftId);
    const { opened: imported, expectedDocument } = await this.importPayload(payload);
    let verificationSessionId: string | null = null;
    try {
      const verified = await this.library.open(imported.libraryDocumentId);
      verificationSessionId = verified.sessionId;
      if (!documentsMatch(verified.document, expectedDocument)) {
        throw new LegacyDraftMigrationError("CORRUPT_FILE", "旧草稿导入核对失败。");
      }
      await this.state?.markImported(candidate.draftId, imported.libraryDocumentId);
      return imported;
    } catch (error) {
      await ignoreFailure(this.library.release(imported.sessionId));
      if (verificationSessionId) await ignoreFailure(this.library.release(verificationSessionId));
      await ignoreFailure(this.library.moveToTrash(imported.libraryDocumentId));
      await ignoreFailure(this.library.permanentlyDelete(imported.libraryDocumentId));
      throw error;
    } finally {
      if (verificationSessionId) await ignoreFailure(this.library.release(verificationSessionId));
    }
  }

  private async importPayload(
    input: PatdocPayload | PatentPatdocPayload,
  ): Promise<{ opened: OpenedLibraryDocument; expectedDocument: CanonicalDocument }> {
    const payload = toDocumentPatdocPayload(input);
    const document = CanonicalDocumentSchema.parse(payload.document);
    if (payload.assets.length === 0) {
      return { opened: await this.library.importDocument(document), expectedDocument: document };
    }
    if (!this.assetStore || !this.library.create || !this.library.replaceInitialDocument) {
      throw new LegacyDraftMigrationError("INVALID_INPUT", "旧草稿图片迁移服务未就绪。");
    }
    const opened = await this.library.create(document.title);
    try {
      const installedAssets = [];
      for (const asset of payload.assets) {
        const installed = await this.assetStore.install(
          { kind: "library-document", libraryDocumentId: opened.libraryDocumentId },
          asset,
        );
        installedAssets.push({
          originalAssetId: asset.descriptor.assetId,
          descriptor: installed.descriptor,
        });
      }
      const expectedDocument = remapImportedAssets(document, installedAssets);
      const replaced = await this.library.replaceInitialDocument(
        opened.libraryDocumentId,
        expectedDocument,
      );
      if (replaced.sessionId !== opened.sessionId) {
        await ignoreFailure(this.library.release(opened.sessionId));
      }
      return { opened: replaced, expectedDocument };
    } catch (error) {
      await ignoreFailure(this.library.release(opened.sessionId));
      await ignoreFailure(this.library.moveToTrash(opened.libraryDocumentId));
      await ignoreFailure(this.library.permanentlyDelete(opened.libraryDocumentId));
      throw error;
    }
  }

  async importDraftResult(draftId: string): Promise<AppResult<OpenedLibraryDocument>> {
    try {
      return { ok: true, value: await this.importDraft(draftId) };
    } catch (error) {
      return migrationFailure(error);
    }
  }
}

function remapImportedAssets(
  documentInput: CanonicalDocument,
  installedAssets: Array<{ originalAssetId: string; descriptor: StoredAsset["descriptor"] }>,
): CanonicalDocument {
  const assetIdMap = new Map(
    installedAssets.map((asset) => [asset.originalAssetId, asset.descriptor.assetId]),
  );
  const descriptorMap = new Map(
    installedAssets.map((asset) => [asset.originalAssetId, asset.descriptor]),
  );
  const document = structuredClone(documentInput);
  document.assets = document.assets.map((asset) => {
    const descriptor = descriptorMap.get(asset.assetId);
    return descriptor ? structuredClone(descriptor) : asset;
  });
  document.content = document.content.map((block) => {
    if (block.type === "figure" && assetIdMap.has(block.assetId)) {
      return { ...block, assetId: assetIdMap.get(block.assetId) ?? block.assetId };
    }
    if (block.type === "chemical-structure" && assetIdMap.has(block.previewAssetId)) {
      return {
        ...block,
        previewAssetId: assetIdMap.get(block.previewAssetId) ?? block.previewAssetId,
      };
    }
    return block;
  });
  return document;
}
