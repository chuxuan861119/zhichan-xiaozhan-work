import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { TransferManifestSchema } from "../../shared/data-transfer/model.js";
import { AppSettingsSchema } from "../../shared/settings/model.js";
import { LibraryDatabase } from "../library/library-database.js";
import { moveNoReplaceHarmony, moveNoReplaceMac } from "../platform/move-no-replace.js";
import {
  DataImportJournalError,
  type DataImportJournalPathIdentities,
  type DataImportJournalPathIdentity,
  type DataImportJournalPhase,
  type DataImportJournalRecord,
} from "./data-import-journal.js";
import { EmptyLibraryInspector } from "./empty-library-inspector.js";
import { ImportStagingValidator } from "./import-staging-validator.js";
import { type OwnedPathIdentity, removeOwnedPath } from "./owned-path-cleanup.js";

export type DataImportRecoveryStatus =
  | "none"
  | "abandoned"
  | "rolled-back"
  | "recovered"
  | "manual-safe-recovery";

export type DataImportRecoveryResult = Readonly<{
  status: DataImportRecoveryStatus;
  phase?: DataImportJournalPhase;
}>;

/**
 * 恢复被永久性阻塞：journal 锚定到其他实例上下文（库/用户数据路径与当前
 * 实例不一致），无论如何重试都无法安全解析。触发该错误时应隔离（保留重命名）
 * journal。隔离记录保留原始字节，后续启动持续保护未解决的恢复任务。
 */
export class DataImportRecoveryBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataImportRecoveryBlockedError";
  }
}

export type DataImportRecoveryJournal = Readonly<{
  read(): Promise<DataImportJournalRecord | undefined>;
  advance(phase: DataImportJournalPhase): Promise<DataImportJournalRecord | unknown>;
  clear(): Promise<void>;
  quarantine(): Promise<string | undefined>;
}>;

type StableIdentity = Readonly<{
  device: string;
  inode: string;
  birthtimeNs: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}>;

type RecoveryFs = Readonly<{
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Buffer>;
  rename(source: string, target: string): Promise<void>;
  remove(path: string, expected: OwnedPathIdentity): Promise<void>;
}>;

export type DataImportRecoveryServiceOptions = Readonly<{
  journal: DataImportRecoveryJournal;
  libraryRoot: string;
  userDataRoot: string;
  applicationDataRoot: string;
  isFormalLibraryEmpty?: () => Promise<boolean>;
  validateInstalled?: (record: DataImportJournalRecord) => Promise<boolean | undefined>;
  /** Test-only identity probe. Returning false is fail-closed. */
  assertStable?: (path: string) => Promise<boolean>;
  fileSystem?: Partial<RecoveryFs>;
}>;

const defaultFileSystem: RecoveryFs = {
  lstat: async (path) => (await lstat(path, { bigint: true })) as unknown as Stats,
  realpath,
  readdir: async (path) => await readdir(path, { encoding: "utf8" }),
  readFile,
  rename:
    process.platform === "darwin"
      ? moveNoReplaceMac
      : ["openharmony", "ohos"].includes(process.platform)
        ? moveNoReplaceHarmony
        : rename,
  remove: removeOwnedPath,
};

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.includes("\0"))
  );
}

function identity(stats: Stats): StableIdentity {
  return Object.freeze({
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String((stats as Stats & { birthtimeNs?: bigint }).birthtimeNs ?? ""),
    size: String(stats.size),
    mtimeNs: String((stats as Stats & { mtimeNs?: bigint }).mtimeNs ?? stats.mtimeMs),
    ctimeNs: String((stats as Stats & { ctimeNs?: bigint }).ctimeNs ?? stats.ctimeMs),
  });
}

