import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { TextPolishHistoryStore } from "../ai-correction/text-polish-history-store.js";
import { FileService } from "../documents/file-service.js";
import type { PatentPatdocPayload } from "../documents/patdoc-format.js";
import { writePatdoc } from "../documents/patdoc-writer.js";
import { DraftService } from "../drafts/draft-service.js";
import type { LibraryDatabase } from "../library/library-database.js";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import { ExportSourceSnapshot, ExportSourceSnapshotError } from "./export-source-snapshot.js";

const roots: string[] = [];
const databases: LibraryDatabase[] = [];
const FIXED_NOW = new Date("2026-08-16T05:00:00.000Z");
const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET_NAME = `${"A".repeat(64)}.asset`;

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "export-source-snapshot-"));
  roots.push(root);
  const libraryRoot = join(root, "Library");
  const userDataRoot = join(root, "user-data");
  const workRoot = join(root, "transfer-work");
  await mkdir(workRoot);
  const prepared = await new LibraryMigrationService(libraryRoot).prepare();
  if (prepared.status !== "ready") throw new Error(`fixture library failed: ${prepared.status}`);
  const database = prepared.database;
  databases.push(database);
  const fileService = new FileService();
  const draftService = new DraftService(join(userDataRoot, "drafts"), () => FIXED_NOW, fileService);
  return { root, libraryRoot, userDataRoot, workRoot, database, fileService, draftService };
}

function request(fixture: Fixture) {
  return {
    database: fixture.database,
    libraryRoot: fixture.libraryRoot,
    userDataRoot: fixture.userDataRoot,
    workRoot: fixture.workRoot,
    draftService: fixture.draftService,
    fileService: fixture.fileService,
  };
}

async function addAsset(fixture: Fixture, bytes = Buffer.from("encrypted asset")) {
  await mkdir(join(fixture.libraryRoot, "assets"), { recursive: true });
  await writeFile(join(fixture.libraryRoot, "assets", ASSET_NAME), bytes);
  fixture.database.transaction((database) =>
    database
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "asset-secret-id",
        "A".repeat(64),
        ASSET_NAME,
        "image/png",
        bytes.byteLength,
        1,
        1,
        FIXED_NOW.toISOString(),
      ),
  );
}

async function addDraft(fixture: Fixture): Promise<string> {
  const payload: PatentPatdocPayload = {
    patent: createBlankPatent({ patentType: "invention", name: "绝密草稿标题" }),
    assets: [],
    flowcharts: [],
  };
  const draftId = payload.patent.patentId;
  const directory = join(fixture.userDataRoot, "drafts", draftId);
  const fileName = "20260816-130000.patdoc";
  await mkdir(directory, { recursive: true });
  await writePatdoc(join(directory, fileName), payload);
  await writeFile(
    join(directory, "draft.json"),
    `${JSON.stringify(
      {
        draftId,
        documentId: draftId,
        displayName: "绝密草稿.patdoc",
        originalPath: "D:\\客户\\绝密草稿.patdoc",
        savedAt: FIXED_NOW.toISOString(),
        fileName,
      },
      null,
      2,
    )}\n`,
  );
  return draftId;
}

