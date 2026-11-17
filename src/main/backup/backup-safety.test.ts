// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupRunResultSchema, BackupStatusSchema } from "../../shared/backup/model.js";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { type BackupDelegate, BackupService } from "./backup-service.js";

const info = {
  documentType: "patent" as const,
  documentId: "00000000-0000-4000-8000-000000000001",
  displayName: "测试",
  modifiedAt: "2026-09-07T00:00:00.000Z",
  revision: 1,
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "backup-safety-"));
  const folder = join(root, "backups");
  let value = {
    ...structuredClone(DEFAULT_APP_SETTINGS),
    backup: { enabled: true, folder, intervalMinutes: 1, waitOnExit: true },
  };
  let revision = 1;
  const delegate: BackupDelegate = {
    listModified: async () => [{ ...info, revision }],
    backupOne: async (source, target) => {
      await writeFile(target, JSON.stringify(source));
    },
    inspect: async (path) => JSON.parse(await readFile(path, "utf8")),
    restoreOne: async () => ({
      documentType: "patent",
      documentId: info.documentId,
      displayName: "恢复",
    }),
  };
  const service = new BackupService({
    settings: {
      read: async () => structuredClone(value),
      update: async (patch) => {
        value = { ...value, ...patch } as typeof value;
        return structuredClone(value);
      },
    },
    delegate,
  });
  return { root, folder, service, delegate, next: () => ++revision };
}
afterEach(() => vi.useRealTimers());

