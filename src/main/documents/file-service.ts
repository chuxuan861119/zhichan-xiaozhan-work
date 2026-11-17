import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  type FileHandle,
  link,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CanonicalDocumentSchema } from "../../shared/document/model.js";
import { JsonObjectSchema } from "../../shared/ipc/primitives.js";
import { type AppResult, normalizeAppError } from "../../shared/ipc/result.js";
import { CanonicalPatentSchema } from "../../shared/patent/model.js";
import { PatdocError, type PatdocPayload, type PatentPatdocPayload } from "./patdoc-format.js";
import { probePatdocFormatVersion, readPatdoc } from "./patdoc-reader.js";
import { portablePatdocPayload } from "./patdoc-transfer-scope.js";
import { writePatdoc } from "./patdoc-writer.js";

export type SavedPatdoc = {
  path: string;
  displayName: string;
  savedAt: string;
  previousVersionRetained: boolean;
};

function sameFlowchartSources(
  actual: NonNullable<PatentPatdocPayload["flowcharts"]>,
  expected: NonNullable<PatentPatdocPayload["flowcharts"]>,
): boolean {
  const expectedById = new Map(expected.map((item) => [item.projectId, item.source]));
  return (
    actual.length === expected.length &&
    expectedById.size === expected.length &&
    new Set(actual.map((item) => item.projectId)).size === actual.length &&
    actual.every((item) => {
      const source = expectedById.get(item.projectId);
      return source !== undefined && Buffer.from(item.source).equals(source);
    })
  );
}

export function toDocumentPatdocPayload(
  payload: PatdocPayload | PatentPatdocPayload,
): PatdocPayload {
  if ("document" in payload) return payload;

  const activeBook = payload.patent.books.find(
    (book) => book.kind === payload.patent.activeBookKind,
  );
  if (!activeBook) {
    throw new PatdocError("INVALID_ARCHIVE", "专利当前书册不存在。");
  }
  return {
    document: {
      ...activeBook.document,
      documentId: payload.patent.patentId,
      title: payload.patent.name ?? activeBook.document.title,
      patentType: payload.patent.patentType,
      createdAt: payload.patent.createdAt,
      modifiedAt: payload.patent.modifiedAt,
      assets: payload.patent.assets,
    },
    settings: {},
    editorState: activeBook.editorState,
    assets: payload.assets,
  };
}

type TargetSnapshot =
  | { exists: false }
  | {
      exists: true;
      device: bigint;
      inode: bigint;
      size: bigint;
      modifiedAt: bigint;
      changedAt: bigint;
      sha256: string;
    };

class TargetChangedError extends Error {
  override readonly name = "TargetChangedError";
}

class UnsafeOverwriteError extends Error {
  override readonly name = "UnsafeOverwriteError";
}

class RecoveryRequiredError extends Error {
  override readonly name = "RecoveryRequiredError";
}

const GENERATED_FILE_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function failure(code: Parameters<typeof normalizeAppError>[0]["code"]): AppResult<never> {
  return { ok: false, error: normalizeAppError({ code, message: "normalized" }) };
}

export function mapFileError(error: unknown): AppResult<never> {
  if (
    error instanceof PatdocError &&
    (error.code === "PATDOC_CAPACITY_LIMIT" || error.code === "PATDOC_HISTORY_INCOMPLETE")
  )
    return failure(error.code);
  if (error instanceof TargetChangedError) return failure("FILE_LOCKED");
  if (error instanceof UnsafeOverwriteError) return failure("UNSAFE_OVERWRITE");
  if (error instanceof RecoveryRequiredError) return failure("RECOVERY_REQUIRED");
  if (error instanceof PatdocError && error.code === "UNSUPPORTED_VERSION") {
    return failure("UNSUPPORTED_VERSION");
  }
  if (error instanceof PatdocError) {
    return failure("CORRUPT_FILE");
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    return failure("NO_PERMISSION");
  }
  if (code === "EBUSY" || code === "ETXTBSY") {
    return failure("FILE_LOCKED");
  }
  if (code === "ENOSPC") {
    return failure("DISK_FULL");
  }
  if (code === "ENOENT") return failure("NOT_FOUND");
  return failure("CORRUPT_FILE");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sameSnapshot(left: TargetSnapshot, right: TargetSnapshot): boolean {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.changedAt === right.changedAt &&
    left.sha256 === right.sha256
  );
}

