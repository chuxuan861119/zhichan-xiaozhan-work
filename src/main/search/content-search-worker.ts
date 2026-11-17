// Self-contained worker entry; Harmony patches only the node:sqlite loader below.
// Source documents are read-only. All writes/deletions target rebuildable cache files.
export function runContentSearchWorker(
  loadModule: NodeJS.Require,
  textTools: ReturnType<
    typeof import("../../shared/library/content-search-text.js").createContentSearchTools
  >,
) {
  const { parentPort, workerData } = loadModule(
    "node:worker_threads",
  ) as typeof import("node:worker_threads");
  const { DatabaseSync } = loadModule("node:sqlite") as typeof import("node:sqlite");
  const { mkdirSync, existsSync, unlinkSync, readdirSync } = loadModule(
    "node:fs",
  ) as typeof import("node:fs");
  const { join } = loadModule("node:path") as typeof import("node:path");
  const { randomUUID } = loadModule("node:crypto") as typeof import("node:crypto");
  if (!parentPort) throw new Error("Worker port missing");
  const port = parentPort;
  const options = workerData as {
    libraryPath: string;
    cacheRoot: string;
    idleMs: number;
    stepMs: number;
    enabled: boolean;
  };
  mkdirSync(options.cacheRoot, { recursive: true });
  const source = new DatabaseSync(options.libraryPath, { readOnly: true, timeout: 100 });
  source.exec("PRAGMA query_only=ON; PRAGMA cache_size=-1024");
  const cacheName = "content-v1.sqlite3";
  const cachePath = join(options.cacheRoot, cacheName);
  function clearDamagedCopies() {
    for (const name of readdirSync(options.cacheRoot))
      if (name.startsWith(cacheName + ".damaged-")) unlinkSync(join(options.cacheRoot, name));
  }
  function openCache() {
    const db = new DatabaseSync(cachePath);
    try {
      // DELETE journaling plus secure_delete prevents retained WAL/freelist copies.
      db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048;" +
          "CREATE TABLE IF NOT EXISTS entries(patent_id TEXT PRIMARY KEY, stamp TEXT NOT NULL, books TEXT NOT NULL);" +
          "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
      );
      db.prepare("SELECT * FROM entries LIMIT 1").get();
      if (db.prepare("SELECT value FROM state WHERE key='formatVersion'").get()?.value !== "3") {
        db.exec("DELETE FROM entries; DELETE FROM state; VACUUM");
        db.prepare("INSERT INTO state VALUES('formatVersion','3')").run();
      }
      return db;
    } catch (failure) {
      db.close();
      throw failure;
    }
  }
  let cache: InstanceType<typeof DatabaseSync>;
  try {
    cache = openCache();
  } catch (failure) {
    const sqlite = failure as { errcode?: number; code?: string };
    if (
      ![11, 26].includes((sqlite.errcode ?? 0) & 255) &&
      !["SQLITE_CORRUPT", "SQLITE_NOTADB"].includes(sqlite.code ?? "")
    )
      throw failure;
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(cachePath + suffix)) unlinkSync(cachePath + suffix);
    cache = openCache();
  }
  clearDamagedCopies();
  // Additive, rebuildable acceleration. Old entries remain searchable while backfilled.
  cache.exec(
    "CREATE TABLE IF NOT EXISTS search_text(patent_id TEXT PRIMARY KEY, stamp TEXT NOT NULL, text TEXT NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS search_text_stamp ON search_text(patent_id,stamp);" +
      "CREATE INDEX IF NOT EXISTS entries_stamp ON entries(patent_id,stamp);" +
      "CREATE TRIGGER IF NOT EXISTS search_entry_delete AFTER DELETE ON entries BEGIN DELETE FROM search_text WHERE patent_id=old.patent_id; END;" +
      "CREATE TRIGGER IF NOT EXISTS search_entry_update AFTER UPDATE ON entries BEGIN DELETE FROM search_text WHERE patent_id=old.patent_id; END;",
  );
  let trigram = false;
  cache.exec("SAVEPOINT candidate_setup");
  try {
    const existed = cache
      .prepare("SELECT 1 FROM sqlite_master WHERE name='search_candidates'")
      .get();
    cache.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS search_candidates USING fts5(text, content='search_text', content_rowid='rowid', tokenize='trigram', detail='none');" +
        "INSERT INTO search_candidates(search_candidates,rank) VALUES('secure-delete',1);" +
        "CREATE TRIGGER IF NOT EXISTS search_text_insert AFTER INSERT ON search_text BEGIN INSERT INTO search_candidates(rowid,text) VALUES(new.rowid,new.text); END;" +
        "CREATE TRIGGER IF NOT EXISTS search_text_delete AFTER DELETE ON search_text BEGIN INSERT INTO search_candidates(search_candidates,rowid,text) VALUES('delete',old.rowid,old.text); END;",
    );
    if (!existed) cache.exec("INSERT INTO search_candidates(search_candidates) VALUES('rebuild')");
    cache.exec("RELEASE candidate_setup");
    trigram = true;
  } catch (failure) {
    cache.exec("ROLLBACK TO candidate_setup; RELEASE candidate_setup");
    // Older platform SQLite builds may lack FTS5/trigram/secure-delete. Exact
    // plaintext prefiltering remains available without changing matching semantics.
    if (
      !/no such module|no such tokenizer|unrecognized option|SQL logic error/i.test(String(failure))
    )
      throw failure;
  }
  function cacheText(id: string, revision: string, books: Book[]) {
    cache.prepare("DELETE FROM search_text WHERE patent_id=?").run(id);
    cache.prepare("INSERT INTO search_text(patent_id,stamp,text) VALUES(?,?,?)").run(
      id,
      revision,
      books
        .map((b) => b.text.replaceAll("\u0000", "\n"))
        .join("\n")
        .toLowerCase()
        .replaceAll("ſ", "s"),
    );
  }
  const instance = randomUUID();
  let indexGeneration = 0;
  const indexVersion = () => instance + ":" + indexGeneration;
  const sourceVersion = () =>
    instance + ":" + String(source.prepare("PRAGMA data_version").get()?.data_version);
  let enabled = options.enabled;
  let updatedAt =
    (cache.prepare("SELECT value FROM state WHERE key='updatedAt'").get()?.value as
      | string
      | undefined) ?? null;
  let lastActivity = Date.now(),
    nextAutomatic = 0;
  let busy = false,
    manual = false,
    running = false,
    error = false,
    deferred = false;
  let completed = 0,
    total = 0,
    failedCount = 0,
    cursor = "",
    runId = "";
  let indexPhase: import("../../shared/library/content-search.js").ContentSearchState["indexPhase"] =
    "idle";
  type PatentRow = { patent_id: string; revision: number; modified_at: string };
  type Book = {
    kind: string;
    text: string;
    spans?: import("../../shared/library/content-search-text.js").ContentSearchSpan[];
  };
  const stamp = (p: PatentRow) => String(p.revision) + ":" + p.modified_at;
  const idle = () => !busy && Date.now() - lastActivity >= options.idleMs;
  let coverage: { key: string; indexedCount: number; pendingCount: number } | undefined;
  function readCoverage() {
    const key = sourceVersion() + ":" + indexVersion();
    if (coverage?.key === key) return coverage;
    const stamps = new Map(
      (
        cache.prepare("SELECT patent_id,stamp FROM entries").all() as {
          patent_id: string;
          stamp: string;
        }[]
      ).map((p) => [p.patent_id, p.stamp]),
    );
    let indexedCount = 0,
      pendingCount = 0;
    for (const p of source
      .prepare(
        "SELECT patent_id,revision,modified_at FROM patents WHERE deleted_at IS NULL AND recovery_state='healthy'",
      )
      .all() as PatentRow[]) {
      if (stamps.has(p.patent_id)) indexedCount++;
      if (stamps.get(p.patent_id) !== stamp(p)) pendingCount++;
    }
    coverage = { key, indexedCount, pendingCount };
    return coverage;
  }
  function state() {
    const { indexedCount, pendingCount } = readCoverage();
    return {
      enabled,
      running,
      manual,
      paused: running && (busy || (!manual && !idle())),
      completed,
      total,
      updatedAt,
      error,
      incomplete: error || deferred || running || pendingCount > 0,
      indexPhase,
      runId,
      indexedCount,
      pendingCount,
      failedCount,
      indexVersion: indexVersion(),
      sourceVersion: sourceVersion(),
    };
  }
  function basicFailure() {
    // Metadata itself may be unavailable; reporting failure must not query it again.
    return {
      enabled,
      running,
      manual,
      paused: false,
      completed,
      total,
      updatedAt,
      error: true,
      incomplete: true,
      indexPhase,
      runId,
      failedCount,
      indexVersion: indexVersion(),
    };
  }
  const setState = (key: string, value: string) =>
    cache.prepare("INSERT OR REPLACE INTO state VALUES(?,?)").run(key, value);
  function removeEntry(id: string) {
    if (cache.prepare("DELETE FROM entries WHERE patent_id=?").run(id).changes) indexGeneration++;
  }
  function sweepMissing() {
    const existing = new Set(
      (source.prepare("SELECT patent_id FROM patents").all() as { patent_id: string }[]).map(
        (p) => p.patent_id,
      ),
    );
    for (const row of cache.prepare("SELECT patent_id FROM entries").all() as {
      patent_id: string;
    }[])
      if (!existing.has(row.patent_id)) removeEntry(row.patent_id);
  }
  sweepMissing();
  // A sentinel cannot occur in valid library queries and prevents artificial cross-node hits.
  const boundary = "\u0000";
  let staged: { patent: PatentRow; books: Book[]; after: string } | undefined;
  function begin() {
    staged = undefined;
    running = true;
    indexPhase = "running";
    runId = randomUUID();
    completed = 0;
    cursor = "";
    error = false;
    deferred = false;
    failedCount = 0;
    sweepMissing();
    total = Number(
      source
        .prepare(
          "SELECT count(*) AS n FROM patents WHERE deleted_at IS NULL AND recovery_state='healthy'",
        )
        .get()?.n ?? 0,
    );
  }
  function step() {
    try {
      if (busy || (!manual && (!enabled || !idle()))) return;
      if (!running) {
        if (!manual && Date.now() < nextAutomatic) return;
        begin();
      }
      if (staged) {
        const p = staged.patent;
        const row = source
          .prepare(
            "SELECT kind,document_json FROM patent_books WHERE patent_id=? AND kind>? ORDER BY kind LIMIT 1",
          )
          .get(p.patent_id, staged.after);
        if (row) {
          staged.after = String(row.kind);
          staged.books.push({
            kind: String(row.kind),
            ...textTools.collect(
              JSON.parse(Buffer.from(row.document_json as Uint8Array).toString("utf8")),
            ),
          });
          return;
        }
        const latest = source
          .prepare(
            "SELECT patent_id,revision,modified_at FROM patents WHERE patent_id=? AND deleted_at IS NULL AND recovery_state='healthy'",
          )
          .get(p.patent_id) as PatentRow | undefined;
        if (latest && stamp(latest) === stamp(p)) {
          cache.exec("BEGIN");
          try {
            cache.prepare("DELETE FROM search_text WHERE patent_id=?").run(p.patent_id);
            cache
              .prepare("INSERT OR REPLACE INTO entries VALUES(?,?,?)")
              .run(p.patent_id, stamp(p), JSON.stringify(staged.books));
            cacheText(p.patent_id, stamp(p), staged.books);
            cache.exec("COMMIT");
          } catch (failure) {
            cache.exec("ROLLBACK");
            throw failure;
          }
          indexGeneration++;
        } else deferred = true;
        staged = undefined;
        completed++;
        return;
      }
      const p = source
        .prepare(
          "SELECT patent_id,revision,modified_at FROM patents WHERE deleted_at IS NULL AND recovery_state='healthy' AND patent_id>? ORDER BY patent_id LIMIT 1",
        )
        .get(cursor) as PatentRow | undefined;
      if (!p) {
        sweepMissing();
        running = false;
        manual = false;
        indexPhase =
          error || deferred || readCoverage().pendingCount > 0
            ? failedCount >= total && total > 0
              ? "failed"
              : "partial"
            : "completed";
        if (indexPhase === "completed") {
          const successAt = new Date().toISOString();
          setState("updatedAt", successAt);
          updatedAt = successAt;
        }
        nextAutomatic = Date.now() + 60000;
        return;
      }
      cursor = p.patent_id;
      if (
        cache.prepare("SELECT stamp FROM entries WHERE patent_id=?").get(p.patent_id)?.stamp ===
        stamp(p)
      ) {
        if (
          !cache
            .prepare("SELECT 1 FROM search_text WHERE patent_id=? AND stamp=?")
            .get(p.patent_id, stamp(p))
        ) {
          const entry = cache
            .prepare("SELECT books FROM entries WHERE patent_id=?")
            .get(p.patent_id);
          try {
            cacheText(p.patent_id, stamp(p), JSON.parse(String(entry!.books)) as Book[]);
          } catch (failure) {
            removeEntry(p.patent_id);
            throw failure;
          }
        }
        completed++;
        return;
      }
      staged = { patent: p, books: [], after: "" };
    } catch {
      error = true;
      if (staged) {
        staged = undefined;
        completed++;
        failedCount++;
        return;
      }
      running = false;
      manual = false;
      indexPhase = "failed";
      nextAutomatic = Date.now() + 60000;
    }
  }
  type Request = import("../../shared/library/content-search.js").ContentSearchRequest;
  type Hit = {
    patentId: string;
    books: {
      kind: string;
      count: number;
      snippets: string[];
      locations: import("../../shared/library/content-search.js").ContentSearchLocation[];
    }[];
  };
  let searchGeneration = 0,
    activeSearchId: string | undefined;
  const changed = () => ({
    ...state(),
    hits: [],
    hasMore: false,
    nextCursor: null,
    nextOffset: null,
    versionChanged: true,
  });
  function bookMatches(book: Book, query: string, offset = 0, limit = 3, occurrenceBase = 0) {
    let count = 0,
      spanIndex = 0;
    const snippets: string[] = [],
      locations: import("../../shared/library/content-search.js").ContentSearchLocation[] = [];
    for (const match of textTools.matches(book.text, query)) {
      const at = match.from;
      if (occurrenceBase + count >= offset && snippets.length < limit) {
        const spans = book.spans ?? [];
        while (spans[spanIndex] && spans[spanIndex]!.end <= at) spanIndex++;
        const span = spans[spanIndex];
        locations.push({
          occurrence: count,
          queryOffset: Math.min(at, 36),
          ...(span?.nodeId
            ? {
                nodeId: span.nodeId,
                textOffset: span.textOffset + at - span.start,
                ...(span.annotation ? { annotation: span.annotation } : {}),
              }
            : {}),
        });
        snippets.push(
          book.text
            .slice(Math.max(0, at - 36), Math.min(book.text.length, match.to + 64))
            .replaceAll(boundary, "\n"),
        );
      }
      count++;
    }
    return { kind: book.kind, count, snippets, locations };
  }
  async function search(request: Extract<Request, { action: "search" }>) {
    activeSearchId = request.searchId;
    const generation = ++searchGeneration;
    // Service messages already queued (including cancellation) before scanning.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const version = indexVersion();
    if (request.indexVersion && request.indexVersion !== version) return changed();
    const hits: Hit[] = [];
    let after = request.after ?? "",
      matched = 0,
      hasMore = false,
      searchError = false,
      budget = Date.now();
    const initial = state();
    // A literal CJK run has identical semantics in JS Unicode matching and
    // SQLite. Other Unicode/case-folding queries retain the exact scan path.
    const chinese =
      request.query.match(/[\u3400-\u9fff]{2,}/u)?.[0] ??
      request.query.match(/[a-zA-Z0-9]{3,}/u)?.[0]?.toLowerCase();
    let candidates: Set<string> | undefined;
    if (chinese) {
      const missing = cache
        .prepare(
          "SELECT e.patent_id FROM entries e LEFT JOIN search_text t ON t.patent_id=e.patent_id AND t.stamp=e.stamp WHERE t.patent_id IS NULL",
        )
        .all();
      const matching =
        trigram && chinese.length >= 3
          ? cache
              .prepare(
                "SELECT patent_id FROM search_text WHERE rowid IN (SELECT rowid FROM search_candidates WHERE search_candidates MATCH ?)",
              )
              .all(
                [
                  ...new Set(
                    Array.from(
                      { length: chinese.length - 2 },
                      (_, i) => '"' + chinese.slice(i, i + 3) + '"',
                    ),
                  ),
                ].join(" AND "),
              )
          : cache.prepare("SELECT patent_id FROM search_text WHERE instr(text,?)>0").all(chinese);
      candidates = new Set([...missing, ...matching].map((row) => String(row.patent_id)));
    }
    const batch = source.prepare(
      "SELECT patent_id,revision,modified_at FROM patents WHERE deleted_at IS NULL AND recovery_state='healthy' AND patent_id>? AND (? IS NULL OR patent_type=?) ORDER BY patent_id LIMIT 128",
    );
    const cached = cache.prepare("SELECT books FROM entries WHERE patent_id=?");
    outer: while (true) {
      if (generation !== searchGeneration)
        return { ...state(), hits: [], hasMore: false, cancelled: true };
      if (busy) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        continue;
      }
      const rows = batch.all(
        after,
        request.patentType ?? null,
        request.patentType ?? null,
      ) as PatentRow[];
      if (!rows.length) break;
      for (const p of rows) {
        if (generation !== searchGeneration)
          return { ...state(), hits: [], hasMore: false, cancelled: true };
        if (busy) break;
        after = p.patent_id;
        const entry = !candidates || candidates.has(after) ? cached.get(after) : undefined;
        if (entry) {
          try {
            const books = (JSON.parse(String(entry.books)) as Book[])
              .map((book) => bookMatches(book, request.query))
              .filter((book) => book.count);
            if (books.length && matched++ >= (request.offset ?? 0))
              hits.push({ patentId: after, books });
            if (hits.length > 30) {
              hits.pop();
              hasMore = true;
              break outer;
            }
          } catch {
            removeEntry(after);
            searchError = true;
          }
        }
        if (Date.now() - budget >= 8) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          budget = Date.now();
        }
      }
      // Yield by elapsed budget, including empty batches. A zero-delay timer
      // can cost a full Windows timer tick; don't pay it for every 128 rows.
      if (Date.now() - budget >= 8) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        budget = Date.now();
      }
    }
    if (request.indexVersion && version !== indexVersion()) return changed();
    const current = state();
    return {
      ...current,
      indexVersion: version,
      incomplete: initial.incomplete || current.incomplete || version !== indexVersion(),
      hits,
      hasMore,
      searchError,
      nextCursor: hits.at(-1)?.patentId ?? null,
    };
  }
  async function searchDetails(request: Extract<Request, { action: "search-details" }>) {
    const version = indexVersion();
    if (request.indexVersion && request.indexVersion !== version) return changed();
    while (busy) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (version !== indexVersion()) return changed();
    const patent = source
      .prepare(
        "SELECT patent_id,revision,modified_at FROM patents WHERE patent_id=? AND deleted_at IS NULL AND recovery_state='healthy'",
      )
      .get(request.patentId) as PatentRow | undefined;
    if (!patent) return { ...state(), hits: [], hasMore: false, nextOffset: null };
    const entry = cache
      .prepare("SELECT stamp,books FROM entries WHERE patent_id=?")
      .get(request.patentId) as { stamp: string; books: string } | undefined;
    if (!entry) return { ...state(), hits: [], hasMore: false, nextOffset: null, incomplete: true };
    let occurrenceIndex = 0,
      pageCount = 0;
    const books: Hit["books"] = [];
    for (const book of JSON.parse(entry.books) as Book[]) {
      const match = bookMatches(
        book,
        request.query,
        request.offset ?? 0,
        30 - pageCount,
        occurrenceIndex,
      );
      occurrenceIndex += match.count;
      pageCount += match.snippets.length;
      if (match.count) books.push(match);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      while (busy) await new Promise<void>((resolve) => setTimeout(resolve, 25));
      if (version !== indexVersion()) return changed();
    }
    const hasMore = occurrenceIndex > (request.offset ?? 0) + pageCount;
    return {
      ...state(),
      indexVersion: version,
      incomplete: error || running || entry.stamp !== stamp(patent),
      hits: books.length ? [{ patentId: request.patentId, books }] : [],
      hasMore,
      nextOffset: hasMore ? (request.offset ?? 0) + pageCount : null,
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    clearTimeout(timer);
    if (busy || (!manual && !enabled)) return;
    const delay = manual
      ? 0
      : Math.max(
          options.stepMs,
          options.idleMs - (Date.now() - lastActivity),
          running ? 0 : nextAutomatic - Date.now(),
        );
    timer = setTimeout(() => {
      // Bound work by elapsed time, not a sleep for every book/unchanged row.
      const until = Date.now() + (manual ? 8 : 4);
      do {
        step();
      } while (running && !busy && Date.now() < until && (manual || idle()));
      schedule();
    }, delay);
  }
  port.on(
    "message",
    async (message: { id?: number; request?: Request; activity?: boolean; busy?: boolean }) => {
      if (message.activity) {
        lastActivity = Date.now();
        return;
      }
      if (typeof message.busy === "boolean") {
        busy = message.busy;
        lastActivity = Date.now();
        schedule();
        return;
      }
      const request = message.request;
      if (!request) return;
      try {
        let result: unknown;
        switch (request.action) {
          case "configure":
            enabled = request.enabled;
            if (!enabled && !manual) {
              running = false;
              indexPhase = "cancelled";
              staged = undefined;
            }
            break;
          case "start":
            if (!manual) {
              manual = true;
              if (!running) begin();
            }
            break;
          case "stop":
            manual = false;
            running = false;
            indexPhase = "cancelled";
            staged = undefined;
            nextAutomatic = Date.now() + options.idleMs;
            lastActivity = Date.now();
            break;
          case "purge-patent":
            searchGeneration++;
            if (staged?.patent.patent_id === request.patentId) staged = undefined;
            removeEntry(request.patentId);
            clearDamagedCopies();
            break;
          case "cancel-search":
            if (request.searchId === activeSearchId) searchGeneration++;
            break;
          case "search":
            result = await search(request);
            break;
          case "search-details":
            result = await searchDetails(request);
            break;
        }
        if (!["status", "search", "search-details"].includes(request.action)) schedule();
        port.postMessage({ id: message.id, value: result ?? state() });
      } catch {
        error = true;
        if (request.action === "start") {
          running = false;
          manual = false;
          indexPhase = "failed";
        }
        port.postMessage({
          id: message.id,
          value: {
            ...basicFailure(),
            hits: [],
            searchError: ["search", "search-details", "purge-patent"].includes(request.action),
          },
        });
      }
    },
  );
  port.on("close", () => {
    clearTimeout(timer);
    cache.close();
    source.close();
  });
}