test("exit reuses verified unchanged backups without scanning archives", async () => {
  const f = await fixture();
  f.delegate.listModified = async () => [{ ...info, createdAt: "2026-09-01T00:00:00.000Z" }];
  await f.service.ensureCurrent(info, "idle");
  const inspect = vi.spyOn(f.delegate, "inspect");
  const write = vi.spyOn(f.delegate, "backupOne");
  expect(await f.service.finalize()).toMatchObject({ skippedCount: 1, successCount: 0 });
  expect(inspect).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

test("background checks still inspect archives and exit backs up a newer revision", async () => {
  const f = await fixture();
  await f.service.ensureCurrent(info, "idle");
  const inspect = vi.spyOn(f.delegate, "inspect");
  await f.service.ensureCurrent(info, "idle");
  expect(inspect).toHaveBeenCalled();
  f.next();
  expect(await f.service.finalize()).toMatchObject({ successCount: 1, skippedCount: 0 });
  expect((await f.service.list()).some((entry) => entry.revision === 2)).toBe(true);
});

test("exit repairs a changed or missing verified backup", async () => {
  const f = await fixture();
  await f.service.ensureCurrent(info, "idle");
  const [entry] = await f.service.list();
  if (!entry) throw new Error("missing backup");
  await writeFile(join(f.folder, entry.fileName), "damaged");
  expect(await f.service.finalize()).toMatchObject({ successCount: 1 });
  const healthy = (await f.service.list()).find((item) => item.status === "healthy");
  if (!healthy) throw new Error("missing healthy backup");
  await unlink(join(f.folder, healthy.fileName));
  expect(await f.service.finalize()).toMatchObject({ successCount: 1 });
});

test("unavailable startup folder resumes scheduled backup once available", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  try {
    await writeFile(f.folder, "unavailable");
    await f.service.initialize();
    expect((await f.service.status()).lastError).not.toBeNull();
    expect((await f.service.status()).nextBackupAt).not.toBeNull();
    await rename(f.folder, join(f.root, "blocker"));
    await mkdir(f.folder);
    await vi.advanceTimersByTimeAsync(60000);
    await vi.waitFor(async () => {
      expect((await f.service.list()).some((entry) => entry.status === "healthy")).toBe(true);
      expect((await f.service.status()).lastError).toBeNull();
    });
  } finally {
    await f.service.shutdown();
  }
});

test.each(["corrupt", "wrong-identity", "wrong-revision"])(
  "replaces %s baseline instead of reporting a false success",
  async (kind) => {
    const f = await fixture();
    await f.service.runNow();
    const file = (await readdir(f.folder))[0];
    if (!file) throw new Error("Missing backup fixture");
    const changed =
      kind === "corrupt"
        ? "corrupt"
        : JSON.stringify({
            ...info,
            ...(kind === "wrong-identity" ? { documentId: "other" } : { revision: 0 }),
          });
    await writeFile(join(f.folder, file), changed);
    const result = await f.service.finalize();
    expect(result).toMatchObject({
      successCount: 1,
      skippedCount: 0,
      failures: [],
      cancelled: false,
    });
    expect(await readFile(join(f.folder, file), "utf8")).toBe(changed);
    await f.service.shutdown();
  },
);

test("retention preserves externally named copies", async () => {
  const f = await fixture();
  await mkdir(f.folder);
  const external = "PWB-AUTO-user-retained.patdoc";
  await writeFile(join(f.folder, external), JSON.stringify({ ...info, revision: 0 }));
  expect((await f.service.list())[0]?.managed).toBe(false);
  for (let i = 0; i < 4; i++) {
    await f.service.runNow();
    f.next();
  }
  expect(await readdir(f.folder)).toContain(external);
  expect((await f.service.list()).filter((entry) => entry.managed)).toHaveLength(3);
  await f.service.shutdown();
});

test("failed replacement reports failure and retries without destroying damaged evidence", async () => {
  const f = await fixture();
  await f.service.runNow();
  const entry = (await f.service.list())[0];
  if (!entry) throw new Error("Missing backup fixture");
  await writeFile(join(f.folder, entry.fileName), "damaged");
  const write = f.delegate.backupOne;
  f.delegate.backupOne = async () => {
    throw new Error("disk full");
  };
  expect((await f.service.finalize()).failures).toHaveLength(1);
  expect((await f.service.status()).lastError).toContain("disk full");
  expect(await readFile(join(f.folder, entry.fileName), "utf8")).toBe("damaged");
  f.delegate.backupOne = write;
  expect((await f.service.finalize()).successCount).toBe(1);
  expect((await f.service.status()).lastError).toBeNull();
  await f.service.shutdown();
});

test("retention preserves generated names whose metadata no longer matches", async () => {
  const f = await fixture();
  await mkdir(f.folder);
  const external = `PWB-AUTO-PAT-${info.documentId}-r99-10000000-0000-4000-8000-000000000003.patdoc`;
  await writeFile(join(f.folder, external), JSON.stringify({ ...info, revision: 0 }));
  expect((await f.service.list())[0]?.managed).toBe(false);
  await expect(f.service.delete(external)).rejects.toThrow(/身份|自动备份/);
  for (let i = 0; i < 4; i++) {
    await f.service.runNow();
    f.next();
  }
  expect(await readdir(f.folder)).toContain(external);
  await f.service.shutdown();
});

test("listing tolerates a backup removed after directory enumeration", async () => {
  const f = await fixture();
  await mkdir(f.folder);
  await writeFile(join(f.folder, "a.patdoc"), JSON.stringify(info));
  await writeFile(join(f.folder, "b.patdoc"), JSON.stringify(info));
  const inspect = f.delegate.inspect;
  let first = true;
  f.delegate.inspect = async (path) => {
    if (first) {
      first = false;
      for (const name of await readdir(f.folder)) {
        if (join(f.folder, name) !== path) await unlink(join(f.folder, name));
      }
    }
    return await inspect(path);
  };
  await expect(f.service.list()).resolves.toHaveLength(1);
  await f.service.shutdown();
});

test("long storage errors remain readable through the backup IPC contracts", async () => {
  const f = await fixture();
  f.delegate.backupOne = async () => {
    throw new Error("disk error ".repeat(300));
  };
  expect(BackupRunResultSchema.safeParse(await f.service.finalize()).success).toBe(true);
  expect(BackupStatusSchema.safeParse(await f.service.status()).success).toBe(true);
  await f.service.shutdown();
});

test("next backup time follows the actual schedule rather than manual backup completion", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const start = Date.now();
  try {
    await f.service.initialize();
    expect((await f.service.status()).nextBackupAt).toBe(new Date(start + 5_000).toISOString());
    await vi.advanceTimersByTimeAsync(5_000);
    await f.service.finalize();
    expect((await f.service.status()).nextBackupAt).toBe(new Date(start + 60_000).toISOString());
    await vi.advanceTimersByTimeAsync(10_000);
    await f.service.runNow();
    expect((await f.service.status()).nextBackupAt).toBe(new Date(start + 60_000).toISOString());
  } finally {
    await f.service.shutdown();
  }
});

