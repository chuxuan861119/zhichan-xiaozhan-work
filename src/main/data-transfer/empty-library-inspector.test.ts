import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBlankDocument } from "../../shared/document/defaults.js";
import type { AssetDescriptor } from "../../shared/document/model.js";
import { createLegacyFactoryPatentTemplatesV1 } from "../../shared/patent/templates.js";
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_PATENT_TEMPLATE_SETTINGS,
} from "../../shared/settings/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import type { FileService } from "../documents/file-service.js";
import type { PatdocPayload } from "../documents/patdoc-format.js";
import { DraftService } from "../drafts/draft-service.js";
import { FlowchartService } from "../flowcharts/flowchart-service.js";
import { FlowchartSourceStore } from "../flowcharts/flowchart-source-store.js";
import { AssetStore } from "../library/asset-store.js";
import type { LibraryDatabase } from "../library/library-database.js";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import { LibraryService } from "../library/library-service.js";
import { PatentService } from "../library/patent-service.js";
import { PatentTemplateService } from "../library/patent-template-service.js";
import { encodeJson } from "../library/plaintext-codec.js";

import { SettingsService } from "../settings/settings-service.js";
import {
  EMPTY_LIBRARY_V10_TABLE_POLICIES,
  EmptyLibraryInspector,
} from "./empty-library-inspector.js";
import { createOwnedExportTask, recoverAbandonedExportTasks } from "./export-task-recovery.js";

const FIXED_NOW = new Date("2026-08-16T08:00:00.000Z");
const roots: string[] = [];
const databases: LibraryDatabase[] = [];
let nextId = 1;

