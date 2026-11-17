import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(resolve(root, path));
const json = (path) => JSON.parse(read(path).toString("utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baseline = json("SOURCE_BASELINE.json");
const manifest = json(baseline.manifest);
assert.equal(baseline.sourceCommit, "c6d08fb15bf75eec8151dfc01fee4f1308099a10");
assert.equal(manifest.sourceCommit, baseline.sourceCommit);
assert.equal(json("package.json").version, "1.1.8");
assert.equal(json("package.json").license, "GPL-3.0-only");
assert.match(read("LICENSE").toString(), /Version 3, 29 June 2007/u);
assert.match(
  read("src/shared/patent/model.ts").toString(),
  /z\.enum\(\["invention", "utility-model"\]\)/u,
);
assert.equal(existsSync(resolve(root, "src/renderer/src/design-patent")), false);
assert.equal(existsSync(resolve(root, "src/renderer/src/three-d")), false);
assert.equal(json("resources/usage-statistics-channel.json").endpoint, "");
assert.equal(json("resources/update-channel.json").feedUrl, "");

const expected = new Map(manifest.files.map((file) => [file.path, file]));
const adaptations = new Set(manifest.adaptedBaselineFiles);
const record = json("docs/releases/1.1.8-publication-files.json");
let unchanged = 0;
for (const file of manifest.files) {
  const actual = sha(read(file.path));
  if (adaptations.has(file.path)) {
    assert.equal(actual, record.files[file.path], `Unreviewed adaptation: ${file.path}`);
  } else {
    assert.equal(actual, file.sha256, `Changed baseline source: ${file.path}`);
    unchanged++;
  }
}
for (const [path, digest] of Object.entries(record.files)) {
  assert.equal(sha(read(path)), digest, `Changed publication material: ${path}`);
}
const readme = read("README.md").toString("utf8");
const images = [...readme.matchAll(/!\[[^\]]+\]\(([^)]+)\)/gu)];
assert.equal(images.length, 12);
for (const image of images) assert.ok(existsSync(resolve(root, image[1])));
assert.ok(readme.includes("中国专利") && readme.includes("https://zcxzz.cn/"));

// Verify the actual index before committing, and the same tracked set after cloning.
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
assert.ok(tracked.length > 0, "Stage the explicit publication file list before verifying");
for (const path of tracked) {
  assert.ok(
    expected.has(path) ||
      Object.hasOwn(record.files, path) ||
      path === "docs/releases/1.1.8-publication-files.json",
    `Unexpected tracked file: ${path}`,
  );
  assert.ok(!/^(?:website|\.workbuddy|\.worktrees)\//u.test(path), path);
}
for (const path of expected.keys())
  assert.ok(tracked.includes(path), `Untracked baseline: ${path}`);
for (const path of Object.keys(record.files))
  assert.ok(tracked.includes(path), `Untracked publication material: ${path}`);
console.log(
  `1.1.8 source scope verified: ${unchanged} unchanged baseline files; ${adaptations.size} documented adaptations; ${tracked.length} tracked files; 12 images.`,
);
