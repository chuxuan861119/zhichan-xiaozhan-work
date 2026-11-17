import { lstat, readdir, rename as renameDefault } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { APPLICATION_DATA_DIRECTORY } from "../../shared/branding.js";

const LEGACY_APPLICATION_DATA_DIRECTORY = "PatentWorkbench";
const LIBRARY_DIRECTORY = "Library";

type RenameDirectory = (source: string, destination: string) => Promise<void>;

export class LibraryDirectoryMigrationError extends Error {
  constructor(
    readonly code: "LIBRARY_DIRECTORY_CONFLICT" | "LIBRARY_DIRECTORY_MIGRATION_FAILED",
    message: string,
    readonly paths: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LibraryDirectoryMigrationError";
  }
}

type MigrationResult =
  | { status: "not-needed" | "migrated"; libraryRoot: string }
  | { status: "overridden"; libraryRoot: null };

type MigrationOptions = Readonly<{
  localAppData: string;
  hasExplicitOverride?: boolean;
  rename?: RenameDirectory;
}>;

function applicationDirectory(localAppData: string, name: string): string {
  if (!isAbsolute(localAppData)) throw new Error("localAppData must be absolute.");
  const root = resolve(localAppData);
  if (parse(root).root === root) throw new Error("localAppData must not be a filesystem root.");
  return join(root, name);
}

async function directoryEntries(path: string): Promise<readonly string[] | null> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new LibraryDirectoryMigrationError(
        "LIBRARY_DIRECTORY_MIGRATION_FAILED",
        `专利库数据目录不是普通文件夹：${path}`,
        [path],
      );
    }
    return (await readdir(path)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function migrateDefaultLibraryDirectory(
  options: MigrationOptions,
): Promise<MigrationResult> {
  if (options.hasExplicitOverride === true) return { status: "overridden", libraryRoot: null };

  const legacy = applicationDirectory(options.localAppData, LEGACY_APPLICATION_DATA_DIRECTORY);
  const current = applicationDirectory(options.localAppData, APPLICATION_DATA_DIRECTORY);
  const libraryRoot = join(current, LIBRARY_DIRECTORY);
  const [legacyEntries, currentEntries] = await Promise.all([
    directoryEntries(legacy),
    directoryEntries(current),
  ]);

  if (legacyEntries === null) return { status: "not-needed", libraryRoot };
  if (currentEntries !== null) {
    if (legacyEntries.length === 0 && currentEntries.length === 0) {
      return { status: "not-needed", libraryRoot };
    }
    throw new LibraryDirectoryMigrationError(
      "LIBRARY_DIRECTORY_CONFLICT",
      `检测到新旧专利库数据目录同时存在，请先备份并人工确认后再启动。\n旧目录：${legacy}\n新目录：${current}`,
      [legacy, current],
    );
  }

  try {
    await (options.rename ?? renameDefault)(legacy, current);
    const [remainingLegacy, migratedEntries] = await Promise.all([
      directoryEntries(legacy),
      directoryEntries(current),
    ]);
    if (
      remainingLegacy !== null ||
      migratedEntries === null ||
      migratedEntries.length !== legacyEntries.length ||
      migratedEntries.some((entry, index) => entry !== legacyEntries[index])
    ) {
      throw new Error("migrated directory verification failed");
    }
    return { status: "migrated", libraryRoot };
  } catch (error) {
    if (error instanceof LibraryDirectoryMigrationError) throw error;
    throw new LibraryDirectoryMigrationError(
      "LIBRARY_DIRECTORY_MIGRATION_FAILED",
      `无法迁移旧专利库数据目录，软件未创建或覆盖新专利库。\n旧目录：${legacy}\n新目录：${current}`,
      [legacy, current],
      { cause: error },
    );
  }
}
