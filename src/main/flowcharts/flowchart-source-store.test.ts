import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import { FlowchartSourceStore } from "./flowchart-source-store.js";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "flowchart-source-store-"));
  roots.push(root);
  const prepared = await new LibraryMigrationService(root).prepare();
  if (prepared.status !== "ready") throw new Error("library setup failed");
  const patentId = randomUUID();
  prepared.database.read((database) =>
    database
      .prepare(
        "INSERT INTO patents VALUES (?, NULL, NULL, 'invention', 1, 0, 'now', 'now', NULL, 'healthy', NULL)",
      )
      .run(patentId),
  );
  return { database: prepared.database, patentId };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("stores source and metadata as ordinary data and loads a verified copy", async () => {
  const { database, patentId } = await setup();
  using _owned = database;
  const projectId = randomUUID();
  const store = new FlowchartSourceStore({
    database,
    now: () => new Date("2026-08-11T00:00:00.000Z"),
  });
  const source = Buffer.from('<mxfile><diagram id="p1" name="页面一"/></mxfile>', "utf8");

  const saved = store.appendRevision({
    patentId,
    projectId,
    expectedProjectRevision: 0,
    source,
    metadata: { name: "敏感工程名", pageCount: 1, lastPageId: "p1" },
  });
  const databaseBytes = database.read((raw) =>
    Buffer.concat(
      (
        raw
          .prepare("SELECT source AS value FROM patent_flowchart_source_revisions")
          .all() as Array<{ value: Uint8Array }>
      ).map((row) => Buffer.from(row.value)),
    ),
  );
  const metadataBytes = database.read((raw) =>
    Buffer.from(
      (
        raw.prepare("SELECT metadata AS value FROM patent_flowcharts").get() as {
          value: Uint8Array;
        }
      ).value,
    ),
  );
  expect(databaseBytes.toString("utf8")).toContain("mxfile");
  expect(metadataBytes.toString("utf8")).toContain("敏感工程名");
  expect(saved.revision).toBe(0);
  expect(store.loadCurrent(patentId, projectId)).toEqual(saved);
  expect(saved.source).not.toBe(source);
});

test("deduplicates identical source and atomically advances a changed source", async () => {
  const { database, patentId } = await setup();
  using _owned = database;
  const projectId = randomUUID();
  const ids = [randomUUID(), randomUUID()];
  const store = new FlowchartSourceStore({
    database,
    randomUUID: () => ids.shift() as string,
  });
  const metadata = { name: "工程", pageCount: 1, lastPageId: "p1" };
  const first = store.appendRevision({
    patentId,
    projectId,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    metadata,
  });
  expect(
    store.appendRevision({
      patentId,
      projectId,
      expectedProjectRevision: 0,
      source: first.source,
      metadata,
    }),
  ).toEqual(first);
  const second = store.appendRevision({
    patentId,
    projectId,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1">changed</diagram></mxfile>'),
    metadata,
  });
  expect(second.revision).toBe(1);
  expect(
    database.read(
      (raw) =>
        (
          raw.prepare("SELECT count(*) AS count FROM patent_flowchart_source_revisions").get() as {
            count: number;
          }
        ).count,
    ),
  ).toBe(2);
});

test("rejects stale revisions and authenticated corruption without changing current", async () => {
  const { database, patentId } = await setup();
  using _owned = database;
  const projectId = randomUUID();
  const store = new FlowchartSourceStore({ database });
  const metadata = { name: "工程", pageCount: 1, lastPageId: "p1" };
  store.appendRevision({
    patentId,
    projectId,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    metadata,
  });
  expect(() =>
    store.appendRevision({
      patentId,
      projectId,
      expectedProjectRevision: 4,
      source: Buffer.from('<mxfile><diagram id="p1">x</diagram></mxfile>'),
      metadata,
    }),
  ).toThrow(/revision|版本/iu);
  database.read((raw) =>
    raw
      .prepare("UPDATE patent_flowchart_source_revisions SET source_sha256 = ?")
      .run("A".repeat(64)),
  );
  expect(() => store.loadCurrent(patentId, projectId)).toThrow(/hash|摘要|corrupt|损坏/iu);
});

test("collects only revisions not retained by current, snapshots, or edit log", async () => {
  const { database, patentId } = await setup();
  using _owned = database;
  const projectId = randomUUID();
  const store = new FlowchartSourceStore({ database });
  const metadata = { name: "工程", pageCount: 1, lastPageId: "p1" };
  const first = store.appendRevision({
    patentId,
    projectId,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    metadata,
  });
  const second = store.appendRevision({
    patentId,
    projectId,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1">new</diagram></mxfile>'),
    metadata,
  });
  database.transaction((raw) => {
    raw
      .prepare(
        "INSERT INTO snapshots (patent_id, revision, model_version, payload, content_hash, created_at, source) VALUES (?, 0, 2, ?, 'hash', 'now', 'automatic')",
      )
      .run(patentId, Buffer.from("snapshot"));
    raw
      .prepare("INSERT INTO snapshot_flowchart_revisions VALUES (?, 0, ?, ?)")
      .run(patentId, projectId, first.sourceRevisionId);
  });
  expect(store.collectUnreferenced(patentId)).toBe(0);
  database.transaction((raw) => {
    raw.prepare("DELETE FROM snapshots WHERE patent_id = ? AND revision = 0").run(patentId);
    const operationId = randomUUID();
    raw
      .prepare("INSERT INTO edit_log VALUES (?, ?, 0, 1, 2, ?, 'hash', 'now')")
      .run(operationId, patentId, Buffer.from("edit"));
    raw
      .prepare("INSERT INTO edit_log_flowchart_revisions VALUES (?, ?, ?)")
      .run(operationId, projectId, first.sourceRevisionId);
  });
  expect(store.collectUnreferenced(patentId)).toBe(0);
  database.read((raw) => raw.prepare("DELETE FROM edit_log WHERE patent_id = ?").run(patentId));
  expect(store.collectUnreferenced(patentId)).toBe(1);
  expect(
    database.read((raw) =>
      raw
        .prepare(
          "SELECT source_revision_id FROM patent_flowchart_source_revisions WHERE source_revision_id = ?",
        )
        .get(first.sourceRevisionId),
    ),
  ).toBeUndefined();
  expect(store.loadCurrent(patentId, projectId)).toEqual(second);
});

test("disposes idempotently and rejects use after disposal", async () => {
  const { database, patentId } = await setup();
  using _owned = database;
  const projectId = randomUUID();
  const store = new FlowchartSourceStore({ database });
  store.appendRevision({
    patentId,
    projectId,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="p1"/></mxfile>'),
    metadata: { name: "工程", pageCount: 1, lastPageId: "p1" },
  });

  store.dispose();
  store.dispose();

  expect(() => store.loadCurrent(patentId, projectId)).toThrow(/disposed|closed/iu);
  expect(() => store.list(patentId)).toThrow(/disposed|closed/iu);
});