async function expectSourceSaveFailure(
  fixture: Fixture,
  operation: Promise<unknown>,
): Promise<void> {
  const failure = await operation.catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "SOURCE_SAVE_FAILED" });
  expect((failure as Error).message).not.toMatch(/secret|绝密|客户|asset-secret-id/iu);
  expect(await readdir(fixture.workRoot)).toEqual([]);
  expect(fixture.database.integrityCheck()).toEqual({ ok: true });
  fixture.database.transaction((database) =>
    database
      .prepare("INSERT OR REPLACE INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
      .run("after-failed-snapshot", Buffer.from("still-usable"), FIXED_NOW.toISOString()),
  );
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("freezes real WAL data, declared assets and portable legacy drafts", async () => {
  const fixture = await createFixture();
  await mkdir(join(fixture.userDataRoot, "content-search-cache"), { recursive: true });
  await writeFile(
    join(fixture.userDataRoot, "content-search-cache", "content-v1.sqlite3"),
    "local-search-cache",
  );
  await addAsset(fixture);
  const draftId = await addDraft(fixture);
  fixture.database.transaction((database) =>
    database
      .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
      .run("transfer-test", Buffer.from("encrypted-test-state"), FIXED_NOW.toISOString()),
  );
  expect((await stat(join(fixture.libraryRoot, "library.sqlite3-wal"))).size).toBeGreaterThan(0);

  const snapshotter = new ExportSourceSnapshot({
    now: () => FIXED_NOW,
    randomUUID: () => TASK_ID,
  });
  const summary = await snapshotter.create(request(fixture));

  expect(summary.cutoffAt).toBe(FIXED_NOW.toISOString());
  expect(summary.assetCount).toBe(1);
  expect(summary.draftCount).toBe(1);
  expect(summary.database).toBe(summary.entries[0]);
  expect(summary.entries.map((entry) => entry.logicalPath)).toEqual([
    "library/library.sqlite3",
    `library/assets/${ASSET_NAME}`,
    `legacy-drafts/${draftId}/20260816-130000.patdoc`,
    `legacy-drafts/${draftId}/draft.json`,
  ]);
  expect(summary.entries.every((entry) => entry.sourcePath.startsWith(summary.taskDirectory))).toBe(
    true,
  );
  expect(summary.entries.every((entry) => /^[0-9a-f]{64}$/u.test(entry.hash))).toBe(true);
  expect(summary.totalBytes).toBe(summary.entries.reduce((total, entry) => total + entry.size, 0));
  expect(Object.isFrozen(summary)).toBe(true);
  expect(Object.isFrozen(summary.entries)).toBe(true);
  expect(JSON.stringify(summary)).not.toMatch(/绝密草稿标题|D:\\\\客户|originalPath/iu);
  expect(await readdir(join(summary.taskDirectory, "library"))).toEqual([
    "assets",
    "library.sqlite3",
  ]);

  const copiedDatabase = new DatabaseSync(summary.database.sourcePath, { readOnly: true });
  try {
    const row = copiedDatabase
      .prepare("SELECT value FROM library_state WHERE key = ?")
      .get("transfer-test") as { value: Uint8Array };
    expect(Buffer.from(row.value).toString("utf8")).toBe("encrypted-test-state");
  } finally {
    copiedDatabase.close();
  }
  const draftMetadata = JSON.parse(
    await readFile(join(summary.taskDirectory, "legacy-drafts", draftId, "draft.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(draftMetadata.originalPath).toBeNull();
  expect(JSON.stringify(draftMetadata)).not.toContain("D:\\客户");

  expect(fixture.database.integrityCheck()).toEqual({ ok: true });
  fixture.database.transaction((database) =>
    database
      .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
      .run("after-snapshot", Buffer.from("still-writable"), FIXED_NOW.toISOString()),
  );
  const liveRow = fixture.database.read((database) =>
    database.prepare("SELECT value FROM library_state WHERE key = ?").get("after-snapshot"),
  ) as { value: Uint8Array };
  expect(Buffer.from(liveRow.value).toString("utf8")).toBe("still-writable");
});

test("freezes polish drafts, active state and preserved unreadable bytes as distinct entries", async () => {
  const fixture = await createFixture();
  const directory = join(fixture.userDataRoot, "text-polish-history", TASK_ID);
  await mkdir(directory, { recursive: true });
  const files = {
    "draft-new.json": JSON.stringify({ text: "尚未发送", presets: [] }),
    [`draft-${TASK_ID}.json`]: JSON.stringify({ text: "继续对话", presets: [] }),
    "active.json": JSON.stringify({ conversationId: TASK_ID }),
    [`active.json.unreadable-${TASK_ID}`]: "{broken original bytes",
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes);
  const summary = await new ExportSourceSnapshot().create(request(fixture));
  const entries = summary.entries.filter((entry) => entry.kind === "text-polish-history");
  expect(entries).toHaveLength(4);
  for (const entry of entries) {
    expect(await readFile(entry.sourcePath, "utf8")).toBe(
      files[(entry.logicalPath.split("/").at(-1) ?? "") as keyof typeof files],
    );
  }
});

test("exports legacy conversation results without reasoning and keeps package hashes consistent", async () => {
  const fixture = await createFixture();
  const root = join(fixture.userDataRoot, "text-polish-history");
  const snapshot = {
    conversationId: TASK_ID,
    patentId: TASK_ID,
    sessionId: TASK_ID,
    bookKind: "description" as const,
    conversationRevision: 0,
    source: { kind: "generation" as const, requirement: "synthetic" },
    model: {
      profileId: TASK_ID,
      providerId: "custom",
      displayName: "Synthetic",
      baseUrl: "https://example.com/v1",
      model: "synthetic",
    },
    messages: [],
    latestValidDraft: "保留最终结果",
    summary: null,
    activeTurn: null,
    lastTurnOutcome: null,
    reasoningByTurn: { [TASK_ID]: { text: "不可导出的思考", truncated: false } },
  };
  new TextPolishHistoryStore(root).save(snapshot);
  const path = join(root, TASK_ID, `conversation-${TASK_ID}.json`);
  await writeFile(path, JSON.stringify({ snapshot, updatedAt: "original" }));
  const summary = await new ExportSourceSnapshot().create(request(fixture));
  const entry = summary.entries.find((item) => item.kind === "text-polish-history");
  if (!entry) throw new Error("missing history");
  const bytes = await readFile(entry.sourcePath);
  expect(bytes.toString()).not.toContain("reasoningByTurn");
  expect(bytes.toString()).toContain("保留最终结果");
  expect(entry.size).toBe(bytes.length);
  expect(entry.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(await readFile(path, "utf8")).toContain("不可导出的思考");
});

test("backs up original corrupt conversation bytes after explicit recovery", async () => {
  const fixture = await createFixture();
  const historyRoot = join(fixture.userDataRoot, "text-polish-history");
  const store = new TextPolishHistoryStore(historyRoot);
  store.saveDraft(TASK_ID, null, { text: "safe draft", presets: [] });
  const name = `conversation-${TASK_ID}.json`;
  const bytes = Buffer.from([0xff, 0xfe, 0x7b, 0x00]);
  await writeFile(join(historyRoot, TASK_ID, name), bytes);
  store.recoverState(TASK_ID, TASK_ID);
  const summary = await new ExportSourceSnapshot().create(request(fixture));
  const entry = summary.entries.find((item) => item.logicalPath.includes(`${name}.unreadable-`));
  expect(entry).toBeDefined();
  if (!entry) throw new Error("missing quarantine entry");
  expect(await readFile(entry.sourcePath)).toEqual(bytes);
  expect(store.history(TASK_ID)).toEqual([]);
});

test("runs checkpoint, source integrity, source foreign keys and backup in fixed order", async () => {
  const fixture = await createFixture();
  const events: string[] = [];
  const waitForIdle = fixture.draftService.waitForIdle.bind(fixture.draftService);
  const checkpoint = fixture.database.checkpoint.bind(fixture.database);
  const integrityCheck = fixture.database.integrityCheck.bind(fixture.database);
  const foreignKeyCheck = fixture.database.foreignKeyCheck.bind(fixture.database);
  vi.spyOn(fixture.database, "checkpoint").mockImplementation(() => {
    events.push("checkpoint");
    checkpoint();
  });
  vi.spyOn(fixture.draftService, "waitForIdle").mockImplementation(async () => {
    events.push("draft-idle");
    await waitForIdle();
  });
  vi.spyOn(fixture.database, "integrityCheck").mockImplementation(() => {
    events.push("integrity");
    return integrityCheck();
  });
  vi.spyOn(fixture.database, "foreignKeyCheck").mockImplementation(() => {
    events.push("foreign-keys");
    return foreignKeyCheck();
  });
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterDatabaseBackup: () => {
      events.push("backup");
    },
  });

  await snapshotter.create(request(fixture));

  expect(events.slice(0, 5)).toEqual([
    "draft-idle",
    "checkpoint",
    "integrity",
    "foreign-keys",
    "backup",
  ]);
});

test("rejects source foreign key violations without exposing row values", async () => {
  const fixture = await createFixture();
  fixture.database.read((database) =>
    database.exec(`
      CREATE TABLE transfer_parent(id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE transfer_child(
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES transfer_parent(id)
      ) STRICT;
      PRAGMA foreign_keys=OFF;
      INSERT INTO transfer_child VALUES ('secret-child', 'secret-parent');
      PRAGMA foreign_keys=ON;
    `),
  );

  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(request(fixture)),
  );
});

test("rejects a failed source integrity check and leaves the source open", async () => {
  const fixture = await createFixture();
  vi.spyOn(fixture.database, "integrityCheck").mockReturnValueOnce({
    ok: false,
    messages: ["secret page content"],
  });

  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(request(fixture)),
  );
});

test("rejects a failed draft queue drain and removes only its owned task directory", async () => {
  const fixture = await createFixture();
  const failedDraftService = {
    waitForIdle: vi.fn(async () => {
      throw new Error("secret draft queue failure");
    }),
  };

  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create({
      ...request(fixture),
      draftService: failedDraftService,
    }),
  );
  expect(failedDraftService.waitForIdle).toHaveBeenCalledOnce();
});