function uuid(): string {
  return `00000000-0000-4000-8000-${(nextId++).toString(16).padStart(12, "0")}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(
  layout: "separate" | "nested-library" | "nested-default" = "separate",
) {
  const root = await mkdtemp(join(tmpdir(), "empty-library-inspector-"));
  roots.push(root);
  const userDataRoot = join(root, "user-data");
  const applicationDataRoot = join(layout === "separate" ? root : userDataRoot, "application-data");
  const libraryRoot =
    layout === "nested-default"
      ? join(applicationDataRoot, "Library")
      : join(layout === "nested-library" ? userDataRoot : root, "Library");
  await mkdir(userDataRoot, { recursive: true });
  await mkdir(applicationDataRoot, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });
  const prepared = await new LibraryMigrationService(libraryRoot).prepare();
  if (prepared.status !== "ready") throw new Error("fixture library preparation failed");
  databases.push(prepared.database);
  return {
    root,
    libraryRoot,
    userDataRoot,
    applicationDataRoot,
    database: prepared.database,
    inspector: new EmptyLibraryInspector({
      libraryRoot,
      userDataRoot,
      applicationDataRoot,
      database: prepared.database,
      createReparsePointProbe: () => ({ assertSafe: async () => {}, close: async () => {} }),
    }),
  };
}

async function createOwnedStagingCapability(root: string) {
  const info = await lstat(root, { bigint: true });
  return {
    root,
    identity: {
      device: info.dev.toString(),
      inode: info.ino.toString(),
      birthtimeNs: info.birthtimeNs.toString(),
    },
  };
}

function createPatentService(fixture: Fixture): PatentService {
  return new PatentService({
    database: fixture.database,
    now: () => FIXED_NOW,
    randomUUID: uuid,
  });
}

function createDocumentService(fixture: Fixture): LibraryService {
  return new LibraryService({
    database: fixture.database,
    now: () => FIXED_NOW,
    randomUUID: uuid,
  });
}

function storedAsset(): StoredAsset {
  const original = Uint8Array.from([1, 2, 3, 4]);
  const preview = Uint8Array.from([5, 6]);
  const descriptor: AssetDescriptor = {
    assetId: uuid(),
    kind: "image",
    originalName: "fixture.png",
    mediaType: "image/png",
    extension: "png",
    byteLength: original.byteLength,
    sha256: sha256(original),
    widthPx: 8,
    heightPx: 6,
    previewByteLength: preview.byteLength,
    previewSha256: sha256(preview),
  };
  return { descriptor, original, preview };
}

async function seedPatent(fixture: Fixture, trashed = false) {
  const service = createPatentService(fixture);
  const opened = await service.create({
    patentType: "invention",
    name: "绝不能出现在检查结果里的专利标题",
    templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
  });
  if (trashed) {
    await service.release(opened.sessionId);
    await service.moveToTrash(opened.patentId);
  }
  return { service, opened };
}

async function seedDocument(fixture: Fixture) {
  const service = createDocumentService(fixture);
  return { service, opened: await service.create("绝不能出现在检查结果里的文档标题") };
}

async function seedAssetGraph(fixture: Fixture) {
  const { opened } = await seedPatent(fixture);
  const { opened: document } = await seedDocument(fixture);
  const store = new AssetStore({
    root: fixture.libraryRoot,
    database: fixture.database,
    now: () => FIXED_NOW,
    randomUUID: uuid,
  });
  const asset = storedAsset();
  const installed = await store.install({ kind: "patent", patentId: opened.patentId }, asset);
  await store.install(
    { kind: "library-document", libraryDocumentId: document.libraryDocumentId },
    asset,
  );
  fixture.database.transaction((database) => {
    database
      .prepare(
        `INSERT INTO patent_figures(
          patent_id, figure_id, asset_id, position, width_mm, explanation, flowchart_link
        ) VALUES (?, ?, ?, 0, 30, '', NULL)`,
      )
      .run(opened.patentId, uuid(), installed.descriptor.assetId);
    database
      .prepare("INSERT INTO snapshot_assets(patent_id, revision, asset_id) VALUES (?, 0, ?)")
      .run(opened.patentId, installed.descriptor.assetId);
  });
}

async function seedEditLogs(fixture: Fixture) {
  const { opened: patent } = await seedPatent(fixture);
  const { opened: document } = await seedDocument(fixture);
  fixture.database.transaction((database) => {
    database
      .prepare(
        `INSERT INTO edit_log(
          operation_id, patent_id, base_revision, target_revision, model_version,
          payload, content_hash, created_at
        ) VALUES (?, ?, 0, 1, 1, ?, ?, ?)`,
      )
      .run(uuid(), patent.patentId, Buffer.from("payload"), "hash", FIXED_NOW.toISOString());
    database
      .prepare(
        `INSERT INTO document_edit_log(
          operation_id, library_document_id, base_revision, target_revision, model_version,
          payload, content_hash, created_at
        ) VALUES (?, ?, 0, 1, 1, ?, ?, ?)`,
      )
      .run(
        uuid(),
        document.libraryDocumentId,
        Buffer.from("payload"),
        "hash",
        FIXED_NOW.toISOString(),
      );
  });
}

async function seedFlowchartGraph(fixture: Fixture) {
  const { service: patents, opened } = await seedPatent(fixture);
  const sourceStore = new FlowchartSourceStore({
    database: fixture.database,
    now: () => FIXED_NOW,
    randomUUID: uuid,
  });
  const assets = new AssetStore({
    root: fixture.libraryRoot,
    database: fixture.database,
    now: () => FIXED_NOW,
    randomUUID: uuid,
  });
  const flowcharts = new FlowchartService({
    database: fixture.database,
    sourceStore,
    patentService: patents,
    assetStore: assets,
  });
  const created = await flowcharts.create({
    patentId: opened.patentId,
    expectedPatentRevision: 0,
    name: "流程工程",
    source: Buffer.from('<mxfile><diagram id="page"/></mxfile>'),
    pageCount: 1,
    lastPageId: "page",
  });
  fixture.database.transaction((database) => {
    const source = database
      .prepare(
        `SELECT current_source_revision_id AS source_revision_id
         FROM patent_flowcharts WHERE patent_id = ? AND project_id = ?`,
      )
      .get(opened.patentId, created.project.projectId) as { source_revision_id: string };
    database
      .prepare(
        `INSERT INTO snapshot_flowchart_revisions(
          patent_id, snapshot_revision, project_id, source_revision_id
        ) VALUES (?, 0, ?, ?)`,
      )
      .run(opened.patentId, created.project.projectId, source.source_revision_id);
  });
}

async function seedDraft(fixture: Fixture) {
  const payload: PatdocPayload = {
    document: createBlankDocument("私密草稿标题"),
    settings: {},
    editorState: {},
    assets: [],
  };
  const fileService = {
    saveDocument: async (path: string) => {
      await writeFile(path, "draft fixture");
      return {
        ok: true as const,
        value: {
          path,
          displayName: "draft.patdoc",
          savedAt: FIXED_NOW.toISOString(),
          previousVersionRetained: false,
        },
      };
    },
  } as unknown as FileService;
  await new DraftService(join(fixture.userDataRoot, "drafts"), () => FIXED_NOW, fileService).save({
    documentId: payload.document.documentId,
    displayName: "私密草稿标题",
    originalPath: "D:\\绝密\\私密草稿标题.patdoc",
    payload,
  });
}

function expectBlocker(
  result: Awaited<ReturnType<EmptyLibraryInspector["inspect"]>>,
  kind: string,
) {
  expect(result.empty).toBe(false);
  expect(result.blockers.some((blocker) => blocker.kind === kind && blocker.count > 0)).toBe(true);
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  nextId = 1;
});

test("accepts the dismissed tray hint without ignoring actual preferences", async () => {
  const fixture = await createFixture();
  const path = join(fixture.userDataRoot, "settings.json");
  await writeFile(path, JSON.stringify({ ...DEFAULT_APP_SETTINGS, trayIntroDismissed: true }));
  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
  await writeFile(
    path,
    JSON.stringify({ ...DEFAULT_APP_SETTINGS, trayIntroDismissed: true, closeToTray: false }),
  );
  expect((await fixture.inspector.inspect()).empty).toBe(false);
});

test("accepts a newly initialized V10 library and freezes the complete result", async () => {
  const fixture = await createFixture();
  await mkdir(join(fixture.libraryRoot, "assets"));
  await mkdir(join(fixture.userDataRoot, "drafts"));
  await mkdir(join(fixture.userDataRoot, "logs"));
  await writeFile(
    join(fixture.userDataRoot, "settings.json"),
    JSON.stringify(DEFAULT_APP_SETTINGS),
  );
  await writeFile(
    join(fixture.userDataRoot, "settings.json.last-good"),
    JSON.stringify(DEFAULT_APP_SETTINGS),
  );
  await writeFile(join(fixture.userDataRoot, "logs", "app.log"), "safe log\n");
  await writeFile(
    join(fixture.libraryRoot, "last-run-state.json"),
    JSON.stringify({
      version: 1,
      runId: uuid(),
      appVersion: "0.1.0",
      startedAt: FIXED_NOW.toISOString(),
      cleanShutdown: false,
      finishedAt: null,
    }),
  );

  const result = await fixture.inspector.inspect();

  expect(result).toEqual({ empty: true, blockers: [] });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.blockers)).toBe(true);
});
test("local library location metadata does not block importing into an empty library", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.userDataRoot, "library-location.json"),
    JSON.stringify({
      version: 1,
      baseRoot: fixture.libraryRoot,
      active: null,
      pending: null,
    }),
  );
  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
});

test("remains empty after real first-run template initialization and a second startup", async () => {
  const fixture = await createFixture();
  const settings = new SettingsService(join(fixture.userDataRoot, "settings.json"));
  const service = new PatentTemplateService({ database: fixture.database });
  service.initializeFromLegacySettings(await settings.readForTemplateMigration());
  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
  await settings.ensurePersisted();
  service.initializeFromLegacySettings(await settings.readForTemplateMigration());
  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
});

test.each(["0", "pending", 1, null])(
  "does not exempt a malformed initialization value %j",
  async (value) => {
    const fixture = await createFixture();
    fixture.database.transaction((raw) =>
      raw
        .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
        .run(
          "patent-template-catalog-migrated-v1",
          Buffer.from(encodeJson(value)),
          FIXED_NOW.toISOString(),
        ),
    );
    expect(await fixture.inspector.inspect()).toMatchObject({
      empty: false,
      blockers: [{ kind: "library-state", count: 1 }],
    });
  },
);

test("preserves migrated legacy auxiliary customization even with system book templates", async () => {
  const fixture = await createFixture();
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.patentTemplates = createLegacyFactoryPatentTemplatesV1(uuid);
  settings.patentTemplates.invention.drawingLegend.content = [
    { type: "text", text: "用户附图标记模板", marks: [] },
  ];
  new PatentTemplateService({ database: fixture.database }).initializeFromLegacySettings(settings);
  expect(await fixture.inspector.inspect()).toMatchObject({
    empty: false,
    blockers: [{ kind: "library-state", count: 1 }],
  });
});

test("the current fixture contains exactly the explicitly classified tables", async () => {
  const fixture = await createFixture();
  const tables = fixture.database.read((database) =>
    database
      .prepare(
        `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((row) => (row as { name: string }).name),
  );
  expect(tables).toEqual(
    [
      "assets",
      "automation_operations",
      "document_assets",
      "document_edit_log",
      "document_snapshots",
      "documents",
      "edit_log",
      "edit_log_flowchart_revisions",
      "library_state",
      "patent_assets",
      "patent_auxiliary_documents",
      "patent_books",
      "patent_figures",
      "patent_flowchart_source_revisions",
      "patent_flowcharts",
      "patent_import_reports",

      "patent_template_auxiliary",
      "patent_template_preferences",
      "patent_template_slots",
      "patents",
      "schema_migrations",
      "snapshot_assets",
      "snapshot_flowchart_revisions",
      "snapshots",
      "template_assets",
    ].sort(),
  );
  expect(Object.keys(EMPTY_LIBRARY_V10_TABLE_POLICIES).sort()).toEqual(tables);
  expect(EMPTY_LIBRARY_V10_TABLE_POLICIES).toEqual({
    assets: "assets",
    automation_operations: null,
    document_assets: "assets",
    document_edit_log: "edit-logs",
    document_snapshots: "snapshots",
    documents: "documents",
    edit_log: "edit-logs",
    edit_log_flowchart_revisions: "edit-logs",
    library_state: "library-state",
    patent_assets: "assets",
    patent_auxiliary_documents: "patents",
    patent_books: "patents",
    patent_figures: "assets",
    patent_flowchart_source_revisions: "projects",
    patent_flowcharts: "projects",
    patent_import_reports: "patents",

    patent_template_auxiliary: null,
    patent_template_preferences: null,
    patent_template_slots: null,
    patents: "patents",
    schema_migrations: null,
    snapshot_assets: "snapshots",
    snapshot_flowchart_revisions: "snapshots",
    snapshots: "snapshots",
    template_assets: "assets",
  });
});

