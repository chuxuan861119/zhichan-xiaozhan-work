import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile as copyFileDefault,
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

const DATABASE_NAME = "library.sqlite3";
const ASSETS_DIRECTORY_NAME = "assets";
const BACKUPS_DIRECTORY_NAME = "safety-backups";
const ASSET_MANIFEST_NAME = "asset-manifest.json";
const MAX_ASSET_FILES = 10_000;
const MAX_ASSET_DIRECTORIES = 1_024;
const MAX_ASSET_DIRECTORY_ENTRIES = 4_096;
const MAX_ASSET_DEPTH = 32;
const MAX_ASSET_RELATIVE_PATH_BYTES = 1_024;
const MAX_ASSET_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_BACKUP_COLLISIONS = 1_000;

export type LibrarySafetyBackupEvent =
  | "backup-database"
  | "backup-wal"
  | "backup-shm"
  | "asset-manifest";

type Fingerprint = { size: number; sha256: string };

type SourceSnapshot = Map<string, Fingerprint>;

export type LibrarySafetyBackup = {
  directory: string;
  logicalDatabaseSnapshot: SourceSnapshot;
};

export type LibrarySafetyBackupDependencies = {
  now?: (() => Date) | undefined;
  onEvent?: ((event: LibrarySafetyBackupEvent) => void) | undefined;
  copyFile?: ((source: string, destination: string) => Promise<void>) | undefined;
  hashFile?: ((path: string) => Promise<Fingerprint>) | undefined;
};

type AssetManifestEntry = {
  relativePath: string;
  size: number;
  sha256: string;
};

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function compareSafetyBackupAssetPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function normalizedFileSystemPath(path: string): string {
  const normalized = resolve(path).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameFileSystemPath(left: string, right: string): boolean {
  return normalizedFileSystemPath(left) === normalizedFileSystemPath(right);
}

async function pathInfo(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function defaultHashFile(path: string): Promise<Fingerprint> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (!Number.isSafeInteger(size)) throw new Error("File is too large to verify safely");
    hash.update(bytes);
  }
  return { size, sha256: hash.digest("hex") };
}

export class LibrarySafetyBackupService {
  private readonly now: () => Date;
  private readonly onEvent: (event: LibrarySafetyBackupEvent) => void;
  private readonly copyFile: (source: string, destination: string) => Promise<void>;
  private readonly hashFile: (path: string) => Promise<Fingerprint>;

  constructor(
    private readonly requestedRoot: string,
    dependencies: LibrarySafetyBackupDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.onEvent = dependencies.onEvent ?? (() => undefined);
    this.copyFile = dependencies.copyFile ?? copyFileDefault;
    this.hashFile = dependencies.hashFile ?? defaultHashFile;
  }

  async create(): Promise<LibrarySafetyBackup> {
    const root = await this.#validateRoot();
    const backup = await this.#createUniqueBackupDirectory(root);
    try {
      const before = await this.#snapshotBackupSources(root);
      for (const name of before.keys()) {
        await this.copyFile(resolve(root, name), resolve(backup, name));
      }
      await this.#writeAndVerifyAssetManifest(root, backup);
      const after = await this.#snapshotBackupSources(root);
      if (!sameSnapshot(before, after)) throw new Error("Backup source set changed");
      for (const [name, sourceFingerprint] of before) {
        const destinationFingerprint = await this.hashFile(resolve(backup, name));
        if (
          destinationFingerprint.size !== sourceFingerprint.size ||
          destinationFingerprint.sha256 !== sourceFingerprint.sha256
        ) {
          throw new Error("Backup destination verification failed");
        }
      }

      const events = new Map<string, LibrarySafetyBackupEvent>([
        [DATABASE_NAME, "backup-database"],
        [`${DATABASE_NAME}-wal`, "backup-wal"],
        [`${DATABASE_NAME}-shm`, "backup-shm"],
      ]);
      for (const name of before.keys()) {
        const event = events.get(name);
        if (event !== undefined) this.onEvent(event);
      }
      this.onEvent("asset-manifest");

      return { directory: backup, logicalDatabaseSnapshot: logicalDatabaseSnapshot(after) };
    } catch (error) {
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #validateRoot(): Promise<string> {
    const absoluteRoot = resolve(this.requestedRoot);
    await validateExistingAncestorChain(absoluteRoot);
    const rootInfo = await pathInfo(absoluteRoot);
    if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("Invalid library root");
    }
    const root = await realpath(absoluteRoot);
    if (!isSameFileSystemPath(root, absoluteRoot)) throw new Error("Library root escaped its path");
    return root;
  }

