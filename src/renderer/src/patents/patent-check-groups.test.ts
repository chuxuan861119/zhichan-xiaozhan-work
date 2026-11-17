import { describe, expect, test } from "vitest";
import type { InspectionIssue } from "../../../shared/patent-inspection/types";
import { conciseIssueSummary, groupCheckIssues } from "./patent-check-groups";

function issue(overrides: Partial<InspectionIssue>): InspectionIssue {
  return {
    fingerprint: "test",
    ruleId: "test",
    ruleVersion: 1,
    source: "deterministic",
    category: "drawing-reference",
    legacyCode: "drawing-missing-figure",
    severity: "warning",
    confidence: "certain",
    summary: "图1缺少附图说明。",
    evidence: [],
    recommendation: null,
    locations: [{ bookKind: "description-drawings", targetId: "figure1" }],
    ...overrides,
  };
}
describe("concise check groups", () => {
  test("lists missing caption figure numbers in natural order", () => {
    const problems = [11, 2, 1].map((n) =>
      issue({
        fingerprint: String(n),
        summary: `图${n}缺少附图说明。`,
        identityKey: `explanation:${n}`,
      }),
    );
    expect(groupCheckIssues(problems)[0]?.title).toBe("图1、图2、图11缺少附图说明");
  });
  test("does not merge missing image references with missing captions", () => {
    const missingCaption = issue({ identityKey: "explanation:1" });
    const missingImage = issue({
      fingerprint: "ref",
      summary: "正文引用的图9不存在。",
      identityKey: "reference:1",
    });
    expect(groupCheckIssues([missingCaption, missingImage])).toHaveLength(2);
  });
  test("retains every occurrence and the highest severity", () => {
    const first = issue({ severity: "warning" });
    const second = issue({ fingerprint: "second", severity: "error" });
    const groups = groupCheckIssues([first, second]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.issue.severity).toBe("error");
    expect(groups[0]?.members).toEqual([first, second]);
  });
  test("keeps definite findings separate from candidates of the same rule", () => {
    const definite = issue({ severity: "error", confidence: "certain" });
    const candidate = issue({
      fingerprint: "candidate",
      severity: "suggestion",
      confidence: "likely",
    });
    expect(groupCheckIssues([candidate, definite]).map((group) => group.issue)).toEqual([
      definite,
      candidate,
    ]);
  });
  test("keeps optional chapter advice out of a required chapter problem group", () => {
    const required = issue({
      ruleId: "core.description.chapter-body",
      legacyCode: "missing-description-chapter",
      summary: "技术领域还没有正文。",
    });
    const optional = issue({
      ruleId: required.ruleId,
      legacyCode: required.legacyCode,
      fingerprint: "optional",
      severity: "suggestion",
      summary: "有益效果还没有正文。",
    });
    const groups = groupCheckIssues([required, optional]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.members)).toEqual([[required], [optional]]);
  });
  test("shortens a long message without deleting its detailed wording", () => {
    const original = issue({
      legacyCode: "claim-paragraph-ending",
      summary: `权利要求1的非末段包含中文句号“。”且其后仍有文字，请将句号保留在权利要求末段。请再次核对段落。`,
    });
    expect(conciseIssueSummary(original).length).toBeLessThan(30);
    expect(conciseIssueSummary(original, true)).toBe(original.summary);
  });
  test("preserves technical terms from the original patent in detailed results", () => {
    const original = issue({
      legacyCode: "claim-keyword-reference-warning",
      summary: "权利要求1的主题名称“结构化书册扫描装置”未在说明书中找到完全一致的表述。",
    });
    expect(conciseIssueSummary(original, true)).toBe(original.summary);
  });
  test("uses a neutral short title for an incompatible-unit range candidate", () => {
    const original = issue({
      legacyCode: "numeric-range-reversed",
      confidence: "likely",
      summary: "范围“范围下限为80℃，上限为20mm”的上下限单位量纲不同，请结合具体技术内容核对。",
    });
    expect(conciseIssueSummary(original)).toBe("核对数值范围");
  });
  test("folds a generic sync warning into the specific missing-caption findings", () => {
    const problems = [1, 2].map((n) =>
      issue({
        fingerprint: `caption${n}`,
        identityKey: `explanation:${n}`,
        summary: `图${n}缺少附图说明。`,
      }),
    );
    problems.push(
      issue({
        fingerprint: "sync",
        ruleId: "core.drawings.explanation-sync",
        legacyCode: "drawing-explanation-sync-paused",
        summary: "附图说明与现有附图存在缺失、重复、越界或顺序问题，请核对。",
      }),
    );
    const groups = groupCheckIssues(problems);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("图1、图2缺少附图说明");
  });
});
