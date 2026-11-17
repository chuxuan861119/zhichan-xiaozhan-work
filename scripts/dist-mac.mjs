import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertMacReleaseSource,
  readMacReleaseSource,
  validateMacAcceptance,
} from "./mac-release-policy.mjs";

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
  throw new Error("请在目标架构的 Mac 上构建。");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const local = process.argv.includes("--local");
if (!local && (!process.env.CSC_NAME || !process.env.APPLE_KEYCHAIN_PROFILE)) {
  throw new Error(
    "正式分发需要 CSC_NAME 签名身份和 APPLE_KEYCHAIN_PROFILE 公证凭据；本地验收使用 npm run dist:mac:local。",
  );
}
let releaseCommit;
if (!local) {
  const source = readMacReleaseSource(root);
  assertMacReleaseSource(source);
  releaseCommit = source.commit;
  if (!process.env.MAC_ACCEPTANCE_REPORT)
    throw new Error(
      "正式构建还需要 MAC_ACCEPTANCE_REPORT，提供匹配当前提交的真实 Mac 人工验收记录。",
    );
  validateMacAcceptance(JSON.parse(readFileSync(process.env.MAC_ACCEPTANCE_REPORT, "utf8")), {
    commit: source.commit,
    arch: process.arch,
    version: JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version,
  });
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("npm", ["run", "vendor:mac-tools"]);
run("npm", ["run", "vendor:cad"]);
if (local) {
  run("npm", ["run", "verify:mac"]);
  run("npm", ["run", "build:app"]);
} else {
  run("npm", ["run", "build"]);
}
run("npm", ["run", "vendor:cli"]);
run("npm", ["run", "generate:icon"]);
run(process.execPath, ["scripts/generate-mac-dmg-background.mjs"]);
run("npm", ["run", "audit:licenses"]);
run("npm", ["run", "audit:drawings"]);
if (!local) assertMacReleaseSource(readMacReleaseSource(root), releaseCommit);
run("npx", [
  "--no-install",
  "electron-builder",
  "--mac",
  `--${process.arch}`,
  "--publish",
  "never",
  ...(local ? ["-c.mac.identity=-", "-c.mac.notarize=false"] : ["-c.forceCodeSigning=true"]),
]);
