import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  assertCleanReleaseWorktree,
  evidenceLogPath,
  summarizeReleaseEvidence,
} from "./release-evidence.mjs";
import { RELEASE_REQUIREMENTS } from "./release-requirements.mjs";

test("keeps automated checks separate from manual release evidence", () => {
  assert.ok(RELEASE_REQUIREMENTS.some((item) => item.kind === "automated"));
  assert.ok(RELEASE_REQUIREMENTS.some((item) => item.kind === "manual"));
  assert.ok(RELEASE_REQUIREMENTS.every((item) => item.id && item.label));
});

test("blocks release while manual evidence is missing", () => {
  const summary = summarizeReleaseEvidence(
    RELEASE_REQUIREMENTS.map((item) => ({
      ...item,
      status: item.kind === "automated" ? "passed" : "not-run",
    })),
  );
  assert.equal(summary.automatedGate, "passed");
  assert.equal(summary.releaseReady, false);
  assert.ok(summary.blockers.some((item) => item.includes("人工")));
});

test("fails the automated gate when a command fails", () => {
  const summary = summarizeReleaseEvidence([
    { id: "check", label: "静态检查", kind: "automated", status: "failed" },
  ]);
  assert.equal(summary.automatedGate, "failed");
  assert.equal(summary.releaseReady, false);
});

test("requires real Mac installation and input evidence before release", () => {
  for (const id of ["mac-arm64", "mac-x64", "mac-gatekeeper", "mac-input"]) {
    assert.equal(RELEASE_REQUIREMENTS.find((item) => item.id === id)?.kind, "manual");
  }
  const results = RELEASE_REQUIREMENTS.map((item) => ({ ...item, status: "passed" }));
  results.find((item) => item.id === "mac-gatekeeper").status = "not-run";
  assert.equal(summarizeReleaseEvidence(results).releaseReady, false);
});

test("refuses to attribute dirty-worktree results to the current commit", () => {
  assert.throws(() => assertCleanReleaseWorktree(" M src/main/index.ts\n"), /工作区不干净/u);
  assert.doesNotThrow(() => assertCleanReleaseWorktree(""));
});

test("assigns every automated requirement a stable, commit-scoped evidence log", () => {
  assert.equal(
    evidenceLogPath("abc123", "flowchart-e2e"),
    "release/evidence/abc123/logs/flowchart-e2e.log",
  );
  for (const requirement of RELEASE_REQUIREMENTS.filter((item) => item.kind === "automated")) {
    assert.match(
      evidenceLogPath("abc123", requirement.id),
      /^release\/evidence\/abc123\/logs\/.+\.log$/u,
    );
  }
});

test("user guide does not advertise the retired chart feature", () => {
  assert.doesNotMatch(readFileSync(resolve("docs/user-guide.md"), "utf8"), /实验图/u);
});