function sameMovedFileFingerprint(left: TargetSnapshot, right: TargetSnapshot): boolean {
  if (!left.exists || !right.exists) return false;
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.sha256 === right.sha256
  );
}

function sameContentFingerprint(left: TargetSnapshot, right: TargetSnapshot): boolean {
  return left.exists && right.exists && left.size === right.size && left.sha256 === right.sha256;
}

type FileIdentity = { device: bigint; inode: bigint };
type ExistingTargetSnapshot = Extract<TargetSnapshot, { exists: true }>;
type ExpectedOwnedFile = FileIdentity | ExistingTargetSnapshot;
type CopyContents = (sourcePath: string, targetHandle: FileHandle) => Promise<void>;
type BeforeOwnedRemoval = (targetPath: string) => Promise<void>;
type IsolationOutcome = "retained" | "unsafe";

const noopBeforeOwnedRemoval: BeforeOwnedRemoval = async () => {};

function isHardLinkUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EPERM" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "EINVAL" ||
    code === "EXDEV" ||
    code === "ENOSYS"
  );
}

async function defaultCopyContents(sourcePath: string, targetHandle: FileHandle): Promise<void> {
  const sourceHandle = await open(sourcePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    for (;;) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) return;
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(buffer, written, bytesRead - written, null);
        if (result.bytesWritten === 0) throw new Error("复制文件时写入中断。");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
  } finally {
    await sourceHandle.close();
  }
}

async function captureTargetSnapshot(path: string): Promise<TargetSnapshot> {
  let before: Awaited<ReturnType<typeof stat>>;
  try {
    before = await stat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
  let digest: string;
  let after: typeof before;
  try {
    digest = await hashFile(path);
    after = await stat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TargetChangedError();
    throw error;
  }
  const beforeIdentity = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs];
  const afterIdentity = [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs];
  if (beforeIdentity.some((value, index) => value !== afterIdentity[index])) {
    throw new TargetChangedError();
  }
  return {
    exists: true,
    device: after.dev,
    inode: after.ino,
    size: after.size,
    modifiedAt: after.mtimeNs,
    changedAt: after.ctimeNs,
    sha256: digest,
  };
}

async function bestEffortRestoreQuarantinedFile(
  quarantinedPath: string,
  path: string,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
  copyContents: CopyContents,
  beforeOwnedRemoval: BeforeOwnedRemoval,
): Promise<void> {
  try {
    await linkFile(quarantinedPath, path);
    await syncPath(path);
    return;
  } catch (error) {
    if (!isHardLinkUnsupported(error)) return;
  }

  let targetHandle: FileHandle | undefined;
  let createdIdentity: FileIdentity | undefined;
  try {
    targetHandle = await open(path, "wx");
    const created = await targetHandle.stat({ bigint: true });
    createdIdentity = { device: created.dev, inode: created.ino };
    await copyContents(quarantinedPath, targetHandle);
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = undefined;
    const source = await captureTargetSnapshot(quarantinedPath);
    const restored = await captureTargetSnapshot(path);
    if (!sameContentFingerprint(source, restored)) throw new Error("恢复文件校验失败。");
  } catch {
    await targetHandle?.close().catch(() => undefined);
    if (createdIdentity) {
      await isolateOwnedPath(path, createdIdentity, linkFile, copyContents, beforeOwnedRemoval);
    }
  }
}

