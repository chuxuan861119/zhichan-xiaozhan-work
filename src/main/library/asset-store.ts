import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { AssetDescriptor } from "../../shared/document/model.js";
import { AssetDescriptorSchema } from "../../shared/document/model.js";
import type { ImportedAsset } from "../../shared/ipc/contract.js";
import type { AssetOwner, StoredAsset } from "../assets/asset-store.js";
import { LibraryServiceError } from "./edit-journal.js";
import type { LibraryDatabase } from "./library-database.js";

const ASSET_DIRECTORY_NAME = "assets";
const ASSET_FILE_EXTENSION = ".asset";
const ASSET_PAYLOAD_MAGIC = Buffer.from("PATASSET1\n", "utf8");
const ASSET_PAYLOAD_VERSION = 1;
const ORPHAN_TEMP_PATTERN =
  /^[0-9A-F]{64}\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type AssetRow = {
  asset_id: string;
  content_hash: string;
  relative_path: string;
  mime_type: AssetDescriptor["mediaType"];
  byte_length: number;
  width: number;
  height: number;
  created_at: string;
};

type AssetPayload = {
  descriptor: AssetDescriptor;
  original: Uint8Array;
  preview: Uint8Array;
};

type AssetPayloadHeader = {
  version: 1;
  descriptor: AssetDescriptor;
};

type AssetOwnerTable = {
  table: "document_assets" | "patent_assets" | "template_assets";
  ownerColumn: "library_document_id" | "patent_id" | "template_id";
  entityTable: "documents" | "patents" | "patent_template_slots";
};

export type AssetOwnerScope = { kind: AssetOwner["kind"] };

type AssetFileSystem = {
  access(path: string): Promise<void>;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  open: typeof open;
  readFile: typeof readFile;
  readdir(path: string): Promise<Dirent[]>;
  rename: typeof rename;
  unlink: typeof unlink;
};

export type AssetCollectionReport = {
  deletedAssetIds: string[];
  failedAssetIds: string[];
};

export type AssetReconciliationReport = {
  quarantinedAssetIds: string[];
};

export type AssetStoreOptions = {
  root: string;
  database: LibraryDatabase;
  now?: () => Date;
  fileSystem?: Partial<AssetFileSystem>;
  afterTempWrite?: (path: string) => Promise<void> | void;
  beforeUnreferencedFileDelete?: (assetId: string) => Promise<void> | void;
  randomUUID?: () => string;
};

const defaultFileSystem: AssetFileSystem = {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir: (path: string) => readdir(path, { withFileTypes: true }),
  rename,
  unlink,
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function cloneStoredAsset(asset: StoredAsset): StoredAsset {
  return {
    descriptor: structuredClone(asset.descriptor),
    original: Uint8Array.from(asset.original),
    preview: Uint8Array.from(asset.preview),
  };
}

function bufferView(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function nativeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function validateStoredAsset(asset: StoredAsset): StoredAsset {
  const descriptor = AssetDescriptorSchema.parse(asset.descriptor);
  const original = Uint8Array.from(asset.original);
  const preview = Uint8Array.from(asset.preview);
  if (descriptor.byteLength !== original.byteLength || descriptor.sha256 !== sha256(original)) {
    throw new LibraryServiceError("INVALID_INPUT", "Asset original bytes do not match metadata.");
  }
  if (
    descriptor.previewByteLength !== preview.byteLength ||
    descriptor.previewSha256 !== sha256(preview)
  ) {
    throw new LibraryServiceError("INVALID_INPUT", "Asset preview bytes do not match metadata.");
  }
  return { descriptor, original, preview };
}

function encodeAssetPayload(asset: StoredAsset): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      version: ASSET_PAYLOAD_VERSION,
      descriptor: asset.descriptor,
    } satisfies AssetPayloadHeader),
    "utf8",
  );
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.byteLength);
  return Buffer.concat([
    ASSET_PAYLOAD_MAGIC,
    headerLength,
    header,
    bufferView(asset.preview),
    bufferView(asset.original),
  ]);
}

function decodeAssetPayload(bytes: Uint8Array): AssetPayload {
  const source = bufferView(bytes);
  if (
    source.byteLength < ASSET_PAYLOAD_MAGIC.byteLength + 4 ||
    !source.subarray(0, ASSET_PAYLOAD_MAGIC.byteLength).equals(ASSET_PAYLOAD_MAGIC)
  ) {
    throw new LibraryServiceError("CORRUPT_FILE", "Asset payload is malformed.");
  }
  const headerLengthOffset = ASSET_PAYLOAD_MAGIC.byteLength;
  const headerLength = source.readUInt32BE(headerLengthOffset);
  const headerStart = headerLengthOffset + 4;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > source.byteLength) {
    throw new LibraryServiceError("CORRUPT_FILE", "Asset header is truncated.");
  }
  const parsed = JSON.parse(
    source.subarray(headerStart, headerEnd).toString("utf8"),
  ) as Partial<AssetPayloadHeader>;
  if (parsed.version !== ASSET_PAYLOAD_VERSION || parsed.descriptor === undefined) {
    throw new LibraryServiceError("CORRUPT_FILE", "Asset header is invalid.");
  }
  const descriptor = AssetDescriptorSchema.parse(parsed.descriptor);
  const previewStart = headerEnd;
  const previewEnd = previewStart + descriptor.previewByteLength;
  const originalEnd = previewEnd + descriptor.byteLength;
  if (originalEnd !== source.byteLength) {
    throw new LibraryServiceError("CORRUPT_FILE", "Asset byte lengths do not match.");
  }
  return {
    descriptor,
    preview: Uint8Array.from(source.subarray(previewStart, previewEnd)),
    original: Uint8Array.from(source.subarray(previewEnd, originalEnd)),
  };
}

