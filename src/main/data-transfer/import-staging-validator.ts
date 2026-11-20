import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TransferManifest } from "../../shared/data-transfer/model.js";
import { TransferManifestSchema } from "../../shared/data-transfer/model.js";
import {
  MAX_TEXT_POLISH_HISTORY_JSON_BYTES,
  validateTextPolishHistoryEntry,
} from "../../shared/data-transfer/text-polish-history.js";
import { LibraryEditBatchSchema } from "../../shared/library/edit-operations.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { patentDocumentSnapshot } from "../../shared/patent/snapshot-scope.js";
import { DraftService } from "../drafts/draft-service.js";
import {
  decodeDocumentSnippet,
  decodeDocumentTitle,
  decodeEnvelope,
  decodePatentRecoverySnapshot,
  decodeSnapshotDocument,
  hashJson,
  loadLibraryDocumentForValidation,
} from "../library/edit-journal.js";
import { createLibraryRuntime, type LibraryRuntime } from "../library/library-runtime.js";
import { decodeBytes, decodeJson } from "../library/plaintext-codec.js";
import { parsePatentEditPayload, replayPatentEdit } from "../library/recovery-service.js";
import { CURRENT_SCHEMA_VERSION, validateCurrentSchema } from "../library/schema.js";

import {
  CORE_DATA_TRANSFER_TABLES,
  type DataTransferDomainValidator,
  DataTransferDomainValidatorRegistry,
  FLOWCHART_DATA_TRANSFER_TABLES,
} from "./domain-validator-registry.js";
import type { OwnedImportStagingCapability } from "./empty-library-inspector.js";

export type ImportValidationCategory =
  | "manifest"
  | "database"
  | "patent"
  | "document"
  | "snapshot"
  | "draft"
  | "asset"
  | "template"
  | "flowchart";

export class ImportStagingValidationError extends Error {
  override readonly name = "ImportStagingValidationError";
  readonly code = "PACKAGE_TAMPERED" as const;

  constructor(readonly category: ImportValidationCategory) {
    super("导入数据未通过完整性验证。");
    delete this.stack;
  }
}

export type ImportStagingValidationSummary = Readonly<{
  activePatents: number;
  trashedPatents: number;
  documents: number;
  legacyDrafts: number;
  snapshots: number;
  assets: number;
  flowchartProjects: number;

  totalBytes: number;
}>;

export type ImportStagingLayout = Readonly<{
  libraryRoot: string;
  userDataRoot: string;
  /** During post-swap validation this points at the preserved package root. */
  packageRoot?: string;
  /** During post-swap validation this points at the preserved extracted settings root. */
  portableSettingsRoot?: string;
  /** During post-swap validation this points at the preserved legacy-drafts root. */
  legacyDraftsRoot?: string;
  polishHistoryRoot?: string;
  /** Final installed layout stores the package's `library/` entries directly in libraryRoot. */
  installed?: boolean;
  /** Hash captured after preparation-time recovery has finished mutating the staged database. */
  installedDatabaseIntegrity?: Readonly<{ byteLength: number; sha256: string }>;
  libraryCapability?: OwnedImportStagingCapability;
  userDataCapability?: OwnedImportStagingCapability;
  libraryDirectoryCapability?: OwnedImportStagingCapability;
  legacyDraftsCapability?: OwnedImportStagingCapability;
}>;

type ResolvedImportStagingLayout = Readonly<{
  libraryRoot: string;
  userDataRoot: string;
  packageRoot?: string;
  portableSettingsRoot?: string;
  legacyDraftsRoot?: string;
  polishHistoryRoot?: string;
  installed: boolean;
  installedDatabaseIntegrity?: Readonly<{ byteLength: number; sha256: string }>;
  libraryCapability?: OwnedImportStagingCapability;
  userDataCapability?: OwnedImportStagingCapability;
  libraryDirectoryCapability?: OwnedImportStagingCapability;
  legacyDraftsCapability?: OwnedImportStagingCapability;
}>;

type PatentSnapshotRow = {
  patent_id: string;
  revision: number;
  model_version: number;
  payload: Uint8Array;
  content_hash: string;
};

type DocumentSnapshotRow = {
  library_document_id: string;
  revision: number;
  model_version: number;
  payload: Uint8Array;
  content_hash: string;
};

type PatentEditRow = {
  operation_id: string;
  patent_id: string;
  base_revision: number;
  target_revision: number;
  payload: Uint8Array;
  content_hash: string;
  created_at: string;
};