test("rejects a damaged database backup during independent read-only verification", async () => {
  const fixture = await createFixture();
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterDatabaseBackup: async (path) => {
      const handle = await open(path, "r+");
      try {
        await handle.write(Buffer.alloc(128, 0xff), 0, 128, 4_096);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  });

  await expectSourceSaveFailure(fixture, snapshotter.create(request(fixture)));
});

test.each(["ENOSPC", "EFBIG"] as const)(
  "retains only safe native space code %s at the snapshot boundary",
  async (nativeCode) => {
    const fixture = await createFixture();
    const snapshotter = new ExportSourceSnapshot({
      randomUUID: () => TASK_ID,
      afterDatabaseBackup: () => {
        throw Object.assign(new Error(`secret:${fixture.libraryRoot}`), {
          code: nativeCode,
          path: fixture.libraryRoot,
        });
      },
    });

    const failure = await snapshotter.create(request(fixture)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExportSourceSnapshotError);
    expect(failure).toMatchObject({ code: "SOURCE_SAVE_FAILED", nativeCode });
    expect((failure as Error).stack).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(fixture.libraryRoot);
    expect(failure).not.toHaveProperty("cause");
  },
);

test("rejects a backup whose schema fingerprint differs from the source version", async () => {
  const fixture = await createFixture();
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterDatabaseBackup: (path) => {
      const database = new DatabaseSync(path);
      try {
        database.exec("PRAGMA journal_mode=DELETE; DROP INDEX patents_modified_at_idx");
      } finally {
        database.close();
      }
    },
  });

  await expectSourceSaveFailure(fixture, snapshotter.create(request(fixture)));
});

