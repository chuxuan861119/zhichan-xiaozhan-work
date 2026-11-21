// @vitest-environment node
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { usesHarmonyPublicFileCopy } from "../platform/harmony-public-files.js";
import { BackupService, type DocumentModifiedInfo } from "./backup-service.js";

vi.mock("../platform/harmony-public-files.js", () => ({
  usesHarmonyPublicFileCopy: vi.fn(() => false),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    copyFile: vi.fn(actual.copyFile),
    open: vi.fn(actual.open),
    link: vi.fn(actual.link),
    utimes: vi.fn(actual.utimes),
  };
});
const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(fs.copyFile).mockImplementation(actualFs.copyFile);
  vi.mocked(fs.open).mockImplementation(actualFs.open);
  vi.mocked(fs.link).mockImplementation(actualFs.link);
  vi.mocked(fs.utimes).mockImplementation(actualFs.utimes);
  vi.mocked(usesHarmonyPublicFileCopy).mockReturnValue(false);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(createdAt?: string) {
  const folder = await fs.mkdtemp(join(tmpdir(), "backup-publication-"));
  roots.push(folder);
  const info: DocumentModifiedInfo = {
    documentType: "patent" as const,
    documentId: "00000000-0000-4000-8000-000000000001",
    displayName: "发布校验测试",
    revision: 1,
    modifiedAt: "2026-09-27T00:00:00.000Z",
    ...(createdAt ? { createdAt } : {}),
  };
  const settings = {
    ...DEFAULT_APP_SETTINGS,
    backup: { enabled: true, folder, intervalMinutes: 1, waitOnExit: true },
  };
  const inspect = vi.fn(async (path: string) => JSON.parse(await fs.readFile(path, "utf8")));
  const service = new BackupService({
    settings: { read: async () => settings, update: async () => settings },
    delegate: {
      listModified: async () => [{ ...info }],
      backupOne: async (source, target) => fs.writeFile(target, JSON.stringify(source)),
      inspect,
      restoreOne: async () => info,
    },
  });
  return { folder, service, info, inspect };
}

test("Harmony public backups publish verified bytes when exclusive copy and links are unsupported", async () => {
  const f = await fixture("2026-09-27T00:00:00.000Z");
  vi.mocked(usesHarmonyPublicFileCopy).mockReturnValue(true);
  const denied = Object.assign(new Error("unsupported public storage operation"), {
    code: "EPERM",
  });
  vi.mocked(fs.copyFile).mockRejectedValue(denied);
  vi.mocked(fs.link).mockRejectedValue(denied);
  try {
    const result = await f.service.finalize();
    expect(result.failures).toEqual([]);
    expect(result.successCount).toBe(1);
    const entries = await f.service.list();
    expect(entries).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(join(f.folder, entries[0]!.fileName), "utf8"))).toEqual(
      f.info,
    );
  } finally {
    await f.service.shutdown();
  }
});

test("public backup time survives denied timestamp changes without depending on copied file mtime", async () => {
  const f = await fixture("2026-09-27T00:00:00.000Z");
  vi.mocked(usesHarmonyPublicFileCopy).mockReturnValue(true);
  vi.mocked(fs.utimes).mockRejectedValue(
    Object.assign(new Error("unsupported utime"), { code: "EPERM" }),
  );
  try {
    const result = await f.service.finalize();
    expect(result.failures).toEqual([]);
    const [entry] = await f.service.list();
    if (!entry) throw Error("Missing backup");
    await actualFs.utimes(join(f.folder, entry.fileName), new Date(0), new Date(0));
    const [listed] = await f.service.list();
    expect(listed?.backedUpAt).toBe(entry.backedUpAt);
  } finally {
    await f.service.shutdown();
  }
});

test("Harmony public backup migration publishes verified bytes without unsupported exclusive copies", async () => {
  const f = await fixture("2026-09-27T00:00:00.000Z");
  vi.mocked(usesHarmonyPublicFileCopy).mockReturnValue(true);
  const denied = Object.assign(new Error("unsupported"), { code: "EPERM" });
  vi.mocked(fs.copyFile).mockRejectedValue(denied);
  vi.mocked(fs.link).mockRejectedValue(denied);
  try {
    expect((await f.service.finalize()).successCount).toBe(1);
    const [entry] = await f.service.list();
    if (!entry) throw Error("Missing backup");
    const source = await fs.readFile(join(f.folder, entry.fileName));
    const destination = await fs.mkdtemp(join(tmpdir(), "backup-migration-target-"));
    roots.push(destination);
    const migration = await f.service.configure({
      enabled: true,
      folder: destination,
      intervalMinutes: 1,
      migrateExisting: true,
    });
    expect(migration?.migratedCount).toBe(1);
    expect(await fs.readFile(join(destination, entry.fileName))).toEqual(source);
  } finally {
    await f.service.shutdown();
  }
});