function importedAsset(asset: StoredAsset): ImportedAsset {
  return {
    descriptor: structuredClone(asset.descriptor),
    preview: Uint8Array.from(asset.preview),
  };
}

export class AssetStore {
  readonly #root: string;
  readonly #assetRoot: string;
  readonly #database: LibraryDatabase;
  readonly #availableOwnerTables: ReadonlySet<AssetOwner["kind"]>;
  readonly #now: () => Date;
  readonly #fileSystem: AssetFileSystem;
  readonly #afterTempWrite: ((path: string) => Promise<void> | void) | undefined;
  readonly #beforeUnreferencedFileDelete: ((assetId: string) => Promise<void> | void) | undefined;
  readonly #randomUUID: () => string;
  readonly #installingHashes = new Map<string, number>();
  readonly #assetMutationLocks = new Map<string, Promise<void>>();
  readonly #pendingFileWrites = new Map<string, Promise<boolean>>();
  readonly #stagedSessions = new Map<string, Map<string, Set<string>>>();
  readonly #snapshotAssetLeases = new Map<string, number>();
  readonly #patentHistoryAssets = new Map<string, Set<string>>();
  readonly #verifiedDescriptors = new Map<
    string,
    { fingerprint: string; descriptor: AssetDescriptor }
  >();
  #assetMutationEpoch = 0;

  constructor(options: AssetStoreOptions) {
    this.#root = resolve(options.root);
    this.#assetRoot = resolve(this.#root, ASSET_DIRECTORY_NAME);
    this.#database = options.database;
    this.#availableOwnerTables = this.#detectAvailableOwnerTables();
    this.#now = options.now ?? (() => new Date());
    this.#fileSystem = { ...defaultFileSystem, ...options.fileSystem };
    this.#afterTempWrite = options.afterTempWrite;
    this.#beforeUnreferencedFileDelete = options.beforeUnreferencedFileDelete;
    this.#randomUUID = options.randomUUID ?? randomUUID;
  }

  async waitForIdle(): Promise<{ stagedSessionIds: string[] }> {
    let firstFailure: unknown;
    let failed = false;
    while (true) {
      const observedEpoch = this.#assetMutationEpoch;
      const pending = [...this.#assetMutationLocks.values(), ...this.#pendingFileWrites.values()];
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (!failed && result.status === "rejected") {
          failed = true;
          firstFailure = result.reason;
        }
      }
      if (
        this.#assetMutationLocks.size === 0 &&
        this.#pendingFileWrites.size === 0 &&
        observedEpoch === this.#assetMutationEpoch
      ) {
        if (failed) throw firstFailure;
        return { stagedSessionIds: [...this.#stagedSessions.keys()].sort() };
      }
    }
  }

  async leaseSnapshotAssets(assetIds: readonly string[]): Promise<() => void> {
    const leasedAssetIds: string[] = [];
    try {
      for (const assetId of [...new Set(assetIds)].sort()) {
        const candidate = this.#rowByAssetId(assetId);
        if (candidate === undefined) {
          throw new LibraryServiceError("NOT_FOUND", "Snapshot asset not found.");
        }
        await this.#withAssetMutationLock(candidate.content_hash, () => {
          if (this.#rowByAssetId(assetId) === undefined) {
            throw new LibraryServiceError("NOT_FOUND", "Snapshot asset not found.");
          }
          this.#snapshotAssetLeases.set(assetId, (this.#snapshotAssetLeases.get(assetId) ?? 0) + 1);
          leasedAssetIds.push(assetId);
        });
      }
    } catch (error) {
      this.#releaseSnapshotAssetLeases(leasedAssetIds);
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseSnapshotAssetLeases(leasedAssetIds);
    };
  }