test("rejects foreign key violations introduced into the database backup", async () => {
  const fixture = await createFixture();
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterDatabaseBackup: (path) => {
      const database = new DatabaseSync(path);
      try {
        database.exec(`
          PRAGMA journal_mode=DELETE;
          CREATE TABLE copy_parent(id TEXT PRIMARY KEY) STRICT;
          CREATE TABLE copy_child(parent_id TEXT REFERENCES copy_parent(id)) STRICT;
          PRAGMA foreign_keys=OFF;
          INSERT INTO copy_child VALUES ('secret-copy-parent');
          PRAGMA foreign_keys=ON;
        `);
      } finally {
        database.close();
      }
    },
  });

  await expectSourceSaveFailure(fixture, snapshotter.create(request(fixture)));
});

test("rejects a database-declared asset that is missing", async () => {
  const fixture = await createFixture();
  await addAsset(fixture);
  await rm(join(fixture.libraryRoot, "assets", ASSET_NAME));

  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(request(fixture)),
  );
});

test("rejects a database asset path outside the exact uppercase encrypted naming contract", async () => {
  const fixture = await createFixture();
  fixture.database.transaction((database) =>
    database
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "asset-secret-id",
        "A".repeat(64),
        `${"a".repeat(64)}.asset`,
        "image/png",
        1,
        1,
        1,
        FIXED_NOW.toISOString(),
      ),
  );

  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(request(fixture)),
  );
});

