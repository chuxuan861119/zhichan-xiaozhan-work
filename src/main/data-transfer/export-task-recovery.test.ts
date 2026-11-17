import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  type ExportTaskReceipt,
  readOwnedExportTask,
  recordExportTaskFiles,
  recoverAbandonedExportTasks,
  removeOwnedExportTaskRoot,
} from "./export-task-recovery.js";

const readBoundary = vi.hoisted(() => ({
  afterClose: undefined as ((path: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const wrapped = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      await readBoundary.afterClose?.(String(args[0]));
    };
    return handle;
  };
  return { ...actual, default: { ...actual, open: wrapped }, open: wrapped };
});

const roots: string[] = [];
afterEach(async () => {
  readBoundary.afterClose = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function identity(path: string) {
  const info = await lstat(path, { bigint: true });
  return {
    device: String(info.dev),
    inode: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "export-task-recovery-"));
  roots.push(root);
  const workRoot = join(root, "work"),
    destination = join(root, "destination");
  await mkdir(workRoot);
  await mkdir(destination);
  const taskRoot = join(workRoot, `.full-data-export-${randomUUID()}`);
  await mkdir(taskRoot);
  const markerSecret = "a".repeat(64);
  await writeFile(join(taskRoot, ".full-data-export-owner"), markerSecret);
  await writeFile(join(taskRoot, "frozen-source-copy"), "synthetic frozen bytes");
  const operationId = randomUUID(),
    finalPath = join(destination, "transfer.ZXWBACKUP");
  const partial = join(destination, `.transfer.${operationId}.zxwbackup.partial`);
  await writeFile(partial, "synthetic encrypted incomplete package");
  const receipt: ExportTaskReceipt = {
    version: 1,
    rootPath: taskRoot,
    rootIdentity: await identity(taskRoot),
    markerSecret,
    operationId,
    finalPath,
    files: [{ path: partial, identity: await identity(partial) }],
  };
  await recordExportTaskFiles(receipt);
  return { root, workRoot, destination, taskRoot, receipt, partial, finalPath };
}

test("cleans an interrupted partial and anchor without deleting an already published final package", async () => {
  const f = await fixture();
  const anchor = join(f.destination, `.verified-${randomUUID()}.zxwbackup.partial`);
  f.receipt.files.push({ path: anchor, identity: await identity(f.partial) });
  await recordExportTaskFiles(f.receipt);
  await link(f.partial, anchor);
  await link(anchor, f.finalPath);
  expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
    cleaned: 1,
    pending: 0,
  });
  expect(await readFile(f.finalPath, "utf8")).toBe("synthetic encrypted incomplete package");
  expect(await readdir(f.destination)).toEqual(["transfer.ZXWBACKUP"]);
  expect(await readdir(f.workRoot)).toEqual([]);
  expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
    cleaned: 0,
    pending: 0,
  });
});
test("retains ownership and never deletes a replaced external partial", async () => {
  const f = await fixture();
  await rename(f.partial, `${f.partial}.moved`);
  await writeFile(f.partial, "foreign file must survive");
  expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
    cleaned: 0,
    pending: 1,
  });
  expect(await readFile(f.partial, "utf8")).toBe("foreign file must survive");
  expect(await readOwnedExportTask(f.workRoot, basename(f.taskRoot))).toBeDefined();
  // Removing the foreign replacement restores a safe, idempotent retry; moved user bytes survive.
  await rm(f.partial);
  expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
    cleaned: 1,
    pending: 0,
  });
  expect(await readFile(`${f.partial}.moved`, "utf8")).toBe(
    "synthetic encrypted incomplete package",
  );
});
test("refuses a task-directory replacement even with copied marker and receipt", async () => {
  const f = await fixture();
  const receiptBytes = await readFile(join(f.taskRoot, ".full-data-export-recovery.json"));
  await rename(f.taskRoot, `${f.taskRoot}.moved`);
  await mkdir(f.taskRoot);
  await writeFile(join(f.taskRoot, ".full-data-export-owner"), f.receipt.markerSecret);
  await writeFile(join(f.taskRoot, ".full-data-export-recovery.json"), receiptBytes);
  expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
    cleaned: 0,
    pending: 1,
  });
  await expect(lstat(f.partial)).resolves.toBeDefined();
});
test("never authorizes the final package as a cleanup target", async () => {
  const f = await fixture();
  await writeFile(f.finalPath, "finished user package");
  const unsafe = {
    ...f.receipt,
    files: [{ path: f.finalPath, identity: await identity(f.finalPath) }],
  };
  await writeFile(join(f.taskRoot, ".full-data-export-recovery.json"), JSON.stringify(unsafe));
  expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
    cleaned: 0,
    pending: 1,
  });
  expect(await readFile(f.finalPath, "utf8")).toBe("finished user package");
});
test("a truncated unpublished receipt cannot authorize deleting new external files", async () => {
  const f = await fixture();
  await writeFile(join(f.taskRoot, ".full-data-export-recovery.json.partial"), '{"version":');
  expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
    cleaned: 1,
    pending: 0,
  });
  expect(await readdir(f.destination)).toEqual([]);
});
test("adopts a complete interrupted receipt publication before cleaning its anchor", async () => {
  const f = await fixture();
  const anchor = join(f.destination, `.verified-${randomUUID()}.zxwbackup.partial`);
  await link(f.partial, anchor);
  f.receipt.files.push({ path: anchor, identity: await identity(f.partial) });
  await writeFile(
    join(f.taskRoot, ".full-data-export-recovery.json.partial"),
    JSON.stringify(f.receipt),
  );
  expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
    cleaned: 1,
    pending: 0,
  });
  expect(await readdir(f.destination)).toEqual([]);
});
test("cleans only legacy internal copies with an authentic-shaped marker, not unknown directories", async () => {
  const f = await fixture();
  await rm(join(f.taskRoot, ".full-data-export-recovery.json"));
  const unknown = join(f.workRoot, `.full-data-export-${randomUUID()}`);
  await mkdir(unknown);
  await writeFile(join(unknown, "foreign.txt"), "preserve");
  expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
    cleaned: 1,
    pending: 1,
  });
  expect(await readFile(join(unknown, "foreign.txt"), "utf8")).toBe("preserve");
  // Legacy markers do not authorize deletion of any external package.
  await expect(lstat(f.partial)).resolves.toBeDefined();
});
test.each(["pending-data-import.json", `pending-data-import.json.failed-${randomUUID()}`])(
  "unresolved migration recovery inhibits cleanup (%s)",
  async (journal) => {
    const f = await fixture();
    await writeFile(join(f.workRoot, journal), "unresolved original recovery bytes");
    expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
      cleaned: 0,
      pending: 0,
    });
    await expect(lstat(f.taskRoot)).resolves.toBeDefined();
    await expect(lstat(f.partial)).resolves.toBeDefined();
  },
);

