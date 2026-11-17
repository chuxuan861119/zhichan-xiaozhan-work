const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

function createBuildInfo({ version, builtAt, commit, dirty, mode }) {
  const stamp = new Date(builtAt).toISOString().replace(/[-:.]/g, "");
  return {
    version,
    builtAt,
    commit,
    dirty,
    mode,
    buildId: `${stamp}-${commit ? commit.slice(0, 8) : "source-unknown"}${dirty ? "-dirty" : ""}`,
  };
}

function captureBuildInfo(root, mode) {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  let commit = null;
  let dirty = null;
  try {
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    commit = git("rev-parse", "HEAD");
    dirty =
      git("status", "--porcelain", "--untracked-files=no").length > 0 ||
      git(
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--",
        "src",
        "tests",
        "scripts",
        "build",
        "resources",
        "package.json",
        "package-lock.json",
        "electron.vite.config.ts",
        "electron-builder.yml",
        "tsconfig.node.json",
        "tsconfig.web.json",
      ).length > 0;
  } catch {
    // Source archives may have no Git database. Never imply a verified clean commit.
    commit = null;
    dirty = null;
    console.warn("Build provenance unavailable: this build will be marked source-unknown.");
  }
  return createBuildInfo({ version, builtAt: new Date().toISOString(), commit, dirty, mode });
}

function validateBuildPair(main, renderer, version) {
  const valid = (info) =>
    info &&
    info.version === version &&
    info.mode === "production" &&
    typeof info.builtAt === "string" &&
    Number.isFinite(Date.parse(info.builtAt)) &&
    (info.commit === null || /^[a-f0-9]{40,64}$/.test(info.commit)) &&
    [null, true, false].includes(info.dirty) &&
    info.buildId === createBuildInfo(info).buildId;
  if (!valid(main) || !valid(renderer) || JSON.stringify(main) !== JSON.stringify(renderer)) {
    throw new Error("构建信息缺失、不一致或不是生产构建，请重新运行 npm run build:app 后再打包。");
  }
  return main;
}

async function beforePack(context) {
  const root = context.packager.projectDir;
  const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const info = validateBuildPair(
    read("out/main/build-info.json"),
    read("out/renderer/build-info.json"),
    read("package.json").version,
  );
  // Read by electron-builder's artifact-name macro after beforePack.
  process.env.PATENT_BUILD_ID = info.buildId;
}

module.exports = beforePack;
Object.assign(module.exports, { createBuildInfo, captureBuildInfo, validateBuildPair });