  async #createUniqueBackupDirectory(root: string): Promise<string> {
    const backups = resolve(root, BACKUPS_DIRECTORY_NAME);
    const backupsInfo = await pathInfo(backups);
    if (backupsInfo !== null && (!backupsInfo.isDirectory() || backupsInfo.isSymbolicLink())) {
      throw new Error("Invalid safety backup root");
    }
    if (backupsInfo === null) await mkdir(backups);
    const resolvedBackups = await realpath(backups);
    if (!isInside(root, resolvedBackups)) throw new Error("Safety backup root escaped library");

    const timestamp = this.now().toISOString().replace(/[-:.]/gu, "");
    for (let collision = 0; collision < MAX_BACKUP_COLLISIONS; collision += 1) {
      const suffix = collision === 0 ? "" : `-${collision}`;
      const candidate = resolve(resolvedBackups, `${timestamp}${suffix}`);
      if (!isInside(resolvedBackups, candidate)) throw new Error("Invalid backup destination");
      try {
        await mkdir(candidate);
        return candidate;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
    }
    throw new Error("Could not allocate a unique safety backup directory");
  }

  async #snapshotBackupSources(root: string): Promise<SourceSnapshot> {
    const snapshot: SourceSnapshot = new Map();
    for (const [name, optional] of [
      [DATABASE_NAME, false],
      [`${DATABASE_NAME}-wal`, true],
      [`${DATABASE_NAME}-shm`, true],
    ] as const) {
      const source = resolve(root, name);
      const sourceInfo = await pathInfo(source);
      if (sourceInfo === null && optional) continue;
      if (sourceInfo === null || !sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
        throw new Error("Invalid backup source");
      }
      const canonicalSource = await realpath(source);
      if (!isInside(root, canonicalSource) || canonicalSource !== source) {
        throw new Error("Backup source escaped library");
      }
      snapshot.set(name, await this.hashFile(source));
    }
    return snapshot;
  }

  async #writeAndVerifyAssetManifest(root: string, backup: string): Promise<void> {
    const assetRoot = resolve(root, ASSETS_DIRECTORY_NAME);
    const assetInfo = await pathInfo(assetRoot);
    const entries = assetInfo === null ? [] : await this.#collectAssets(root, assetRoot);
    const manifest = `${JSON.stringify({ version: 1, assets: entries }, null, 2)}\n`;
    if (Buffer.byteLength(manifest) > MAX_ASSET_MANIFEST_BYTES) {
      throw new Error("Asset manifest is too large");
    }

    const manifestPath = resolve(backup, ASSET_MANIFEST_NAME);
    await writeFile(manifestPath, manifest, { encoding: "utf8", flag: "wx" });
    const copiedManifest = await readFile(manifestPath, "utf8");
    if (copiedManifest !== manifest) throw new Error("Asset manifest verification failed");
    for (const entry of entries) {
      const source = resolve(assetRoot, ...entry.relativePath.split("/"));
      const fingerprint = await this.hashFile(source);
      if (fingerprint.size !== entry.size || fingerprint.sha256 !== entry.sha256) {
        throw new Error("Asset changed while creating its manifest");
      }
    }
  }

  async #collectAssets(root: string, assetRoot: string): Promise<AssetManifestEntry[]> {
    const canonicalAssetRoot = await realpath(assetRoot);
    if (!isInside(root, canonicalAssetRoot) || canonicalAssetRoot !== assetRoot) {
      throw new Error("Asset root escaped library");
    }

    const files: Array<{ path: string; relativePath: string; size: number }> = [];
    const directories: Array<{ path: string; depth: number }> = [{ path: assetRoot, depth: 0 }];
    let directoryCount = 1;
    let entryCount = 0;
    let totalBytes = 0;
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory === undefined) break;
      const handle = await opendir(directory.path);
      for await (const child of handle) {
        entryCount += 1;
        if (entryCount > MAX_ASSET_DIRECTORY_ENTRIES) {
          throw new Error("Asset directory entry bound exceeded");
        }
        const path = resolve(directory.path, child.name);
        if (!isInside(assetRoot, path) || child.isSymbolicLink()) {
          throw new Error("Asset path escaped asset root");
        }
        const relativePath = relative(assetRoot, path).split(sep).join("/");
        if (
          relativePath.length === 0 ||
          Buffer.byteLength(relativePath, "utf8") > MAX_ASSET_RELATIVE_PATH_BYTES
        ) {
          throw new Error("Invalid asset relative path");
        }
        if (child.isDirectory()) {
          const childDepth = directory.depth + 1;
          directoryCount += 1;
          if (directoryCount > MAX_ASSET_DIRECTORIES || childDepth > MAX_ASSET_DEPTH) {
            throw new Error("Asset directory bound exceeded");
          }
          const info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error("Invalid asset directory");
          }
          directories.push({ path, depth: childDepth });
          continue;
        }
        if (!child.isFile()) throw new Error("Unsupported entry in asset root");
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size)) {
          throw new Error("Invalid asset file");
        }
        totalBytes += info.size;
        if (
          files.length >= MAX_ASSET_FILES ||
          !Number.isSafeInteger(totalBytes) ||
          totalBytes > MAX_ASSET_TOTAL_BYTES
        ) {
          throw new Error("Asset manifest bounds exceeded");
        }
        files.push({ path, relativePath, size: info.size });
      }
    }

    files.sort((left, right) =>
      compareSafetyBackupAssetPaths(left.relativePath, right.relativePath),
    );
    const entries: AssetManifestEntry[] = [];
    for (const file of files) {
      const fingerprint = await this.hashFile(file.path);
      if (fingerprint.size !== file.size) throw new Error("Asset changed while hashing");
      entries.push({
        relativePath: file.relativePath,
        size: fingerprint.size,
        sha256: fingerprint.sha256,
      });
    }
    return entries;
  }
}