function sameObjectIdentity(left: StableIdentity, right: StableIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameStableIdentity(left: StableIdentity, right: DataImportJournalPathIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameRelocatedIdentity(
  left: StableIdentity,
  right: DataImportJournalPathIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size;
}

export function validateRecoveredSettingsContent(
  bytes: Buffer,
  expectedSha256: string | undefined,
): boolean {
  if (!expectedSha256) return false;
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) return false;
  try {
    AppSettingsSchema.parse(JSON.parse(bytes.toString("utf8")));
    return true;
  } catch {
    return false;
  }
}

type PathState = Readonly<{
  path: string;
  exists: boolean;
  kind?: "file" | "directory";
  identity?: StableIdentity;
}>;

export class DataImportRecoveryService {
  readonly #options: DataImportRecoveryServiceOptions;
  readonly #fs: RecoveryFs;
  readonly #libraryRoot: string;
  readonly #userDataRoot: string;
  readonly #applicationDataRoot: string;

  constructor(options: DataImportRecoveryServiceOptions) {
    this.#options = options;
    this.#fs = { ...defaultFileSystem, ...options.fileSystem };
    this.#libraryRoot = resolve(options.libraryRoot);
    this.#userDataRoot = resolve(options.userDataRoot);
    this.#applicationDataRoot = resolve(options.applicationDataRoot);
  }

  async recover(): Promise<DataImportRecoveryResult> {
    let record: DataImportJournalRecord | undefined;
    try {
      record = await this.#options.journal.read();
    } catch (error) {
      // journal 无法读取（损坏、或锚定到其他实例上下文）：本次启动仍
      // fail-closed；隔离原始字节后，后续启动仍保持未解决任务的保护。
      if (error instanceof DataImportJournalError || error instanceof Error) {
        await this.#quarantineJournal();
      }
      return Object.freeze({ status: "manual-safe-recovery" as const });
    }
    if (!record) return Object.freeze({ status: "none" as const });

    try {
      this.#assertRecordAnchors(record);
      await this.#assertKnownPathsStable(record);
      if (record.phase === "committed" || record.phase === "rolled-back") {
        await this.#cleanupOwned(record);
        await this.#clearJournal(record);
        return Object.freeze({
          status: record.phase === "committed" ? "recovered" : "rolled-back",
          phase: record.phase,
        });
      }
      if (record.phase === "prepared") return await this.#recoverPrepared(record);
      if (record.phase === "old-library-moved" && !(await this.#exists(record.libraryPath))) {
        return await this.#restoreOldLibrary(record);
      }
      if (record.phase === "restart-validation-pending") {
        return await this.#validateOrRollback(record);
      }
      const completedRecord = await this.#completeInstalledStages(record);
      return await this.#validateOrRollback(completedRecord);
    } catch (error) {
      if (error instanceof DataImportRecoveryBlockedError) {
        // 锚定上下文不可信：隔离字节，但不得解除后续启动的恢复保护。
        await this.#quarantineJournal();
      }
      return Object.freeze({ status: "manual-safe-recovery", phase: record.phase });
    }
  }

  /** 隔离失败不掩盖恢复结果；下次启动仍可重试。 */
  async #quarantineJournal(): Promise<void> {
    try {
      await this.#options.journal.quarantine();
    } catch {
      // 保留隔离失败（权限、残留锁等），不影响 manual-safe-recovery 结果。
    }
  }

  #assertRecordAnchors(record: DataImportJournalRecord): void {
    const libraryParent = dirname(this.#libraryRoot);
    const userDataParent = dirname(this.#userDataRoot);
    const polish = record.polishHistory;
    if (
      polish &&
      (!samePath(polish.livePath, join(this.#userDataRoot, "text-polish-history")) ||
        !samePath(
          polish.stagingPath,
          join(userDataParent, `.import-user-data-${record.operationId}`, "text-polish-history"),
        ) ||
        !samePath(
          polish.rollbackPath,
          join(this.#userDataRoot, `.polish-history-rollback-${record.operationId}`),
        ))
    )
      throw new DataImportRecoveryBlockedError("polish history anchor changed");
    if (
      record.libraryPath !== this.#libraryRoot &&
      !samePath(record.libraryPath, this.#libraryRoot)
    ) {
      throw new DataImportRecoveryBlockedError("library anchor changed");
    }
    if (!samePath(record.draftsPath, join(this.#userDataRoot, "drafts"))) {
      throw new DataImportRecoveryBlockedError("draft anchor changed");
    }
    if (!isInside(libraryParent, record.stagingPath)) {
      throw new DataImportRecoveryBlockedError("staging path changed");
    }
    if (!isInside(libraryParent, record.rollbackLibraryPath)) {
      throw new DataImportRecoveryBlockedError("library rollback path changed");
    }
    if (
      !samePath(record.stagingPath, join(libraryParent, `.import-staging-${record.operationId}`)) ||
      !samePath(
        record.rollbackLibraryPath,
        join(libraryParent, `.import-rollback-${record.operationId}`),
      ) ||
      !samePath(
        record.stagingDraftsPath,
        join(userDataParent, `.import-user-data-${record.operationId}`, "drafts"),
      ) ||
      !samePath(
        record.rollbackDraftsPath,
        join(this.#userDataRoot, `.drafts-rollback-${record.operationId}`),
      ) ||
      !samePath(
        record.settingsCandidatePath,
        join(
          userDataParent,
          `.import-user-data-${record.operationId}`,
          `settings-candidate-${record.operationId}.json`,
        ),
      ) ||
      !samePath(record.settingsPath, join(this.#userDataRoot, "settings.json")) ||
      !samePath(
        record.rollbackSettingsPath,
        join(this.#userDataRoot, `settings-rollback-${record.operationId}.json`),
      )
    ) {
      throw new DataImportRecoveryBlockedError("recovery path layout changed");
    }
    if (!isInside(this.#userDataRoot, record.rollbackDraftsPath)) {
      throw new DataImportRecoveryBlockedError("draft rollback path changed");
    }
    if (
      !isInside(this.#userDataRoot, record.settingsPath) &&
      !isInside(this.#applicationDataRoot, record.settingsPath)
    )
      throw new DataImportRecoveryBlockedError("settings path changed");
    if (!isInside(userDataParent, record.settingsCandidatePath)) {
      throw new DataImportRecoveryBlockedError("settings candidate path changed");
    }
    if (
      !isInside(this.#userDataRoot, record.rollbackSettingsPath) &&
      !isInside(this.#applicationDataRoot, record.rollbackSettingsPath)
    ) {
      throw new DataImportRecoveryBlockedError("settings rollback path changed");
    }
    if (
      record.manifestPath !== undefined &&
      !samePath(
        record.manifestPath,
        join(record.stagingPath, `.import-manifest-${record.operationId}.json`),
      )
    ) {
      throw new DataImportRecoveryBlockedError("manifest path changed");
    }
  }

  async #inspect(path: string): Promise<PathState> {
    let stats: Stats;
    try {
      stats = await this.#fs.lstat(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return Object.freeze({ path, exists: false });
      throw error;
    }
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
      throw new Error("unsupported recovery path");
    }
    const canonical = await this.#fs.realpath(path);
    if (!samePath(canonical, path)) throw new Error("reparse recovery path");
    return Object.freeze({
      path,
      exists: true,
      kind: stats.isDirectory() ? "directory" : "file",
      identity: identity(stats),
    });
  }

  async #exists(path: string): Promise<boolean> {
    return (await this.#inspect(path)).exists;
  }

  async #assertKnownPathsStable(record: DataImportJournalRecord): Promise<void> {
    const identities: DataImportJournalPathIdentities = record.pathIdentities ?? {};
    for (const expected of [
      identities.stagingRoot,
      identities.stagingLibrary,
      identities.library,
      identities.stagingDraftsRoot,
      identities.stagingDrafts,
      identities.drafts,
      identities.settingsCandidate,
      identities.settings,
    ]) {
      if (!expected) throw new Error("recovery path identity missing");
    }
    if (
      (record.phase === "settings-installed" || record.phase === "restart-validation-pending") &&
      !record.settingsContentSha256
    ) {
      throw new Error("settings content identity missing");
    }
    if (record.manifestPath && !identities.manifest) {
      throw new Error("manifest identity missing");
    }
    const libraryInstalled =
      record.phase === "new-library-installed" ||
      record.phase === "drafts-installed" ||
      record.phase === "settings-installed" ||
      record.phase === "restart-validation-pending" ||
      record.phase === "committed";
    const draftsInstalled =
      record.phase === "drafts-installed" ||
      record.phase === "settings-installed" ||
      record.phase === "restart-validation-pending" ||
      record.phase === "committed";
    const settingsInstalled =
      record.phase === "settings-installed" ||
      record.phase === "restart-validation-pending" ||
      record.phase === "committed";
    const settingsRelocated = settingsInstalled || record.phase === "rolled-back";
    const paths: Array<{
      path: string;
      expected: DataImportJournalPathIdentity | undefined;
      relocated?: boolean;
      alternatives?: ReadonlyArray<{
        expected: DataImportJournalPathIdentity | undefined;
        relocated?: boolean;
      }>;
    }> = [
      { path: record.stagingPath, expected: identities.stagingRoot },
      {
        path: join(record.stagingPath, "library"),
        expected: identities.stagingLibrary,
        relocated: libraryInstalled,
      },
      {
        path: record.libraryPath,
        expected: libraryInstalled ? identities.stagingLibrary : identities.library,
        relocated: libraryInstalled,
        ...(record.phase === "old-library-moved"
          ? {
              alternatives: [{ expected: identities.stagingLibrary, relocated: true }],
            }
          : record.phase === "restart-validation-pending"
            ? {
                alternatives: [{ expected: identities.library, relocated: true }],
              }
            : {}),
      },
      {
        path: record.rollbackLibraryPath,
        expected: identities.rollbackLibrary ?? identities.library,
        relocated: true,
      },
      {
        path: dirname(record.stagingDraftsPath),
        expected: identities.stagingDraftsRoot,
      },
      {
        path: record.stagingDraftsPath,
        expected: identities.stagingDrafts,
        relocated: draftsInstalled,
      },
      {
        path: record.draftsPath,
        expected: draftsInstalled ? identities.stagingDrafts : identities.drafts,
        relocated: draftsInstalled,
        ...(record.phase === "new-library-installed"
          ? {
              alternatives: [{ expected: identities.stagingDrafts, relocated: true }],
            }
          : record.phase === "restart-validation-pending"
            ? {
                alternatives: [{ expected: identities.drafts, relocated: true }],
              }
            : {}),
      },
      {
        path: record.rollbackDraftsPath,
        expected: identities.rollbackDrafts ?? identities.drafts,
        relocated: true,
      },
      {
        path: record.settingsCandidatePath,
        expected: identities.settingsCandidate,
        relocated: settingsInstalled,
      },
      {
        path: record.settingsPath,
        expected: settingsInstalled ? identities.settingsCandidate : identities.settings,
        relocated: settingsRelocated,
        ...(record.phase === "drafts-installed"
          ? {
              alternatives: [{ expected: identities.settingsCandidate, relocated: true }],
            }
          : record.phase === "restart-validation-pending"
            ? {
                alternatives: [{ expected: identities.settings, relocated: true }],
              }
            : {}),
      },
      {
        path: record.rollbackSettingsPath,
        expected: identities.rollbackSettings ?? identities.settings,
        relocated: true,
      },
      ...(record.manifestPath && identities.manifest
        ? [{ path: record.manifestPath, expected: identities.manifest }]
        : []),
      { path: dirname(record.libraryPath), expected: undefined },
      { path: dirname(record.draftsPath), expected: undefined },
    ];
    for (const { path, expected, relocated, alternatives } of paths) {
      const state = await this.#inspect(path);
      const actualIdentity = state.identity;
      const identityMatches = [
        ...(expected ? [{ expected, relocated }] : []),
        ...(alternatives ?? []),
      ].some((candidate) => {
        if (!candidate.expected || !actualIdentity) return false;
        // Directory size/mtime changes with normal child writes and rename.
        // Object identity remains mandatory; contents are validated separately.
        if (state.kind === "directory")
          return sameObjectIdentity(actualIdentity, candidate.expected);
        return candidate.relocated
          ? sameRelocatedIdentity(actualIdentity, candidate.expected)
          : sameStableIdentity(actualIdentity, candidate.expected);
      });
      const hasExpectation = Boolean(expected) || (alternatives?.length ?? 0) > 0;
      if (state.exists && hasExpectation && !identityMatches) {
        throw new Error("recovery path identity changed");
      }
      if (state.exists && this.#options.assertStable && !(await this.#options.assertStable(path))) {
        throw new Error("recovery path identity changed");
      }
    }
    if (record.polishHistory) {
      const polish = record.polishHistory;
      for (const [path, candidates] of [
        [polish.stagingPath, [polish.stagingIdentity]],
        [polish.rollbackPath, [polish.liveIdentity]],
        [polish.livePath, [polish.liveIdentity, polish.stagingIdentity]],
      ] as const) {
        const state = await this.#inspect(path);
        const actualIdentity = state.identity;
        if (
          state.exists &&
          (state.kind !== "directory" ||
            !actualIdentity ||
            !candidates.some((expected) => sameObjectIdentity(actualIdentity, expected)))
        )
          throw new Error("polish history identity changed");
      }
    }
  }

  async #readStableFile(path: string): Promise<Buffer> {
    const before = await this.#inspect(path);
    if (!before.exists || before.kind !== "file" || !before.identity) {
      throw new Error("stable file missing");
    }
    const bytes = await this.#fs.readFile(path);
    const after = await this.#inspect(path);
    if (
      !after.exists ||
      after.kind !== "file" ||
      !after.identity ||
      !sameObjectIdentity(before.identity, after.identity)
    ) {
      throw new Error("stable file changed");
    }
    return bytes;
  }

  async #recoverPrepared(record: DataImportJournalRecord): Promise<DataImportRecoveryResult> {
    const live = await this.#inspect(record.libraryPath);
    const rollback = await this.#inspect(record.rollbackLibraryPath);
    if (!live.exists && rollback.exists) return await this.#restoreOldLibrary(record);
    if (!live.exists || rollback.exists)
      throw new Error("prepared import candidates are ambiguous");
    const empty = this.#options.isFormalLibraryEmpty
      ? await this.#options.isFormalLibraryEmpty()
      : await this.#isLibraryStructurallyEmpty(record.libraryPath);
    if (!empty) throw new Error("prepared import has a non-empty live library");
    await this.#options.journal.advance("rolled-back");
    await this.#cleanupOwned(record);
    await this.#clearJournal(record);
    return Object.freeze({ status: "abandoned" as const, phase: "prepared" as const });
  }

  async #restoreOldLibrary(record: DataImportJournalRecord): Promise<DataImportRecoveryResult> {
    const rollback = await this.#inspect(record.rollbackLibraryPath);
    if (!rollback.exists || rollback.kind !== "directory") throw new Error("old library missing");
    await this.#moveNoReplace(
      record.rollbackLibraryPath,
      record.libraryPath,
      "directory",
      record.pathIdentities?.rollbackLibrary ?? record.pathIdentities?.library,
      true,
    );
    await this.#options.journal.advance("rolled-back");
    await this.#cleanupOwned(record);
    await this.#clearJournal(record);
    return Object.freeze({ status: "rolled-back" as const, phase: record.phase });
  }

  async #completeInstalledStages(
    record: DataImportJournalRecord,
  ): Promise<DataImportJournalRecord> {
    const stagingLibrary = join(record.stagingPath, "library");
    const liveLibrary = await this.#inspect(record.libraryPath);
    const rollbackLibrary = await this.#inspect(record.rollbackLibraryPath);
    const stagedLibrary = await this.#inspect(stagingLibrary);
    const stagedDrafts = await this.#inspect(record.stagingDraftsPath);
    const drafts = await this.#inspect(record.draftsPath);
    const rollbackDrafts = await this.#inspect(record.rollbackDraftsPath);
    const candidate = await this.#inspect(record.settingsCandidatePath);
    const settings = await this.#inspect(record.settingsPath);
    const rollbackSettings = await this.#inspect(record.rollbackSettingsPath);

    if (!liveLibrary.exists && rollbackLibrary.exists) {
      await this.#moveNoReplace(
        record.rollbackLibraryPath,
        record.libraryPath,
        "directory",
        record.pathIdentities?.rollbackLibrary ?? record.pathIdentities?.library,
        true,
      );
      await this.#options.journal.advance("rolled-back");
      throw new Error("library rollback completed");
    }
    if (!liveLibrary.exists || !rollbackLibrary.exists) {
      throw new Error("library swap candidates are incomplete");
    }

    const relocatedDirectoryMatches = (
      state: PathState,
      expected: DataImportJournalPathIdentity | undefined,
    ): boolean =>
      Boolean(
        state.exists &&
          state.kind === "directory" &&
          state.identity &&
          expected &&
          sameObjectIdentity(state.identity, expected),
      );
    const relocatedFileMatches = (
      state: PathState,
      expected: DataImportJournalPathIdentity | undefined,
    ): boolean =>
      Boolean(
        state.exists &&
          state.kind === "file" &&
          state.identity &&
          expected &&
          sameRelocatedIdentity(state.identity, expected),
      );
    const requireDirectory = (state: PathState, label: string): void => {
      if (!state.exists || state.kind !== "directory") throw new Error(`${label} missing`);
    };
    const requireFile = (state: PathState, label: string): void => {
      if (!state.exists || state.kind !== "file") throw new Error(`${label} missing`);
    };
    let phase = record.phase;
    if (phase === "old-library-moved") {
      if (stagedLibrary.exists) {
        requireDirectory(stagedLibrary, "staged library");
        await this.#moveNoReplace(
          stagingLibrary,
          record.libraryPath,
          "directory",
          record.pathIdentities?.stagingLibrary,
        );
      } else if (!relocatedDirectoryMatches(liveLibrary, record.pathIdentities?.stagingLibrary)) {
        throw new Error("staged library missing");
      }
      await this.#options.journal.advance("new-library-installed");
      phase = "new-library-installed";
    }

    if (phase === "new-library-installed") {
      if (stagedDrafts.exists) {
        requireDirectory(stagedDrafts, "staged drafts");
        if (!rollbackDrafts.exists) {
          if (!drafts.exists || drafts.kind !== "directory")
            throw new Error("drafts source missing");
          await this.#moveNoReplace(
            record.draftsPath,
            record.rollbackDraftsPath,
            "directory",
            record.pathIdentities?.drafts,
          );
        }
        await this.#moveNoReplace(
          record.stagingDraftsPath,
          record.draftsPath,
          "directory",
          record.pathIdentities?.stagingDrafts,
        );
        await this.#options.journal.advance("drafts-installed");
        phase = "drafts-installed";
      } else if (
        !relocatedDirectoryMatches(drafts, record.pathIdentities?.stagingDrafts) ||
        !relocatedDirectoryMatches(rollbackDrafts, record.pathIdentities?.drafts)
      ) {
        throw new Error("staged drafts missing");
      } else {
        await this.#options.journal.advance("drafts-installed");
        phase = "drafts-installed";
      }
    }

    if (phase === "drafts-installed") {
      await this.#completePolishHistory(record);
      if (candidate.exists) {
        requireFile(candidate, "settings candidate");
        if (!rollbackSettings.exists) {
          if (!settings.exists || settings.kind !== "file")
            throw new Error("settings source missing");
          await this.#moveNoReplace(
            record.settingsPath,
            record.rollbackSettingsPath,
            "file",
            record.pathIdentities?.settings,
          );
        }
        await this.#moveNoReplace(
          record.settingsCandidatePath,
          record.settingsPath,
          "file",
          record.pathIdentities?.settingsCandidate,
        );
        await this.#options.journal.advance("settings-installed");
        phase = "settings-installed";
      } else if (
        !relocatedFileMatches(settings, record.pathIdentities?.settingsCandidate) ||
        !relocatedFileMatches(rollbackSettings, record.pathIdentities?.settings)
      ) {
        throw new Error("settings candidate missing");
      } else {
        await this.#options.journal.advance("settings-installed");
        phase = "settings-installed";
      }
    }

    if (phase === "settings-installed") {
      const installedSettings = await this.#inspect(record.settingsPath);
      const installedRollbackSettings = await this.#inspect(record.rollbackSettingsPath);
      if (
        !relocatedFileMatches(installedSettings, record.pathIdentities?.settingsCandidate) ||
        !relocatedFileMatches(installedRollbackSettings, record.pathIdentities?.settings)
      ) {
        throw new Error("installed settings mismatch");
      }
      await this.#options.journal.advance("restart-validation-pending");
      phase = "restart-validation-pending";
    }

    return { ...record, phase };
  }

  async #completePolishHistory(record: DataImportJournalRecord): Promise<void> {
    const polish = record.polishHistory;
    if (!polish) return; // Journals created before polish backup support retain their original sequence.
    if (await this.#exists(polish.stagingPath)) {
      if (!(await this.#exists(polish.rollbackPath))) {
        await this.#moveNoReplace(
          polish.livePath,
          polish.rollbackPath,
          "directory",
          polish.liveIdentity,
        );
      }
      await this.#moveNoReplace(
        polish.stagingPath,
        polish.livePath,
        "directory",
        polish.stagingIdentity,
      );
    }
    await this.#assertPolishHistoryInstalled(record);
  }

  async #assertPolishHistoryInstalled(record: DataImportJournalRecord): Promise<void> {
    const polish = record.polishHistory;
    if (!polish) return;
    const live = await this.#inspect(polish.livePath);
    const rollback = await this.#inspect(polish.rollbackPath);
    if (
      !live.identity ||
      !rollback.identity ||
      live.kind !== "directory" ||
      rollback.kind !== "directory" ||
      !sameObjectIdentity(live.identity, polish.stagingIdentity) ||
      !sameObjectIdentity(rollback.identity, polish.liveIdentity)
    )
      throw new Error("polish history install incomplete");
    await this.#assertRegularTree(polish.livePath);
  }

  async #validateOrRollback(record: DataImportJournalRecord): Promise<DataImportRecoveryResult> {
    if (record.phase !== "restart-validation-pending") {
      throw new Error("invalid validation phase");
    }
    let valid = false;
    try {
      // A restored or removed live root means rollback has already started.
      // Never validate (and commit) a mixture of old and imported roots.
      for (const [path, expected] of [
        [record.libraryPath, record.pathIdentities?.stagingLibrary],
        [record.draftsPath, record.pathIdentities?.stagingDrafts],
        [record.settingsPath, record.pathIdentities?.settingsCandidate],
      ] as const) {
        const state = await this.#inspect(path);
        if (
          !state.identity ||
          !expected ||
          !(state.kind === "directory"
            ? sameObjectIdentity(state.identity, expected)
            : sameRelocatedIdentity(state.identity, expected))
        )
          throw new Error("installed root identity changed");
      }
      await this.#assertPolishHistoryInstalled(record);
      valid = this.#options.validateInstalled
        ? (await this.#options.validateInstalled(record)) !== false
        : await this.#defaultValidateInstalled(record);
    } catch {
      valid = false;
    }
    if (valid) {
      await this.#options.journal.advance("committed");
      await this.#cleanupOwned(record);
      await this.#clearJournal(record);
      return Object.freeze({ status: "recovered" as const, phase: record.phase });
    }
    await this.#rollbackInstalled(record);
    await this.#options.journal.advance("rolled-back");
    await this.#cleanupOwned(record);
    await this.#clearJournal(record);
    return Object.freeze({ status: "rolled-back" as const, phase: record.phase });
  }

  async #defaultValidateInstalled(record: DataImportJournalRecord): Promise<boolean> {
    const databasePath = join(record.libraryPath, "library.sqlite3");
    const database = await this.#inspect(databasePath);
    if (!database.exists || database.kind !== "file") return false;
    const drafts = await this.#inspect(record.draftsPath);
    if (!drafts.exists || drafts.kind !== "directory") return false;
    const settings = await this.#inspect(record.settingsPath);
    if (!settings.exists || settings.kind !== "file") return false;
    const settingsBytes = await this.#readStableFile(record.settingsPath);
    try {
      if (!validateRecoveredSettingsContent(settingsBytes, record.settingsContentSha256)) {
        return false;
      }
    } finally {
      settingsBytes.fill(0);
    }
    await this.#assertRegularTree(record.libraryPath);
    await this.#assertRegularTree(record.draftsPath);
    if (!record.manifestPath) return false;
    const manifestState = await this.#inspect(record.manifestPath);
    if (!manifestState.exists || manifestState.kind !== "file") return false;
    const manifest = TransferManifestSchema.parse(
      JSON.parse((await this.#fs.readFile(record.manifestPath)).toString("utf8")),
    );
    const [packageRoot, portableSettingsRoot] = await Promise.all([
      this.#findPackageExtractionRoot(record.stagingPath),
      this.#findPackageExtractionRoot(dirname(record.stagingDraftsPath)),
    ]);
    const summary = await new ImportStagingValidator().validate(
      {
        installed: true,
        libraryRoot: record.libraryPath,
        userDataRoot: this.#userDataRoot,
        packageRoot,
        portableSettingsRoot,
        legacyDraftsRoot: record.draftsPath,
        ...(record.polishHistory ? { polishHistoryRoot: record.polishHistory.livePath } : {}),
        ...(record.databaseContentSha256 !== undefined && record.databaseByteLength !== undefined
          ? {
              installedDatabaseIntegrity: {
                byteLength: record.databaseByteLength,
                sha256: record.databaseContentSha256,
              },
            }
          : {}),
      },
      manifest,
    );
    return (
      summary.activePatents === manifest.summary.activePatents &&
      summary.trashedPatents === manifest.summary.trashedPatents &&
      summary.documents === manifest.summary.documents &&
      summary.legacyDrafts === manifest.summary.legacyDrafts &&
      summary.snapshots === manifest.summary.snapshots &&
      summary.assets === manifest.summary.assets &&
      summary.flowchartProjects === manifest.summary.flowchartProjects &&
      summary.totalBytes === manifest.summary.totalBytes
    );
  }

  async #findPackageExtractionRoot(ownerRoot: string): Promise<string> {
    const candidates = (await this.#fs.readdir(ownerRoot)).filter((name) =>
      /^\.package-extract-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        name,
      ),
    );
    const name = candidates[0];
    if (candidates.length !== 1 || !name) throw new Error("package extraction root missing");
    const candidate = join(ownerRoot, name);
    const state = await this.#inspect(candidate);
    if (!state.exists || state.kind !== "directory") {
      throw new Error("package extraction root missing");
    }
    return candidate;
  }

  async #rollbackInstalled(record: DataImportJournalRecord): Promise<void> {
    if (record.polishHistory) {
      const polish = record.polishHistory;
      if (await this.#exists(polish.rollbackPath)) {
        if (await this.#exists(polish.livePath))
          await this.#removeOwned(polish.livePath, polish.stagingIdentity);
        await this.#moveNoReplace(
          polish.rollbackPath,
          polish.livePath,
          "directory",
          polish.liveIdentity,
          true,
        );
      } else {
        // A previous rollback may have restored history before another root failed.
        const restored = await this.#inspect(polish.livePath);
        if (
          restored.kind !== "directory" ||
          !restored.identity ||
          !sameObjectIdentity(restored.identity, polish.liveIdentity)
        )
          throw new Error("polish history rollback missing");
      }
    }
    for (const [livePath, rollbackPath, kind, original, imported] of [
      [
        record.libraryPath,
        record.rollbackLibraryPath,
        "directory",
        record.pathIdentities?.rollbackLibrary ?? record.pathIdentities?.library,
        record.pathIdentities?.stagingLibrary,
      ],
      [
        record.draftsPath,
        record.rollbackDraftsPath,
        "directory",
        record.pathIdentities?.rollbackDrafts ?? record.pathIdentities?.drafts,
        record.pathIdentities?.stagingDrafts,
      ],
      [
        record.settingsPath,
        record.rollbackSettingsPath,
        "file",
        record.pathIdentities?.rollbackSettings ?? record.pathIdentities?.settings,
        record.pathIdentities?.settingsCandidate,
      ],
    ] as const) {
      const rollback = await this.#inspect(rollbackPath);
      const live = await this.#inspect(livePath);
      if (!rollback.exists) {
        if (
          live.kind !== kind ||
          !live.identity ||
          !original ||
          !(kind === "directory"
            ? sameObjectIdentity(live.identity, original)
            : sameRelocatedIdentity(live.identity, original))
        )
          throw new Error("restored root identity missing");
        continue;
      }
      if (live.exists) await this.#removeOwned(livePath, imported);
      await this.#moveNoReplace(rollbackPath, livePath, kind, original, true);
    }
  }

  async #cleanupOwned(record: DataImportJournalRecord): Promise<void> {
    for (const { path, expected } of [
      ...(record.polishHistory
        ? [{ path: record.polishHistory.rollbackPath, expected: record.polishHistory.liveIdentity }]
        : []),
      { path: record.stagingPath, expected: record.pathIdentities?.stagingRoot },
      {
        path: dirname(record.stagingDraftsPath),
        expected: record.pathIdentities?.stagingDraftsRoot,
      },
      {
        path: record.rollbackLibraryPath,
        expected: record.pathIdentities?.rollbackLibrary ?? record.pathIdentities?.library,
      },
      {
        path: record.rollbackDraftsPath,
        expected: record.pathIdentities?.rollbackDrafts ?? record.pathIdentities?.drafts,
      },
      {
        path: record.rollbackSettingsPath,
        expected: record.pathIdentities?.rollbackSettings ?? record.pathIdentities?.settings,
      },
    ]) {
      // A terminal journal remains durable until every owned path is removed.
      // On restart its phase bypasses validation/rollback and retries cleanup.
      if (await this.#exists(path)) await this.#removeOwned(path, expected);
    }
  }

  async #assertRegularTree(root: string): Promise<void> {
    const state = await this.#inspect(root);
    if (!state.exists || state.kind !== "directory") throw new Error("recovery tree missing");
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      for (const name of await this.#fs.readdir(current)) {
        const child = join(current, name);
        const childState = await this.#inspect(child);
        if (!childState.exists) throw new Error("recovery tree changed");
        if (childState.kind === "directory") pending.push(child);
      }
    }
  }

  async #removeOwned(path: string, expected?: DataImportJournalPathIdentity): Promise<void> {
    const before = await this.#inspect(path);
    if (!before.exists || !before.identity) throw new Error("owned path missing");
    if (
      expected &&
      (before.kind === "directory"
        ? !sameObjectIdentity(before.identity, expected)
        : !sameRelocatedIdentity(before.identity, expected))
    ) {
      throw new Error("owned path identity changed");
    }
    if (this.#options.assertStable && !(await this.#options.assertStable(path))) {
      throw new Error("owned path identity changed");
    }
    await this.#fs.remove(path, before.identity);
    try {
      await this.#fs.lstat(path);
      throw new Error("owned path was not removed");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  async #moveNoReplace(
    source: string,
    target: string,
    kind: "file" | "directory",
    expectedSource?: DataImportJournalPathIdentity,
    expectedSourceRelocated = false,
  ): Promise<void> {
    const sourceState = await this.#inspect(source);
    if (!sourceState.exists || sourceState.kind !== kind || !sourceState.identity)
      throw new Error("swap source missing");
    if (
      expectedSource &&
      (kind === "directory"
        ? !sameObjectIdentity(sourceState.identity, expectedSource)
        : expectedSourceRelocated
          ? !sameRelocatedIdentity(sourceState.identity, expectedSource)
          : !sameStableIdentity(sourceState.identity, expectedSource))
    ) {
      throw new Error("swap source identity changed");
    }
    const targetState = await this.#inspect(target);
    if (targetState.exists) throw new Error("swap target already exists");
    const parent = await this.#inspect(dirname(target));
    if (!parent.exists || parent.kind !== "directory") throw new Error("swap parent missing");
    if (this.#options.assertStable && !(await this.#options.assertStable(source)))
      throw new Error("swap source changed");
    await this.#fs.rename(source, target);
    const installed = await this.#inspect(target);
    if (
      !installed.exists ||
      installed.kind !== kind ||
      !installed.identity ||
      (kind === "directory"
        ? !sameObjectIdentity(sourceState.identity, installed.identity)
        : !sameRelocatedIdentity(sourceState.identity, installed.identity)) ||
      (expectedSource &&
        (kind === "directory"
          ? !sameObjectIdentity(installed.identity, expectedSource)
          : !sameRelocatedIdentity(installed.identity, expectedSource)))
    ) {
      throw new Error("swap identity changed");
    }
  }

  async #clearJournal(_record: DataImportJournalRecord): Promise<void> {
    await this.#options.journal.clear();
  }

  async #isLibraryStructurallyEmpty(libraryPath: string): Promise<boolean> {
    const state = await this.#inspect(libraryPath);
    if (!state.exists || state.kind !== "directory") return false;
    const databasePath = join(libraryPath, "library.sqlite3");
    const database = await this.#inspect(databasePath);
    if (database.exists) {
      const opened = LibraryDatabase.openReadOnly(databasePath);
      try {
        const inspector = new EmptyLibraryInspector({
          libraryRoot: libraryPath,
          userDataRoot: this.#userDataRoot,
          applicationDataRoot: this.#applicationDataRoot,
          database: opened,
        });
        if (!inspector.inspectDatabaseContent().empty) return false;
      } finally {
        opened.close();
      }
    } else if (
      (await this.#exists(join(libraryPath, "library.sqlite3-wal"))) ||
      (await this.#exists(join(libraryPath, "library.sqlite3-shm")))
    ) {
      return false;
    }
    const entries = await readdir(libraryPath);
    for (const name of entries) {
      if (
        ![
          "library.sqlite3",
          "library.sqlite3-wal",
          "library.sqlite3-shm",
          "last-run-state.json",
          "assets",
        ].includes(name)
      )
        return false;
    }
    const assets = await this.#inspect(join(libraryPath, "assets"));
    if (assets.exists) {
      const assetEntries = await readdir(join(libraryPath, "assets"));
      if (assetEntries.length > 0) return false;
    }
    return true;
  }
}
