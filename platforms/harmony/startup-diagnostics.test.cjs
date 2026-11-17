const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const prepare = require("./startup-diagnostics.cjs");
test("relocates a recognized launcher report without discarding its bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-diagnostics-"));
  try {
    const bytes = JSON.stringify({
      platform: "openharmony",
      source: { buildId: "synthetic" },
      startedAt: "2026-10-21T00:00:00Z",
      windows: [],
      errors: [],
    });
    await fs.writeFile(path.join(root, "harmony-startup.json"), bytes);
    const cache = prepare(root);
    const files = await fs.readdir(cache);
    assert.equal(files.length, 1);
    assert.equal(await fs.readFile(path.join(cache, files[0]), "utf8"), bytes);
    await assert.rejects(fs.stat(path.join(root, "harmony-startup.json")), { code: "ENOENT" });
    assert.equal(prepare(root), cache);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("does not relocate an unknown file or follow a legacy report symlink", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-diagnostics-"));
  try {
    const legacy = path.join(root, "harmony-startup.json");
    await fs.writeFile(legacy, "unrecognized");
    prepare(root);
    assert.equal(await fs.readFile(legacy, "utf8"), "unrecognized");
    const next = path.join(root, "next");
    await fs.mkdir(next);
    await fs.symlink(legacy, path.join(next, "harmony-startup.json"));
    prepare(next);
    assert.equal((await fs.lstat(path.join(next, "harmony-startup.json"))).isSymbolicLink(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
