import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
  throw new Error("Build native tools on the target Mac architecture.");
const root = resolve("resources/platform-tools");
await mkdir(root, { recursive: true });
const executable = `${root}/move-no-replace`;
const source = resolve("tools/platform/macos-move.c");
const sdk = spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" });
if (sdk.status !== 0)
  throw new Error("macOS SDK is unavailable; configure Xcode or Command Line Tools first.");
const build = spawnSync(
  process.env.CC || "cc",
  [
    "-isysroot",
    sdk.stdout.trim(),
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-arch",
    process.arch === "x64" ? "x86_64" : "arm64",
    "-mmacosx-version-min=14.0",
    source,
    "-o",
    executable,
  ],
  { stdio: "inherit" },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const displaySource = resolve("tools/platform/macos-display-size.c");
const displayExecutable = root + "/display-width-mm";
const displayBuild = spawnSync(
  process.env.CC || "cc",
  [
    "-isysroot",
    sdk.stdout.trim(),
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-arch",
    process.arch === "x64" ? "x86_64" : "arm64",
    "-mmacosx-version-min=14.0",
    displaySource,
    "-framework",
    "CoreGraphics",
    "-o",
    displayExecutable,
  ],
  { stdio: "inherit" },
);
if (displayBuild.error) throw displayBuild.error;
if (displayBuild.status !== 0) process.exit(displayBuild.status ?? 1);
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
await writeFile(
  `${root}/manifest.json`,
  JSON.stringify(
    {
      target: `osx-${process.arch}`,
      displayWidth: {
        sourceSha256: await hash(displaySource),
        sha256: await hash(displayExecutable),
      },
      sourceSha256: await hash(source),
      cleanupSourceSha256: await hash(resolve("tools/platform/owned-cleanup.h")),
      sha256: await hash(executable),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Native Mac file helper ready: osx-${process.arch}`);
