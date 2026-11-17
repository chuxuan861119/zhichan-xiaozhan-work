import { execFileSync } from "node:child_process";
export const MAC_ACCEPTANCE_CHECKS = [
  "install-open-dock",
  "startup-quit-save",
  "patdoc-roundtrip",
  "docx-pdf-export",
  "printing",
  "cad-import-zoom",
  "flowchart-edit",
  "native-shortcuts",
  "keychain-recovery",
  "ai-consent-disable",
  "file-permissions",
];
export function validateMacAcceptance(report, expected) {
  if (
    report?.sourceCommit !== expected.commit ||
    report?.version !== expected.version ||
    report?.arch !== expected.arch ||
    report?.physicalDevice !== true ||
    typeof report?.systemVersion !== "string" ||
    !report.systemVersion.trim() ||
    !Number.isFinite(Date.parse(report?.testedAt))
  )
    throw new Error(
      "Mac 验收报告必须来自真实设备，匹配当前提交、版本和架构，并包含系统版本与验收时间。",
    );
  for (const id of MAC_ACCEPTANCE_CHECKS) {
    const check = report.checks?.[id];
    if (check?.status !== "passed" || typeof check.evidence !== "string" || !check.evidence.trim())
      throw new Error(`Mac 人工验收未完成：${id}`);
  }
}
export function assertMacReleaseSource(source, expectedCommit) {
  if (
    !/^[a-f0-9]{40}$/u.test(source.commit) ||
    source.status.trim() ||
    (expectedCommit && source.commit !== expectedCommit)
  )
    throw new Error(
      "Mac 正式构建需要干净且未变动的 Git 提交。请单独提交本次相关改动后重试；脚本不会自动清理或回退工作区。",
    );
}
export function readMacReleaseSource(root) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return {
    commit: git(["rev-parse", "HEAD"]),
    status: git(["status", "--porcelain", "--untracked-files=normal"]),
  };
}
// Applied only to Mac release binaries; dev/Harmony custom runtimes keep their launch contracts.
export const MAC_ELECTRON_FUSES = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
};
