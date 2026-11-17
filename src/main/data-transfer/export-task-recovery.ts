import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { movePathNoReplace } from "../platform/move-no-replace.js";
import { hasUnresolvedDataImport } from "./data-import-journal.js";
import { type OwnedPathIdentity, removeOwnedPath } from "./owned-path-cleanup.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TASK_NAME = new RegExp(`^\\.full-data-export-(${UUID})(?:\\.cleanup-${UUID})?$`, "iu");
const INITIALIZING_NAME = new RegExp(`^\\.full-data-export-init-(${UUID})-([0-9a-f]{64})$`, "u");
const CLEANUP_SUFFIX = ".cleanup-record.json";
const OWNER = ".full-data-export-owner";
const RECEIPT = ".full-data-export-recovery.json";
const identitySchema = z
  .object({
    device: z.string().regex(/^\d+$/u),
    inode: z.string().regex(/^\d+$/u),
    birthtimeNs: z.string().regex(/^\d+$/u),
  })
  .strict();
const receiptSchema = z
  .object({
    version: z.literal(1),
    rootPath: z.string(),
    rootIdentity: identitySchema,
    markerSecret: z.string().regex(/^[0-9a-f]{64}$/u),
    operationId: z.uuid(),
    finalPath: z.string(),
    files: z.array(z.object({ path: z.string(), identity: identitySchema }).strict()).max(2),
  })
  .strict();
export type ExportTaskReceipt = z.infer<typeof receiptSchema>;
const cleanupSchema = z
  .object({
    version: z.literal(1),
    taskPath: z.string(),
    taskIdentity: identitySchema,
    markerSecret: z.string().regex(/^[0-9a-f]{64}$/u),
    receipt: receiptSchema.optional(),
  })
  .strict();
type OwnedExportTask = {
  path: string;
  identity: OwnedPathIdentity;
  markerSecret: string;
  files: ExportTaskReceipt["files"];
  receipt?: ExportTaskReceipt;
};
const samePath = (left: string, right: string) =>
  process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
const identityOf = (info: {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}): OwnedPathIdentity => ({
  device: String(info.dev),
  inode: String(info.ino),
  birthtimeNs: String(info.birthtimeNs),
});
const sameIdentity = (left: OwnedPathIdentity, right: OwnedPathIdentity) =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.birthtimeNs === right.birthtimeNs;

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** No payload enters a directory until its complete owner has been atomically published. */
export async function createOwnedExportTask(workRoot: string): Promise<OwnedExportTask> {
  const id = randomUUID(),
    secret = randomBytes(32).toString("hex");
  const preparing = join(resolve(workRoot), `.full-data-export-init-${id}-${secret}`);
  const path = join(resolve(workRoot), `.full-data-export-${id}`);
  await mkdir(preparing);
  const marker = await open(join(preparing, OWNER), "wx", 0o600);
  try {
    await marker.writeFile(secret, "ascii");
    await marker.sync();
  } finally {
    await marker.close();
  }
  await syncDirectory(preparing);
  const identity = identityOf(await lstat(preparing, { bigint: true }));
  await movePathNoReplace(preparing, path);
  await syncDirectory(resolve(workRoot));
  return { path, identity, markerSecret: secret, files: [] };
}

async function inspectInitializingTask(workRoot: string, name: string) {
  const match = INITIALIZING_NAME.exec(name);
  if (!match) return undefined;
  const path = join(resolve(workRoot), name);
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path))
    return undefined;
  const entries = await readdir(path);
  if (entries.some((entry) => entry !== OWNER)) return undefined;
  const markerPath = join(path, OWNER);
  const marker = await boundedPlainFile(markerPath, 64);
  if (marker !== undefined && !match[2]?.startsWith(marker.contents)) return undefined;
  return {
    path,
    markerPath: marker === undefined ? undefined : markerPath,
    markerIdentity: marker?.identity,
  };
}

async function readCleanupRecord(workRoot: string, name: string) {
  if (!TASK_NAME.test(name)) return undefined;
  const path = join(resolve(workRoot), `${name}${CLEANUP_SUFFIX}`);
  const bytes = await boundedPlainFile(path, 16384);
  if (bytes === undefined) return undefined;
  const record = cleanupSchema.parse(JSON.parse(bytes.contents));
  const taskPath = join(resolve(workRoot), name);
  if (!isAbsolute(record.taskPath) || !samePath(record.taskPath, taskPath))
    throw new Error("Unsafe export cleanup record");
  if (record.receipt)
    validateReceipt(record.receipt, taskPath, record.taskIdentity, record.markerSecret);
  return { record, identity: bytes.identity };
}