function fail(category: ImportValidationCategory): never {
  throw new ImportStagingValidationError(category);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function normalize(category: ImportValidationCategory, error: unknown): never {
  if (error instanceof ImportStagingValidationError) throw error;
  fail(category);
}

function count(runtime: LibraryRuntime, sql: string): number {
  const value = runtime.database.read(
    (database) => database.prepare(sql).get() as { count?: unknown } | undefined,
  )?.count;
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("database");
  return value as number;
}

function resolvedLayout(input: string | ImportStagingLayout): ResolvedImportStagingLayout {
  if (typeof input === "string") {
    const root = resolve(input);
    return Object.freeze({ libraryRoot: root, userDataRoot: root, installed: false });
  }
  return Object.freeze({
    libraryRoot: resolve(input.libraryRoot),
    userDataRoot: resolve(input.userDataRoot),
    ...(input.packageRoot ? { packageRoot: resolve(input.packageRoot) } : {}),
    ...(input.portableSettingsRoot
      ? { portableSettingsRoot: resolve(input.portableSettingsRoot) }
      : {}),
    ...(input.legacyDraftsRoot ? { legacyDraftsRoot: resolve(input.legacyDraftsRoot) } : {}),
    ...(input.polishHistoryRoot ? { polishHistoryRoot: resolve(input.polishHistoryRoot) } : {}),
    installed: input.installed === true,
    ...(input.installedDatabaseIntegrity
      ? { installedDatabaseIntegrity: input.installedDatabaseIntegrity }
      : {}),
    ...(input.libraryCapability ? { libraryCapability: input.libraryCapability } : {}),
    ...(input.userDataCapability ? { userDataCapability: input.userDataCapability } : {}),
    ...(input.libraryDirectoryCapability
      ? { libraryDirectoryCapability: input.libraryDirectoryCapability }
      : {}),
    ...(input.legacyDraftsCapability
      ? { legacyDraftsCapability: input.legacyDraftsCapability }
      : {}),
  });
}

function entryRoot(layout: ResolvedImportStagingLayout, logicalPath: string): string {
  if (logicalPath.startsWith("text-polish-history/"))
    return layout.polishHistoryRoot ?? layout.userDataRoot;
  if (layout.installed && logicalPath.startsWith("library/")) return layout.libraryRoot;
  if (layout.installed && logicalPath === "portable-settings.json") {
    return layout.portableSettingsRoot ?? layout.userDataRoot;
  }
  if (layout.installed && logicalPath.startsWith("legacy-drafts/")) {
    return layout.legacyDraftsRoot ?? layout.userDataRoot;
  }
  if (
    layout.installed &&
    (logicalPath.startsWith("secrets/") || logicalPath.startsWith("verification/"))
  ) {
    return layout.packageRoot ?? layout.libraryRoot;
  }
  return logicalPath === "portable-settings.json" || logicalPath.startsWith("legacy-drafts/")
    ? layout.userDataRoot
    : layout.libraryRoot;
}

function safeEntryPath(layout: ResolvedImportStagingLayout, logicalPath: string): string {
  const root = entryRoot(layout, logicalPath);
  const relativePath =
    layout.polishHistoryRoot && logicalPath.startsWith("text-polish-history/")
      ? logicalPath.slice("text-polish-history/".length)
      : layout.installed && logicalPath.startsWith("library/")
        ? logicalPath.slice("library/".length)
        : layout.installed &&
            layout.legacyDraftsRoot !== undefined &&
            logicalPath.startsWith("legacy-drafts/")
          ? logicalPath.slice("legacy-drafts/".length)
          : logicalPath;
  const target = resolve(root, ...relativePath.split("/"));
  const fromRoot = relative(root, target);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    fail("manifest");
  }
  return target;
}

function capabilityForRoot(
  layout: ResolvedImportStagingLayout,
  root: string,
): OwnedImportStagingCapability | undefined {
  if (samePath(layout.libraryRoot, root)) return layout.libraryCapability;
  if (samePath(layout.userDataRoot, root)) return layout.userDataCapability;
  if (layout.portableSettingsRoot && samePath(layout.portableSettingsRoot, root)) return undefined;
  if (layout.legacyDraftsRoot && samePath(layout.legacyDraftsRoot, root)) return undefined;
  if (layout.packageRoot && samePath(layout.packageRoot, root)) return undefined;
  if (layout.polishHistoryRoot && samePath(layout.polishHistoryRoot, root)) return undefined;
  fail("manifest");
}

function childCapabilityForLogicalPath(
  layout: ResolvedImportStagingLayout,
  logicalPath: string,
): OwnedImportStagingCapability | undefined {
  if (logicalPath.startsWith("library/")) return layout.libraryDirectoryCapability;
  if (logicalPath.startsWith("legacy-drafts/")) return layout.legacyDraftsCapability;
  return undefined;
}

