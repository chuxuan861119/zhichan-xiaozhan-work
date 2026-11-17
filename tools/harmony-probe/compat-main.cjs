// Independent dependency experiments; never points at a user's document library.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { app } = require("electron");
app.on("window-all-closed", () => {});
app.dock?.hide();
const output = path.join(app.getPath("userData"), "compat-20261002-v1");
fs.mkdirSync(output, { recursive: true });
const runId = require("node:crypto").randomUUID();
const reportFile = path.join(output, `${runId}.json`);
const report = { runId, platform: process.platform, versions: process.versions, checks: [] };
function persist() {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`Harmony compatibility report: ${reportFile}`);
}
async function check(name, fn) {
  report.activeCheck = name;
  persist();
  try {
    report.checks.push({ name, status: "passed", detail: await fn() });
  } catch (error) {
    report.checks.push({ name, status: "failed", message: error.stack });
  }
  report.activeCheck = null;
  persist();
}
async function main() {
  await require("./sharp-adapted.cjs").initialize();
  await check("sqlite-native-main-and-worker", async () => {
    const Database = require("better-sqlite3");
    const nativeBinding = "/data/storage/el1/bundle/libs/arm64/better_sqlite3.node";
    const file = path.join(output, `${runId}-native.sqlite3`);
    const db = new Database(file, { nativeBinding });
    try {
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; CREATE TABLE sample(id INTEGER PRIMARY KEY, content TEXT NOT NULL) STRICT",
      );
      db.transaction(() => db.prepare("INSERT INTO sample VALUES(?,?)").run(1, "鸿蒙专利 α"))();
      assert.throws(
        db.transaction(() => {
          db.prepare("INSERT INTO sample VALUES(?,?)").run(2, "不能保留");
          throw new Error("rollback");
        }),
        /rollback/,
      );
      assert.equal(db.prepare("SELECT count(*) AS n FROM sample").get().n, 1);
      await db.backup(path.join(output, `${runId}-backup.sqlite3`));
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert.equal(db.pragma("synchronous", { simple: true }), 2);
      const { Worker } = require("node:worker_threads");
      await new Promise((resolve, reject) => {
        const worker = new Worker(
          `const { parentPort, workerData } = require('node:worker_threads');
          const Database=require(workerData.module); const db=new Database(workerData.file,{nativeBinding:workerData.nativeBinding,readonly:true});
          parentPort.postMessage(db.prepare('SELECT content FROM sample').get().content); db.close();`,
          {
            eval: true,
            workerData: { module: require.resolve("better-sqlite3"), file, nativeBinding },
          },
        );
        let answer;
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("SQLite Worker timed out"));
        }, 10000);
        worker.once("message", (value) => {
          answer = value;
        });
        worker.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0 && answer === "鸿蒙专利 α") resolve();
          else reject(new Error(`SQLite Worker exit ${code}, ${answer}`));
        });
      });
    } finally {
      db.close();
    }
    const restored = new Database(path.join(output, `${runId}-backup.sqlite3`), {
      nativeBinding,
      readonly: true,
    });
    try {
      assert.equal(restored.prepare("SELECT content FROM sample").get().content, "鸿蒙专利 α");
    } finally {
      restored.close();
    }
    return "native SQLite: WAL/FULL, commit/rollback, backup/reopen, Worker read";
  });
  await check("production-database-schema-adapter", async () => {
    const { pathToFileURL } = require("node:url");
    const { LibraryDatabase } = await import(
      pathToFileURL(path.join(__dirname, "adapted-library-database.mjs"))
    );
    const schema = await import(pathToFileURL(path.join(__dirname, "adapted-schema.mjs")));
    const { DatabaseSync, backup } = require("./sqlite-adapted.cjs");
    const file = path.join(output, `${runId}-production.sqlite3`);
    const library = LibraryDatabase.open(file);
    try {
      library.transaction((db) => {
        for (const sql of schema.V14_MIGRATION_STATEMENTS) db.exec(sql);
      });
      assert.equal(library.schemaVersion(), 14);
      assert.equal(
        library.read((db) => schema.validateCurrentSchema(db).ok),
        true,
      );
      assert.equal(library.integrityCheck().ok, true);
      assert.equal(library.foreignKeyCheck().ok, true);
      assert.throws(
        () => library.read((db) => db.prepare("SELECT 9007199254740993 AS value").get()),
        /safe integer/,
      );
      await library.read((db) =>
        backup(db, path.join(output, `${runId}-production-backup.sqlite3`), { rate: 64 }),
      );
      library.checkpoint();
    } finally {
      library.close();
    }
    const reopened = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(schema.validateCurrentSchema(reopened).ok, true);
    } finally {
      reopened.close();
    }
    return "actual LibraryDatabase, schema v14 and constraints, backup, reopen, unsafe integer rejection";
  });
  await check("native-node-harmony-database-exchange", async () => {
    const { DatabaseSync, backup } = require("./sqlite-adapted.cjs");
    const fixture = path.join(output, `${runId}-exchange.sqlite3`);
    fs.copyFileSync(path.join(__dirname, "host-exchange.sqlite3"), fixture);
    const db = new DatabaseSync(fixture);
    try {
      assert.equal(
        db.prepare("SELECT name FROM patents WHERE patent_id=?").get("cross-platform").name,
        "跨平台测试专利",
      );
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE patents SET name=?,revision=revision+1 WHERE patent_id=?").run(
        "鸿蒙保存后返回桌面",
        "cross-platform",
      );
      db.exec("COMMIT");
      await backup(db, path.join(output, `${runId}-exchange-return.sqlite3`));
    } finally {
      db.close();
    }
    return "Native Node SQLite fixture opened and modified; return-file verification on host pending";
  });
  const writeAtomic = require("./atomic-adapted.cjs");
  await check("atomic-normal-concurrent-failure", async () => {
    const file = path.join(output, `${runId}-原子保存.txt`);
    await writeAtomic(file, "旧文件", { fsync: true });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => writeAtomic(file, `版本 ${i}`, { fsync: true })),
    );
    assert.equal(fs.readFileSync(file, "utf8"), "版本 19");
    await assert.rejects(
      writeAtomic(file, "不能覆盖", {
        fsync: true,
        tmpfileCreated() {
          throw new Error("injected-before-write");
        },
      }),
      /injected-before-write/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "版本 19");
    writeAtomic.sync(file, "同步保存", { fsync: true });
    assert.equal(fs.readFileSync(file, "utf8"), "同步保存");
    assert.equal(
      fs.readdirSync(output).filter((name) => name.startsWith(`${path.basename(file)}.`)).length,
      0,
    );
    return "async/sync, 20 ordered writes, rejected write preserves old data, temporary files cleaned";
  });
  await check("wasm-threads", async () => {
    const module = new WebAssembly.Module(Buffer.from("0061736d01000000010401600000", "hex"));
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    assert.equal(memory.buffer instanceof SharedArrayBuffer, true);
    assert.ok(new WebAssembly.Instance(module));
    return "Wasm compile/instantiate and shared memory supported; sharp exercises real workers separately";
  });
  await check("sharp-wasm-images", async () => {
    const sharp = require("./sharp-adapted.cjs");
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="red"/></svg>',
    );
    const png = await sharp(svg).png().toBuffer();
    const transformed = await sharp(png).rotate(90).resize({ height: 40 }).png().toBuffer();
    const info = await sharp(transformed).metadata();
    assert.equal(info.width, 20);
    assert.equal(info.height, 40);
    const { pathToFileURL } = require("node:url");
    const { importImage } = await import(pathToFileURL(path.join(__dirname, "image-importer.mjs")));
    const imported = await importImage({ originalName: "兼容测试.png", bytes: png });
    assert.equal(imported.descriptor.widthPx, 160);
    assert.deepEqual(Buffer.from(imported.original), png);
    fs.writeFileSync(path.join(output, `${runId}-preview.png`), imported.preview);
    return { versions: sharp.versions, sourceImporter: true };
  });
  await check("svg-text-and-production-formula", async () => {
    const sharp = require("./sharp-adapted.cjs");
    const { pathToFileURL } = require("node:url");
    const { renderFormulaFallback } = await import(
      pathToFileURL(path.join(__dirname, "formula-fallback.mjs"))
    );
    const formula = await renderFormulaFallback(String.raw`\frac{\alpha+\beta}{2}=\sqrt{x^2+y^2}`);
    assert.ok(formula.widthPx > 20 && formula.heightPx > 20);
    fs.writeFileSync(path.join(output, `${runId}-formula.png`), formula.png);
    const counts = {};
    for (const [name, text] of [
      ["latin", "NH2 COOH"],
      ["chinese", "一种专利装置"],
    ]) {
      const svg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><rect width="400" height="80" fill="white"/><text x="10" y="50" font-size="32" fill="black">${text}</text></svg>`,
      );
      const png = await sharp(svg).png().toBuffer();
      fs.writeFileSync(path.join(output, `${runId}-${name}.png`), png);
      const { data, info } = await sharp(png)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let dark = 0;
      for (let i = 0; i < data.length; i += info.channels) if (data[i] < 128) dark++;
      counts[name] = dark;
    }
    assert.ok(
      counts.latin > 100 && counts.chinese > 100,
      `SVG text missing: ${JSON.stringify(counts)}`,
    );
    return {
      formulaSize: [formula.widthPx, formula.heightPx],
      darkPixels: counts,
      visualReview: "pending",
    };
  });
  report.finishedAt = new Date().toISOString();
  persist();
  app.exit(report.checks.some((check) => check.status === "failed") ? 1 : 0);
}
main().catch((error) => {
  console.error(error);
  app.exit(2);
});