/** A sibling credential survives partial recursive removal of the disposable copy. */
export async function removeOwnedExportTaskRoot(task: OwnedExportTask): Promise<void> {
  const workRoot = dirname(task.path),
    name = basename(task.path);
  const cleanup = await readCleanupRecord(workRoot, name);
  let recordIdentity = cleanup?.identity;
  if (cleanup) {
    const { record } = cleanup;
    if (
      !sameIdentity(record.taskIdentity, task.identity) ||
      record.markerSecret !== task.markerSecret
    )
      throw new Error("Export cleanup ownership changed");
  } else {
    // Write inside the still-owned root, then atomically publish a complete record outside it.
    // A crash before publication leaves the original owner and receipt intact.
    const current = await readOwnedExportTask(workRoot, name);
    if (
      !current ||
      !sameIdentity(current.identity, task.identity) ||
      current.markerSecret !== task.markerSecret
    )
      throw new Error("Export cleanup ownership changed");
    const record = {
      version: 1,
      taskPath: task.path,
      taskIdentity: task.identity,
      markerSecret: task.markerSecret,
      ...(task.receipt ? { receipt: task.receipt } : {}),
    };
    const temporary = join(task.path, `.cleanup-record-${randomUUID()}.partial`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
      recordIdentity = identityOf(await handle.stat({ bigint: true }));
    } finally {
      await handle.close();
    }
    await movePathNoReplace(temporary, join(workRoot, `${name}${CLEANUP_SUFFIX}`));
    await syncDirectory(workRoot);
  }
  const recordPath = join(workRoot, `${name}${CLEANUP_SUFFIX}`);
  if (!recordIdentity) throw new Error("Unverified export cleanup record");
  await removeOwnedPath(task.path, task.identity);
  await removeOwnedPath(recordPath, recordIdentity);
}

async function boundedPlainFile(
  path: string,
  limit: number,
): Promise<{ contents: string; identity: OwnedPathIdentity } | undefined> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > limit ||
    !samePath(await realpath(path), path)
  )
    throw new Error("Unsafe export ownership record");
  const handle = await open(path, "r");
  try {
    const actual = await handle.stat({ bigint: true });
    const expected = await lstat(path, { bigint: true });
    if (!sameIdentity(identityOf(actual), identityOf(expected)) || actual.size > BigInt(limit))
      throw new Error("Export ownership changed");
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error("Oversized export ownership record");
    return {
      contents: bytes.subarray(0, bytesRead).toString("utf8"),
      identity: identityOf(actual),
    };
  } finally {
    await handle.close();
  }
}

function validateReceipt(
  record: ExportTaskReceipt,
  taskRoot: string,
  identity: OwnedPathIdentity,
  secret: string,
): void {
  if (
    !isAbsolute(record.rootPath) ||
    !samePath(dirname(record.rootPath), dirname(taskRoot)) ||
    !(
      samePath(record.rootPath, taskRoot) ||
      basename(taskRoot).startsWith(`${basename(record.rootPath)}.cleanup-`)
    ) ||
    !sameIdentity(record.rootIdentity, identity) ||
    record.markerSecret !== secret ||
    !isAbsolute(record.finalPath) ||
    !record.finalPath.toLowerCase().endsWith(".zxwbackup")
  )
    throw new Error("Export recovery anchors changed");
  const partial = `.${basename(record.finalPath, extname(record.finalPath))}.${record.operationId}.zxwbackup.partial`;
  const names = new Set<string>();
  for (const file of record.files) {
    const name = basename(file.path);
    if (
      !isAbsolute(file.path) ||
      !samePath(dirname(file.path), dirname(record.finalPath)) ||
      samePath(file.path, record.finalPath) ||
      names.has(name) ||
      (name !== partial &&
        !new RegExp(`^\\.verified-${UUID}\\.zxwbackup\\.partial$`, "iu").test(name))
    )
      throw new Error("Unsafe export cleanup target");
    names.add(name);
  }
}

