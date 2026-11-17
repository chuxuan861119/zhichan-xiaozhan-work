const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Worker } = require("node:worker_threads");
const checkNames = [
  "sqlite-library",
  "sqlite-worker",
  "atomic-file",
  "sharp-image-import",
  "hidden-window-pdf",
  "credential-storage",
];
const onlyIndex = process.argv.indexOf("--only");
const selectedChecks = onlyIndex >= 0 ? (process.argv[onlyIndex + 1] || "").split(",") : null;
if (selectedChecks?.some((name) => !checkNames.includes(name))) {
  throw new Error(`--only must list names from: ${checkNames.join(", ")}`);
}

const electron =
  process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE ? require("electron") : null;
if (electron) {
  electron.app.dock?.hide();
  // Keep the diagnostic alive after the hidden PDF window closes.
  electron.app.on("window-all-closed", () => {});
}
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
if (!output || !path.isAbsolute(output)) {
  throw new Error(
    "Pass --output <absolute-new-report-directory>; formal data directories are forbidden.",
  );
}
// Refuse to overwrite a previous run or any existing data directory.
require("node:fs").mkdirSync(output);
if (electron) {
  const userData = path.join(output, "electron-user-data");
  require("node:fs").mkdirSync(userData);
  electron.app.setPath("userData", userData);
}
const report = {
  startedAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  versions: process.versions,
  evidence: ["ohos", "openharmony"].includes(process.platform)
    ? "harmony-runtime"
    : "host-baseline-only",
  selectedChecks,
  checks: [],
  unverified: [
    "real-device",
    "printer",
    "crash-recovery",
    "DWG",
    "PATDOC-roundtrip",
    "DOCX-roundtrip",
    "chemical-editor",
    "font-pagination-visual-review",
  ],
};

async function check(name, run) {
  if (selectedChecks && !selectedChecks.includes(name)) {
    report.checks.push({ name, status: "not-run", reason: "Excluded by --only" });
    return;
  }
  report.activeCheck = name;
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Harmony dependency probe starting: ${name}`);
  try {
    const detail = await run();
    report.checks.push({ name, status: "passed", detail });
  } catch (error) {
    report.checks.push({ name, status: "failed", code: error.code, message: error.message });
  }
  report.activeCheck = null;
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Harmony dependency probe result: ${JSON.stringify(report.checks.at(-1))}`);
}

async function sqliteProbe() {
  const { DatabaseSync, backup } = require("node:sqlite");
  const { LibraryDatabase } = await import(
    pathToFileURL(path.join(__dirname, "library-database.mjs"))
  );
  const file = path.join(output, "probe.sqlite3");
  const library = LibraryDatabase.open(file);
  try {
    library.read((db) =>
      db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY, content TEXT NOT NULL) STRICT"),
    );
    library.transaction((db) =>
      db.prepare("INSERT INTO sample VALUES (?, ?)").run(1, "测试专利：一种装置 α"),
    );
    assert.throws(
      () =>
        library.transaction((db) => {
          db.prepare("INSERT INTO sample VALUES (?, ?)").run(2, "应被回滚");
          throw new Error("probe-rollback");
        }),
      /probe-rollback/,
    );
    assert.equal(
      library.read((db) => db.prepare("SELECT count(*) AS n FROM sample").get().n),
      1,
    );
    assert.equal(
      library.read((db) => db.prepare("PRAGMA journal_mode").get().journal_mode),
      "wal",
    );
    assert.equal(
      library.read((db) => db.prepare("PRAGMA synchronous").get().synchronous),
      2,
    );
    assert.equal(library.integrityCheck().ok, true);
    await library.read((db) => backup(db, path.join(output, "backup.sqlite3")));
    library.checkpoint();
  } finally {
    library.close();
  }
  const reopened = LibraryDatabase.openReadOnly(file);
  try {
    assert.equal(
      reopened.read((db) => db.prepare("SELECT content FROM sample").get().content),
      "测试专利：一种装置 α",
    );
  } finally {
    reopened.close();
  }
  const restored = new DatabaseSync(path.join(output, "backup.sqlite3"), {
    readOnly: true,
    timeout: 5000,
  });
  try {
    assert.equal(restored.prepare("SELECT count(*) AS n FROM sample").get().n, 1);
  } finally {
    restored.close();
  }
  return "Actual LibraryDatabase: commit, rollback, WAL, synchronous=FULL, backup, checkpoint, read-only reopen";
}