test.each([
  ["malformed key envelope", "key-envelope.bin", "not-json"],
  ["invalid runtime state", "last-run-state.json", "{}"],
] as const)("fails closed for %s", async (_label, name, contents) => {
  const fixture = await createFixture();
  await writeFile(join(fixture.libraryRoot, name), contents);
  expect(await fixture.inspector.inspect()).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test("fails closed for non-default settings", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.userDataRoot, "settings.json"),
    JSON.stringify({ ...DEFAULT_APP_SETTINGS, zoomPercent: 125 }),
  );
  expect(await fixture.inspector.inspect()).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test.each([
  ["active patents and patent books", "patents", async (fixture: Fixture) => seedPatent(fixture)],
  ["trashed patents", "patents", async (fixture: Fixture) => seedPatent(fixture, true)],
  ["documents and document snapshots", "documents", seedDocument],
  ["patent snapshots", "snapshots", async (fixture: Fixture) => seedPatent(fixture)],
  ["patent and document edit logs", "edit-logs", seedEditLogs],
  ["assets, both owners, figures and snapshot links", "assets", seedAssetGraph],
  ["flowchart projects, revisions and history links", "projects", seedFlowchartGraph],
  [
    "business library state",
    "library-state",
    async (fixture: Fixture) =>
      fixture.database.transaction((database) => {
        database
          .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
          .run("business-state", Buffer.from("value"), FIXED_NOW.toISOString());
      }),
  ],
  [
    "recovery markers",
    "pending-operation",
    async (fixture: Fixture) =>
      fixture.database.transaction((database) => {
        database
          .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
          .run(`recovery:${uuid()}`, Buffer.from("value"), FIXED_NOW.toISOString());
      }),
  ],
  ["legacy drafts", "legacy-drafts", seedDraft],
] as const)("blocks %s without returning business content", async (_label, kind, seed) => {
  const fixture = await createFixture();
  await seed(fixture);

  const result = await fixture.inspector.inspect();

  expectBlocker(result, kind);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("绝不能");
  expect(serialized).not.toContain("私密");
  expect(serialized).not.toContain(fixture.root);
  for (const blocker of result.blockers) {
    expect(Number.isSafeInteger(blocker.count)).toBe(true);
    expect(blocker.count).toBeGreaterThan(0);
    expect(Object.isFrozen(blocker)).toBe(true);
  }
});

test("blocks draft UUID directories and unknown draft entries alike", async () => {
  const fixture = await createFixture();
  const drafts = join(fixture.userDataRoot, "drafts");
  await mkdir(join(drafts, uuid()), { recursive: true });
  await writeFile(join(drafts, "unknown-entry"), "unknown");

  const result = await fixture.inspector.inspect();

  expect(result.blockers).toContainEqual({ kind: "legacy-drafts", count: 2 });
});

test("fails closed for unknown library-root files even when known business blockers exist", async () => {
  const fixture = await createFixture();
  await seedPatent(fixture);
  await mkdir(join(fixture.libraryRoot, "assets"));
  await writeFile(join(fixture.libraryRoot, "assets", `${"A".repeat(64)}.asset`), "asset");
  await writeFile(join(fixture.libraryRoot, "assets", `${"B".repeat(64)}.tmp-${uuid()}`), "temp");
  await writeFile(join(fixture.libraryRoot, "unknown-private-file"), "private");

  const result = await fixture.inspector.inspect();

  expect(result).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test("fails closed for an unknown library-root directory", async () => {
  const fixture = await createFixture();
  await mkdir(join(fixture.libraryRoot, "unknown-private-directory"));

  expect(await fixture.inspector.inspect()).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test.each(["unknown-file", "unknown-directory"] as const)(
  "fails closed for an %s in userData",
  async (kind) => {
    const fixture = await createFixture();
    const path = join(fixture.userDataRoot, `pending-private-transaction-${uuid()}`);
    if (kind === "unknown-file") await writeFile(path, "pending");
    else await mkdir(path);

    expect(await fixture.inspector.inspect()).toEqual({
      empty: false,
      blockers: [{ kind: "unreadable-library", count: 1 }],
    });
  },
);

test("allows known Electron userData files and directories", async () => {
  const fixture = await createFixture();
  await writeFile(join(fixture.userDataRoot, "Preferences"), "{}");
  await writeFile(join(fixture.userDataRoot, "lockfile"), "");
  await mkdir(join(fixture.userDataRoot, "Cache"));
  await mkdir(join(fixture.userDataRoot, "Dictionaries"));

  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
});

test("allows an empty plain polish-history directory left by import preparation", async () => {
  const fixture = await createFixture();
  await mkdir(join(fixture.userDataRoot, "text-polish-history"));
  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
});

test("rejects an empty polish-history junction", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.root, "outside-history");
  await mkdir(outside);
  await symlink(outside, join(fixture.userDataRoot, "text-polish-history"), "junction");
  expect(await fixture.inspector.inspect()).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test.each(["file", "directory"])(
  "classifies a polish-history %s as local state, retaining non-empty protection",
  async (kind) => {
    const fixture = await createFixture();
    const history = join(fixture.userDataRoot, "text-polish-history");
    await mkdir(history);
    if (kind === "file") await writeFile(join(history, "history.json"), "{}");
    else await mkdir(join(history, "patent"));
    expect(await fixture.inspector.inspect()).toEqual({
      empty: false,
      blockers: [{ kind: "library-state", count: 1 }],
    });
  },
);

test("ignores WAL lock metadata churn while still inspecting logical database state", async () => {
  const fixture = await createFixture();
  const walPath = resolve(fixture.libraryRoot, "library.sqlite3-wal");
  let walReads = 0;
  const inspector = new EmptyLibraryInspector({
    libraryRoot: fixture.libraryRoot,
    userDataRoot: fixture.userDataRoot,
    applicationDataRoot: fixture.applicationDataRoot,
    database: fixture.database,
    createReparsePointProbe: () => ({ assertSafe: async () => {}, close: async () => {} }),
    fileSystem: {
      lstat: async (path: string) => {
        const info = await lstat(path);
        if (resolve(path) !== walPath) return info;
        walReads += 1;
        return new Proxy(info, {
          get(target, property) {
            if (property === "mtimeMs") return target.mtimeMs + walReads;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    },
  });

  expect(await inspector.inspect()).toEqual({ empty: true, blockers: [] });
});

test("ignores metadata churn in recognized Electron runtime and application log files", async () => {
  const fixture = await createFixture();
  const dipsWalPath = resolve(fixture.userDataRoot, "DIPS-wal");
  const logDirectory = resolve(fixture.userDataRoot, "logs");
  const logPath = resolve(logDirectory, "app.log");
  await writeFile(dipsWalPath, "runtime");
  await mkdir(logDirectory);
  await writeFile(logPath, "runtime log");
  let volatileReads = 0;
  const inspector = new EmptyLibraryInspector({
    libraryRoot: fixture.libraryRoot,
    userDataRoot: fixture.userDataRoot,
    applicationDataRoot: fixture.applicationDataRoot,
    database: fixture.database,
    createReparsePointProbe: () => ({ assertSafe: async () => {}, close: async () => {} }),
    fileSystem: {
      lstat: async (path: string) => {
        const info = await lstat(path);
        if (![dipsWalPath, logDirectory, logPath].includes(resolve(path))) return info;
        volatileReads += 1;
        return new Proxy(info, {
          get(target, property) {
            if (property === "mtimeMs") return target.mtimeMs + volatileReads;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    },
  });

  expect(await inspector.inspect()).toEqual({ empty: true, blockers: [] });
});

test("ignores rebuildable search cache churn without treating it as business data", async () => {
  const fixture = await createFixture();
  const cacheRoot = join(fixture.userDataRoot, "content-search-cache");
  await mkdir(cacheRoot);
  await writeFile(join(cacheRoot, "search.sqlite3"), "rebuildable index");
  let reads = 0;
  const inspector = new EmptyLibraryInspector({
    ...fixture,
    fileSystem: {
      lstat: async (path) => {
        const info = await lstat(path);
        if (path !== cacheRoot) return info;
        return new Proxy(info, {
          get(target, property) {
            if (property === "mtimeMs") return target.mtimeMs + ++reads;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    },
  });
  expect(await inspector.inspect()).toEqual({ empty: true, blockers: [] });
  await seedPatent(fixture);
  expectBlocker(await inspector.inspect(), "patents");
});

test.each(["file", "symlink", "unknown-directory"] as const)(
  "search cache exemption does not allow a %s",
  async (kind) => {
    const fixture = await createFixture();
    const cacheRoot = join(fixture.userDataRoot, "content-search-cache");
    if (kind === "file") await writeFile(cacheRoot, "unexpected file");
    else if (kind === "symlink") await symlink(fixture.root, cacheRoot, "junction");
    else await mkdir(`${cacheRoot}-unknown`);
    expect(await fixture.inspector.inspect()).toEqual({
      empty: false,
      blockers: [{ kind: "unreadable-library", count: 1 }],
    });
  },
);

test("treats the legacy draft migration marker as a pending operation", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.userDataRoot, "legacy-draft-migration.json"),
    JSON.stringify({ formatVersion: 1, importedDrafts: [] }),
  );

  expectBlocker(await fixture.inspector.inspect(), "pending-operation");
});

test("treats pending-data-import.json as a pending operation", async () => {
  const fixture = await createFixture();
  await writeFile(join(fixture.applicationDataRoot, "pending-data-import.json"), "{}");

  expect(await fixture.inspector.inspect()).toEqual({
    empty: false,
    blockers: [{ kind: "pending-operation", count: 1 }],
  });
});

test("does not treat Electron userData as the import-journal location", async () => {
  const fixture = await createFixture();
  await writeFile(join(fixture.userDataRoot, "pending-data-import.json"), "{}");

  expect(await fixture.inspector.inspect()).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test.each(["unknown-file", "unknown-directory"] as const)(
  "fails closed for an %s in application data",
  async (kind) => {
    const fixture = await createFixture();
    const path = join(fixture.applicationDataRoot, `.import-unknown-${uuid()}`);
    if (kind === "unknown-file") await writeFile(path, "pending");
    else await mkdir(path);

    expect(await fixture.inspector.inspect()).toEqual({
      empty: false,
      blockers: [{ kind: "unreadable-library", count: 1 }],
    });
  },
);

test("allows a default Library directory beside an explicitly overridden library root", async () => {
  const fixture = await createFixture();
  await mkdir(join(fixture.applicationDataRoot, "Library"));

  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
});

test("rejects an import staging directory during the initial inspection", async () => {
  const fixture = await createFixture();
  await mkdir(join(dirname(fixture.libraryRoot), `.import-staging-${uuid()}`));

  expect(await fixture.inspector.inspect()).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test("rejects a malformed staging-like sibling of an externally overridden library", async () => {
  const fixture = await createFixture();
  await mkdir(join(dirname(fixture.libraryRoot), ".import-staging-not-a-uuid"));

  expect(await fixture.inspector.inspect()).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test.each(["separate", "nested-library", "nested-default"] as const)(
  "allows only explicitly owned staging for %s layout",
  async (layout) => {
    const fixture = await createFixture(layout);
    const stagingRoot = join(dirname(fixture.libraryRoot), `.import-staging-${uuid()}`);
    await mkdir(stagingRoot);
    await writeFile(join(stagingRoot, "verified-package-entry"), "verified");
    const capability = await createOwnedStagingCapability(stagingRoot);

    expect(await fixture.inspector.inspect({ ownedImportStaging: capability })).toEqual({
      empty: true,
      blockers: [],
    });
    expect((await fixture.inspector.inspect()).empty).toBe(false);
    await mkdir(join(dirname(fixture.libraryRoot), `.import-staging-${uuid()}`));
    expect((await fixture.inspector.inspect({ ownedImportStaging: capability })).empty).toBe(false);
  },
);

test("rejects other import staging directories beside the explicitly owned one", async () => {
  const fixture = await createFixture();
  const stagingRoot = join(dirname(fixture.libraryRoot), `.import-staging-${uuid()}`);
  await mkdir(stagingRoot);
  const capability = await createOwnedStagingCapability(stagingRoot);
  await mkdir(join(dirname(fixture.libraryRoot), `.import-staging-${uuid()}`));

  expect(await fixture.inspector.inspect({ ownedImportStaging: capability })).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test("rejects an owned staging directory replaced after ownership was captured", async () => {
  const fixture = await createFixture();
  const libraryParent = dirname(fixture.libraryRoot);
  const stagingRoot = join(libraryParent, `.import-staging-${uuid()}`);
  await mkdir(stagingRoot);
  const capability = await createOwnedStagingCapability(stagingRoot);
  const secondLibraryParentRead = deferred();
  const resume = deferred();
  let libraryParentReads = 0;
  const inspector = new EmptyLibraryInspector({
    libraryRoot: fixture.libraryRoot,
    userDataRoot: fixture.userDataRoot,
    applicationDataRoot: fixture.applicationDataRoot,
    database: fixture.database,
    createReparsePointProbe: () => ({ assertSafe: async () => {}, close: async () => {} }),
    fileSystem: {
      readdir: async (path: string): Promise<Dirent[]> => {
        if (resolve(path) === resolve(libraryParent)) {
          libraryParentReads += 1;
          if (libraryParentReads === 2) {
            secondLibraryParentRead.resolve();
            await resume.promise;
          }
        }
        return await readdir(path, { withFileTypes: true });
      },
    },
  });
  const inspection = inspector.inspect({ ownedImportStaging: capability });
  await secondLibraryParentRead.promise;
  await rm(stagingRoot, { recursive: true });
  await mkdir(stagingRoot);
  resume.resolve();

  expect(await inspection).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test("rejects an owned staging path that is a junction/reparse point", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.root, "outside-staging");
  const stagingRoot = join(dirname(fixture.libraryRoot), `.import-staging-${uuid()}`);
  await mkdir(outside);
  await symlink(outside, stagingRoot, "junction");
  const capability = await createOwnedStagingCapability(stagingRoot);

  expect(await fixture.inspector.inspect({ ownedImportStaging: capability })).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test("rejects an owned staging capability under the wrong parent", async () => {
  const fixture = await createFixture();
  const stagingRoot = join(fixture.applicationDataRoot, `.import-staging-${uuid()}`);
  await mkdir(stagingRoot);
  const capability = await createOwnedStagingCapability(stagingRoot);

  expect(await fixture.inspector.inspect({ ownedImportStaging: capability })).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test.each([Buffer.alloc(0), Buffer.from("rollback journal")])(
  "fails closed whenever a rollback journal exists in a WAL library",
  async (contents) => {
    const fixture = await createFixture();
    await writeFile(join(fixture.libraryRoot, "library.sqlite3-journal"), contents);

    expect(await fixture.inspector.inspect()).toEqual({
      empty: false,
      blockers: [{ kind: "unreadable-library", count: 1 }],
    });
  },
);

test.each([
  [
    "foreign-key violations",
    async (fixture: Fixture) => {
      fixture.database.read((database) => {
        database.exec("PRAGMA foreign_keys=OFF");
        database
          .prepare(
            `INSERT INTO patent_figures(
              patent_id, figure_id, asset_id, position, width_mm, explanation, flowchart_link
            ) VALUES (?, ?, ?, 0, 30, '', NULL)`,
          )
          .run(uuid(), uuid(), uuid());
        database.exec("PRAGMA foreign_keys=ON");
      });
    },
  ],
  [
    "schema fingerprint changes",
    async (fixture: Fixture) =>
      fixture.database.read((database) =>
        database.exec("ALTER TABLE patents ADD COLUMN secret TEXT"),
      ),
  ],
  [
    "unclassified business tables",
    async (fixture: Fixture) =>
      fixture.database.read((database) =>
        database.exec(
          "CREATE TABLE future_business_data(id INTEGER PRIMARY KEY) STRICT; INSERT INTO future_business_data VALUES (1)",
        ),
      ),
  ],
] as const)("fails closed for %s", async (_label, mutate) => {
  const fixture = await createFixture();
  await mutate(fixture);

  expect(await fixture.inspector.inspect()).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test("fails closed when the required database is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "empty-library-missing-database-"));
  roots.push(root);
  const libraryRoot = join(root, "Library");
  const userDataRoot = join(root, "user-data");
  const applicationDataRoot = join(root, "application-data");
  await mkdir(libraryRoot);
  await mkdir(userDataRoot);
  await mkdir(applicationDataRoot);

  const result = await new EmptyLibraryInspector({
    libraryRoot,
    userDataRoot,
    applicationDataRoot,
    database: undefined as unknown as LibraryDatabase,
    createReparsePointProbe: () => ({ assertSafe: async () => {}, close: async () => {} }),
  }).inspect();

  expect(result).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test("a recognized disposable export copy does not count as installed user data", async () => {
  const fixture = await createFixture();
  const task = await createOwnedExportTask(fixture.applicationDataRoot);
  await writeFile(join(task.path, "frozen.sqlite3"), "synthetic frozen bytes");
  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
});

test("a cleanup credential remains recognized after root deletion and retires on retry", async () => {
  const fixture = await createFixture();
  const task = await createOwnedExportTask(fixture.applicationDataRoot);
  const record = `${task.path}.cleanup-record.json`;
  await writeFile(
    record,
    JSON.stringify({
      version: 1,
      taskPath: task.path,
      taskIdentity: task.identity,
      markerSecret: task.markerSecret,
    }),
  );
  await rm(task.path, { recursive: true });
  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
  expect(
    await recoverAbandonedExportTasks(fixture.applicationDataRoot, { exclusiveStartup: true }),
  ).toEqual({ cleaned: 1, pending: 0 });
  await expect(lstat(record)).rejects.toMatchObject({ code: "ENOENT" });
});

test("early interrupted owner initialization does not block an actually empty library", async () => {
  const fixture = await createFixture();
  const preparing = join(
    fixture.applicationDataRoot,
    `.full-data-export-init-${randomUUID()}-${"a".repeat(64)}`,
  );
  await mkdir(preparing);
  await writeFile(join(preparing, ".full-data-export-owner"), "a".repeat(17));
  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
});

test("an export-looking directory without trustworthy ownership still fails closed", async () => {
  const fixture = await createFixture();
  const unknown = join(fixture.applicationDataRoot, `.full-data-export-${randomUUID()}`);
  await mkdir(unknown);
  await writeFile(join(unknown, "foreign.txt"), "unrecognized user bytes");
  expect(await fixture.inspector.inspect()).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test("does not open or mutate a closed library when no runtime database is supplied", async () => {
  const fixture = await createFixture();
  fixture.database.close();
  const before = await readdir(fixture.libraryRoot);

  const result = await new EmptyLibraryInspector({
    libraryRoot: fixture.libraryRoot,
    userDataRoot: fixture.userDataRoot,
    applicationDataRoot: fixture.applicationDataRoot,
    database: undefined as unknown as LibraryDatabase,
    createReparsePointProbe: () => ({ assertSafe: async () => {}, close: async () => {} }),
  }).inspect();

  expect(result).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
  expect(await readdir(fixture.libraryRoot)).toEqual(before);
});

test("fails closed for a corrupt database without exposing paths, SQL or stacks", async () => {
  const fixture = await createFixture();
  fixture.database.close();
  await writeFile(join(fixture.libraryRoot, "library.sqlite3"), "not a sqlite database");

  const result = await new EmptyLibraryInspector({
    libraryRoot: fixture.libraryRoot,
    userDataRoot: fixture.userDataRoot,
    applicationDataRoot: fixture.applicationDataRoot,
    database: undefined as unknown as LibraryDatabase,
    createReparsePointProbe: () => ({ assertSafe: async () => {}, close: async () => {} }),
  }).inspect();

  expect(result).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(fixture.root);
  expect(serialized).not.toMatch(/SELECT|SQL|stack/iu);
});

test("converts filesystem read errors to one sanitized unreadable blocker", async () => {
  const fixture = await createFixture();
  const secret = `${fixture.root} SELECT private_title FROM patents stack`;
  const result = await new EmptyLibraryInspector({
    libraryRoot: fixture.libraryRoot,
    userDataRoot: fixture.userDataRoot,
    applicationDataRoot: fixture.applicationDataRoot,
    database: fixture.database,
    fileSystem: {
      readdir: async () => {
        throw new Error(secret);
      },
    },
  }).inspect();

  expect(result).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(fixture.root);
});

test("rejects a junction/reparse point instead of traversing it", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.root, "outside-assets");
  await mkdir(outside);
  await symlink(outside, join(fixture.libraryRoot, "assets"), "junction");

  expect(await fixture.inspector.inspect()).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test("fails closed for a generic Windows reparse-point attribute", async () => {
  const fixture = await createFixture();
  const databasePath = join(fixture.libraryRoot, "library.sqlite3");
  const result = await new EmptyLibraryInspector({
    libraryRoot: fixture.libraryRoot,
    userDataRoot: fixture.userDataRoot,
    applicationDataRoot: fixture.applicationDataRoot,
    database: fixture.database,
    createReparsePointProbe: () => ({
      assertSafe: async (path) => {
        if (resolve(path) === resolve(databasePath)) throw new Error("reparse");
      },
      close: async () => {},
    }),
  }).inspect();

  expect(result).toEqual({
    empty: false,
    blockers: [{ kind: "unreadable-library", count: 1 }],
  });
});

test.each(["database", "filesystem"] as const)(
  "fails closed when %s state changes between the two inspections",
  async (kind) => {
    const fixture = await createFixture();
    const secondLibraryRead = deferred();
    const resume = deferred();
    let libraryReads = 0;
    const frozenLibraryStats = new Map<string, Stats>();
    const inspector = new EmptyLibraryInspector({
      libraryRoot: fixture.libraryRoot,
      userDataRoot: fixture.userDataRoot,
      applicationDataRoot: fixture.applicationDataRoot,
      database: fixture.database,
      createReparsePointProbe: () => ({ assertSafe: async () => {}, close: async () => {} }),
      fileSystem: {
        lstat: async (path: string) => {
          if (kind !== "database" || !resolve(path).startsWith(resolve(fixture.libraryRoot))) {
            return await lstat(path);
          }
          const normalized = resolve(path);
          const existing = frozenLibraryStats.get(normalized);
          if (existing !== undefined) return existing;
          const info = await lstat(path);
          frozenLibraryStats.set(normalized, info);
          return info;
        },
        readdir: async (path: string): Promise<Dirent[]> => {
          if (resolve(path) === resolve(fixture.libraryRoot)) {
            libraryReads += 1;
            if (libraryReads === 2) {
              secondLibraryRead.resolve();
              await resume.promise;
            }
          }
          return await readdir(path, { withFileTypes: true });
        },
      },
    });
    const inspection = inspector.inspect();
    await secondLibraryRead.promise;
    if (kind === "database") {
      const writer = new DatabaseSync(join(fixture.libraryRoot, "library.sqlite3"));
      try {
        writer
          .prepare("INSERT INTO library_state(key, value, updated_at) VALUES (?, ?, ?)")
          .run("race-state", Buffer.from("1"), FIXED_NOW.toISOString());
      } finally {
        writer.close();
      }
    } else {
      await writeFile(join(fixture.libraryRoot, "appeared-during-inspection"), "race");
    }
    resume.resolve();

    expect(await inspection).toEqual({
      empty: false,
      blockers: [{ kind: "unreadable-library", count: 1 }],
    });
  },
);

test("automation ledger and library identity do not turn an unused library into customer data", async () => {
  const fixture = await createFixture();
  fixture.database.transaction((db) => {
    db.prepare("INSERT INTO automation_operations VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)").run(
      "client",
      "status",
      "request",
      "operation",
      "hash",
      "committed",
      "{}",
      "now",
    );
    db.prepare("INSERT INTO library_state VALUES (?, ?, ?)").run(
      "automation:library-id",
      encodeJson("library-id"),
      "now",
    );
    db.prepare("INSERT INTO library_state VALUES (?, ?, ?)").run(
      "automation:baseline:client:patent",
      encodeJson({ books: [] }),
      "now",
    );
    db.prepare("INSERT INTO library_state VALUES (?, ?, ?)").run(
      "automation:task:task-id",
      encodeJson({ version: 1, clientId: "client", patentIds: [] }),
      "now",
    );
  });
  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
});

test("derived search cache and a valid external automation handoff do not block an unused library", async () => {
  const fixture = await createFixture();
  await mkdir(join(fixture.userDataRoot, "content-search-cache", "index"), { recursive: true });
  await writeFile(
    join(fixture.userDataRoot, "content-search-cache", "index", "content.sqlite3"),
    "derived cache",
  );
  await mkdir(join(fixture.applicationDataRoot, "automation-transfer"));
  const receipt = join(fixture.applicationDataRoot, "automation-transfer", "handoff.json");
  await writeFile(
    receipt,
    JSON.stringify({
      importId: uuid(),
      libraryRoot: fixture.libraryRoot,
      phase: "scheduled",
      updatedAt: new Date().toISOString(),
    }),
  );
  const inspector = new EmptyLibraryInspector(fixture);
  expect((await inspector.inspect()).empty).toBe(true);
  await writeFile(
    join(fixture.applicationDataRoot, "automation-transfer", "unknown"),
    "preserve me",
  );
  expect((await inspector.inspect()).empty).toBe(false);
});

test("dismissing onboarding does not turn an unused library into custom settings", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.userDataRoot, "settings.json"),
    JSON.stringify({ ...DEFAULT_APP_SETTINGS, welcomeCompleted: true }),
  );
  expect((await fixture.inspector.inspect()).empty).toBe(true);
});

test("usage counters are local runtime state and do not make an unused library nonempty", async () => {
  const fixture = await createFixture();
  await writeFile(join(fixture.userDataRoot, "usage-statistics.json"), '{"enabled":false}');
  const result = await fixture.inspector.inspect();
  expect(result.empty).toBe(true);
});

test("first-use agreement consent is local state, not patent data blocking CLI transfer", async () => {
  const fixture = await createFixture();
  const path = join(fixture.userDataRoot, "agreement-consent.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      appVersion: "test",
      termsVersion: "test",
      privacyVersion: "test",
      statisticsNoticeVersion: null,
      everStatisticsConsent: false,
    }),
  );
  expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
  await writeFile(path, '{"not":"an agreement record"}');
  expect((await fixture.inspector.inspect()).empty).toBe(false);
});

test.each(["nested-library", "nested-default"] as const)(
  "inspects configured %s directories without hiding unknown library artifacts",
  async (layout) => {
    const fixture = await createFixture(layout);
    expect(await fixture.inspector.inspect()).toEqual({ empty: true, blockers: [] });
    await writeFile(join(fixture.libraryRoot, "unknown-transaction"), "preserve");
    expect(await fixture.inspector.inspect()).toEqual({
      empty: false,
      blockers: [{ kind: "unreadable-library", count: 1 }],
    });
  },
);