function childRootForLogicalPath(
  layout: ResolvedImportStagingLayout,
  logicalPath: string,
): string | undefined {
  if (logicalPath.startsWith("library/")) {
    return layout.installed ? layout.libraryRoot : join(layout.libraryRoot, "library");
  }
  if (logicalPath.startsWith("legacy-drafts/")) {
    return layout.legacyDraftsRoot ?? join(layout.userDataRoot, "legacy-drafts");
  }
  return undefined;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function libraryDataRoot(layout: ResolvedImportStagingLayout): string {
  return layout.installed ? layout.libraryRoot : join(layout.libraryRoot, "library");
}

async function assertLayoutRoot(
  root: string,
  capability: OwnedImportStagingCapability | undefined,
): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(root, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !samePath(await realpath(root), root)
    ) {
      fail("manifest");
    }
  } catch (error) {
    if (error instanceof ImportStagingValidationError) throw error;
    fail("manifest");
  }
  if (
    capability &&
    (String(metadata.dev) !== capability.identity.device ||
      String(metadata.ino) !== capability.identity.inode ||
      String(metadata.birthtimeNs) !== capability.identity.birthtimeNs ||
      !samePath(capability.root, root))
  ) {
    fail("manifest");
  }
}

async function assertPlainPath(
  root: string,
  target: string,
  capability?: OwnedImportStagingCapability,
  childRoot?: string,
  childCapability?: OwnedImportStagingCapability,
): Promise<void> {
  await assertLayoutRoot(root, capability);
  if (childRoot) await assertLayoutRoot(childRoot, childCapability);
  const fromRoot = relative(root, target);
  const segments = fromRoot === "" ? [] : fromRoot.split(sep);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) fail("manifest");
    if (!samePath(await realpath(current), current)) fail("manifest");
  }
  await assertLayoutRoot(root, capability);
  if (childRoot) await assertLayoutRoot(childRoot, childCapability);
}

