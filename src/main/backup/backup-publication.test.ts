// @vitest-environment node
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { BackupService } from "./backup-service.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, copyFile: vi.fn(actual.copyFile), open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(fs.copyFile).mockImplementation(actualFs.copyFile);
  vi.mocked(fs.open).mockImplementation(actualFs.open);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const folder = await fs.mkdtemp(join(tmpdir(), "backup-publication-"));
  roots.push(folder);
  const info = {
    documentType: "patent" as const,
    documentId: "00000000-0000-4000-8000-000000000001",
    displayName: "发布校验测试",
    revision: 1,
    modifiedAt: "2026-09-27T00:00:00.000Z",
  };
  const settings = {
    ...DEFAULT_APP_SETTINGS,
    backup: { enabled: true, folder, intervalMinutes: 1, waitOnExit: true },
  };
  const service = new BackupService({
    settings: { read: async () => settings, update: async () => settings },
    delegate: {
      listModified: async () => [{ ...info }],
      backupOne: async (source, target) => fs.writeFile(target, JSON.stringify(source)),
      inspect: async (path) => JSON.parse(await fs.readFile(path, "utf8")),
      restoreOne: async () => info,
    },
  });
  return { folder, service, info };
}

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
