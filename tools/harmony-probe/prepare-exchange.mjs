import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outputArg = process.argv[2];
if (!outputArg) throw new Error("Usage: prepare-exchange.mjs <new-output-directory>");
const output = resolve(outputArg);
const here = dirname(fileURLToPath(import.meta.url));
await mkdir(output); // Existing evidence must never be replaced.
await build({
  entryPoints: [resolve(here, "../../src/main/library/schema.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(output, "host-schema.mjs"),
});
const schema = await import(pathToFileURL(join(output, "host-schema.mjs")));
const db = new DatabaseSync(join(output, "host-exchange.sqlite3"));
try {
  db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  for (const sql of schema.V14_MIGRATION_STATEMENTS) db.exec(sql);
  db.prepare(`INSERT INTO patents(patent_id,name,patent_type,revision,created_at,modified_at,recovery_state)
    VALUES(?,?,?,?,?,?,?)`).run(
    "cross-platform",
    "跨平台测试专利",
    "invention",
    0,
    "2026-10-02",
    "2026-10-02",
    "healthy",
  );
  db.exec("COMMIT");
  assert.equal(schema.validateCurrentSchema(db).ok, true);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  await writeFile(
    join(output, "fixture-info.json"),
    JSON.stringify(
      {
        platform: process.platform,
        node: process.versions.node,
        schemaVersion: 14,
        sqlite: db.prepare("SELECT sqlite_version() AS version").get().version,
        syntheticDataOnly: true,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