  async install(owner: AssetOwner, asset: StoredAsset): Promise<ImportedAsset> {
    const validated = validateStoredAsset(asset);
    this.#assertOwnerExists(owner);
    return this.#withAssetMutationLock(`id:${validated.descriptor.assetId}`, () =>
      this.#withAssetMutationLock(validated.descriptor.sha256, () =>
        this.#installValidated(owner, validated),
      ),
    );
  }

  async #installValidated(owner: AssetOwner, validated: StoredAsset): Promise<ImportedAsset> {
    const contentHash = validated.descriptor.sha256;
    await this.#ensureAssetRoot();
    const existing = this.#rowByAssetId(validated.descriptor.assetId);
    if (existing && this.#ownedBy(owner, existing.asset_id)) {
      const stored = await this.#readRow(existing);
      if (JSON.stringify(stored.descriptor) === JSON.stringify(validated.descriptor)) {
        return importedAsset(stored);
      }
    }
    validated = this.#independentAsset(validated);
    const relativePath = await this.#newAssetPath(validated);

    this.#beginInstalling(contentHash);
    let createdFinalFile = false;
    try {
      createdFinalFile = await this.#writeAssetIfMissing(validated, relativePath);
      const ownerTable = this.#ownerTable(owner);
      const ownerId = this.#ownerId(owner);
      const installedAssetId = this.#database.transaction((database) => {
        const raceWinner = database
          .prepare("SELECT asset_id FROM assets WHERE relative_path = ?")
          .get(relativePath) as { asset_id: string } | undefined;
        const assetId = raceWinner?.asset_id ?? validated.descriptor.assetId;
        if (raceWinner === undefined) {
          database
            .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(
              assetId,
              contentHash,
              relativePath,
              validated.descriptor.mediaType,
              validated.descriptor.byteLength,
              validated.descriptor.widthPx,
              validated.descriptor.heightPx,
              this.#now().toISOString(),
            );
        }
        this.#insertOwnerReference(database, ownerTable, ownerId, assetId);
        return assetId;
      });
      return importedAsset(await this.readAsset(installedAssetId));
    } catch (error) {
      const finalFileExists =
        createdFinalFile || (await this.#exists(this.#safeAssetPath(relativePath)));
      if (finalFileExists && this.#installCount(contentHash) === 1) {
        await this.#removeUnregisteredFinalFile(relativePath);
      }
      throw error;
    } finally {
      this.#endInstalling(contentHash);
    }
  }

  async stageMany(
    sessionId: string,
    assets: StoredAsset[],
    operationId: string = this.#randomUUID(),
  ): Promise<ImportedAsset[]> {
    const validated = assets.map(validateStoredAsset);
    if (validated.length === 0) return [];
    const previousLeaseIds = new Set(this.#stagedSessions.get(sessionId)?.get(operationId) ?? []);
    const createdAssetIds: string[] = [];
    try {
      const imported: ImportedAsset[] = [];
      for (const asset of validated) {
        imported.push(await this.#stageOne(sessionId, operationId, asset, createdAssetIds));
      }
      return imported;
    } catch (error) {
      const operations = this.#stagedSessions.get(sessionId);
      const current = operations?.get(operationId);
      if (current) {
        for (const assetId of [...current]) {
          if (!previousLeaseIds.has(assetId)) current.delete(assetId);
        }
        if (current.size === 0) operations?.delete(operationId);
        if (operations?.size === 0) this.#stagedSessions.delete(sessionId);
      }
      for (const assetId of createdAssetIds.reverse()) {
        await this.#deleteUnreferencedAsset(assetId);
      }
      await this.cleanupOrphanTemps();
      throw error;
    }
  }

  async #stageOne(
    sessionId: string,
    operationId: string,
    asset: StoredAsset,
    createdAssetIds: string[],
  ): Promise<ImportedAsset> {
    return this.#withAssetMutationLock(`id:${asset.descriptor.assetId}`, () =>
      this.#withAssetMutationLock(asset.descriptor.sha256, async () => {
        await this.#ensureAssetRoot();
        asset = this.#independentAsset(asset);
        const contentHash = asset.descriptor.sha256;
        const relativePath = await this.#newAssetPath(asset);

        this.#beginInstalling(contentHash);
        try {
          await this.#writeAssetIfMissing(asset, relativePath);
          const installed = this.#database.transaction((database) => {
            const raceWinner = database
              .prepare("SELECT asset_id FROM assets WHERE relative_path = ?")
              .get(relativePath) as { asset_id: string } | undefined;
            if (raceWinner) return { assetId: raceWinner.asset_id, created: false };
            database
              .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
              .run(
                asset.descriptor.assetId,
                contentHash,
                relativePath,
                asset.descriptor.mediaType,
                asset.descriptor.byteLength,
                asset.descriptor.widthPx,
                asset.descriptor.heightPx,
                this.#now().toISOString(),
              );
            return { assetId: asset.descriptor.assetId, created: true };
          });
          if (installed.created) createdAssetIds.push(installed.assetId);
          this.#leaseStaged(sessionId, operationId, installed.assetId);
          return importedAsset(await this.readAsset(installed.assetId));
        } catch (error) {
          await this.#removeUnregisteredFinalFile(relativePath);
          throw error;
        } finally {
          this.#endInstalling(contentHash);
        }
      }),
    );
  }

  async commitStaged(sessionId: string, assetIds: readonly string[]): Promise<void> {
    this.#releaseStageLeases(sessionId, assetIds);
  }

  async discardStaged(
    sessionId: string,
    assetIds: readonly string[],
    operationId?: string,
  ): Promise<void> {
    const released = this.#releaseStageLeases(sessionId, assetIds, operationId);
    for (const assetId of released) {
      if (!this.#isProtected(assetId)) await this.#deleteUnreferencedAsset(assetId);
    }
  }

  async adopt(owner: AssetOwner, assetId: string): Promise<void> {
    this.#assertOwnerExists(owner);
    const asset = this.#rowByAssetId(assetId);
    if (asset === undefined) throw new LibraryServiceError("NOT_FOUND", "Asset not found.");
    await this.#withAssetMutationLock(asset.content_hash, () => this.#adoptLocked(owner, assetId));
  }

  #adoptLocked(owner: AssetOwner, assetId: string): void {
    const ownerTable = this.#ownerTable(owner);
    const ownerId = this.#ownerId(owner);
    this.#database.transaction((database) => {
      const row = database.prepare("SELECT asset_id FROM assets WHERE asset_id = ?").get(assetId) as
        | { asset_id: string }
        | undefined;
      if (row === undefined) {
        throw new LibraryServiceError("NOT_FOUND", "Asset not found.");
      }
      this.assertIndependentOwner(owner, assetId);
      this.#insertOwnerReference(database, ownerTable, ownerId, assetId);
    });
  }

  /** Ownership is a data boundary, not a content-based deduplication opportunity. */
  assertIndependentOwner(owner: AssetOwner, assetId: string): void {
    const ownerId = this.#ownerId(owner);
    for (const kind of this.#availableOwnerTables) {
      const table = this.#ownerTable({ kind });
      const rows = this.#database.read((database) =>
        database
          .prepare(`SELECT ${table.ownerColumn} AS id FROM ${table.table} WHERE asset_id = ?`)
          .all(assetId),
      ) as { id: string }[];
      if (rows.some((row) => kind !== owner.kind || row.id !== ownerId)) {
        throw new LibraryServiceError(
          "INVALID_INPUT",
          "Resource belongs to another owner; copy it before use.",
        );
      }
    }
    if (this.#availableOwnerTables.has("patent")) {
      const rows = this.#database.read((database) =>
        database
          .prepare("SELECT DISTINCT patent_id AS id FROM snapshot_assets WHERE asset_id = ?")
          .all(assetId),
      ) as { id: string }[];
      if (rows.some((row) => owner.kind !== "patent" || row.id !== ownerId)) {
        throw new LibraryServiceError(
          "INVALID_INPUT",
          "Resource belongs to another patent's history.",
        );
      }
    }
  }

  #ownedBy(owner: AssetOwner, assetId: string): boolean {
    const table = this.#ownerTable(owner);
    return (
      this.#database.read((database) =>
        database
          .prepare(`SELECT 1 FROM ${table.table} WHERE ${table.ownerColumn} = ? AND asset_id = ?`)
          .get(this.#ownerId(owner), assetId),
      ) !== undefined
    );
  }

  #independentAsset(asset: StoredAsset): StoredAsset {
    let assetId = asset.descriptor.assetId;
    while (this.#rowByAssetId(assetId)) assetId = this.#randomUUID();
    return { ...asset, descriptor: { ...asset.descriptor, assetId } };
  }

  async #newAssetPath(asset: StoredAsset): Promise<string> {
    // Keep the legacy filename shape for backup/transfer compatibility. Only the
    // first independent resource may use the original hash; subsequent copies
    // get a unique storage key unrelated to content equality.
    const legacy = this.#relativeAssetPath(asset.descriptor.sha256);
    if (!this.#rowByRelativePath(legacy) && !(await this.#exists(this.#safeAssetPath(legacy))))
      return legacy;
    let path = this.#relativeAssetPath(sha256(Buffer.from(asset.descriptor.assetId, "utf8")));
    while (this.#rowByRelativePath(path) || (await this.#exists(this.#safeAssetPath(path))))
      path = this.#relativeAssetPath(sha256(Buffer.from(this.#randomUUID(), "utf8")));
    return path;
  }

  async read(assetId: string): Promise<Uint8Array> {
    return (await this.readAsset(assetId)).original;
  }

  async preview(assetId: string): Promise<Uint8Array> {
    const row = this.#rowByAssetId(assetId);
    if (!row) throw new LibraryServiceError("NOT_FOUND", "Asset not found.");
    const fingerprint = await this.#fingerprint(row);
    const cached = this.#previews.get(assetId);
    if (cached?.fingerprint === fingerprint) return Uint8Array.from(cached.bytes);
    if (cached) {
      this.#previewBytes -= cached.bytes.byteLength;
      this.#previews.delete(assetId);
    }
    const { preview } = await this.#readRow(row);
    const current = this.#rowByAssetId(assetId);
    if (!current || fingerprint !== (await this.#fingerprint(current)))
      throw new LibraryServiceError("CORRUPT_FILE", "Asset changed during preview verification.");
    if (preview.byteLength <= 8 * 1024 * 1024) {
      // Another request may have verified and installed the same entry while
      // this read was pending. Account for replacements exactly once.
      this.#previewBytes -= this.#previews.get(assetId)?.bytes.byteLength ?? 0;
      this.#previews.set(assetId, { fingerprint, bytes: Uint8Array.from(preview) });
      this.#previewBytes += preview.byteLength;
      while (this.#previewBytes > 8 * 1024 * 1024 || this.#previews.size > 256) {
        const oldest = this.#previews.keys().next().value;
        if (!oldest) break;
        this.#previewBytes -= this.#previews.get(oldest)!.bytes.byteLength;
        this.#previews.delete(oldest);
      }
    }
    return preview;
  }

  #previews = new Map<string, { fingerprint: string; bytes: Uint8Array }>();
  #previewBytes = 0;

  async #fingerprint(row: AssetRow): Promise<string> {
    let info: BigIntStats;
    try {
      info = await this.#fileSystem.lstat(this.#safeAssetPath(row.relative_path), { bigint: true });
    } catch (error) {
      if (nativeErrorCode(error) === "ENOENT")
        throw new LibraryServiceError("CORRUPT_FILE", "Asset file is missing.");
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink())
      throw new LibraryServiceError("CORRUPT_FILE", "Asset path is unsafe.");
    return `${JSON.stringify(row)}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  }

  async readAsset(assetId: string): Promise<StoredAsset> {
    const row = this.#rowByAssetId(assetId);
    if (row === undefined) throw new LibraryServiceError("NOT_FOUND", "Asset not found.");
    return this.#readRow(row);
  }

  async readVerifiedDescriptor(assetId: string): Promise<AssetDescriptor> {
    const row = this.#rowByAssetId(assetId);
    if (!row) throw new LibraryServiceError("NOT_FOUND", "Asset not found.");
    const fingerprint = async () => {
      let info: BigIntStats;
      try {
        info = await this.#fileSystem.lstat(this.#safeAssetPath(row.relative_path), {
          bigint: true,
        });
      } catch (error) {
        if (nativeErrorCode(error) === "ENOENT")
          throw new LibraryServiceError("CORRUPT_FILE", "Asset file is missing.");
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink())
        throw new LibraryServiceError("CORRUPT_FILE", "Asset path is unsafe.");
      return `${JSON.stringify(row)}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    };
    const before = await fingerprint();
    const cached = this.#verifiedDescriptors.get(assetId);
    if (cached?.fingerprint === before) return structuredClone(cached.descriptor);
    this.#verifiedDescriptors.delete(assetId);
    const descriptor = (await this.#readRow(row)).descriptor;
    // Do not associate bytes read before a concurrent replacement with its new fingerprint.
    if (before !== (await fingerprint()))
      throw new LibraryServiceError(
        "CORRUPT_FILE",
        "Asset changed during verification; retry the save.",
      );
    this.#verifiedDescriptors.set(assetId, {
      fingerprint: before,
      descriptor: structuredClone(descriptor),
    });
    // Metadata only: a CAD edit history routinely exceeds 256 resources. A smaller
    // cache causes every sequential save/close pass to evict the next needed entry.
    if (this.#verifiedDescriptors.size > 16_384) {
      const oldest = this.#verifiedDescriptors.keys().next().value;
      if (oldest) this.#verifiedDescriptors.delete(oldest);
    }
    return descriptor;
  }

  async release(owner: AssetOwner): Promise<void> {
    const ownerTable = this.#ownerTable(owner);
    const ownerId = this.#ownerId(owner);
    this.#database.transaction((database) => {
      database
        .prepare(`DELETE FROM ${ownerTable.table} WHERE ${ownerTable.ownerColumn} = ?`)
        .run(ownerId);
    });
  }

  retainPatentHistoryAssets(patentId: string): void {
    const retained = this.#patentHistoryAssets.get(patentId) ?? new Set<string>();
    const rows = this.#database.read((database) =>
      database.prepare("SELECT asset_id FROM patent_assets WHERE patent_id = ?").all(patentId),
    ) as { asset_id: string }[];
    for (const row of rows) retained.add(row.asset_id);
    this.#patentHistoryAssets.set(patentId, retained);
  }

  releasePatentHistoryAssets(patentId: string): void {
    this.#patentHistoryAssets.delete(patentId);
  }

  async collectUnreferenced(owner?: AssetOwner): Promise<AssetCollectionReport> {
    await this.#ensureAssetRoot();
    const ownerTable = owner ? this.#ownerTable(owner) : undefined;
    const rows = ownerTable
      ? (this.#database.read((database) =>
          database
            .prepare(
              `SELECT asset_id,
                  content_hash,
                  relative_path,
                  mime_type,
                  byte_length,
                  width,
                  height,
                  created_at
           FROM assets
           WHERE NOT EXISTS (
             SELECT 1 FROM ${ownerTable.table} WHERE ${ownerTable.table}.asset_id = assets.asset_id
           )
           ORDER BY asset_id`,
            )
            .all(),
        ) as AssetRow[])
      : this.#assetRows();
    const deletedAssetIds: string[] = [];
    const failedAssetIds: string[] = [];
    for (const row of rows) {
      if (this.#installCount(row.content_hash) !== 0) continue;
      if (this.#isProtected(row.asset_id)) continue;
      if (this.#referenceCount(row.asset_id) !== 0) continue;
      try {
        if (await this.#deleteUnreferencedAsset(row.asset_id)) {
          deletedAssetIds.push(row.asset_id);
        }
      } catch (error) {
        if (nativeErrorCode(error) !== "ENOENT") {
          failedAssetIds.push(row.asset_id);
        }
      }
    }
    return { deletedAssetIds, failedAssetIds };
  }

  async cleanupOrphanTemps(): Promise<void> {
    await this.#ensureAssetRoot();
    const entries = await this.#fileSystem.readdir(this.#assetRoot);
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && ORPHAN_TEMP_PATTERN.test(entry.name))
        .map((entry) =>
          this.#fileSystem.unlink(this.#safeAssetPath(entry.name)).catch(() => undefined),
        ),
    );
  }

  async reconcile(): Promise<AssetReconciliationReport> {
    await this.cleanupOrphanTemps();
    const rows = this.#assetRows();
    const quarantinedAssetIds: string[] = [];
    for (const row of rows) {
      try {
        await this.#readRow(row);
      } catch (error) {
        quarantinedAssetIds.push(row.asset_id);
        this.#quarantineAsset(row.asset_id, error);
      }
    }
    return { quarantinedAssetIds };
  }

  references(scope: AssetOwnerScope, assetIds: readonly string[]): string[] {
    if (assetIds.length === 0) return [];
    const ownerTable = this.#ownerTable(scope);
    const uniqueAssetIds = [...new Set(assetIds)];
    return this.#database.read((database) => {
      const statement = database.prepare(
        `SELECT ${ownerTable.ownerColumn} AS owner_id FROM ${ownerTable.table} WHERE asset_id = ? ORDER BY ${ownerTable.ownerColumn}`,
      );
      const ownerIds = new Set<string>();
      for (const assetId of uniqueAssetIds) {
        for (const row of statement.all(assetId) as Array<{ owner_id: string }>) {
          ownerIds.add(row.owner_id);
        }
      }
      return [...ownerIds].sort((left, right) => left.localeCompare(right));
    });
  }

  #detectAvailableOwnerTables(): ReadonlySet<AssetOwner["kind"]> {
    return this.#database.read((database) => {
      const rows = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('document_assets', 'patent_assets', 'template_assets')",
        )
        .all() as Array<{ name: string }>;
      return new Set<AssetOwner["kind"]>(
        rows.map((row) => {
          if (row.name === "document_assets") return "library-document";
          if (row.name === "patent_assets") return "patent";
          return "patent-template";
        }),
      );
    });
  }

  #ownerTable(owner: AssetOwner | AssetOwnerScope): AssetOwnerTable {
    if (!this.#availableOwnerTables.has(owner.kind)) {
      throw new LibraryServiceError("INVALID_INPUT", "Asset owner kind is unavailable.");
    }
    if (owner.kind === "library-document") {
      return {
        table: "document_assets",
        ownerColumn: "library_document_id",
        entityTable: "documents",
      };
    }
    if (owner.kind === "patent") {
      return { table: "patent_assets", ownerColumn: "patent_id", entityTable: "patents" };
    }
    return {
      table: "template_assets",
      ownerColumn: "template_id",
      entityTable: "patent_template_slots",
    };
  }

  #ownerId(owner: AssetOwner): string {
    if (owner.kind === "library-document") return owner.libraryDocumentId;
    if (owner.kind === "patent") return owner.patentId;
    return owner.templateId;
  }

  #insertOwnerReference(
    database: Parameters<Parameters<LibraryDatabase["transaction"]>[0]>[0],
    ownerTable: AssetOwnerTable,
    ownerId: string,
    assetId: string,
  ): void {
    if (ownerTable.table === "template_assets") {
      database
        .prepare(
          "INSERT OR IGNORE INTO template_assets(template_id, asset_id, purpose) VALUES (?, ?, 'chemical-preview')",
        )
        .run(ownerId, assetId);
      return;
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO ${ownerTable.table}(${ownerTable.ownerColumn}, asset_id) VALUES (?, ?)`,
      )
      .run(ownerId, assetId);
  }

  #assertOwnerExists(owner: AssetOwner): void {
    const ownerTable = this.#ownerTable(owner);
    const ownerId = this.#ownerId(owner);
    const exists = this.#database.read((database) =>
      database
        .prepare(`SELECT 1 FROM ${ownerTable.entityTable} WHERE ${ownerTable.ownerColumn} = ?`)
        .get(ownerId),
    );
    if (exists === undefined) throw new LibraryServiceError("NOT_FOUND", "Asset owner not found.");
  }

  async #writeAssetIfMissing(asset: StoredAsset, relativePath: string): Promise<boolean> {
    const pending = this.#pendingFileWrites.get(relativePath);
    if (pending !== undefined) {
      await pending;
      return false;
    }

    const write = this.#writeAssetIfMissingOnce(asset, relativePath);
    this.#pendingFileWrites.set(relativePath, write);
    try {
      return await write;
    } finally {
      if (this.#pendingFileWrites.get(relativePath) === write) {
        this.#pendingFileWrites.delete(relativePath);
      }
    }
  }

  async #writeAssetIfMissingOnce(asset: StoredAsset, finalRelativePath: string): Promise<boolean> {
    const finalPath = this.#safeAssetPath(finalRelativePath);
    if (await this.#exists(finalPath)) return false;

    const tempRelativePath = `${finalRelativePath.slice(0, -ASSET_FILE_EXTENSION.length)}.tmp-${this.#randomUUID()}`;
    const tempPath = this.#safeAssetPath(tempRelativePath);
    const payload = encodeAssetPayload(asset);
    const handle = await this.#fileSystem.open(tempPath, "wx");
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.#afterTempWrite?.(tempPath);
    try {
      await this.#fileSystem.rename(tempPath, finalPath);
      return true;
    } catch (error) {
      if (nativeErrorCode(error) !== "EEXIST") throw error;
      await this.#fileSystem.unlink(tempPath).catch(() => undefined);
      return false;
    }
  }

  async #removeUnregisteredFinalFile(relativePath: string): Promise<void> {
    if (this.#rowByRelativePath(relativePath) !== undefined) return;
    try {
      await this.#fileSystem.unlink(this.#safeAssetPath(relativePath));
    } catch (error) {
      if (nativeErrorCode(error) !== "ENOENT") throw error;
    }
  }

  async #readRow(row: AssetRow): Promise<StoredAsset> {
    const filePath = this.#safeAssetPath(row.relative_path);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await this.#fileSystem.lstat(filePath);
    } catch (error) {
      if (nativeErrorCode(error) === "ENOENT") {
        throw new LibraryServiceError("CORRUPT_FILE", "Asset file is missing.");
      }
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new LibraryServiceError("CORRUPT_FILE", "Asset path is unsafe.");
    }
    const payload = decodeAssetPayload(await this.#fileSystem.readFile(filePath));
    const descriptor = AssetDescriptorSchema.parse({
      ...payload.descriptor,
      assetId: row.asset_id,
    });
    const stored = validateStoredAsset({
      descriptor,
      original: payload.original,
      preview: payload.preview,
    });
    if (
      stored.descriptor.sha256 !== row.content_hash ||
      stored.descriptor.mediaType !== row.mime_type ||
      stored.descriptor.byteLength !== row.byte_length ||
      stored.descriptor.widthPx !== row.width ||
      stored.descriptor.heightPx !== row.height
    ) {
      throw new LibraryServiceError("CORRUPT_FILE", "Asset metadata mismatch.");
    }
    return cloneStoredAsset(stored);
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await this.#fileSystem.access(path);
      return true;
    } catch (error) {
      if (nativeErrorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async #ensureAssetRoot(): Promise<void> {
    await this.#fileSystem.mkdir(this.#assetRoot, { recursive: true });
  }

  #relativeAssetPath(contentHash: string): string {
    if (!/^[0-9A-F]{64}$/u.test(contentHash)) {
      throw new LibraryServiceError("INVALID_INPUT", "Asset hash is invalid.");
    }
    return `${contentHash}${ASSET_FILE_EXTENSION}`;
  }

  #safeAssetPath(relativePath: string): string {
    if (!/^[0-9A-F]{64}(?:\.asset|\.tmp-[0-9a-f-]{36})$/u.test(relativePath)) {
      throw new LibraryServiceError("CORRUPT_FILE", "Asset path is invalid.");
    }
    const fullPath = resolve(this.#assetRoot, relativePath);
    const fromRoot = relative(this.#assetRoot, fullPath);
    if (fromRoot.startsWith("..") || fromRoot === "" || resolve(fromRoot) === fromRoot) {
      throw new LibraryServiceError("CORRUPT_FILE", "Asset path escapes the library.");
    }
    return fullPath;
  }

  #rowByRelativePath(relativePath: string): AssetRow | undefined {
    return this.#database.read((database) =>
      database
        .prepare(
          `SELECT asset_id,
                  content_hash,
                  relative_path,
                  mime_type,
                  byte_length,
                  width,
                  height,
                  created_at
           FROM assets
           WHERE relative_path = ?`,
        )
        .get(relativePath),
    ) as AssetRow | undefined;
  }

  #rowByAssetId(assetId: string): AssetRow | undefined {
    return this.#database.read((database) =>
      database
        .prepare(
          `SELECT asset_id,
                  content_hash,
                  relative_path,
                  mime_type,
                  byte_length,
                  width,
                  height,
                  created_at
           FROM assets
           WHERE asset_id = ?`,
        )
        .get(assetId),
    ) as AssetRow | undefined;
  }

  #assetRows(): AssetRow[] {
    return this.#database.read((database) =>
      database
        .prepare(
          `SELECT asset_id,
                  content_hash,
                  relative_path,
                  mime_type,
                  byte_length,
                  width,
                  height,
                  created_at
           FROM assets
           ORDER BY asset_id`,
        )
        .all(),
    ) as AssetRow[];
  }

  #referenceCount(assetId: string): number {
    return this.#database.read((database) => {
      if (
        database
          .prepare("SELECT 1 FROM library_state WHERE key = 'snapshot-asset-index-incomplete'")
          .get() !== undefined
      ) {
        return 1;
      }
      let count = 0;
      for (const kind of this.#availableOwnerTables) {
        const table = this.#ownerTable({ kind });
        count += (
          database
            .prepare(`SELECT count(*) AS count FROM ${table.table} WHERE asset_id = ?`)
            .get(assetId) as { count: number }
        ).count;
      }
      const snapshotTable = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'snapshot_assets'")
        .get();
      if (snapshotTable !== undefined) {
        count += (
          database
            .prepare("SELECT count(*) AS count FROM snapshot_assets WHERE asset_id = ?")
            .get(assetId) as { count: number }
        ).count;
      }
      return count;
    });
  }

  #beginInstalling(contentHash: string): void {
    this.#installingHashes.set(contentHash, this.#installCount(contentHash) + 1);
  }

  #endInstalling(contentHash: string): void {
    const count = this.#installCount(contentHash);
    if (count <= 1) this.#installingHashes.delete(contentHash);
    else this.#installingHashes.set(contentHash, count - 1);
  }

  #installCount(contentHash: string): number {
    return this.#installingHashes.get(contentHash) ?? 0;
  }

  async #withAssetMutationLock<T>(
    contentHash: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    this.#assetMutationEpoch += 1;
    const previous = this.#assetMutationLocks.get(contentHash) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#assetMutationLocks.set(contentHash, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#assetMutationLocks.get(contentHash) === current) {
        this.#assetMutationLocks.delete(contentHash);
      }
      this.#assetMutationEpoch += 1;
    }
  }

  #leaseStaged(sessionId: string, operationId: string, assetId: string): void {
    const operations = this.#stagedSessions.get(sessionId) ?? new Map<string, Set<string>>();
    const leases = operations.get(operationId) ?? new Set<string>();
    leases.add(assetId);
    operations.set(operationId, leases);
    this.#stagedSessions.set(sessionId, operations);
  }

  #releaseStageLeases(
    sessionId: string,
    assetIds: readonly string[],
    operationId?: string,
  ): string[] {
    const operations = this.#stagedSessions.get(sessionId);
    if (!operations) return [];
    const released: string[] = [];
    const targets = operationId
      ? [[operationId, operations.get(operationId)] as const]
      : [...operations.entries()];
    for (const [currentOperationId, leases] of targets) {
      if (!leases) continue;
      for (const assetId of new Set(assetIds)) {
        if (!leases.delete(assetId)) continue;
        released.push(assetId);
      }
      if (leases.size === 0) operations.delete(currentOperationId);
    }
    if (operations.size === 0) this.#stagedSessions.delete(sessionId);
    return [...new Set(released)];
  }

  #isStaged(assetId: string): boolean {
    for (const operations of this.#stagedSessions.values()) {
      for (const leases of operations.values()) {
        if (leases.has(assetId)) return true;
      }
    }
    return false;
  }

  #isProtected(assetId: string): boolean {
    return (
      this.#isStaged(assetId) ||
      (this.#snapshotAssetLeases.get(assetId) ?? 0) > 0 ||
      [...this.#patentHistoryAssets.values()].some((assets) => assets.has(assetId))
    );
  }

  #releaseSnapshotAssetLeases(assetIds: readonly string[]): void {
    for (const assetId of assetIds) {
      const count = this.#snapshotAssetLeases.get(assetId) ?? 0;
      if (count <= 1) this.#snapshotAssetLeases.delete(assetId);
      else this.#snapshotAssetLeases.set(assetId, count - 1);
    }
  }

  async #deleteUnreferencedAsset(assetId: string): Promise<boolean> {
    const asset = this.#rowByAssetId(assetId);
    if (asset === undefined) return false;
    return this.#withAssetMutationLock(asset.content_hash, async () => {
      const row = this.#rowByAssetId(assetId);
      if (
        row === undefined ||
        this.#installCount(row.content_hash) !== 0 ||
        this.#referenceCount(assetId) !== 0 ||
        this.#isProtected(assetId)
      ) {
        return false;
      }
      await this.#beforeUnreferencedFileDelete?.(assetId);
      try {
        await this.#fileSystem.unlink(this.#safeAssetPath(row.relative_path));
      } catch (error) {
        if (nativeErrorCode(error) !== "ENOENT") throw error;
      }
      return this.#database.transaction((database) => {
        if (
          database
            .prepare("SELECT 1 FROM library_state WHERE key = 'snapshot-asset-index-incomplete'")
            .get() !== undefined
        ) {
          return false;
        }
        let count = 0;
        for (const kind of this.#availableOwnerTables) {
          const table = this.#ownerTable({ kind });
          count += (
            database
              .prepare(`SELECT count(*) AS count FROM ${table.table} WHERE asset_id = ?`)
              .get(assetId) as { count: number }
          ).count;
        }
        const snapshotTable = database
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'snapshot_assets'")
          .get();
        if (snapshotTable !== undefined) {
          count += (
            database
              .prepare("SELECT count(*) AS count FROM snapshot_assets WHERE asset_id = ?")
              .get(assetId) as { count: number }
          ).count;
        }
        if (count !== 0 || this.#isProtected(assetId)) return false;
        database.prepare("DELETE FROM assets WHERE asset_id = ?").run(assetId);
        return true;
      });
    });
  }

  #quarantineAsset(assetId: string, error: unknown): void {
    const now = this.#now().toISOString();
    const diagnostic = Buffer.from(
      JSON.stringify({
        code: error instanceof LibraryServiceError ? error.code : "CORRUPT_FILE",
        message: error instanceof Error ? error.message : "Asset recovery failed.",
        quarantinedAt: now,
      }),
      "utf8",
    );
    this.#database.transaction((database) => {
      database
        .prepare(
          `INSERT OR REPLACE INTO library_state(key, value, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(`asset:${assetId}:quarantine`, diagnostic, now);
    });
  }
}
