import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { ContentSearchRequestSchema } from "../../shared/library/content-search.js";
import { ContentSearchService } from "./content-search-service.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function setup(stepMs = 15, requestTimeoutMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "content-search-"));
  const source = new DatabaseSync(join(root, "library.sqlite3"));
  source.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE patents(patent_id TEXT PRIMARY KEY, revision INTEGER, modified_at TEXT, deleted_at TEXT, recovery_state TEXT, patent_type TEXT);
    CREATE TABLE patent_books(patent_id TEXT, kind TEXT, document_json BLOB);
    INSERT INTO patents VALUES('p1', 1, 'one', NULL, 'healthy', 'invention');`);
  const update = (text: string, revision: number) => {
    source
      .prepare("UPDATE patents SET revision=?, modified_at=? WHERE patent_id='p1'")
      .run(revision, String(revision));
    source.exec("DELETE FROM patent_books");
    source
      .prepare("INSERT INTO patent_books VALUES('p1','description',?)")
      .run(
        Buffer.from(
          JSON.stringify({ content: [{ type: "paragraph", content: [{ type: "text", text }] }] }),
        ),
      );
  };
  update("中文螺旋输送装置", 1);
  const service = new ContentSearchService({
    libraryRoot: root,
    cacheRoot: join(root, "cache"),
    idleMs: 120,
    stepMs,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
  cleanups.push(async () => {
    await service.close();
    source.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { service, source, update, root };
}

function cacheFolder(root: string) {
  const folder = readdirSync(join(root, "cache"))[0];
  if (!folder) throw new Error("Expected search cache folder");
  return folder;
}

it("searches visible table names and notes but not disabled annotations", async () => {
  const { service, source } = setup(2);
  source.prepare("UPDATE patent_books SET document_json=?").run(
    Buffer.from(
      JSON.stringify({
        content: [
          {
            type: "table",
            id: "table-1",
            tableNameEnabled: true,
            tableName: "耐高温循环测试结果",
            tableNoteEnabled: true,
            tableNote: "测试环境温度为三十五摄氏度",
            rows: [],
          },
          {
            type: "table",
            id: "table-2",
            tableNameEnabled: false,
            tableName: "不可搜索的隐藏表名",
            tableNoteEnabled: false,
            tableNote: "不可搜索的隐藏补充说明",
            rows: [],
          },
        ],
      }),
    ),
  );
  await service.request({ action: "start" });
  await finish(service);
  const name = await service.request({ action: "search", query: "耐高温循环" });
  expect(name.hits?.[0]?.books[0]?.count).toBe(1);
  expect(name.hits?.[0]?.books[0]?.locations?.[0]).toMatchObject({
    nodeId: "table-1",
    annotation: "name",
  });
  const note = await service.request({ action: "search", query: "三十五摄氏度" });
  expect(note.hits?.[0]?.books[0]?.locations?.[0]).toMatchObject({
    nodeId: "table-1",
    annotation: "note",
  });
  expect((await service.request({ action: "search", query: "不可搜索" })).hits).toEqual([]);
});

it("keeps original Unicode offsets and uses the editor's literal case matching", async () => {
  const { service, update } = setup(2);
  update("İX µ μ ^w", 2);
  await service.request({ action: "start" });
  await finish(service);
  const result = await service.request({ action: "search", query: "X" });
  expect(result.hits?.[0]?.books[0]?.locations?.[0]?.queryOffset).toBe(1);
  expect((await service.request({ action: "search", query: "μ" })).hits?.[0]?.books[0]?.count).toBe(
    2,
  );
  expect(
    (await service.request({ action: "search", query: "^w" })).hits?.[0]?.books[0]?.count,
  ).toBe(1);
});

it("bounds a paused request and keeps the service usable after timeout", async () => {
  const { service } = setup(2, 500);
  await service.request({ action: "status" });
  const release = service.beginOperation();
  try {
    await expect(
      service.request({ action: "search", query: "螺旋", searchId: "timeout" }),
    ).rejects.toThrow("正文检索请求超时");
  } finally {
    release();
  }
  expect((await service.request({ action: "status" })).error).toBe(false);
});

it("invalidates the old cache format and sweeps deleted entries on restart", async () => {
  const { service, source, root } = setup(2);
  await service.request({ action: "start" });
  await finish(service);
  await service.close();
  const folder = cacheFolder(root);
  const path = join(root, "cache", folder, "content-v1.sqlite3");
  const cache = new DatabaseSync(path);
  cache.exec("UPDATE state SET value='2' WHERE key='formatVersion'");
  cache.close();
  writeFileSync(path + ".damaged-old", "old body diagnostic");
  const reopened = new ContentSearchService({
    libraryRoot: root,
    cacheRoot: join(root, "cache"),
    stepMs: 2,
  });
  cleanups.unshift(() => reopened.close());
  expect((await reopened.request({ action: "search", query: "螺旋" })).hits).toEqual([]);
  expect(readdirSync(join(root, "cache", folder))).not.toContain("content-v1.sqlite3.damaged-old");
  await reopened.request({ action: "start" });
  await finish(reopened);
  expect((await reopened.request({ action: "search", query: "螺旋" })).hits).toHaveLength(1);
  await reopened.close();
  source.exec("DELETE FROM patent_books; DELETE FROM patents");
  const final = new ContentSearchService({ libraryRoot: root, cacheRoot: join(root, "cache") });
  cleanups.unshift(() => final.close());
  expect((await final.request({ action: "status" })).indexedCount).toBe(0);
  const inspected = new DatabaseSync(path);
  try {
    expect(inspected.prepare("SELECT count(*) AS n FROM entries").get()?.n).toBe(0);
  } finally {
    inspected.close();
  }
});

it("returns bounded first and continuation pages from 5000 indexed patents", async () => {
  const { service, source, root } = setup(2);
  await service.request({ action: "status" });
  const folder = cacheFolder(root);
  const cache = new DatabaseSync(join(root, "cache", folder, "content-v1.sqlite3"));
  source.exec("BEGIN");
  cache.exec("BEGIN");
  try {
    for (let index = 0; index < 5000; index++) {
      const id = `a${String(index).padStart(4, "0")}`;
      source.prepare("INSERT INTO patents VALUES(?,1,'one',NULL,'healthy','invention')").run(id);
      cache
        .prepare("INSERT INTO entries VALUES(?,'1:one',?)")
        .run(id, JSON.stringify([{ kind: "description", text: "共同关键词" }]));
    }
    source.exec("COMMIT");
    cache.exec("COMMIT");
  } finally {
    cache.close();
  }
  const started = performance.now();
  const first = await service.request({ action: "search", query: "共同关键词" });
  const firstMs = performance.now() - started;
  const continued = performance.now();
  const next = await service.request({
    action: "search",
    query: "共同关键词",
    after: first.nextCursor ?? undefined,
    indexVersion: first.indexVersion,
  });
  const nextMs = performance.now() - continued;
  process.stdout.write(
    `5000 patents: first page ${firstMs.toFixed(1)}ms; continuation ${nextMs.toFixed(1)}ms\n`,
  );
  expect(first.hits).toHaveLength(30);
  expect(next.hits).toHaveLength(30);
  expect(first.nextCursor).toBe("a0029");
  expect(next.hits?.[0]?.patentId).toBe("a0030");
  expect(firstMs).toBeLessThan(2000);
  expect(nextMs).toBeLessThan(2000);
});
async function finish(service: ContentSearchService) {
  await expect
    .poll(async () => (await service.request({ action: "status" })).running, { timeout: 4000 })
    .toBe(false);
}

it("continues detail pages beyond 100000 occurrences through the IPC request schema", async () => {
  const { service, update } = setup(2);
  update("词".repeat(100080), 2);
  await service.request({ action: "start" });
  await finish(service);
  const allOccurrences: number[] = [];
  let offset: number | null = 99990;
  while (offset !== null) {
    const request = ContentSearchRequestSchema.parse({
      action: "search-details",
      query: "词",
      patentId: "p1",
      offset,
    });
    const result = await service.request(request);
    const book = result.hits?.[0]?.books[0];
    expect(book?.count).toBe(100080);
    expect(book?.snippets.length).toBeLessThanOrEqual(30);
    allOccurrences.push(...(book?.locations?.map((location) => location.occurrence) ?? []));
    if (result.hasMore) expect(result.nextOffset).toBeGreaterThan(offset);
    offset = result.nextOffset ?? null;
  }
  expect(allOccurrences).toEqual(Array.from({ length: 90 }, (_, i) => 99990 + i));
});

it("indexes small five-book libraries without a fixed wait for every book", async () => {
  const { service, source } = setup(500);
  for (let i = 0; i < 10; i++) {
    addPatent(source, `fast-${i}`);
    for (const kind of ["claims", "abstract", "description-drawings", "abstract-drawing"])
      source
        .prepare("INSERT INTO patent_books VALUES(?,?,?)")
        .run(`fast-${i}`, kind, Buffer.from('{"content":[]}'));
  }
  const started = performance.now();
  await service.request({ action: "start" });
  await finish(service);
  expect(performance.now() - started).toBeLessThan(2000);
});

function addPatent(source: DatabaseSync, id: string, type = "invention", text = "共同关键词") {
  source.prepare("INSERT INTO patents VALUES(?,1,'one',NULL,'healthy',?)").run(id, type);
  source
    .prepare("INSERT INTO patent_books VALUES(?,'description',?)")
    .run(
      id,
      Buffer.from(
        JSON.stringify({ content: [{ type: "paragraph", content: [{ type: "text", text }] }] }),
      ),
    );
}

it("reports actual index coverage after an empty library gains a patent", async () => {
  const { service, source } = setup(2);
  source.exec("DELETE FROM patent_books; DELETE FROM patents");
  await service.request({ action: "start" });
  await finish(service);
  addPatent(source, "new-patent");
  expect(await service.request({ action: "status" })).toMatchObject({
    indexedCount: 0,
    pendingCount: 1,
  });
});

it("does not report damaged source books as successful indexing", async () => {
  const { service, source } = setup(2);
  source.exec("UPDATE patent_books SET document_json='broken'");
  await service.request({ action: "start" });
  await finish(service);
  expect(await service.request({ action: "status" })).toMatchObject({
    indexPhase: "failed",
    failedCount: 1,
    indexedCount: 0,
    updatedAt: null,
  });
});

it("does not concatenate text across hard breaks, figures or formulas", async () => {
  const { service, source } = setup(2);
  for (const type of [
    "hard-break",
    "inline-figure",
    "inline-formula",
    "page-break",
    "chemical-structure",
  ])
    addPatent(source, type);
  source.prepare("UPDATE patent_books SET document_json=? WHERE patent_id=?").run(
    Buffer.from(
      JSON.stringify({
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "甲" },
              { type: "hard-break" },
              { type: "text", text: "乙" },
            ],
          },
        ],
      }),
    ),
    "p1",
  );
  for (const type of [
    "hard-break",
    "inline-figure",
    "inline-formula",
    "page-break",
    "chemical-structure",
  ])
    source.prepare("UPDATE patent_books SET document_json=? WHERE patent_id=?").run(
      Buffer.from(
        JSON.stringify({
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "甲" }, { type }, { type: "text", text: "乙" }],
            },
          ],
        }),
      ),
      type,
    );
  await service.request({ action: "start" });
  await finish(service);
  expect((await service.request({ action: "search", query: "甲乙" })).hits).toEqual([]);
  expect((await service.request({ action: "search", query: "甲 乙" })).hits).toEqual([]);
});

it("rejects detail continuation from a replaced index revision", async () => {
  const { service, update } = setup(2);
  update("关键词".repeat(35), 2);
  await service.request({ action: "start" });
  await finish(service);
  const first = await service.request({
    action: "search-details",
    query: "关键词",
    patentId: "p1",
  });
  update("新增关键词" + "关键词".repeat(35), 3);
  await service.request({ action: "start" });
  await finish(service);
  const next = await service.request({
    action: "search-details",
    query: "关键词",
    patentId: "p1",
    offset: 30,
    indexVersion: first.indexVersion,
  });
  expect(next).toMatchObject({ versionChanged: true, hits: [], hasMore: false });
});

it("removes permanently deleted plaintext during maintenance", async () => {
  const { service, source, root } = setup(2);
  await service.request({ action: "start" });
  await finish(service);
  source.exec("DELETE FROM patent_books; DELETE FROM patents");
  await service.request({ action: "start" });
  await finish(service);
  const folder = cacheFolder(root);
  const cache = new DatabaseSync(join(root, "cache", folder, "content-v1.sqlite3"));
  try {
    expect(cache.prepare("SELECT count(*) AS n FROM entries").get()?.n).toBe(0);
  } finally {
    cache.close();
  }
});

it("clears cached plaintext and damaged copies before deletion while maintenance is paused", async () => {
  const { service, source, root, update } = setup(2);
  const marker = "PRIVACY_SEARCH_CACHE_MARKER_".repeat(12);
  update(marker, 2);
  await service.request({ action: "start" });
  await finish(service);
  const folder = cacheFolder(root);
  const path = join(root, "cache", folder, "content-v1.sqlite3");
  writeFileSync(path + ".damaged-123", marker);
  expect(readFileSync(path).includes(Buffer.from(marker))).toBe(true);
  const release = await service.preparePermanentDelete("p1");
  try {
    expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false);
    expect(
      readdirSync(join(root, "cache", folder)).some((name) => name.includes(".damaged-")),
    ).toBe(false);
    source.exec("DELETE FROM patent_books; DELETE FROM patents");
  } finally {
    release();
  }
});

it("fails cache deletion visibly and releases the pause so source deletion can be refused", async () => {
  const { service, root, source } = setup(2);
  await service.request({ action: "start" });
  await finish(service);
  const folder = cacheFolder(root);
  const cache = new DatabaseSync(join(root, "cache", folder, "content-v1.sqlite3"));
  cache.exec(
    "CREATE TRIGGER deny_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT,'blocked'); END;",
  );
  cache.close();
  await expect(service.preparePermanentDelete("p1")).rejects.toThrow("正文缓存清除失败");
  expect(source.prepare("SELECT patent_id FROM patents WHERE patent_id='p1'").get()).toBeDefined();
  expect((await service.request({ action: "status" })).paused).toBe(false);
});

it("reports terminal worker read failures without querying broken metadata again", async () => {
  const { service, source } = setup(50);
  await service.request({ action: "start" });
  source.exec("DROP TABLE patents");
  await finish(service);
  expect(await service.request({ action: "status" })).toMatchObject({
    indexPhase: "failed",
    running: false,
    error: true,
    updatedAt: null,
  });
});

it("preserves indexed entries and reports cancellation when stopped", async () => {
  const { service } = setup(2);
  await service.request({ action: "start" });
  await finish(service);
  await service.request({ action: "start" });
  expect(await service.request({ action: "stop" })).toMatchObject({
    indexPhase: "cancelled",
    running: false,
    indexedCount: 1,
  });
  expect((await service.request({ action: "search", query: "螺旋" })).hits).toHaveLength(1);
});

it("applies type filtering before pagination and detects unindexed records beyond the first page", async () => {
  const { service, source } = setup(2);
  for (let i = 0; i < 35; i++) addPatent(source, `a${String(i).padStart(3, "0")}`);
  addPatent(source, "zz-utility", "utility-model");
  await service.request({ action: "start" });
  await finish(service);
  const filtered = await service.request({
    action: "search",
    query: "共同关键词",
    patentType: "utility-model",
  });
  expect(filtered.hits?.map((h) => h.patentId)).toEqual(["zz-utility"]);
  addPatent(source, "zzz-not-indexed");
  const page = await service.request({ action: "search", query: "共同关键词" });
  expect(page.hasMore).toBe(true);
  expect(page.incomplete).toBe(true);
});

it("uses a stable cursor when an earlier result disappears between pages", async () => {
  const { service, source } = setup(2);
  for (let i = 0; i < 35; i++) addPatent(source, `a${String(i).padStart(3, "0")}`);
  await service.request({ action: "start" });
  await finish(service);
  const first = await service.request({ action: "search", query: "共同关键词" });
  expect(first.nextCursor).toBe("a029");
  source.prepare("UPDATE patents SET deleted_at='now' WHERE patent_id='a000'").run();
  const next = await service.request({
    action: "search",
    query: "共同关键词",
    after: first.nextCursor ?? undefined,
  });
  expect(next.hits?.map((h) => h.patentId)).toEqual(["a030", "a031", "a032", "a033", "a034"]);
});

it("loads all matches for one patent in bounded detail pages", async () => {
  const { service, update } = setup(2);
  update(
    Array.from({ length: 35 }, (_, index) => `第${index + 1}处关键词匹配内容。`).join("\n"),
    2,
  );
  await service.request({ action: "start" });
  await finish(service);

  const preview = await service.request({ action: "search", query: "关键词" });
  expect(preview.hits?.[0]?.books[0]).toMatchObject({ count: 35 });
  expect(preview.hits?.[0]?.books[0]?.snippets).toHaveLength(3);
  expect(preview.hits?.[0]?.books[0]?.locations?.map((item) => item.occurrence)).toEqual([0, 1, 2]);

  const first = await service.request({
    action: "search-details",
    query: "关键词",
    patentId: "p1",
  });
  expect(first.hits?.[0]?.books[0]?.snippets).toHaveLength(30);
  expect(first.hasMore).toBe(true);
  expect(first.nextOffset).toBe(30);

  const second = await service.request({
    action: "search-details",
    query: "关键词",
    patentId: "p1",
    offset: first.nextOffset ?? undefined,
  });
  expect(second.hits?.[0]?.books[0]?.snippets).toHaveLength(5);
  expect(second.hits?.[0]?.books[0]?.locations?.map((item) => item.occurrence)).toEqual([
    30, 31, 32, 33, 34,
  ]);
  expect(second.hasMore).toBe(false);
});

it("cancels a departed search without returning a misleading empty success", async () => {
  const { service, source } = setup();
  for (let i = 0; i < 300; i++) addPatent(source, `a${String(i).padStart(3, "0")}`);
  const running = service.request({
    action: "search",
    query: "共同关键词",
    searchId: "leaving-page",
  });
  await service.request({ action: "cancel-search", searchId: "leaving-page" });
  expect((await running).cancelled).toBe(true);
});
it("queries never build indexes; manual indexing works while automatic indexing is off", async () => {
  const { service } = setup();
  expect((await service.request({ action: "search", query: "螺旋" })).hits).toEqual([]);
  await service.request({ action: "start" });
  await finish(service);
  const result = await service.request({ action: "search", query: "螺旋" });
  expect(result.enabled).toBe(false);
  expect(result.hits?.[0]?.books[0]?.snippets[0]).toContain("中文螺旋输送装置");
});

it("keeps a persistent candidate index and verifies structural boundaries exactly", async () => {
  const { service, root, update } = setup(2);
  update("甲乙丙\n独特检索标记", 2);
  await service.request({ action: "start" });
  await finish(service);
  const cache = new DatabaseSync(join(root, "cache", cacheFolder(root), "content-v1.sqlite3"));
  try {
    expect(cache.prepare("SELECT count(*) AS n FROM search_text").get()?.n).toBe(1);
    expect((await service.request({ action: "search", query: "独特检索标记" })).hits).toHaveLength(
      1,
    );
    expect((await service.request({ action: "search", query: "丙独特" })).hits).toHaveLength(0);
  } finally {
    cache.close();
  }
});

it("updates and purges candidate data together with cached books", async () => {
  const { service, root, update } = setup(2);
  update("唯一旧词条 KſS", 2);
  await service.request({ action: "start" });
  await finish(service);
  expect((await service.request({ action: "search", query: "KSS" })).hits).toHaveLength(1);
  update("全新内容词条", 3);
  await service.request({ action: "start" });
  await finish(service);
  expect((await service.request({ action: "search", query: "唯一旧词条" })).hits).toHaveLength(0);
  expect((await service.request({ action: "search", query: "全新内容词条" })).hits).toHaveLength(1);
  const release = await service.preparePermanentDelete("p1");
  release();
  const cache = new DatabaseSync(join(root, "cache", cacheFolder(root), "content-v1.sqlite3"));
  try {
    expect(cache.prepare("SELECT count(*) AS n FROM search_text").get()?.n).toBe(0);
    expect(
      cache
        .prepare(
          "SELECT count(*) AS n FROM search_candidates WHERE search_candidates MATCH '全新内'",
        )
        .get()?.n,
    ).toBe(0);
  } finally {
    cache.close();
  }
});
it("coalesces frequent saves and activity, and excludes deleted patents even from stale indexes", async () => {
  const { service, source, update } = setup();
  await service.request({ action: "configure", enabled: true });
  for (let i = 2; i < 8; i++) {
    service.activity();
    update(`最终内容${i}`, i);
    await new Promise((r) => setTimeout(r, 30));
  }
  expect((await service.request({ action: "search", query: "最终" })).hits).toEqual([]);
  await expect
    .poll(
      async () => (await service.request({ action: "search", query: "最终内容7" })).hits?.length,
      { timeout: 4000 },
    )
    .toBe(1);
  source.exec("UPDATE patents SET deleted_at='now'");
  expect((await service.request({ action: "search", query: "最终" })).hits).toEqual([]);
});
it("keeps old results until an explicit update, and stop does not enable background maintenance", async () => {
  const { service, update } = setup();
  await service.request({ action: "start" });
  await finish(service);
  update("新的正文", 2);
  expect((await service.request({ action: "search", query: "新的" })).hits).toEqual([]);
  await service.request({ action: "start" });
  await finish(service);
  expect((await service.request({ action: "search", query: "新的" })).hits).toHaveLength(1);
  expect((await service.request({ action: "stop" })).enabled).toBe(false);
});

it("yields to important operations, stops without losing completed entries, and indexes formatted/table text", async () => {
  const { service, source } = setup();
  const release = service.beginOperation();
  await service.request({ action: "start" });
  await new Promise((r) => setTimeout(r, 100));
  expect((await service.request({ action: "status" })).completed).toBe(0);
  await service.request({ action: "stop" });
  release();
  expect((await service.request({ action: "search", query: "螺旋" })).hits).toEqual([]);
  source.prepare("UPDATE patent_books SET document_json=?").run(
    Buffer.from(
      JSON.stringify({
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "跨格式" },
              { type: "text", text: "关键词", marks: [{ type: "bold" }] },
            ],
          },
          {
            type: "table",
            rows: [
              {
                cells: [
                  {
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "表格中的文字" }] },
                    ],
                  },
                ],
              },
            ],
          },
          { type: "image", attrs: { text: "图片隐私不索引" } },
        ],
      }),
    ),
  );
  await service.request({ action: "start" });
  await finish(service);
  expect((await service.request({ action: "search", query: "跨格式关键词" })).hits).toHaveLength(1);
  expect((await service.request({ action: "search", query: "表格中的" })).hits).toHaveLength(1);
  expect((await service.request({ action: "search", query: "图片隐私" })).hits).toEqual([]);
});

it("isolates damaged cached entries and rebuilds them on the next index pass", async () => {
  const { service, source, root } = setup(2);
  addPatent(source, "p2", "invention", "中文螺旋另一装置");
  await service.request({ action: "start" });
  await finish(service);
  const folder = readdirSync(join(root, "cache"))[0];
  if (!folder) throw new Error("Expected search cache folder");
  const cache = new DatabaseSync(join(root, "cache", folder, "content-v1.sqlite3"));
  try {
    cache.prepare("UPDATE entries SET books='broken' WHERE patent_id='p1'").run();
  } finally {
    cache.close();
  }
  const partial = await service.request({ action: "search", query: "螺旋" });
  expect(partial.searchError).toBe(true);
  expect(partial.hits?.map((h) => h.patentId)).toEqual(["p2"]);
  await service.request({ action: "start" });
  await finish(service);
  const repaired = await service.request({ action: "search", query: "螺旋" });
  expect(repaired.searchError).toBe(false);
  expect(repaired.hits).toHaveLength(2);
});

it("pauses an active search for important operations and allows cancellation while paused", async () => {
  const { service } = setup();
  const release = service.beginOperation();
  let settled = false;
  const search = service
    .request({ action: "search", query: "词", searchId: "paused" })
    .then((result) => {
      settled = true;
      return result;
    });
  await service.request({ action: "status" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(settled).toBe(false);
  await service.request({ action: "cancel-search", searchId: "paused" });
  expect((await search).cancelled).toBe(true);
  release();
});