async function main() {
  await check("sqlite-library", sqliteProbe);
  await check(
    "sqlite-worker",
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(
          'const { parentPort } = require("node:worker_threads"); const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:"); parentPort.postMessage(db.prepare("SELECT 42 AS answer").get().answer); db.close();',
          { eval: true },
        );
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("Worker timed out"));
        }, 10000);
        let answer;
        worker.once("message", (value) => {
          answer = value;
        });
        worker.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.once("exit", (code) => {
          clearTimeout(timer);
          if (code !== 0 || answer !== 42)
            reject(new Error(`Worker failed: exit=${code}, answer=${answer}`));
          else resolve("SQLite query completed in worker thread");
        });
      }),
  );
  await check("atomic-file", async () => {
    const atomicWrite = require("write-file-atomic");
    const file = path.join(output, "原子保存.txt");
    await atomicWrite(file, "旧内容", { fsync: true });
    await atomicWrite(file, "新内容", { fsync: true });
    assert.equal(await fs.readFile(file, "utf8"), "新内容");
    return "Unicode filename and atomic replacement; interruption recovery remains unverified";
  });
  await check("sharp-image-import", async () => {
    const sharp = require("sharp");
    const { importImage } = await import(pathToFileURL(path.join(__dirname, "image-importer.mjs")));
    const png = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="red"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const imported = await importImage({ originalName: "测试图.png", bytes: png });
    assert.equal(imported.descriptor.widthPx, 160);
    assert.equal(imported.descriptor.heightPx, 80);
    assert.deepEqual(Buffer.from(imported.original), png);
    const rotated = await sharp(png).rotate(90).resize({ height: 40 }).png().toBuffer();
    const metadata = await sharp(rotated).metadata();
    assert.equal(metadata.width, 20);
    assert.equal(metadata.height, 40);
    await fs.writeFile(path.join(output, "image-preview.png"), imported.preview);
    return { library: sharp.versions.sharp, vips: sharp.versions.vips, sourceImporter: true };
  });
  if (electron) {
    await electron.app.whenReady();
    await check("hidden-window-pdf", async () => {
      const window = new electron.BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      try {
        const html =
          '<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:20mm}body{font-family:serif}td{border:1px solid;padding:8px}</style><h1>专利依赖验证</h1><p>一种测试装置　α + β = γ</p><table><tr><td>部件</td><td>功能</td></tr><tr><td>测试组件</td><td>输出验证</td></tr></table>';
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        await window.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
        const bytes = await window.webContents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true,
        });
        assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
        assert.ok(bytes.length > 1000);
        await fs.writeFile(path.join(output, "sample.pdf"), bytes);
        return { bytes: bytes.length, visible: window.isVisible(), visualReview: "pending" };
      } finally {
        window.destroy();
      }
    });
    await check("credential-storage", async () => {
      assert.equal(electron.safeStorage.isEncryptionAvailable(), true);
      const encrypted = electron.safeStorage.encryptString("public-probe-not-a-real-key");
      assert.equal(electron.safeStorage.decryptString(encrypted), "public-probe-not-a-real-key");
      return "Dummy value encryption/decryption; cross-restart persistence remains unverified";
    });
  } else {
    report.checks.push({
      name: "electron-pdf-and-credentials",
      status: "not-run",
      reason: "Requires Electron application runtime",
    });
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  const code = report.checks.some((item) => item.status === "failed") ? 1 : 0;
  if (electron) electron.app.exit(code);
  else process.exitCode = code;
}

main().catch(async (error) => {
  console.error(error);
  if (electron) electron.app.exit(1);
  else process.exitCode = 1;
});