async function isolateOwnedPath(
  path: string,
  expected: ExpectedOwnedFile,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
  copyContents: CopyContents,
  beforeOwnedRemoval: BeforeOwnedRemoval,
  afterOwnedSnapshot: BeforeOwnedRemoval = noopBeforeOwnedRemoval,
  restoreUnexpected = true,
): Promise<IsolationOutcome> {
  await beforeOwnedRemoval(path);
  let beforeIsolation: TargetSnapshot;
  try {
    beforeIsolation = await captureTargetSnapshot(path);
  } catch {
    return "unsafe";
  }
  const matchedBeforeIsolation =
    beforeIsolation.exists &&
    beforeIsolation.device === expected.device &&
    beforeIsolation.inode === expected.inode &&
    (!("sha256" in expected) || sameSnapshot(expected, beforeIsolation));
  const quarantinedPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.recovery`);
  try {
    await rename(path, quarantinedPath);
  } catch {
    return "unsafe";
  }

  let quarantined: TargetSnapshot;
  let stableQuarantined: TargetSnapshot;
  try {
    quarantined = await captureTargetSnapshot(quarantinedPath);
    stableQuarantined = await captureTargetSnapshot(quarantinedPath);
  } catch {
    if (restoreUnexpected) {
      await bestEffortRestoreQuarantinedFile(
        quarantinedPath,
        path,
        linkFile,
        copyContents,
        beforeOwnedRemoval,
      );
    }
    return "unsafe";
  }
  await afterOwnedSnapshot(quarantinedPath);
  const finalQuarantined = await captureTargetSnapshot(quarantinedPath).catch(() => ({
    exists: false as const,
  }));
  // Renaming updates ctime on supported Windows filesystems, so compare the
  // complete caller snapshot immediately before isolation, then require the
  // post-isolation identity/content fingerprint and repeated complete snapshots
  // (including the new ctime) to remain stable, including after the final hook.
  const safelyIsolated =
    matchedBeforeIsolation &&
    sameMovedFileFingerprint(beforeIsolation, quarantined) &&
    sameSnapshot(quarantined, stableQuarantined) &&
    sameSnapshot(stableQuarantined, finalQuarantined);
  if (!safelyIsolated) {
    if (restoreUnexpected) {
      await bestEffortRestoreQuarantinedFile(
        quarantinedPath,
        path,
        linkFile,
        copyContents,
        beforeOwnedRemoval,
      );
    }
    return "unsafe";
  }
  // Node has no cross-platform unlink-by-handle API, so every isolated object is
  // retained. The threat model is accidental concurrent writes to documented
  // target/backup names, not a malicious same-account process scanning and
  // replacing private UUID recovery names.
  return "retained";
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyNoClobber(
  sourcePath: string,
  targetPath: string,
  expectedSource: TargetSnapshot,
  copyContents: CopyContents,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
  beforeOwnedRemoval: BeforeOwnedRemoval,
): Promise<TargetSnapshot> {
  let targetHandle: FileHandle | undefined;
  let identity: FileIdentity | undefined;
  try {
    targetHandle = await open(targetPath, "wx");
    const created = await targetHandle.stat({ bigint: true });
    identity = { device: created.dev, inode: created.ino };
    await copyContents(sourcePath, targetHandle);
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = undefined;
    const installed = await captureTargetSnapshot(targetPath);
    if (!sameContentFingerprint(expectedSource, installed))
      throw new Error("复制后的文件校验失败。");
    return installed;
  } catch (error) {
    await targetHandle?.close().catch(() => undefined);
    if (identity) {
      await isolateOwnedPath(targetPath, identity, linkFile, copyContents, beforeOwnedRemoval);
      throw new RecoveryRequiredError();
    }
    throw error;
  }
}

async function installNoClobber(
  sourcePath: string,
  targetPath: string,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
  copyContents: CopyContents,
  beforeOwnedRemoval: BeforeOwnedRemoval,
): Promise<TargetSnapshot> {
  const expectedSource = await captureTargetSnapshot(sourcePath);
  if (!expectedSource.exists) throw Object.assign(new Error("source missing"), { code: "ENOENT" });
  try {
    await linkFile(sourcePath, targetPath);
  } catch (error) {
    if (isHardLinkUnsupported(error)) {
      return copyNoClobber(
        sourcePath,
        targetPath,
        expectedSource,
        copyContents,
        linkFile,
        beforeOwnedRemoval,
      );
    }
    throw error;
  }

  const identity = { device: expectedSource.device, inode: expectedSource.inode };
  try {
    await syncPath(targetPath);
    const installed = await captureTargetSnapshot(targetPath);
    if (!sameContentFingerprint(expectedSource, installed))
      throw new Error("安装后的文件校验失败。");
    return installed;
  } catch {
    await isolateOwnedPath(targetPath, identity, linkFile, copyContents, beforeOwnedRemoval);
    throw new RecoveryRequiredError();
  }
}

async function inspectOverwriteTarget(path: string): Promise<TargetSnapshot> {
  const before = await captureTargetSnapshot(path);
  if (!before.exists) return before;
  const probe = await probePatdocFormatVersion(path);
  if (probe.kind === "future") {
    throw new PatdocError("UNSUPPORTED_VERSION", "此文件由更新版本的软件创建。");
  }
  if (probe.kind !== "current") throw new UnsafeOverwriteError();
  try {
    await readPatdoc(path);
  } catch (error) {
    if (error instanceof PatdocError && error.code === "UNSUPPORTED_VERSION") throw error;
    throw new UnsafeOverwriteError();
  }
  const after = await captureTargetSnapshot(path);
  if (!sameSnapshot(before, after)) throw new TargetChangedError();
  return after;
}

async function inspectFinalTarget(
  path: string,
  initial: TargetSnapshot,
  beforeValidatedSnapshot: (path: string) => Promise<void>,
): Promise<TargetSnapshot> {
  const before = await captureTargetSnapshot(path);
  if (!sameSnapshot(initial, before)) {
    if (before.exists) {
      const probe = await probePatdocFormatVersion(path);
      if (probe.kind === "future") {
        throw new PatdocError("UNSUPPORTED_VERSION", "此文件由更新版本的软件创建。");
      }
    }
    throw new TargetChangedError();
  }
  await beforeValidatedSnapshot(path);
  const validated = await inspectOverwriteTarget(path);
  if (!sameSnapshot(initial, validated)) throw new TargetChangedError();
  return validated;
}

async function restoreBackupWithoutClobber(
  backupPath: string,
  path: string,
  expectedBackup: TargetSnapshot,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
  copyContents: CopyContents,
  beforeOwnedRemoval: BeforeOwnedRemoval,
): Promise<void> {
  try {
    const currentBackup = await captureTargetSnapshot(backupPath);
    if (!sameMovedFileFingerprint(expectedBackup, currentBackup)) {
      throw new RecoveryRequiredError();
    }
    await installNoClobber(backupPath, path, linkFile, copyContents, beforeOwnedRemoval);
    const installedBackup = await captureTargetSnapshot(backupPath);
    if (!sameMovedFileFingerprint(currentBackup, installedBackup)) {
      throw new RecoveryRequiredError();
    }
    if (!installedBackup.exists) throw new RecoveryRequiredError();
    await isolateOwnedPath(
      backupPath,
      installedBackup,
      linkFile,
      copyContents,
      beforeOwnedRemoval,
      noopBeforeOwnedRemoval,
      false,
    );
    throw new RecoveryRequiredError();
  } catch {
    throw new RecoveryRequiredError();
  }
}

async function recoverInterruptedInstall(
  path: string,
  directory: string,
  targetName: string,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
  copyContents: CopyContents,
  beforeOwnedRemoval: BeforeOwnedRemoval,
): Promise<boolean> {
  const prefix = `.${targetName}.`;
  const backupNames = (await readdir(directory)).filter((name) => {
    if (!name.startsWith(prefix) || !name.endsWith(".bak")) return false;
    return GENERATED_FILE_TOKEN.test(name.slice(prefix.length, -".bak".length));
  });
  if (backupNames.length === 0) return false;
  if ((await captureTargetSnapshot(path)).exists || backupNames.length !== 1) {
    throw new RecoveryRequiredError();
  }
  try {
    const backupPath = join(directory, backupNames[0] ?? "");
    const backupSnapshot = await inspectOverwriteTarget(backupPath);
    if (!backupSnapshot.exists) throw new RecoveryRequiredError();
    const restoredTarget = await installNoClobber(
      backupPath,
      path,
      linkFile,
      copyContents,
      beforeOwnedRemoval,
    );
    const stableRestoredTarget = await captureTargetSnapshot(path);
    if (
      !sameContentFingerprint(backupSnapshot, restoredTarget) ||
      !sameSnapshot(restoredTarget, stableRestoredTarget)
    ) {
      throw new RecoveryRequiredError();
    }
    const stableBackup = await captureTargetSnapshot(backupPath);
    if (!stableBackup.exists || !sameMovedFileFingerprint(backupSnapshot, stableBackup)) {
      throw new RecoveryRequiredError();
    }
    const outcome = await isolateOwnedPath(
      backupPath,
      stableBackup,
      linkFile,
      copyContents,
      beforeOwnedRemoval,
      noopBeforeOwnedRemoval,
      false,
    );
    if (outcome !== "retained") {
      throw new RecoveryRequiredError();
    }
    return true;
  } catch {
    throw new RecoveryRequiredError();
  }
}

export async function installNewFileWithoutClobber(
  sourcePath: string,
  targetPath: string,
  linkFile: (source: string, target: string) => Promise<void> = link,
): Promise<void> {
  await installNoClobber(
    sourcePath,
    targetPath,
    linkFile,
    defaultCopyContents,
    noopBeforeOwnedRemoval,
  );
}

export class FileService {
  constructor(
    private readonly renameFile: (from: string, to: string) => Promise<void> = rename,
    private readonly beforeFinalTargetCheck: (path: string) => Promise<void> = async () => {},
    private readonly beforeNoClobberInstall: (path: string) => Promise<void> = async () => {},
    private readonly linkFile: (existingPath: string, newPath: string) => Promise<void> = link,
    private readonly beforeValidatedFinalSnapshot: (path: string) => Promise<void> = async () => {},
    private readonly copyContents: CopyContents = defaultCopyContents,
    private readonly afterBackupMove: (backupPath: string) => Promise<void> = async () => {},
    private readonly beforeOwnedRemoval: BeforeOwnedRemoval = noopBeforeOwnedRemoval,
    private readonly afterOwnedSnapshot: BeforeOwnedRemoval = noopBeforeOwnedRemoval,
    private readonly writePatdocFile: typeof writePatdoc = writePatdoc,
  ) {}

  async #installWithoutClobber(
    temporaryPath: string,
    path: string,
    backupPath: string,
    expectedTarget: TargetSnapshot,
  ): Promise<boolean> {
    if (!expectedTarget.exists) {
      await this.beforeNoClobberInstall(path);
      await installNoClobber(
        temporaryPath,
        path,
        this.linkFile,
        this.copyContents,
        this.beforeOwnedRemoval,
      );
      return false;
    }
    await this.renameFile(path, backupPath);
    let installedTarget: TargetSnapshot | undefined;
    try {
      await this.afterBackupMove(backupPath);
      const backupSnapshot = await captureTargetSnapshot(backupPath);
      if (!sameMovedFileFingerprint(expectedTarget, backupSnapshot)) {
        const probe = await probePatdocFormatVersion(backupPath);
        if (probe.kind === "future") {
          throw new PatdocError("UNSUPPORTED_VERSION", "此文件由更新版本的软件创建。");
        }
        throw new TargetChangedError();
      }
      await this.beforeNoClobberInstall(path);
      installedTarget = await installNoClobber(
        temporaryPath,
        path,
        this.linkFile,
        this.copyContents,
        this.beforeOwnedRemoval,
      );
      if (!backupSnapshot.exists) throw new RecoveryRequiredError();
      const outcome = await isolateOwnedPath(
        backupPath,
        backupSnapshot,
        this.linkFile,
        this.copyContents,
        this.beforeOwnedRemoval,
        this.afterOwnedSnapshot,
        false,
      );
      if (outcome !== "retained") {
        throw new RecoveryRequiredError();
      }
      return true;
    } catch (error) {
      const backupSnapshot = await captureTargetSnapshot(backupPath).catch(() => ({
        exists: false as const,
      }));
      if (!sameMovedFileFingerprint(expectedTarget, backupSnapshot)) {
        throw new RecoveryRequiredError();
      }
      if (installedTarget?.exists) {
        await isolateOwnedPath(
          path,
          installedTarget,
          this.linkFile,
          this.copyContents,
          this.beforeOwnedRemoval,
        );
      }
      await restoreBackupWithoutClobber(
        backupPath,
        path,
        expectedTarget,
        this.linkFile,
        this.copyContents,
        this.beforeOwnedRemoval,
      );
      throw error;
    }
  }

  async saveDocument(path: string, payload: PatdocPayload): Promise<AppResult<SavedPatdoc>> {
    return this.#savePatdoc(path, payload);
  }

  async savePatent(path: string, payload: PatentPatdocPayload): Promise<AppResult<SavedPatdoc>> {
    return this.#savePatdoc(path, portablePatdocPayload(payload));
  }

  async #savePatdoc(
    path: string,
    payload: PatdocPayload | PatentPatdocPayload,
  ): Promise<AppResult<SavedPatdoc>> {
    const directory = dirname(path);
    const token = randomUUID();
    const temporaryPath = join(directory, `.${basename(path)}.${token}.tmp`);
    const backupPath = join(directory, `.${basename(path)}.${token}.bak`);
    try {
      await mkdir(directory, { recursive: true });
      const recoveredPreviousVersion = await recoverInterruptedInstall(
        path,
        directory,
        basename(path),
        this.linkFile,
        this.copyContents,
        this.beforeOwnedRemoval,
      );
      const initialTarget = await inspectOverwriteTarget(path);
      await this.writePatdocFile(temporaryPath, payload);
      const handle = await open(temporaryPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const verified = await readPatdoc<PatdocPayload | PatentPatdocPayload>(temporaryPath);
      const expectedAssets = [...payload.assets]
        .sort((left, right) => left.descriptor.assetId.localeCompare(right.descriptor.assetId))
        .map((asset) => asset.descriptor);
      const patentValid =
        "patent" in payload &&
        "patent" in verified &&
        verified.patent.patentId === payload.patent.patentId &&
        verified.patent.revision === payload.patent.revision &&
        JSON.stringify(verified.patent) ===
          JSON.stringify(CanonicalPatentSchema.parse(payload.patent)) &&
        JSON.stringify(verified.assets.map((asset) => asset.descriptor)) ===
          JSON.stringify(expectedAssets) &&
        sameFlowchartSources(verified.flowcharts ?? [], payload.flowcharts ?? []) &&
        verified.snapshots === undefined;
      const documentValid =
        "document" in payload &&
        "document" in verified &&
        JSON.stringify(verified.document) ===
          JSON.stringify(CanonicalDocumentSchema.parse(payload.document)) &&
        JSON.stringify(verified.settings) ===
          JSON.stringify(JsonObjectSchema.parse(payload.settings)) &&
        JSON.stringify(verified.editorState) ===
          JSON.stringify(JsonObjectSchema.parse(payload.editorState)) &&
        JSON.stringify(verified.assets.map((asset) => asset.descriptor)) ===
          JSON.stringify(expectedAssets);
      if (!patentValid && !documentValid) {
        throw new Error("保存后的文件校验失败。");
      }

      await this.beforeFinalTargetCheck(path);
      const finalTarget = await inspectFinalTarget(
        path,
        initialTarget,
        this.beforeValidatedFinalSnapshot,
      );
      const overwrittenPreviousVersion = await this.#installWithoutClobber(
        temporaryPath,
        path,
        backupPath,
        finalTarget,
      );

      return {
        ok: true,
        value: {
          path,
          displayName: basename(path),
          savedAt: new Date().toISOString(),
          previousVersionRetained: recoveredPreviousVersion || overwrittenPreviousVersion,
        },
      };
    } catch (error) {
      return mapFileError(error);
    } finally {
      await removeIfPresent(temporaryPath).catch(() => undefined);
    }
  }

  async openDocument(path: string): Promise<AppResult<PatdocPayload>> {
    try {
      const payload = await readPatdoc<PatdocPayload | PatentPatdocPayload>(path);
      return { ok: true, value: toDocumentPatdocPayload(payload) };
    } catch (error) {
      return mapFileError(error);
    }
  }

  async openPatent(path: string): Promise<AppResult<PatentPatdocPayload>> {
    try {
      const payload = await readPatdoc<PatdocPayload | PatentPatdocPayload>(path);
      if (!("patent" in payload)) {
        return failure("PATDOC_DOCUMENT_ONLY");
      }

      return { ok: true, value: payload };
    } catch (error) {
      return mapFileError(error);
    }
  }
}
