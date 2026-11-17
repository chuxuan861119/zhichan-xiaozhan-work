// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const { rendererDevelopmentOptions } = require("../build/renderer-development.cjs");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function json(file: string, value: unknown) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

async function install(modules: string, name: string, version: string) {
  await json(join(modules, name, "package.json"), {
    name,
    version,
    exports: { ".": "./index.cjs" },
  });
  await writeFile(join(modules, name, "index.cjs"), "module.exports = {};");
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "patent-dependency-environment-"));
  roots.push(parent);
  const root = join(parent, "worktrees", "app");
  const modules = join(parent, "node_modules");
  const dependencies = { "pdfjs-dist": "1.2.3", "@audit/runtime": "2.3.4" };
  await mkdir(join(root, "node_modules"), { recursive: true });
  await json(join(root, "package.json"), { dependencies });
  await json(join(root, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { dependencies },
      "node_modules/pdfjs-dist": { version: "1.2.3" },
      "node_modules/@audit/runtime": { version: "2.3.4" },
    },
  });
  for (const [name, version] of Object.entries(dependencies)) await install(modules, name, version);
  return { root, parent, modules, dependencies };
}

function check(root: string): { checkedCount: number; issues: string[] } {
  return require("./check-installed-dependencies.cjs").checkInstalledDependencies(root);
}

test("development allows resolved parent dependencies when local node_modules is partial", async () => {
  const f = await fixture();
  const options = rendererDevelopmentOptions(f.root);
  expect(options.server.fs.allow).toContain(f.modules);
  expect(options.server.fs.allow).not.toContain(f.parent);
  expect(options.cacheDir).toBe(join(f.root, "out", "node_modules", ".vite", "renderer"));
  expect(options.optimizeDeps.exclude).toContain("ketcher-standalone");
});

test("dependency check accepts locked versions resolved from the parent", async () => {
  const f = await fixture();
  expect(check(f.root)).toEqual({ checkedCount: 2, issues: [] });
});

test("dependency check detects old versions despite otherwise valid parent dependencies", async () => {
  const f = await fixture();
  await install(f.modules, "@audit/runtime", "2.3.3");
  expect(check(f.root).issues.join("\n")).toMatch(/@audit\/runtime.*2\.3\.4.*2\.3\.3/u);
});

test("local dependencies shadow parent versions and cannot evade the version check", async () => {
  const f = await fixture();
  await install(join(f.root, "node_modules"), "pdfjs-dist", "1.2.2");
  expect(check(f.root).issues.join("\n")).toMatch(/pdfjs-dist.*1\.2\.3.*1\.2\.2/u);
});

test("dependency check reports missing packages instead of treating them as verified", async () => {
  const f = await fixture();
  await json(join(f.root, "package.json"), {
    dependencies: { ...f.dependencies, "@audit/missing": "1.0.0" },
  });
  await json(join(f.root, "package-lock.json"), {
    packages: {
      "": { dependencies: { ...f.dependencies, "@audit/missing": "1.0.0" } },
      "node_modules/pdfjs-dist": { version: "1.2.3" },
      "node_modules/@audit/runtime": { version: "2.3.4" },
      "node_modules/@audit/missing": { version: "1.0.0" },
    },
  });
  expect(check(f.root).issues.join("\n")).toMatch(/@audit\/missing.*未安装/u);
});

test("dependency check rejects a stale lockfile even if installed versions match it", async () => {
  const f = await fixture();
  await json(join(f.root, "package.json"), {
    dependencies: { ...f.dependencies, "pdfjs-dist": "1.2.4" },
  });
  expect(check(f.root).issues.join("\n")).toMatch(/pdfjs-dist.*锁文件/u);
});

test("command fails fast with a repair instruction when a dependency version is stale", async () => {
  const f = await fixture();
  await install(f.modules, "pdfjs-dist", "1.2.2");
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/check-installed-dependencies.cjs")],
    {
      cwd: f.root,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("pdfjs-dist");
  expect(result.stderr).toContain("npm ci");
});
