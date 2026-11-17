#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_REQUIREMENTS } from "./release-requirements.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function summarizeReleaseEvidence(results) {
  const failedAutomated = results.filter(
    (item) => item.kind === "automated" && item.status !== "passed",
  );
  const pendingManual = results.filter(
    (item) => item.kind === "manual" && item.status !== "passed",
  );
  return {
    automatedGate: failedAutomated.length === 0 ? "passed" : "failed",
    releaseReady: failedAutomated.length === 0 && pendingManual.length === 0,
    blockers: [
      ...failedAutomated.map((item) => `自动门禁失败：${item.label}`),
      ...pendingManual.map((item) => `人工证据未完成：${item.label}`),
    ],
  };
}

export function assertCleanReleaseWorktree(status) {
  if (status.trim().length > 0) {
    throw new Error("工作区不干净，拒绝把未提交改动的结果归属到当前提交。请先提交或还原改动。");
  }
}

export function evidenceLogPath(commit, requirementId) {
  return `release/evidence/${commit}/logs/${requirementId}.log`;
}

function markdown(report) {
  const lines = [
    `# 发布证据（${report.commit}）`,
    "",
    `生成时间：${report.generatedAt}`,
    "",
    `自动门禁：${report.summary.automatedGate === "passed" ? "通过" : "失败"}`,
    `正式发布就绪：${report.summary.releaseReady ? "是" : "否"}`,
    "",
    "| 检查项 | 类型 | 状态 | 耗时 | 证据 |",
    "| --- | --- | --- | --- | --- |",
    ...report.results.map(
      (item) =>
        `| ${item.label} | ${item.kind === "automated" ? "自动" : "人工"} | ${item.status} | ${item.durationMs ?? "-"} ms | ${item.evidencePath ?? "-"} |`,
    ),
    "",
    "## 阻塞项",
    "",
    ...(report.summary.blockers.length > 0
      ? report.summary.blockers.map((item) => `- ${item}`)
      : ["- 无"]),
    "",
    "> 人工项不会因源码存在或自动化通过而自动标记为通过。",
  ];
  return `${lines.join("\n")}\n`;
}

export function runReleaseEvidence() {
  assertCleanReleaseWorktree(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: ROOT,
      encoding: "utf8",
    }),
  );
  const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const outputDirectory = join(ROOT, "release", "evidence", commit);
  const logDirectory = join(outputDirectory, "logs");
  mkdirSync(logDirectory, { recursive: true });
  const results = [];
  for (const requirement of RELEASE_REQUIREMENTS) {
    if (requirement.kind === "manual") {
      results.push({ ...requirement, status: "not-run" });
      continue;
    }
    const started = Date.now();
    const outcome = spawnSync(requirement.command, {
      cwd: ROOT,
      encoding: "utf8",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const evidencePath = evidenceLogPath(commit, requirement.id);
    const log = [
      `$ ${requirement.command}`,
      "",
      outcome.stdout ?? "",
      outcome.stderr ?? "",
      `exitCode=${String(outcome.status)}`,
    ].join("\n");
    writeFileSync(resolve(ROOT, evidencePath), log);
    process.stdout.write(outcome.stdout ?? "");
    process.stderr.write(outcome.stderr ?? "");
    results.push({
      ...requirement,
      status: outcome.status === 0 ? "passed" : "failed",
      exitCode: outcome.status,
      durationMs: Date.now() - started,
      evidencePath,
    });
  }
  const report = {
    version: 1,
    commit,
    generatedAt: new Date().toISOString(),
    results,
    summary: summarizeReleaseEvidence(results),
  };
  writeFileSync(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outputDirectory, "report.md"), markdown(report));
  console.log(`\n发布证据已写入：${outputDirectory}`);
  process.exitCode = report.summary.automatedGate === "passed" ? 0 : 1;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReleaseEvidence();
}