test.skipIf(process.platform !== "win32")(
  "a busy internal file cannot destroy the durable cleanup identity",
  async () => {
    const f = await fixture();
    const lockedPath = join(f.taskRoot, "z-locked-copy");
    await writeFile(lockedPath, "synthetic locked frozen bytes");
    const script =
      "$p=[Console]::ReadLine();$f=[IO.File]::Open($p,'Open','Read',[IO.FileShare]::ReadWrite);[Console]::WriteLine('READY');[Console]::ReadLine()|Out-Null;$f.Dispose()";
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((done, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? done() : reject(new Error("fixture lock failed")),
      );
    });
    try {
      await new Promise<void>((done, reject) => {
        child.once("error", reject);
        child.stdout.once("data", (bytes) =>
          String(bytes).trim() === "READY" ? done() : reject(new Error("lock not acquired")),
        );
        child.stdin.write(`${lockedPath}\n`);
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
          cleaned: 0,
          pending: 1,
        });
        expect(await readOwnedExportTask(f.workRoot, basename(f.taskRoot))).toBeDefined();
        expect(await readFile(lockedPath, "utf8")).toBe("synthetic locked frozen bytes");
      }
    } finally {
      child.stdin.end("release\n");
      await closed;
    }
    expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
      cleaned: 1,
      pending: 0,
    });
    expect(await readdir(f.workRoot)).toEqual([]);
  },
);

test.each(["", "a".repeat(17), "a".repeat(64)])(
  "recovers a root interrupted before ownership publication (%s)",
  async (marker) => {
    const f = await fixture();
    const preparing = join(f.workRoot, `.full-data-export-init-${randomUUID()}-${"a".repeat(64)}`);
    await mkdir(preparing);
    if (marker) await writeFile(join(preparing, ".full-data-export-owner"), marker);
    expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
      cleaned: 2,
      pending: 0,
    });
    expect(await readdir(f.workRoot)).toEqual([]);
  },
);

test("initializing roots with unexpected bytes are preserved", async () => {
  const f = await fixture();
  const preparing = join(f.workRoot, `.full-data-export-init-${randomUUID()}-${"a".repeat(64)}`);
  await mkdir(preparing);
  await writeFile(join(preparing, "foreign.txt"), "unknown bytes must survive");
  expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
    cleaned: 1,
    pending: 1,
  });
  expect(await readFile(join(preparing, "foreign.txt"), "utf8")).toBe("unknown bytes must survive");
});

test("never retires a cleanup credential replaced after its verified read", async () => {
  const f = await fixture();
  const task = await readOwnedExportTask(f.workRoot, basename(f.taskRoot));
  if (!task) throw new Error("task fixture missing");
  const recordPath = `${f.taskRoot}.cleanup-record.json`;
  await writeFile(
    recordPath,
    JSON.stringify({
      version: 1,
      taskPath: f.taskRoot,
      taskIdentity: task.identity,
      markerSecret: task.markerSecret,
      receipt: f.receipt,
    }),
  );
  readBoundary.afterClose = async (path) => {
    if (resolve(path).toLowerCase() !== resolve(recordPath).toLowerCase()) return;
    readBoundary.afterClose = undefined;
    await rename(recordPath, `${recordPath}.moved`);
    await writeFile(recordPath, "foreign cleanup-record replacement");
  };
  const result = await removeOwnedExportTaskRoot(task).catch((error) => error);
  expect(result).toBeInstanceOf(Error);
  expect(await readFile(recordPath, "utf8")).toBe("foreign cleanup-record replacement");
});

test("never deletes an initializing marker replaced after its verified read", async () => {
  const f = await fixture();
  const preparing = join(f.workRoot, `.full-data-export-init-${randomUUID()}-${"a".repeat(64)}`);
  await mkdir(preparing);
  const markerPath = join(preparing, ".full-data-export-owner");
  await writeFile(markerPath, "a".repeat(64));
  readBoundary.afterClose = async (path) => {
    if (resolve(path).toLowerCase() !== resolve(markerPath).toLowerCase()) return;
    readBoundary.afterClose = undefined;
    await rename(markerPath, `${markerPath}.moved`);
    await writeFile(markerPath, "foreign marker replacement");
  };
  expect(await recoverAbandonedExportTasks(f.workRoot, { exclusiveStartup: true })).toEqual({
    cleaned: 1,
    pending: 1,
  });
  expect(await readFile(markerPath, "utf8")).toBe("foreign marker replacement");
});