test("rejects extra non-temporary asset files and unknown directories", async () => {
  const fixture = await createFixture();
  const assetRoot = join(fixture.libraryRoot, "assets");
  await mkdir(assetRoot);
  await writeFile(join(assetRoot, `${"B".repeat(64)}.asset`), "undeclared secret");

  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(request(fixture)),
  );

  await rm(join(assetRoot, `${"B".repeat(64)}.asset`));
  await mkdir(join(assetRoot, "unknown-directory"));
  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({
      randomUUID: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }).create(request(fixture)),
  );
});

test("ignores only the exact encrypted asset store temporary naming convention", async () => {
  const fixture = await createFixture();
  const assetRoot = join(fixture.libraryRoot, "assets");
  await mkdir(assetRoot);
  await writeFile(
    join(assetRoot, `${"A".repeat(64)}.tmp-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`),
    "staged",
  );

  const summary = await new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(
    request(fixture),
  );

  expect(summary.assetCount).toBe(0);
  expect(summary.entries.map((entry) => entry.kind)).toEqual(["database"]);
});

test("rejects a near-match that is not an encrypted asset store temporary file", async () => {
  const fixture = await createFixture();
  const assetRoot = join(fixture.libraryRoot, "assets");
  await mkdir(assetRoot);
  await writeFile(
    join(assetRoot, `${"A".repeat(64)}.tmp-AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`),
    "not an allowed temp",
  );

  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(request(fixture)),
  );
});

test("rejects an asset that changes after its stable handle and path stat", async () => {
  const fixture = await createFixture();
  await addAsset(fixture, Buffer.alloc(4 * 1024 * 1024, 0x41));
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterSourceStat: async (sourcePath, logicalPath) => {
      if (logicalPath.startsWith("library/assets/")) await writeFile(sourcePath, "changed secret");
    },
  });

  await expectSourceSaveFailure(fixture, snapshotter.create(request(fixture)));
});

test("rejects an asset path replacement after the original handle is opened", async () => {
  const fixture = await createFixture();
  const bytes = Buffer.from("original encrypted bytes");
  await addAsset(fixture, bytes);
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterSourceStat: async (sourcePath, logicalPath) => {
      if (!logicalPath.startsWith("library/assets/")) return;
      await rename(sourcePath, `${sourcePath}.replaced`);
      await writeFile(sourcePath, bytes);
    },
  });

  await expectSourceSaveFailure(fixture, snapshotter.create(request(fixture)));
});

test("rejects an undeclared asset created after the asset directory was enumerated", async () => {
  const fixture = await createFixture();
  await addAsset(fixture);
  const lateAsset = join(fixture.libraryRoot, "assets", `${"B".repeat(64)}.asset`);
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterSourceStat: async (_sourcePath, logicalPath) => {
      if (logicalPath === `library/assets/${ASSET_NAME}`) {
        await writeFile(lateAsset, "late undeclared encrypted bytes");
      }
    },
  });

  await expectSourceSaveFailure(fixture, snapshotter.create(request(fixture)));
});

test("rejects an allowed asset temp renamed to a final asset after enumeration", async () => {
  const fixture = await createFixture();
  await addAsset(fixture);
  const assetRoot = join(fixture.libraryRoot, "assets");
  const tempPath = join(assetRoot, `${"B".repeat(64)}.tmp-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`);
  const finalPath = join(assetRoot, `${"B".repeat(64)}.asset`);
  await writeFile(tempPath, "staged encrypted bytes");
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterSourceStat: async (_sourcePath, logicalPath) => {
      if (logicalPath === `library/assets/${ASSET_NAME}`) await rename(tempPath, finalPath);
    },
  });

  await expectSourceSaveFailure(fixture, snapshotter.create(request(fixture)));
});