test("other filesystems still report denied exclusive copies without changing publication policy", async () => {
  const f = await fixture();
  vi.mocked(fs.copyFile).mockRejectedValue(Object.assign(new Error("denied"), { code: "EPERM" }));
  try {
    const result = await f.service.finalize();
    expect(result.successCount).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(await f.service.list()).toEqual([]);
  } finally {
    await f.service.shutdown();
  }
});

test("legacy backups gain a timestamped public name without losing their bytes or backup minute", async () => {
  const f = await fixture();
  try {
    expect((await f.service.finalize()).successCount).toBe(1);
    const [entry] = await f.service.list();
    if (!entry) throw Error("Missing legacy backup");
    const source = await fs.readFile(join(f.folder, entry.fileName));
    const time = new Date(2021, 2, 4, 12, 34);
    await actualFs.utimes(join(f.folder, entry.fileName), time, time);
    f.inspect.mockImplementation(async (path) => ({
      ...JSON.parse(await fs.readFile(path, "utf8")),
      createdAt: "2020-01-02T00:00:00.000Z",
    }));
    vi.mocked(usesHarmonyPublicFileCopy).mockReturnValue(true);
    vi.mocked(fs.utimes).mockRejectedValue(
      Object.assign(new Error("unsupported utime"), { code: "EPERM" }),
    );
    const destination = await fs.mkdtemp(join(tmpdir(), "backup-legacy-target-"));
    roots.push(destination);
    expect(
      (
        await f.service.configure({
          enabled: true,
          folder: destination,
          intervalMinutes: 1,
          migrateExisting: true,
        })
      )?.migratedCount,
    ).toBe(1);
    const [migrated] = await f.service.list({
      enabled: true,
      folder: destination,
      intervalMinutes: 1,
    });
    if (!migrated) throw Error("Missing migrated backup");
    expect(migrated.backedUpAt).toBe(time.toISOString());
    expect(await fs.readFile(join(destination, migrated.fileName))).toEqual(source);
  } finally {
    await f.service.shutdown();
  }
});

test("Harmony public publication retries a collision without replacing the existing file", async () => {
  const f = await fixture("2026-09-27T00:00:00.000Z");
  vi.mocked(usesHarmonyPublicFileCopy).mockReturnValue(true);
  vi.mocked(fs.link).mockRejectedValue(Object.assign(new Error("unsupported"), { code: "EPERM" }));
  let collision: string | undefined;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (!collision && args[1] === "wx" && String(args[0]).endsWith(".patdoc")) {
      collision = String(args[0]);
      await actualFs.writeFile(collision, "existing unrelated file");
      throw Object.assign(new Error("already exists"), { code: "EEXIST" });
    }
    return actualFs.open(...args);
  });
  try {
    expect((await f.service.finalize()).successCount).toBe(1);
    if (!collision) throw Error("Collision was not exercised");
    expect(await fs.readFile(collision, "utf8")).toBe("existing unrelated file");
    expect(await f.service.list()).toHaveLength(2);
  } finally {
    await f.service.shutdown();
  }
});

test("does not expose a backup while its final copy is still being published", async () => {
  const f = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(fs.copyFile).mockImplementationOnce(async (...args) => {
    await actualFs.copyFile(...args);
    entered();
    await gate;
  });
  const run = f.service.finalize();
  await started;
  try {
    expect(await f.service.list()).toEqual([]);
  } finally {
    release();
    await run;
    await f.service.shutdown();
  }
});

test("a sync failure preserves all prior recovery files and rejects the new backup", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) {
    await f.service.runNow();
    f.info.revision++;
  }
  const before = (await fs.readdir(f.folder)).sort();
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actualFs.open(...args);
    vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("disk sync failed"));
    return handle;
  });
  const result = await f.service.finalize();
  expect(result.failures).toHaveLength(1);
  expect((await fs.readdir(f.folder)).sort()).toEqual(before);
  await f.service.shutdown();
});

test("rejects a copied archive whose bytes changed even when it is still readable", async () => {
  const f = await fixture();
  vi.mocked(fs.copyFile).mockImplementationOnce(async (...args) => {
    await actualFs.copyFile(...args);
    await fs.writeFile(args[1], JSON.stringify({ ...f.info, displayName: "different content" }));
  });
  expect((await f.service.finalize()).failures).toHaveLength(1);
  expect(await f.service.list()).toEqual([]);
  await f.service.shutdown();
});