test.each(["queued", "listing"])("exit cancellation survives the %s phase", async (phase) => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const list = f.delegate.listModified;
  f.delegate.listModified = async () => {
    entered();
    await waiting;
    return list();
  };
  const write = vi.spyOn(f.delegate, "backupOne");
  const predecessor = phase === "queued" ? f.service.runNow() : undefined;
  const closing = f.service.finalize();
  await started;
  f.service.requestFinalizationCancel();
  release();
  await predecessor;
  expect(await closing).toMatchObject({ cancelled: true, successCount: 0 });
  expect(write).not.toHaveBeenCalled();
  // Cancellation must not leak into a subsequent retry.
  expect((await f.service.finalize()).cancelled).toBe(false);
  await f.service.shutdown();
});

test("exit cancellation finishes the current file without starting the next one", async () => {
  const f = await fixture();
  f.delegate.listModified = async () => [
    info,
    { ...info, documentId: "00000000-0000-4000-8000-000000000002" },
  ];
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = f.delegate.backupOne;
  f.delegate.backupOne = async (source, target) => {
    entered();
    await gate;
    await writer(source, target);
  };
  const closing = f.service.finalize();
  await started;
  f.service.requestFinalizationCancel();
  release();
  expect(await closing).toMatchObject({ cancelled: true, successCount: 1, failures: [] });
  expect(await f.service.list()).toEqual([
    expect.objectContaining({ status: "healthy", documentId: info.documentId }),
  ]);
  await f.service.shutdown();
});

test("settings cancellation always clears operation status", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.delegate.backupOne = async (source, target) => {
    entered();
    await wait;
    await writeFile(target, JSON.stringify(source));
  };
  const run = f.service.finalize();
  await started;
  await f.service.configure({ enabled: false, folder: f.folder, intervalMinutes: 1 });
  release();
  expect((await run).cancelled).toBe(true);
  expect(f.service.operationStatus()).toMatchObject({ running: false, currentDisplayName: null });
  await f.service.shutdown();
});

test("targeted success retains other failures until those documents recover", async () => {
  const f = await fixture();
  const second = {
    ...info,
    documentId: "00000000-0000-4000-8000-000000000002",
    displayName: "失败测试",
  };
  f.delegate.listModified = async () => [info, second];
  const write = f.delegate.backupOne;
  f.delegate.backupOne = async (source, target) => {
    if (source.documentId === second.documentId) throw Error("broken");
    await write(source, target);
  };
  await f.service.runNow();
  await f.service.ensureCurrent(info, "idle");
  expect((await f.service.status()).lastRunFailureCount).toBe(1);
  expect((await f.service.status()).lastError).toContain("失败测试");
  f.delegate.backupOne = write;
  await f.service.ensureCurrent(second, "idle");
  expect((await f.service.status()).lastRunFailureCount).toBe(0);
  expect((await f.service.status()).lastError).toBeNull();
  await f.service.shutdown();
});

test("publishes the captured revision when editing advances during backup", async () => {
  const f = await fixture();
  const writer = f.delegate.backupOne;
  f.delegate.backupOne = async (source, path) => {
    f.next();
    await writer({ ...source, revision: 2 }, path);
  };
  await f.service.runNow();
  const entry = (await f.service.list())[0];
  expect(entry?.fileName).toContain("-r2-");
  expect(entry?.revision).toBe(2);
  expect((await f.service.finalize()).skippedCount).toBe(1);
  await f.service.shutdown();
});

test.each(["identity", "older"])(
  "rejects a readable archive with %s mismatch before publication",
  async (kind) => {
    const f = await fixture();
    f.delegate.backupOne = async (source, target) => {
      await writeFile(
        target,
        JSON.stringify({
          ...source,
          ...(kind === "identity" ? { documentId: "other" } : { revision: 0 }),
        }),
      );
    };
    const result = await f.service.finalize();
    expect(result.failures).toHaveLength(1);
    expect(await f.service.list()).toEqual([]);
    await f.service.shutdown();
  },
);

test("backup failures describe storage errors and remain retryable", async () => {
  const f = await fixture();
  const write = f.delegate.backupOne;
  f.delegate.backupOne = async () => {
    throw Object.assign(new Error("EIO: native copy /private/source"), { code: "EIO" });
  };
  try {
    const failed = await f.service.finalize();
    expect(failed.failures[0]?.message).toContain("备份存储设备不可用或读写失败");
    expect(failed.failures[0]?.message).toContain("连接");
    expect((await f.service.status()).lastError).not.toContain("/private/source");
    f.delegate.backupOne = write;
    expect(await f.service.finalize()).toMatchObject({ successCount: 1, failures: [] });
    expect((await f.service.status()).lastError).toBeNull();
  } finally {
    await f.service.shutdown();
  }
});
