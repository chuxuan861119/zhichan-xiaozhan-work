const assert = require("node:assert/strict");
const { test } = require("node:test");
const { auditHeader } = require("../build/audit-package.cjs");
const header = () => ({
  files: {
    out: {
      files: {
        main: { files: { "index.js": { size: 1 } } },
        preload: { files: { "index.cjs": { size: 1 } } },
        renderer: { files: { "index.html": { size: 1 } } },
      },
    },
  },
});
const addFile = (value, filePath) => {
  const parts = filePath.split("/");
  let directory = value.files;
  for (const part of parts.slice(0, -1)) {
    directory[part] ??= { files: {} };
    directory = directory[part].files;
  }
  directory[parts.at(-1)] = { size: 1 };
};

const {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { auditCli } = require("../build/audit-package.cjs");
test("rejects missing CAD resources in the copied application, independently of the checkout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cad-copied-package-"));
  try {
    await assert.rejects(
      require("../build/audit-package.cjs").auditPackagedDrawing(directory, "darwin", "arm64"),
      /ENOENT/,
    );
    await assert.rejects(
      require("../build/prepare-development.cjs").prepareDevelopment(directory),
      /离线 CAD 组件/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("requires standalone CLI resources and verifies bundled runtime hash", () => {
  const directory = mkdtempSync(join(tmpdir(), "zxw-cli-package-"));
  try {
    assert.throws(() => auditCli(directory));
    mkdirSync(join(directory, "runtime"));
    for (const name of ["index.cjs", "manual.md", "zxw.cmd", "runtime/LICENSE.txt"])
      writeFileSync(join(directory, name), "fixture");
    const binary = Buffer.from("isolated-runtime-fixture");
    writeFileSync(join(directory, "runtime/node.exe"), binary);
    writeFileSync(
      join(directory, "runtime/provenance.json"),
      JSON.stringify({
        version: "24.15.0",
        url: "https://nodejs.org/dist/v24.15.0/win-x64/node.exe",
        sha256: createHash("sha256").update(binary).digest("hex"),
      }),
    );
    assert.doesNotThrow(() => auditCli(directory));
    writeFileSync(join(directory, "runtime/node.exe"), "tampered");
    assert.throws(() => auditCli(directory), /checksum mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("accepts runtime entries and rejects old instance and source maps", () => {
  assert.doesNotThrow(() => auditHeader(header()));
  for (const name of ["main-hover-live", "manual-vite-cache-v2"]) {
    const h = header();
    h.files.out.files[name] = { files: { data: { size: 1 } } };
    assert.throws(() => auditHeader(h), /development files/u);
  }
  const h = header();
  h.files.out.files.renderer.files["index.js.map"] = { size: 1 };
  assert.throws(() => auditHeader(h), /development files/u);
  assert.throws(() => auditHeader({ files: {} }), /Missing application entry/u);
});

test("Mac CLI requires target provenance, executable launchers and intact runtime", () => {
  const directory = mkdtempSync(join(tmpdir(), "zxw-mac-cli-"));
  try {
    mkdirSync(join(directory, "runtime"));
    for (const name of ["index.cjs", "manual.md", "zxw", "runtime/LICENSE.txt"])
      writeFileSync(join(directory, name), "fixture", { mode: 0o755 });
    const binary = Buffer.from("isolated-mac-runtime");
    writeFileSync(join(directory, "runtime/node"), binary, { mode: 0o755 });
    const provenance = {
      version: "24.15.0",
      platform: "darwin",
      arch: "arm64",
      url: "https://nodejs.org/dist/v24.15.0/node-v24.15.0-darwin-arm64.tar.gz",
      archiveSha256: "a".repeat(64),
      sha256: createHash("sha256").update(binary).digest("hex"),
    };
    writeFileSync(join(directory, "runtime/provenance.json"), JSON.stringify(provenance));
    assert.doesNotThrow(() => auditCli(directory, "darwin", "arm64"));
    assert.throws(() => auditCli(directory, "darwin", "x64"), /provenance/);
    if (process.platform !== "win32") {
      chmodSync(join(directory, "zxw"), 0o644);
      assert.throws(() => auditCli(directory, "darwin", "arm64"), /EACCES/);
      chmodSync(join(directory, "zxw"), 0o755);
    }
    writeFileSync(join(directory, "runtime/node"), "tampered");
    assert.throws(() => auditCli(directory, "darwin", "arm64"), /checksum mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mac distribution includes and signs the standalone CLI after vendoring its runtime", () => {
  const { load } = require("js-yaml");
  const config = load(readFileSync(join(__dirname, "../electron-builder.yml"), "utf8"));
  const cli = config.mac.extraResources.find((entry) => entry.to === "cli");
  assert.equal(cli.from, "out/cli");
  for (const name of [
    "index.cjs",
    "manual.md",
    "zxw",
    "runtime/node",
    "runtime/LICENSE.txt",
    "runtime/provenance.json",
  ])
    assert.ok(cli.filter.includes(name));
  assert.ok(config.mac.binaries.includes("Contents/Resources/cli/runtime/node"));
  const workflow = readFileSync(join(__dirname, "dist-mac.mjs"), "utf8");
  const manifest = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
  assert.equal(manifest.scripts["vendor:cli"], "node scripts/vendor-cli-runtime.mjs");
  assert.ok(workflow.indexOf('"vendor:cli"') > workflow.indexOf('"build:app"'));
  assert.ok(workflow.indexOf('"vendor:cli"') < workflow.indexOf('"electron-builder"'));
});

test("rejects hidden test entries and missing mac native libraries", () => {
  const h = header();
  h.files.out.files.main.files["index.hidden-test-1.mjs"] = { size: 1 };
  assert.throws(() => auditHeader(h), /development files/);
  const mac = header();
  for (const filePath of [
    "node_modules/detect-libc/index.js",
    "node_modules/semver/index.js",
    "node_modules/@img/colour/index.js",
  ])
    addFile(mac, filePath);
  assert.throws(
    () => auditHeader(mac, { platform: "darwin", arch: "arm64" }),
    /Missing native dependency/,
  );
});

test("rejects Windows packages that omit Sharp runtime dependencies", () => {
  const windows = { platform: "win32", arch: "x64" };
  assert.throws(() => auditHeader(header(), windows), /Missing Sharp runtime dependency/u);

  const complete = header();
  for (const filePath of [
    "node_modules/detect-libc/index.js",
    "node_modules/semver/index.js",
    "node_modules/@img/colour/index.js",
    "node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node",
  ])
    addFile(complete, filePath);
  assert.doesNotThrow(() => auditHeader(complete, windows));
});
