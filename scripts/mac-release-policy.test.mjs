import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMacReleaseSource,
  MAC_ACCEPTANCE_CHECKS,
  validateMacAcceptance,
} from "./mac-release-policy.mjs";

const expected = { commit: "a".repeat(40), version: "1.1.1", arch: "arm64" };
const valid = () => ({
  sourceCommit: expected.commit,
  version: expected.version,
  arch: expected.arch,
  physicalDevice: true,
  systemVersion: "14.0",
  testedAt: "2026-10-04T00:00:00Z",
  checks: Object.fromEntries(
    MAC_ACCEPTANCE_CHECKS.map((id) => [
      id,
      { status: "passed", evidence: "test fixture, not release evidence" },
    ]),
  ),
});
test("formal releases reject dirty, unknown or changed source without cleaning it", () => {
  assert.doesNotThrow(() => assertMacReleaseSource({ commit: expected.commit, status: "" }));
  for (const source of [
    { commit: "", status: "" },
    { commit: expected.commit, status: " M src/main/index.ts" },
  ])
    assert.throws(() => assertMacReleaseSource(source), /干净/u);
  assert.throws(
    () => assertMacReleaseSource({ commit: "b".repeat(40), status: "" }, expected.commit),
    /未变动/u,
  );
});
test("manual evidence must match the actual source and cover every Mac boundary", () => {
  assert.doesNotThrow(() => validateMacAcceptance(valid(), expected));
  for (const patch of [
    { sourceCommit: "other" },
    { arch: "x64" },
    { physicalDevice: false },
    { testedAt: "invalid" },
    { version: "old" },
  ])
    assert.throws(() => validateMacAcceptance({ ...valid(), ...patch }, expected), /验收/u);
  for (const id of MAC_ACCEPTANCE_CHECKS) {
    const report = valid();
    report.checks[id].status = "not-run";
    assert.throws(() => validateMacAcceptance(report, expected), new RegExp(id));
    report.checks[id] = { status: "passed", evidence: "" };
    assert.throws(() => validateMacAcceptance(report, expected), new RegExp(id));
  }
});