/** Ownership is flushed before writing payload or creating a publication anchor. */
export async function recordExportTaskFiles(record: ExportTaskReceipt): Promise<void> {
  const safe = receiptSchema.parse(record);
  const info = await lstat(safe.rootPath, { bigint: true });
  const secret = await boundedPlainFile(join(safe.rootPath, OWNER), 64);
  if (
    !TASK_NAME.test(basename(safe.rootPath)) ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !samePath(await realpath(safe.rootPath), safe.rootPath) ||
    secret === undefined
  )
    throw new Error("Unsafe export task");
  validateReceipt(safe, safe.rootPath, identityOf(info), secret.contents);
  const partial = join(safe.rootPath, `${RECEIPT}.partial`);
  const handle = await open(partial, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(safe));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(partial, join(safe.rootPath, RECEIPT));
  if (process.platform !== "win32") {
    const directory = await open(safe.rootPath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

/** Also recognizes old-version internal task markers, without claiming external files. */
export async function readOwnedExportTask(
  workRoot: string,
  name: string,
): Promise<OwnedExportTask | undefined> {
  if (!TASK_NAME.test(name)) return undefined;
  const taskRoot = join(resolve(workRoot), name);
  const cleanup = (await readCleanupRecord(workRoot, name))?.record;
  const info = await lstat(taskRoot, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && cleanup) return undefined;
    throw error;
  });
  if (cleanup) {
    if (
      info &&
      (!info.isDirectory() ||
        info.isSymbolicLink() ||
        !samePath(await realpath(taskRoot), taskRoot) ||
        !sameIdentity(identityOf(info), cleanup.taskIdentity))
    )
      throw new Error("Export cleanup root changed");
    return {
      path: taskRoot,
      identity: cleanup.taskIdentity,
      markerSecret: cleanup.markerSecret,
      files: cleanup.receipt?.files ?? [],
      ...(cleanup.receipt ? { receipt: cleanup.receipt } : {}),
    };
  }
  if (!info) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(taskRoot), taskRoot))
    return undefined;
  const secret = await boundedPlainFile(join(taskRoot, OWNER), 64);
  if (!secret || !/^[0-9a-f]{64}$/u.test(secret.contents)) return undefined;
  const identity = identityOf(info);
  const durable = await boundedPlainFile(join(taskRoot, RECEIPT), 16384);
  const partial = await boundedPlainFile(join(taskRoot, `${RECEIPT}.partial`), 16384);
  let record: ExportTaskReceipt | undefined;
  if (durable !== undefined) {
    record = receiptSchema.parse(JSON.parse(durable.contents));
    validateReceipt(record, taskRoot, identity, secret.contents);
  }
  if (partial !== undefined) {
    const parsed = receiptSchema.safeParse(
      (() => {
        try {
          return JSON.parse(partial.contents);
        } catch {
          return undefined;
        }
      })(),
    );
    if (parsed.success) {
      validateReceipt(parsed.data, taskRoot, identity, secret.contents);
      if (
        record &&
        (!samePath(record.finalPath, parsed.data.finalPath) ||
          record.operationId !== parsed.data.operationId ||
          record.files.some(
            (file) =>
              !parsed.data.files.some(
                (next) =>
                  samePath(next.path, file.path) && sameIdentity(next.identity, file.identity),
              ),
          ))
      )
        throw new Error("Export recovery receipt changed");
      record = parsed.data;
    }
    // A truncated unpublished receipt cannot authorize new external-file cleanup.
  }
  return {
    path: taskRoot,
    identity,
    markerSecret: secret.contents,
    files: record?.files ?? [],
    ...(record ? { receipt: record } : {}),
  };
}

export async function isOwnedExportArtifact(workRoot: string, name: string): Promise<boolean> {
  if (INITIALIZING_NAME.test(name)) return !!(await inspectInitializingTask(workRoot, name));
  const taskName = name.endsWith(CLEANUP_SUFFIX) ? name.slice(0, -CLEANUP_SUFFIX.length) : name;
  return !!(await readOwnedExportTask(workRoot, taskName));
}

export async function recoverAbandonedExportTasks(
  workRoot: string,
  options: { exclusiveStartup: true },
): Promise<{ cleaned: number; pending: number }> {
  if (!options.exclusiveStartup) throw new Error("Startup ownership required");
  if (await hasUnresolvedDataImport(workRoot)) return { cleaned: 0, pending: 0 };
  const names = await readdir(workRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let cleaned = 0,
    pending = 0;
  for (const name of names.filter((name) => INITIALIZING_NAME.test(name))) {
    try {
      const task = await inspectInitializingTask(workRoot, name);
      if (!task) throw new Error("Unknown initializing task");
      if (task.markerPath && task.markerIdentity)
        await removeOwnedPath(task.markerPath, task.markerIdentity);
      // Never recursively delete an initializing root: an unexpected concurrent file must survive.
      await rmdir(task.path);
      cleaned++;
    } catch {
      pending++;
    }
  }
  const tasks = new Set(
    names
      .map((name) => (name.endsWith(CLEANUP_SUFFIX) ? name.slice(0, -CLEANUP_SUFFIX.length) : name))
      .filter((name) => TASK_NAME.test(name)),
  );
  for (const name of tasks) {
    try {
      const task = await readOwnedExportTask(workRoot, name);
      if (!task) {
        pending++;
        continue;
      }
      for (const file of task.files) await removeOwnedPath(file.path, file.identity);
      await removeOwnedExportTaskRoot(task);
      cleaned++;
    } catch {
      // Keep the task and durable ownership when a file is busy or no longer ours.
      pending++;
    }
  }
  return { cleaned, pending };
}