async function validateExistingAncestorChain(absoluteRoot: string): Promise<void> {
  const parsed = parse(absoluteRoot);
  let current = parsed.root;
  let nearestExistingAncestor = parsed.root;
  const components = absoluteRoot.slice(parsed.root.length).split(sep).filter(Boolean);
  for (const component of components) {
    current = resolve(current, component);
    const info = await pathInfo(current);
    if (info === null) break;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Library ancestor is not a plain directory");
    }
    nearestExistingAncestor = current;
    try {
      const canonical = await realpath(current);
      if (!isSameFileSystemPath(canonical, current)) {
        throw new Error("Library ancestor escaped its lexical path");
      }
    } catch (error) {
      if (!isNodeError(error, "EPERM")) throw error;
    }
  }
  const canonicalAncestor = await realpath(nearestExistingAncestor);
  if (!isSameFileSystemPath(canonicalAncestor, nearestExistingAncestor)) {
    throw new Error("Library ancestor escaped its lexical path");
  }
}

function sameSnapshot(left: SourceSnapshot, right: SourceSnapshot): boolean {
  if (left.size !== right.size) return false;
  for (const [name, fingerprint] of left) {
    const candidate = right.get(name);
    if (
      candidate === undefined ||
      candidate.size !== fingerprint.size ||
      candidate.sha256 !== fingerprint.sha256
    ) {
      return false;
    }
  }
  return true;
}

function logicalDatabaseSnapshot(snapshot: SourceSnapshot): SourceSnapshot {
  const logical: SourceSnapshot = new Map();
  const database = snapshot.get(DATABASE_NAME);
  if (database === undefined) throw new Error("Backup database fingerprint is missing");
  logical.set(DATABASE_NAME, database);
  const wal = snapshot.get(`${DATABASE_NAME}-wal`);
  if (wal !== undefined && wal.size > 0) logical.set(`${DATABASE_NAME}-wal`, wal);
  return logical;
}