test("rejects a declared asset replaced after its frozen copy was completed", async () => {
  const fixture = await createFixture();
  const bytes = Buffer.from("same encrypted bytes");
  await addAsset(fixture, bytes);
  const secondAssetName = `${"B".repeat(64)}.asset`;
  const assetRoot = join(fixture.libraryRoot, "assets");
  await writeFile(join(assetRoot, secondAssetName), bytes);
  fixture.database.transaction((database) =>
    database
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "second-asset-secret-id",
        "B".repeat(64),
        secondAssetName,
        "image/png",
        bytes.byteLength,
        1,
        1,
        FIXED_NOW.toISOString(),
      ),
  );
  const firstAssetPath = join(assetRoot, ASSET_NAME);
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterSourceStat: async (_sourcePath, logicalPath) => {
      if (logicalPath !== `library/assets/${secondAssetName}`) return;
      await rename(firstAssetPath, `${firstAssetPath}.replaced`);
      await writeFile(firstAssetPath, bytes);
    },
  });

  await expectSourceSaveFailure(fixture, snapshotter.create(request(fixture)));
});

test("rejects a later declared asset replaced before its stable handle is opened", async () => {
  const fixture = await createFixture();
  const bytes = Buffer.from("same encrypted bytes");
  await addAsset(fixture, bytes);
  const secondAssetName = `${"B".repeat(64)}.asset`;
  const secondAssetPath = join(fixture.libraryRoot, "assets", secondAssetName);
  const displacedPath = join(
    fixture.libraryRoot,
    "assets",
    `${"B".repeat(64)}.tmp-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
  );
  await writeFile(secondAssetPath, bytes);
  fixture.database.transaction((database) =>
    database
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "second-asset-secret-id",
        "B".repeat(64),
        secondAssetName,
        "image/png",
        bytes.byteLength,
        1,
        1,
        FIXED_NOW.toISOString(),
      ),
  );
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterSourceStat: async (_sourcePath, logicalPath) => {
      if (logicalPath !== `library/assets/${ASSET_NAME}`) return;
      await rename(secondAssetPath, displacedPath);
      await writeFile(secondAssetPath, bytes);
    },
  });

  await expectSourceSaveFailure(fixture, snapshotter.create(request(fixture)));
});

test("rejects a pre-open asset replacement even when size and mtime are preserved", async () => {
  const fixture = await createFixture();
  const bytes = Buffer.from("same encrypted bytes");
  await addAsset(fixture, bytes);
  const secondAssetName = `${"B".repeat(64)}.asset`;
  const secondAssetPath = join(fixture.libraryRoot, "assets", secondAssetName);
  const displacedPath = join(
    fixture.libraryRoot,
    "assets",
    `${"B".repeat(64)}.tmp-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
  );
  await writeFile(secondAssetPath, bytes);
  fixture.database.transaction((database) =>
    database
      .prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "second-asset-secret-id",
        "B".repeat(64),
        secondAssetName,
        "image/png",
        bytes.byteLength,
        1,
        1,
        FIXED_NOW.toISOString(),
      ),
  );
  const originalStats = await stat(secondAssetPath);
  let replacementStats: Awaited<ReturnType<typeof stat>> | undefined;
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterSourceStat: async (_sourcePath, logicalPath) => {
      if (logicalPath !== `library/assets/${ASSET_NAME}`) return;
      await rename(secondAssetPath, displacedPath);
      await writeFile(secondAssetPath, bytes);
      await utimes(secondAssetPath, originalStats.atime, originalStats.mtime);
      replacementStats = await stat(secondAssetPath);
    },
  });

  const outcome = await snapshotter.create(request(fixture)).catch((error: unknown) => error);

  expect(replacementStats?.size).toBe(originalStats.size);
  expect(replacementStats?.mtimeMs).toBeCloseTo(originalStats.mtimeMs, 0);
  expect(replacementStats?.ino).not.toBe(originalStats.ino);
  expect(outcome).toMatchObject({ code: "SOURCE_SAVE_FAILED" });
  expect(await readdir(fixture.workRoot)).toEqual([]);
});

test("rejects a linked or reparse asset entry", async () => {
  const fixture = await createFixture();
  await addAsset(fixture);
  const assetPath = join(fixture.libraryRoot, "assets", ASSET_NAME);
  await rm(assetPath);
  const target = join(fixture.root, "linked-asset-target");
  await mkdir(target);
  await symlink(target, assetPath, process.platform === "win32" ? "junction" : "dir");

  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(request(fixture)),
  );
});

