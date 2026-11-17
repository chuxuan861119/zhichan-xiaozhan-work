// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { BackupService, type DocumentModifiedInfo } from "./backup-service.js";

const roots: string[] = [];
test.each([false, true])("shutdown waits for a pending migration (failure: %s)", async (fail) => {
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { service } = await fixture({
    beforeUpdate: async () => {
      entered();
      await barrier;
      if (fail) throw new Error("write failed");
    },
  });
  const target = await mkdtemp(join(tmpdir(), "backup-shutdown-"));
  roots.push(target);
  const migration = service.configure({
    enabled: true,
    folder: target,
    intervalMinutes: 5,
    migrateExisting: true,
  });
  const outcome = migration.catch(() => undefined);
  await started;
  let closed = false;
  const closing = service.shutdown().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const returnedEarly = closed;
  release();
  await outcome;
  await closing;
  expect(returnedEarly).toBe(false);
  expect((await service.status()).nextBackupAt).toBeNull();
});
test("destination write failure keeps the old folder and backups", async () => {
  const { root, service } = await fixture();
  await service.runNow();
  const first = (await service.list())[0];
  if (!first) throw new Error("missing backup");
  const bytes = await readFile(join(root, first.fileName));
  const target = await mkdtemp(join(tmpdir(), "backup-migrate-"));
  roots.push(target);
  await writeFile(join(target, "2026-07"), "not a directory");
  await expect(
    service.configure({
      enabled: false,
      folder: target,
      intervalMinutes: 5,
      migrateExisting: true,
    }),
  ).rejects.toThrow();
  expect((await service.status()).folder).toBe(root);
  expect(await readFile(join(root, first.fileName))).toEqual(bytes);
});
test("migration waits for an active backup and rejects duplicate configure requests", async () => {
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { root, service } = await fixture({
    beforeBackup: async () => {
      started();
      await barrier;
    },
  });
  const writing = service.runNow();
  await entered;
  const target = await mkdtemp(join(tmpdir(), "backup-migrate-"));
  roots.push(target);
  const request = { enabled: false, folder: target, intervalMinutes: 5, migrateExisting: true };
  const migrating = service.configure(request);
  await expect(service.configure(request)).rejects.toThrow("备份正在处理");
  expect((await service.status()).folder).toBe(root);
  release();
  await writing;
  expect((await migrating)?.migratedCount).toBe(1);
  expect((await service.list()).length).toBe(1);
});