async function hashFile(
  root: string,
  path: string,
  capability?: OwnedImportStagingCapability,
  childRoot?: string,
  childCapability?: OwnedImportStagingCapability,
): Promise<{ bytes: number; sha256: string }> {
  await assertPlainPath(root, path, capability, childRoot, childCapability);
  const handle = await open(path, "r");
  try {
    const [beforePath, beforeHandle] = await Promise.all([
      lstat(path, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (
      !beforePath.isFile() ||
      beforePath.isSymbolicLink() ||
      !beforeHandle.isFile() ||
      beforePath.dev !== beforeHandle.dev ||
      beforePath.ino !== beforeHandle.ino ||
      beforePath.size !== beforeHandle.size
    ) {
      fail("manifest");
    }
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { fd: handle.fd, autoClose: false })) {
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      if (!Number.isSafeInteger(bytes)) fail("manifest");
      hash.update(value);
    }
    const [afterPath, afterHandle] = await Promise.all([
      lstat(path, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (
      afterPath.dev !== beforePath.dev ||
      afterPath.ino !== beforePath.ino ||
      afterPath.size !== beforePath.size ||
      afterPath.mtimeNs !== beforePath.mtimeNs ||
      afterPath.ctimeNs !== beforePath.ctimeNs ||
      afterHandle.dev !== beforeHandle.dev ||
      afterHandle.ino !== beforeHandle.ino ||
      afterHandle.size !== beforeHandle.size ||
      afterHandle.mtimeNs !== beforeHandle.mtimeNs ||
      afterHandle.ctimeNs !== beforeHandle.ctimeNs
    ) {
      fail("manifest");
    }
    await assertPlainPath(root, path, capability, childRoot, childCapability);
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function inspectFrozenDatabase(
  databasePath: string,
  root: string,
  capability: OwnedImportStagingCapability | undefined,
  childRoot: string,
  childCapability: OwnedImportStagingCapability | undefined,
): Promise<{ fingerprint: string; schemaVersion: number | null; currentSchemaValid: boolean }> {
  await assertLayoutRoot(root, capability);
  await assertLayoutRoot(childRoot, childCapability);
  const { LibraryDatabase } = await import("../library/library-database.js");
  using database = LibraryDatabase.openReadOnly(databasePath);
  const rows = database.read((connection) =>
    connection
      .prepare(
        `SELECT type, name, tbl_name AS tableName, sql
         FROM sqlite_master
         WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all(),
  );
  const result = {
    fingerprint: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    schemaVersion: database.schemaVersion(),
    currentSchemaValid: database.read(validateCurrentSchema).ok,
  };
  await assertLayoutRoot(root, capability);
  await assertLayoutRoot(childRoot, childCapability);
  return result;
}

function validateManifestAccounting(manifest: TransferManifest): void {
  const paths = new Set<string>();
  let totalOriginalBytes = 0;
  let totalChunkCount = 0;
  for (const [index, entry] of manifest.entries.entries()) {
    if (entry.ordinal !== index || paths.has(entry.logicalPath)) fail("manifest");
    const expectedKind = entry.logicalPath.startsWith("text-polish-history/")
      ? "text-polish-history"
      : entry.logicalPath === "library/library.sqlite3"
        ? "database"
        : entry.logicalPath.startsWith("library/assets/")
          ? "asset"
          : entry.logicalPath.startsWith("legacy-drafts/")
            ? "legacy-draft"
            : entry.logicalPath === "portable-settings.json"
              ? "settings"
              : entry.logicalPath === "verification/integrity-summary.json"
                ? "verification"
                : undefined;
    if (expectedKind === undefined || entry.kind !== expectedKind) fail("manifest");
    paths.add(entry.logicalPath);
    totalOriginalBytes += entry.originalBytes;
    totalChunkCount += entry.chunkCount;
    if (!Number.isSafeInteger(totalOriginalBytes) || !Number.isSafeInteger(totalChunkCount)) {
      fail("manifest");
    }
  }
  if (
    totalOriginalBytes !== manifest.totalOriginalBytes ||
    totalChunkCount !== manifest.totalChunkCount
  ) {
    fail("manifest");
  }
  const databaseEntries = manifest.entries.filter((entry) => entry.kind === "database");
  if (
    databaseEntries.length !== 1 ||
    databaseEntries[0]?.logicalPath !== "library/library.sqlite3"
  ) {
    fail("manifest");
  }
  for (const required of ["portable-settings.json", "verification/integrity-summary.json"]) {
    if (!paths.has(required)) fail("manifest");
  }
}

async function validateManifestFiles(
  layout: ResolvedImportStagingLayout,
  manifest: TransferManifest,
): Promise<void> {
  validateManifestAccounting(manifest);
  try {
    await lstat(join(libraryDataRoot(layout), "key-envelope.bin"));
    fail("manifest");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  await assertLayoutRoot(layout.libraryRoot, layout.libraryCapability);
  await assertLayoutRoot(layout.userDataRoot, layout.userDataCapability);
  for (const entry of manifest.entries) {
    const root = entryRoot(layout, entry.logicalPath);
    const childRoot = childRootForLogicalPath(layout, entry.logicalPath);
    const digest = await hashFile(
      root,
      safeEntryPath(layout, entry.logicalPath),
      capabilityForRoot(layout, root),
      childRoot,
      childCapabilityForLogicalPath(layout, entry.logicalPath),
    );
    const expected =
      layout.installed && entry.kind === "database"
        ? layout.installedDatabaseIntegrity
        : { byteLength: entry.originalBytes, sha256: entry.sha256 };
    if (!expected || digest.bytes !== expected.byteLength || digest.sha256 !== expected.sha256) {
      fail("manifest");
    }
  }
  await assertLayoutRoot(layout.libraryRoot, layout.libraryCapability);
  await assertLayoutRoot(layout.userDataRoot, layout.userDataCapability);
  const frozenDatabase = await inspectFrozenDatabase(
    safeEntryPath(layout, "library/library.sqlite3"),
    layout.libraryRoot,
    layout.libraryCapability,
    childRootForLogicalPath(layout, "library/library.sqlite3") ?? libraryDataRoot(layout),
    childCapabilityForLogicalPath(layout, "library/library.sqlite3"),
  );
  // A verified older package is upgraded in staging. Its installed database
  // must still match the post-recovery digest above and the full current schema.
  const upgradedInstalledSchema =
    layout.installed &&
    [10, 11, 12, 13, 14, 15].includes(manifest.databaseSchemaVersion) &&
    frozenDatabase.currentSchemaValid;
  if (
    !upgradedInstalledSchema &&
    (frozenDatabase.fingerprint !== manifest.databaseSchemaFingerprint ||
      frozenDatabase.schemaVersion !== manifest.databaseSchemaVersion)
  ) {
    fail("manifest");
  }
}

// Storage materializes omitted rotations as zero; compare recovered meaning, not
// that optional representation. Envelope/content hashes remain checked separately.
function patentRecoveryStateHash(patent: CanonicalPatent): string {
  // Editable workspaces are validated live, independently of document history.
  const document = patentDocumentSnapshot(patent);
  return hashJson({
    ...document,
    figures: document.figures.map(({ rotationDeg, ...figure }) => ({
      ...figure,
      rotationDeg: rotationDeg ?? 0,
    })),
  });
}

function coreValidator(): DataTransferDomainValidator {
  return {
    id: "core",
    ownedTables: CORE_DATA_TRANSFER_TABLES,
    async validate(runtime, manifest) {
      try {
        if (
          runtime.recoveryReport.mode !== "read-write" ||
          runtime.recoveryReport.quarantinedPatentIds.length > 0
        ) {
          fail("patent");
        }

        const active = await runtime.patents.list("active");
        const trash = await runtime.patents.list("trash");
        try {
          if ([...active, ...trash].some((patent) => patent.recoveryState !== "healthy")) {
            fail("patent");
          }
          for (const patent of active) {
            const opened = await runtime.patents.open(patent.patentId);
            await runtime.patents.release(opened.sessionId);
          }
        } catch (error) {
          normalize("patent", error);
        }

        // Design cases are recovered and validated from their independent durable state.
        // Their full-state edits do not depend on an ordinary patent snapshot anchor.
        const designPatentIds = new Set(
          [...active, ...trash]
            .filter((patent) => patent.patentType === "design")
            .map((patent) => patent.patentId),
        );
        const patentSnapshots = runtime.database.read(
          (database) =>
            database
              .prepare(
                `SELECT patent_id, revision, model_version, payload, content_hash
                 FROM snapshots ORDER BY patent_id, revision`,
              )
              .all() as PatentSnapshotRow[],
        );
        const patentSnapshotStates = new Map<string, Map<number, CanonicalPatent>>();
        try {
          for (const snapshot of patentSnapshots) {
            const recovered = decodePatentRecoverySnapshot(snapshot);
            if (
              recovered.patent.patentId !== snapshot.patent_id ||
              recovered.patent.revision !== snapshot.revision
            ) {
              fail("patent");
            }
            let revisions = patentSnapshotStates.get(snapshot.patent_id);
            if (revisions === undefined) {
              revisions = new Map();
              patentSnapshotStates.set(snapshot.patent_id, revisions);
            }
            const existing = revisions.get(snapshot.revision);
            if (
              existing !== undefined &&
              patentRecoveryStateHash(existing) !== patentRecoveryStateHash(recovered.patent)
            ) {
              fail("patent");
            }
            revisions.set(snapshot.revision, recovered.patent);
          }
        } catch (error) {
          normalize("patent", error);
        }

        const patentEdits = runtime.database.read(
          (database) =>
            database
              .prepare(
                `SELECT operation_id, patent_id, base_revision, target_revision,
                        payload, content_hash, created_at
                 FROM edit_log ORDER BY patent_id, target_revision`,
              )
              .all() as PatentEditRow[],
        );
        const patentRevisions = new Map(
          runtime.database
            .read(
              (database) =>
                database
                  .prepare("SELECT patent_id, revision FROM patents ORDER BY patent_id")
                  .all() as Array<{ patent_id: string; revision: number }>,
            )
            .map((row) => [row.patent_id, row.revision] as const),
        );
        try {
          const replayed = new Map<string, CanonicalPatent>();
          const seenOperations = new Set<string>();
          const seenTargets = new Map<string, Set<number>>();
          for (const edit of patentEdits) {
            const rawPayload = decodeJson<unknown>(decodeEnvelope(edit.payload));
            if (hashJson(rawPayload) !== edit.content_hash) fail("patent");
            const payload = parsePatentEditPayload(rawPayload);
            const storedRevision = patentRevisions.get(edit.patent_id);
            let targets = seenTargets.get(edit.patent_id);
            if (targets === undefined) {
              targets = new Set();
              seenTargets.set(edit.patent_id, targets);
            }
            if (
              seenOperations.has(edit.operation_id) ||
              targets.has(edit.target_revision) ||
              storedRevision === undefined ||
              edit.target_revision !== edit.base_revision + 1 ||
              edit.target_revision > storedRevision ||
              payload.patentId !== edit.patent_id ||
              payload.baseRevision !== edit.base_revision ||
              payload.targetRevision !== edit.target_revision
            ) {
              fail("patent");
            }
            seenOperations.add(edit.operation_id);
            targets.add(edit.target_revision);
            if (designPatentIds.has(edit.patent_id)) continue;
            if (payload.type === "design-patent-edit") fail("patent");
            const previous = replayed.get(edit.patent_id);
            const base =
              previous?.revision === edit.base_revision
                ? previous
                : patentSnapshotStates.get(edit.patent_id)?.get(edit.base_revision);
            if (base === undefined) fail("patent");
            const next = replayPatentEdit(base, payload, edit.created_at);
            if (next.patentId !== edit.patent_id || next.revision !== edit.target_revision) {
              fail("patent");
            }
            const snapshotAtTarget = patentSnapshotStates
              .get(edit.patent_id)
              ?.get(edit.target_revision);
            if (
              snapshotAtTarget !== undefined &&
              patentRecoveryStateHash(snapshotAtTarget) !== patentRecoveryStateHash(next)
            ) {
              fail("patent");
            }
            replayed.set(edit.patent_id, next);
          }
          for (const [patentId, storedRevision] of patentRevisions) {
            if (designPatentIds.has(patentId)) continue;
            const replayedRevision = replayed.get(patentId)?.revision;
            if (replayedRevision !== undefined && replayedRevision !== storedRevision) {
              fail("patent");
            }
            if (
              replayedRevision === undefined &&
              !patentSnapshotStates.get(patentId)?.has(storedRevision)
            ) {
              fail("patent");
            }
          }
        } catch (error) {
          normalize("patent", error);
        }

        const documents = runtime.database.read(
          (database) =>
            database
              .prepare(
                `SELECT library_document_id, revision, deleted_at, title, snippet
                 FROM documents ORDER BY library_document_id`,
              )
              .all() as Array<{
              library_document_id: string;
              revision: number;
              deleted_at: string | null;
              title: Uint8Array;
              snippet: Uint8Array;
            }>,
        );
        for (const document of documents) {
          decodeDocumentTitle(document.title);
          decodeDocumentSnippet(document.snippet);
          if (document.deleted_at === null) {
            const opened = await runtime.library.open(document.library_document_id);
            await runtime.library.release(opened.sessionId);
          } else {
            runtime.database.read((database) =>
              loadLibraryDocumentForValidation(database, document.library_document_id),
            );
          }
        }
        const documentSnapshots = runtime.database.read(
          (database) =>
            database
              .prepare(
                `SELECT library_document_id, revision, model_version, payload, content_hash
                 FROM document_snapshots ORDER BY library_document_id, revision`,
              )
              .all() as DocumentSnapshotRow[],
        );
        for (const snapshot of documentSnapshots) {
          decodeSnapshotDocument(snapshot);
        }
        const documentEdits = runtime.database.read(
          (database) =>
            database
              .prepare(
                `SELECT operation_id, library_document_id, base_revision, target_revision,
                        payload, content_hash
                 FROM document_edit_log ORDER BY library_document_id, target_revision`,
              )
              .all() as Array<{
              operation_id: string;
              library_document_id: string;
              base_revision: number;
              target_revision: number;
              payload: Uint8Array;
              content_hash: string;
            }>,
        );
        for (const edit of documentEdits) {
          const payload = LibraryEditBatchSchema.parse(
            decodeJson<unknown>(decodeEnvelope(edit.payload)),
          );
          if (hashJson(payload) !== edit.content_hash) fail("document");
        }

        try {
          const editor = runtime.patentTemplates.openEditor({ patentType: "invention" });
          try {
            const requiredAssets = new Map<string, Set<string>>();
            for (const patentType of ["invention", "utility-model"] as const) {
              for (const slot of editor.catalog[patentType].slots) {
                const books = [slot.claims, slot.description, slot.abstract];
                if (books.every((book) => book === null)) continue;
                if (books.some((book) => book === null)) fail("template");
                requiredAssets.set(
                  slot.templateId,
                  new Set(
                    books.flatMap((book) =>
                      (book?.content ?? []).flatMap((block) =>
                        block.type === "chemical-structure" ? [block.previewAssetId] : [],
                      ),
                    ),
                  ),
                );
              }
            }
            const storedAssets = runtime.database.read(
              (database) =>
                database
                  .prepare(
                    "SELECT template_id, asset_id FROM template_assets ORDER BY template_id, asset_id",
                  )
                  .all() as Array<{ template_id: string; asset_id: string }>,
            );
            const storedByTemplate = new Map<string, Set<string>>();
            for (const row of storedAssets) {
              const assets = storedByTemplate.get(row.template_id) ?? new Set<string>();
              assets.add(row.asset_id);
              storedByTemplate.set(row.template_id, assets);
            }
            for (const [templateId, expected] of requiredAssets) {
              const actual = storedByTemplate.get(templateId) ?? new Set<string>();
              if (
                actual.size !== expected.size ||
                [...expected].some((assetId) => !actual.has(assetId))
              ) {
                fail("template");
              }
            }
            if (
              [...storedByTemplate.keys()].some((templateId) => !requiredAssets.has(templateId))
            ) {
              fail("template");
            }
          } finally {
            runtime.patentTemplates.closeEditor({ sessionId: editor.sessionId });
          }
        } catch (error) {
          normalize("template", error);
        }

        const assetIds = runtime.database.read((database) =>
          (
            database.prepare("SELECT asset_id FROM assets ORDER BY asset_id").all() as Array<{
              asset_id: string;
            }>
          ).map((row) => row.asset_id),
        );
        try {
          for (const assetId of assetIds) await runtime.assetStore.readAsset(assetId);
        } catch (error) {
          normalize("asset", error);
        }

        if (
          active.length !== manifest.summary.activePatents ||
          trash.length !== manifest.summary.trashedPatents ||
          documents.length !== manifest.summary.documents ||
          patentSnapshots.length + documentSnapshots.length !== manifest.summary.snapshots ||
          assetIds.length !== manifest.summary.assets
        ) {
          fail("manifest");
        }
      } catch (error) {
        normalize(
          error instanceof ImportStagingValidationError ? error.category : "document",
          error,
        );
      }
    },
  };
}

function flowchartValidator(): DataTransferDomainValidator {
  return {
    id: "flowchart",
    ownedTables: FLOWCHART_DATA_TRANSFER_TABLES,
    async validate(runtime, manifest) {
      try {
        const patentIds = runtime.database.read((database) =>
          (
            database.prepare("SELECT patent_id FROM patents ORDER BY patent_id").all() as Array<{
              patent_id: string;
            }>
          ).map((row) => row.patent_id),
        );
        for (const patentId of patentIds) runtime.flowchartSourceStore.list(patentId);
        const sources = runtime.database.read(
          (database) =>
            database
              .prepare(
                `SELECT patent_id, project_id, project_revision, source,
                        source_sha256, byte_length
                 FROM patent_flowchart_source_revisions
                 ORDER BY patent_id, project_id, project_revision`,
              )
              .all() as Array<{
              patent_id: string;
              project_id: string;
              project_revision: number;
              source: Uint8Array;
              source_sha256: string;
              byte_length: number;
            }>,
        );
        for (const source of sources) {
          const plain = decodeBytes(decodeEnvelope(source.source));
          try {
            const digest = createHash("sha256").update(plain).digest("hex").toUpperCase();
            const xml = new TextDecoder("utf-8", { fatal: true }).decode(plain);
            if (
              plain.byteLength !== source.byte_length ||
              digest !== source.source_sha256 ||
              !/^\s*<mxfile(?:\s|>)/u.test(xml) ||
              !/<\/mxfile>\s*$/u.test(xml)
            ) {
              fail("flowchart");
            }
          } finally {
            plain.fill(0);
          }
        }
        const projectCount = count(runtime, "SELECT COUNT(*) AS count FROM patent_flowcharts");
        if (projectCount !== manifest.summary.flowchartProjects) fail("manifest");
      } catch (error) {
        normalize(
          error instanceof ImportStagingValidationError ? error.category : "flowchart",
          error,
        );
      }
    },
  };
}

function validateDatabase(runtime: LibraryRuntime): void {
  if (
    runtime.database.schemaVersion() !== CURRENT_SCHEMA_VERSION ||
    !runtime.database.integrityCheck().ok ||
    !runtime.database.foreignKeyCheck().ok ||
    !runtime.database.read((database) => validateCurrentSchema(database)).ok
  ) {
    fail("database");
  }
}

async function validateBusinessData(
  runtime: LibraryRuntime,
  manifest: TransferManifest,
  layout: ResolvedImportStagingLayout,
): Promise<void> {
  const registry = new DataTransferDomainValidatorRegistry([
    flowchartValidator(),

    coreValidator(),
  ]);
  await registry.validateAll(runtime, manifest);
  try {
    const legacyDraftsRoot = layout.legacyDraftsRoot ?? join(layout.userDataRoot, "legacy-drafts");
    if (layout.legacyDraftsCapability) {
      await assertLayoutRoot(legacyDraftsRoot, layout.legacyDraftsCapability);
    }
    const draftService = new DraftService(legacyDraftsRoot);
    const drafts = await draftService.list();
    if (drafts.length !== manifest.summary.legacyDrafts) fail("draft");
    for (const draft of drafts) await draftService.open(draft.draftId);
    if (layout.legacyDraftsCapability) {
      await assertLayoutRoot(legacyDraftsRoot, layout.legacyDraftsCapability);
    }
  } catch (error) {
    normalize("draft", error);
  }
  const snapshotBytes = manifest.entries
    .filter((entry) =>
      ["database", "asset", "legacy-draft", "text-polish-history"].includes(entry.kind),
    )
    .reduce((sum, entry) => sum + entry.originalBytes, 0);
  if (snapshotBytes !== manifest.summary.totalBytes) fail("manifest");
}

async function validateImmutableManifestFiles(
  layout: ResolvedImportStagingLayout,
  manifest: TransferManifest,
): Promise<void> {
  validateManifestAccounting(manifest);
  for (const entry of manifest.entries) {
    // Migration and recovery may intentionally rewrite the staged database. Its original
    // package hash was checked before opening, and its resulting bytes are covered by the
    // post-recovery SQLite/schema checks instead of being compared with stale manifest bytes.
    if (entry.kind === "database") continue;
    const root = entryRoot(layout, entry.logicalPath);
    const childRoot = childRootForLogicalPath(layout, entry.logicalPath);
    const digest = await hashFile(
      root,
      safeEntryPath(layout, entry.logicalPath),
      capabilityForRoot(layout, root),
      childRoot,
      childCapabilityForLogicalPath(layout, entry.logicalPath),
    );
    if (digest.bytes !== entry.originalBytes || digest.sha256 !== entry.sha256) fail("manifest");
    if (entry.kind === "text-polish-history" && !entry.logicalPath.includes(".unreadable-")) {
      if (digest.bytes > MAX_TEXT_POLISH_HISTORY_JSON_BYTES) fail("manifest");
      try {
        const filePath = safeEntryPath(layout, entry.logicalPath);
        await assertPlainPath(
          root,
          filePath,
          capabilityForRoot(layout, root),
          childRoot,
          childCapabilityForLogicalPath(layout, entry.logicalPath),
        );
        const handle = await open(filePath, "r");
        try {
          const [pathStat, handleStat] = await Promise.all([
            lstat(filePath, { bigint: true }),
            handle.stat({ bigint: true }),
          ]);
          if (
            !pathStat.isFile() ||
            pathStat.isSymbolicLink() ||
            !handleStat.isFile() ||
            pathStat.dev !== handleStat.dev ||
            pathStat.ino !== handleStat.ino ||
            handleStat.size !== BigInt(digest.bytes)
          )
            fail("manifest");
          // Bound the allocation even if a file grows after the authenticated hash check.
          const bytes = Buffer.alloc(digest.bytes + 1);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          if (
            offset !== digest.bytes ||
            createHash("sha256").update(bytes.subarray(0, offset)).digest("hex") !== entry.sha256
          )
            fail("manifest");
          validateTextPolishHistoryEntry(entry.logicalPath, bytes.subarray(0, offset));
          await assertPlainPath(
            root,
            filePath,
            capabilityForRoot(layout, root),
            childRoot,
            childCapabilityForLogicalPath(layout, entry.logicalPath),
          );
        } finally {
          await handle.close();
        }
      } catch (error) {
        normalize("manifest", error);
      }
    }
  }
  await assertLayoutRoot(layout.libraryRoot, layout.libraryCapability);
  await assertLayoutRoot(layout.userDataRoot, layout.userDataCapability);
}

export class ImportStagingValidator {
  async validate(
    stagingRootInput: string | ImportStagingLayout,
    manifestInput: TransferManifest,
  ): Promise<ImportStagingValidationSummary> {
    const layout = resolvedLayout(stagingRootInput);
    const manifest = await (async () => {
      try {
        const parsed = TransferManifestSchema.parse(manifestInput);
        await validateManifestFiles(layout, parsed);
        return parsed;
      } catch (error) {
        return normalize("manifest", error);
      }
    })();
    let runtime: LibraryRuntime | undefined;
    try {
      await assertLayoutRoot(layout.libraryRoot, layout.libraryCapability);
      await assertLayoutRoot(layout.userDataRoot, layout.userDataCapability);
      await assertLayoutRoot(libraryDataRoot(layout), layout.libraryDirectoryCapability);
      try {
        runtime = await createLibraryRuntime({
          libraryRoot: libraryDataRoot(layout),
          readOnly: true,
          runRecovery: false,
          startBackgroundSchedulers: false,
        });
      } catch (error) {
        normalize("database", error);
      }
      validateDatabase(runtime);
      await validateBusinessData(runtime, manifest, layout);
      await assertLayoutRoot(layout.libraryRoot, layout.libraryCapability);
      await assertLayoutRoot(layout.userDataRoot, layout.userDataCapability);
      await assertLayoutRoot(libraryDataRoot(layout), layout.libraryDirectoryCapability);
      await runtime.close();
      runtime = undefined;

      if (layout.installed) {
        await validateImmutableManifestFiles(layout, manifest);
        return Object.freeze({ ...manifest.summary });
      }

      try {
        await assertLayoutRoot(libraryDataRoot(layout), layout.libraryDirectoryCapability);
        runtime = await createLibraryRuntime({
          libraryRoot: libraryDataRoot(layout),
          readOnly: false,
          runRecovery: true,
          startBackgroundSchedulers: false,
          preserveAssetsForMigration: true,
        });
      } catch (error) {
        normalize("database", error);
      }
      validateDatabase(runtime);
      await validateBusinessData(runtime, manifest, layout);
      await assertLayoutRoot(layout.libraryRoot, layout.libraryCapability);
      await assertLayoutRoot(layout.userDataRoot, layout.userDataCapability);
      await assertLayoutRoot(libraryDataRoot(layout), layout.libraryDirectoryCapability);
      await validateImmutableManifestFiles(layout, manifest);
      return Object.freeze({ ...manifest.summary });
    } catch (error) {
      normalize(error instanceof ImportStagingValidationError ? error.category : "database", error);
    } finally {
      await runtime?.close();
    }
    return fail("database");
  }
}