test("streams and verifies a large encrypted asset without changing its bytes", async () => {
  const fixture = await createFixture();
  const bytes = Buffer.alloc(20 * 1024 * 1024, 0x5a);
  await addAsset(fixture, bytes);

  const summary = await new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(
    request(fixture),
  );
  const entry = summary.entries.find((candidate) => candidate.kind === "asset");

  expect(entry?.size).toBe(bytes.byteLength);
  expect(entry?.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
});

test("rejects a corrupt legacy draft PATDOC", async () => {
  const fixture = await createFixture();
  const draftId = await addDraft(fixture);
  await writeFile(
    join(fixture.userDataRoot, "drafts", draftId, "20260816-130000.patdoc"),
    "corrupt secret draft",
  );

  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(request(fixture)),
  );
});

test("rejects missing metadata or multiple PATDOC files in a draft", async () => {
  const fixture = await createFixture();
  const draftId = await addDraft(fixture);
  const directory = join(fixture.userDataRoot, "drafts", draftId);
  await rm(join(directory, "draft.json"));
  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(request(fixture)),
  );

  await rm(directory, { recursive: true });
  const secondDraftId = await addDraft(fixture);
  const secondDirectory = join(fixture.userDataRoot, "drafts", secondDraftId);
  await copyFile(
    join(secondDirectory, "20260816-130000.patdoc"),
    join(secondDirectory, "20260816-130001.patdoc"),
  );
  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({
      randomUUID: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }).create(request(fixture)),
  );
});

test("rejects non-UUID and linked legacy draft directories", async () => {
  const fixture = await createFixture();
  const draftRoot = join(fixture.userDataRoot, "drafts");
  await mkdir(join(draftRoot, "not-a-uuid"), { recursive: true });
  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(request(fixture)),
  );

  await rm(join(draftRoot, "not-a-uuid"), { recursive: true });
  const target = join(fixture.root, "linked-draft-target");
  await mkdir(target);
  const linkedId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await symlink(
    target,
    join(draftRoot, linkedId),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expectSourceSaveFailure(
    fixture,
    new ExportSourceSnapshot({
      randomUUID: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }).create(request(fixture)),
  );
});

test("does not delete a caller-owned directory when the task UUID collides", async () => {
  const fixture = await createFixture();
  const occupied = join(fixture.workRoot, TASK_ID);
  await mkdir(occupied);
  await writeFile(join(occupied, "caller-owned.txt"), "keep");

  await expect(
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create(request(fixture)),
  ).rejects.toMatchObject({ code: "SOURCE_SAVE_FAILED" });
  expect(await readFile(join(occupied, "caller-owned.txt"), "utf8")).toBe("keep");
});

test("does not delete a replacement inserted after cleanup ownership validation", async () => {
  const fixture = await createFixture();
  const taskDirectory = join(fixture.workRoot, TASK_ID);
  const preservedOwnedDirectory = join(fixture.root, "preserved-owned-task");
  const sentinelPath = join(taskDirectory, "caller-owned-sentinel.txt");
  const snapshotter = new ExportSourceSnapshot({
    randomUUID: () => TASK_ID,
    afterCleanupValidation: async (validatedTaskDirectory) => {
      await rename(validatedTaskDirectory, preservedOwnedDirectory);
      await mkdir(validatedTaskDirectory);
      await writeFile(sentinelPath, "do not delete");
    },
  });

  const failure = await snapshotter
    .create({
      ...request(fixture),
      draftService: {
        waitForIdle: async () => {
          throw new Error("trigger snapshot cleanup");
        },
      },
    })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "SOURCE_SAVE_FAILED", cleanupFailed: true });
  expect(await readFile(sentinelPath, "utf8")).toBe("do not delete");
  expect(await readFile(join(preservedOwnedDirectory, ".export-source-owner"), "utf8")).toBe(
    `${TASK_ID}\n`,
  );
});

test("honors an already-aborted signal before creating a task directory", async () => {
  const fixture = await createFixture();
  const controller = new AbortController();
  controller.abort();

  await expect(
    new ExportSourceSnapshot({ randomUUID: () => TASK_ID }).create({
      ...request(fixture),
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  expect(await readdir(fixture.workRoot)).toEqual([]);
});