test("legacy root backups migrate unchanged, while stale source requests do nothing", async () => {
  const { root, info, service } = await fixture();
  const name = `PWB-AUTO-PAT-${info.documentId}-r1-11111111-1111-4111-8111-111111111111.patdoc`;
  await writeFile(join(root, name), JSON.stringify(info));
  const target = await mkdtemp(join(tmpdir(), "backup-migrate-"));
  roots.push(target);
  const request = { enabled: false, folder: target, intervalMinutes: 5, migrateExisting: true };
  await expect(service.configure({ ...request, expectedSourceFolder: "wrong" })).rejects.toThrow(
    "已发生变化",
  );
  expect(await readdir(target)).toEqual([]);
  expect((await service.configure(request))?.migratedCount).toBe(1);
  expect(await readFile(join(target, name), "utf8")).toBe(JSON.stringify(info));
});
test("migration preserves colliding files and reuses identical destination copies", async () => {
  for (const identical of [true, false]) {
    const { root, service } = await fixture();
    await service.runNow();
    const first = (await service.list())[0];
    if (!first) throw new Error("missing backup");
    const bytes = await readFile(join(root, first.fileName));
    const target = await mkdtemp(join(tmpdir(), "backup-migrate-"));
    roots.push(target);
    await mkdir(join(target, "2026-07"));
    await writeFile(join(target, first.fileName), identical ? bytes : "unrelated contents");
    const report = await service.configure({
      enabled: false,
      folder: target,
      intervalMinutes: 5,
      migrateExisting: true,
    });
    expect(report?.migratedCount).toBe(1);
    expect(await readFile(join(target, first.fileName))).toEqual(
      identical ? bytes : Buffer.from("unrelated contents"),
    );
    expect((await readdir(join(target, "2026-07"))).length).toBe(identical ? 1 : 2);
    await expect(stat(join(root, first.fileName))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("settings failure retains every source and permits a safe retry", async () => {
  let fail = true;
  const { root, service } = await fixture({
    beforeUpdate: async () => {
      if (fail) throw new Error("settings failed");
    },
  });
  await service.runNow();
  const first = (await service.list())[0];
  if (!first) throw new Error("missing backup");
  const bytes = await readFile(join(root, first.fileName));
  const target = await mkdtemp(join(tmpdir(), "backup-migrate-"));
  roots.push(target);
  const request = { enabled: false, folder: target, intervalMinutes: 5, migrateExisting: true };
  await expect(service.configure(request)).rejects.toThrow("settings failed");
  expect((await service.status()).folder).toBe(root);
  expect(await readFile(join(root, first.fileName))).toEqual(bytes);
  fail = false;
  expect((await service.configure(request))?.migratedCount).toBe(1);
});

test("source changes after settings commit are retained and reported", async () => {
  let source = "";
  const { root, service } = await fixture({
    afterUpdate: async () => {
      await writeFile(source, "changed externally");
    },
  });
  await service.runNow();
  const first = (await service.list())[0];
  if (!first) throw new Error("missing backup");
  source = join(root, first.fileName);
  const target = await mkdtemp(join(tmpdir(), "backup-migrate-"));
  roots.push(target);
  const result = await service.configure({
    enabled: false,
    folder: target,
    intervalMinutes: 5,
    migrateExisting: true,
  });
  expect(result?.retainedSourceCount).toBe(1);
  expect((await service.status()).folder).toBe(target);
  expect(await readFile(source, "utf8")).toBe("changed externally");
});
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(
  options: {
    beforeUpdate?: () => Promise<void>;
    afterUpdate?: () => Promise<void>;
    beforeBackup?: () => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "backup-layout-"));
  roots.push(root);
  const info: DocumentModifiedInfo = {
    documentId: "00000000-0000-4000-8000-000000000001",
    documentType: "patent",
    displayName: "冷却装置",
    patentType: "invention",
    customer: null,
    createdAt: "2026-07-02T01:00:00.000Z",
    modifiedAt: "2026-09-11T01:00:00.000Z",
    revision: 1,
  };
  let settings = {
    ...structuredClone(DEFAULT_APP_SETTINGS),
    backup: { enabled: true, folder: root, intervalMinutes: 5 },
  };
  const restoreOne = vi.fn(async () => ({
    documentId: info.documentId,
    documentType: "patent" as const,
    displayName: "恢复",
  }));
  const service = new BackupService({
    settings: {
      read: async () => settings,
      update: async (patch) => {
        await options.beforeUpdate?.();
        settings = { ...settings, ...patch } as typeof settings;
        await options.afterUpdate?.();
        return settings;
      },
    },
    delegate: {
      listModified: async () => [{ ...info }],
      backupOne: async (source, path) => {
        await options.beforeBackup?.();
        await writeFile(path, JSON.stringify(source));
      },
      inspect: async (path) => JSON.parse(await readFile(path, "utf8")),
      restoreOne,
    },
  });
  return { root, info, service, restoreOne };
}

test("archives by creation month and renames existing backups when customer changes without rewriting history", async () => {
  const { root, info, service, restoreOne } = await fixture();
  await service.runNow();
  const first = (await service.list())[0];
  if (!first) throw new Error("missing backup");
  expect(first.fileName).toMatch(/^2026-07\/.*_发明_冷却装置_PWB2-/);
  const bytes = await readFile(join(root, first.fileName));
  const time = (await stat(join(root, first.fileName))).mtimeMs;
  info.customer = "测试客户";
  await service.runNow();
  const updated = (await service.list())[0];
  if (!updated) throw new Error("missing updated backup");
  expect(updated.fileName).toContain("_冷却装置_测试客户_");
  expect(await readFile(join(root, updated.fileName))).toEqual(bytes);
  expect(Math.abs((await stat(join(root, updated.fileName))).mtimeMs - time)).toBeLessThan(2);
  expect(await service.list()).toHaveLength(1);
  await service.restore(updated.fileName);
  expect(restoreOne).toHaveBeenCalledWith(join(root, updated.fileName));
  info.customer = null;
  info.displayName = "新名称";
  await service.runNow();
  const renamed = (await service.list())[0];
  if (!renamed) throw new Error("missing renamed backup");
  expect(renamed.fileName).toContain("_新名称_PWB2-");
  await service.delete(renamed.fileName);
  expect(await service.list()).toEqual([]);
});

test("organizes verified legacy files while retaining unknown, damaged and mismatched files", async () => {
  const { root, info, service } = await fixture();
  const legacy = `PWB-AUTO-PAT-${info.documentId}-r1-10000000-0000-4000-8000-000000000003.patdoc`;
  await writeFile(join(root, legacy), JSON.stringify(info));
  await utimes(join(root, legacy), new Date(2026, 7, 1, 9, 15), new Date(2026, 7, 1, 9, 15));
  await writeFile(join(root, "用户备份.patdoc"), JSON.stringify(info));
  await writeFile(join(root, legacy.replace("r1", "r9")), "broken");
  await service.initialize();
  await service.runNow();
  service.stop();
  expect(
    (await service.list()).some((item) => item.fileName.startsWith("2026-07/2026-08-01_09-15_")),
  ).toBe(true);
  expect(await readFile(join(root, "用户备份.patdoc"), "utf8")).toBe(JSON.stringify(info));
  expect(await readFile(join(root, legacy.replace("r1", "r9")), "utf8")).toBe("broken");
});

test("retains only three healthy owned backups across month folders", async () => {
  const { root, info, service } = await fixture();
  for (let revision = 1; revision <= 4; revision++) {
    info.revision = revision;
    await service.runNow();
  }
  expect((await service.list()).map((item) => item.revision).sort()).toEqual([2, 3, 4]);
  expect(await readdir(root)).toEqual(["2026-07"]);
});

test("never overwrites a colliding destination while adding customer information", async () => {
  const { root, info, service } = await fixture();
  await service.runNow();
  const first = (await service.list())[0];
  if (!first) throw new Error("missing backup");
  const collision = first.fileName.replace("_PWB2-", "_客户_PWB2-");
  await writeFile(join(root, collision), "保留此文件");
  info.customer = "客户";
  await service.runNow();
  expect(await readFile(join(root, collision), "utf8")).toBe("保留此文件");
  const healthy = (await service.list()).filter((item) => item.status === "healthy");
  expect(healthy).toHaveLength(1);
  expect(healthy[0]?.fileName).toContain("_客户_PWB2-");
  expect(healthy[0]?.fileName).not.toBe(collision);
});

test("unrecognized unsafe filenames do not block listing or backup", async () => {
  const { root, service } = await fixture();
  await writeFile(join(root, "用户..保留.patdoc"), "保留");
  await service.runNow();
  expect(
    (await service.list()).filter((entry) => entry.managed && entry.status === "healthy"),
  ).toHaveLength(1);
  expect(await readFile(join(root, "用户..保留.patdoc"), "utf8")).toBe("保留");
});

test("migrates verified backups before switching and leaves unrelated files in place", async () => {
  const { root, service } = await fixture();
  await service.runNow();
  const original = (await service.list())[0];
  if (!original) throw new Error("missing backup");
  const bytes = await readFile(join(root, original.fileName));
  await writeFile(join(root, "手动保存.patdoc"), "保留");
  const target = await mkdtemp(join(tmpdir(), "backup-migration-"));
  roots.push(target);
  const result = await service.configure({
    enabled: true,
    folder: target,
    intervalMinutes: 5,
    migrateExisting: true,
    expectedSourceFolder: root,
  });
  service.stop();
  expect(result).toMatchObject({ migratedCount: 1, skippedCount: 1, retainedSourceCount: 0 });
  expect((await service.status()).folder).toBe(target);
  expect(await readFile(join(target, original.fileName))).toEqual(bytes);
  await expect(stat(join(root, original.fileName))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, "手动保存.patdoc"), "utf8")).toBe("保留");
});

test("rejects nested destinations without changing the source or settings", async () => {
  const { root, service } = await fixture();
  await service.runNow();
  const original = (await service.list())[0];
  if (!original) throw new Error("missing backup");
  await expect(
    service.configure({
      enabled: true,
      folder: join(root, "nested"),
      intervalMinutes: 5,
      migrateExisting: true,
      expectedSourceFolder: root,
    }),
  ).rejects.toThrow();
  service.stop();
  expect((await service.status()).folder).toBe(root);
  expect((await stat(join(root, original.fileName))).isFile()).toBe(true);
});

test("only switching directories does not move old backups", async () => {
  const { root, service } = await fixture();
  await service.runNow();
  const original = (await service.list())[0];
  if (!original) throw new Error("missing backup");
  const target = await mkdtemp(join(tmpdir(), "backup-switch-"));
  roots.push(target);
  await service.configure({ enabled: false, folder: target, intervalMinutes: 5 });
  expect(await service.list()).toEqual([]);
  expect((await stat(join(root, original.fileName))).isFile()).toBe(true);
});

test("rejects traversal and linked month folders for restore and delete", async () => {
  const { root, service, restoreOne } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "backup-outside-"));
  roots.push(outside);
  await mkdir(join(root, "2026-08"));
  await symlink(outside, join(root, "2026-07"), "junction");
  await writeFile(join(outside, "external.patdoc"), "do not touch");
  for (const path of [
    "../external.patdoc",
    "2026-07/external.patdoc",
    "2026-08/../external.patdoc",
    "C:/external.patdoc",
  ]) {
    await expect(service.restore(path)).rejects.toThrow();
  }
  expect(restoreOne).not.toHaveBeenCalled();
  expect(await service.list()).toEqual([]);
});

test("reports organization failures and retains the original usable backup for retry", async () => {
  const { root, info, service } = await fixture();
  const legacy = `PWB-AUTO-PAT-${info.documentId}-r1-10000000-0000-4000-8000-000000000003.patdoc`;
  const content = JSON.stringify(info);
  await writeFile(join(root, legacy), content);
  await writeFile(join(root, "2026-07"), "月份目录被文件占用");
  await service.initialize();
  await service.runNow();
  service.stop();
  expect((await service.status()).lastRunFailureCount).toBe(1);
  expect(await readFile(join(root, legacy), "utf8")).toBe(content);
  expect(
    (await service.list()).some((entry) => entry.fileName === legacy && entry.status === "healthy"),
  ).toBe(true);
});
