import { describe, expect, test } from "vitest";
import { createBlankPatent } from "../patent/defaults.js";
import { runPatentInspection } from "./engine.js";
import { HEURISTIC_RULE, PRODUCT_POLICY } from "./rule-provenance.js";
import type { InspectionIssueDraft, PatentInspectionRule } from "./types.js";

const issueDraft: InspectionIssueDraft = {
  legacyCode: "empty-required-book",
  severity: "warning",
  confidence: "certain",
  summary: "权利要求书尚未填写。",
  evidence: [],
  locations: [{ kind: "book", bookKind: "claims", targetId: null }],
  recommendation: null,
};

const issueRule: PatentInspectionRule = {
  id: "test.books.empty",
  version: 1,
  category: "formal",
  defaultSeverity: "warning",
  cost: "instant",
  dependencies: ["claims"],
  provenance: PRODUCT_POLICY.claimPunctuation,
  appliesTo: () => true,
  inspect: () => [issueDraft],
};

function createPatent() {
  return createBlankPatent(
    { patentType: "invention", name: "检查测试" },
    {
      now: () => new Date("2026-08-11T08:00:00.000Z"),
      createId: (() => {
        let sequence = 0;
        return () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
      })(),
    },
  );
}

describe("runPatentInspection", () => {
  test("caps report size and explicitly reports incomplete checks", () => {
    const report = runPatentInspection(createPatent(), [
      {
        ...issueRule,
        inspect: () =>
          Array.from({ length: 1200 }, (_, i) => ({ ...issueDraft, identityKey: String(i) })),
      },
    ]);
    expect(report.issues.length).toBeLessThanOrEqual(1000);
    expect(report.degradedRules.some((rule) => rule.message.includes("上限"))).toBe(true);
  });
  test("produces a versioned report and a stable issue fingerprint", () => {
    const patent = createPatent();
    const first = runPatentInspection(patent, [issueRule], {
      now: () => new Date("2026-08-11T08:01:00.000Z"),
    });
    const second = runPatentInspection(patent, [issueRule], {
      now: () => new Date("2026-08-11T08:02:00.000Z"),
    });

    expect(first.engineVersion).toBe(12);
    expect(first.patentId).toBe(patent.patentId);
    expect(first.patentRevision).toBe(patent.revision);
    expect(first.checkedAt).toBe("2026-08-11T08:01:00.000Z");
    expect(first.issues[0]?.fingerprint).toBe(second.issues[0]?.fingerprint);
    expect(first.degradedRules).toEqual([]);
  });

  test("reports one failed rule without discarding successful issues", () => {
    const failingRule: PatentInspectionRule = {
      ...issueRule,
      id: "test.failure",
      inspect: () => {
        throw new Error("boom: patent content must not escape");
      },
    };
    const report = runPatentInspection(createPatent(), [failingRule, issueRule]);

    expect(report.issues).toHaveLength(1);
    expect(report.degradedRules).toEqual([
      expect.objectContaining({ ruleId: "test.failure", message: "该项检查未完成。" }),
    ]);
    expect(JSON.stringify(report)).not.toContain("patent content must not escape");
  });

  test("orders issues deterministically", () => {
    const errorRule: PatentInspectionRule = {
      ...issueRule,
      id: "test.error",
      category: "grammar",
      inspect: () => [
        {
          ...issueDraft,
          severity: "error",
          summary: "说明书存在阻断问题。",
          locations: [{ kind: "book", bookKind: "description", targetId: null }],
        },
      ],
    };

    const report = runPatentInspection(createPatent(), [issueRule, errorRule]);

    expect(report.issues.map((issue) => issue.ruleId)).toEqual(["test.error", "test.books.empty"]);
  });

  test("uses a stable identity key to distinguish issues at the same location", () => {
    const identityRule: PatentInspectionRule = {
      ...issueRule,
      inspect: () => [
        { ...issueDraft, identityKey: "missing-parent:8", summary: "缺少引用 8。" },
        { ...issueDraft, identityKey: "missing-parent:9", summary: "缺少引用 9。" },
      ],
    };

    const report = runPatentInspection(createPatent(), [identityRule]);

    expect(report.issues).toHaveLength(2);
    expect(new Set(report.issues.map((issue) => issue.fingerprint)).size).toBe(2);
  });

  test("deduplicates identical issues without tying identity to display wording", () => {
    const duplicateRule: PatentInspectionRule = {
      ...issueRule,
      inspect: () => [
        { ...issueDraft, identityKey: "book:claims", summary: "旧文案" },
        { ...issueDraft, identityKey: "book:claims", summary: "新文案" },
      ],
    };

    const report = runPatentInspection(createPatent(), [duplicateRule]);

    expect(report.issues).toHaveLength(1);
  });

  test("degrades the whole inspection when fact indexing fails without leaking error details", () => {
    const report = runPatentInspection(createPatent(), [issueRule], {
      buildFacts: () => {
        throw new Error("sensitive patent text");
      },
    });

    expect(report.issues).toEqual([]);
    expect(report.degradedRules).toEqual([
      { ruleId: "engine.facts", message: "检查所需数据未能完成整理。" },
    ]);
    expect(JSON.stringify(report)).not.toContain("sensitive patent text");
  });

  test("selects instant rules for instant mode and full rules for full mode", () => {
    const instantRule: PatentInspectionRule = {
      ...issueRule,
      id: "test.instant",
      cost: "instant",
      dependencies: ["claims"],
      provenance: PRODUCT_POLICY.claimPunctuation,
    };
    const fullRule: PatentInspectionRule = {
      ...issueRule,
      id: "test.full",
      cost: "full",
      dependencies: ["claims", "description"],
      provenance: HEURISTIC_RULE,
    };

    expect(
      runPatentInspection(createPatent(), [instantRule, fullRule], { mode: "instant" }).issues.map(
        ({ ruleId }) => ruleId,
      ),
    ).toEqual(["test.instant"]);
    expect(
      runPatentInspection(createPatent(), [instantRule, fullRule], { mode: "full" }).issues.map(
        ({ ruleId }) => ruleId,
      ),
    ).toEqual(["test.full", "test.instant"]);
  });

  test("keeps mode, provenance, offsets, and wording-independent fingerprints stable", () => {
    const withOffsets: PatentInspectionRule = {
      ...issueRule,
      id: "test.offsets",
      inspect: () => [
        {
          ...issueDraft,
          evidence: [
            {
              location: {
                kind: "book",
                bookKind: "claims",
                targetId: "claim-1",
                startOffset: 2,
                endOffset: 6,
              },
              excerpt: "对象",
            },
          ],
          locations: [
            { kind: "book", bookKind: "claims", targetId: "claim-1", startOffset: 2, endOffset: 6 },
          ],
        },
      ],
    };
    const first = runPatentInspection(createPatent(), [withOffsets], { mode: "instant" });
    const second = runPatentInspection(
      createPatent(),
      [
        {
          ...withOffsets,
          inspect: () => [
            {
              ...issueDraft,
              summary: "另一条显示文案",
              evidence: [
                {
                  location: {
                    kind: "book",
                    bookKind: "claims",
                    targetId: "claim-1",
                    startOffset: 2,
                    endOffset: 6,
                  },
                  excerpt: "不同的证据文案",
                },
              ],
              locations: [
                {
                  kind: "book",
                  bookKind: "claims",
                  targetId: "claim-1",
                  startOffset: 2,
                  endOffset: 6,
                },
              ],
            },
          ],
        },
      ],
      { mode: "instant" },
    );

    expect(first.mode).toBe("instant");
    expect(first.issues[0]?.provenance?.authority).toBe("product-policy");
    expect(first.issues[0]?.locations[0]?.startOffset).toBe(2);
    expect(first.issues[0]?.fingerprint).toBe(second.issues[0]?.fingerprint);
  });

  test("keeps fingerprints stable across evidence order and distinguishes offsets", () => {
    const firstLocation = {
      kind: "book" as const,
      bookKind: "claims" as const,
      targetId: "claim-1",
      startOffset: 2,
      endOffset: 6,
    };
    const secondLocation = {
      kind: "book" as const,
      bookKind: "claims" as const,
      targetId: "claim-1",
      startOffset: 8,
      endOffset: 11,
    };
    const issueWithEvidence = (
      evidence: readonly [{ location: typeof firstLocation }, { location: typeof secondLocation }],
    ) => ({
      ...issueDraft,
      evidence: evidence.map((item) => ({ ...item, excerpt: "仅用于展示的证据" })),
      locations: [firstLocation],
    });
    const ordered = runPatentInspection(createPatent(), [
      {
        ...issueRule,
        id: "test.evidence-order",
        inspect: () => [
          issueWithEvidence([{ location: firstLocation }, { location: secondLocation }]),
        ],
      },
    ]);
    const reversed = runPatentInspection(createPatent(), [
      {
        ...issueRule,
        id: "test.evidence-order",
        inspect: () => [
          issueWithEvidence([{ location: secondLocation }, { location: firstLocation }]),
        ],
      },
    ]);
    const changedOffset = runPatentInspection(createPatent(), [
      {
        ...issueRule,
        id: "test.evidence-order",
        inspect: () => [
          {
            ...issueDraft,
            evidence: [{ location: secondLocation, excerpt: "仅用于展示的证据" }],
            locations: [secondLocation],
          },
        ],
      },
    ]);

    expect(ordered.issues[0]?.fingerprint).toBe(reversed.issues[0]?.fingerprint);
    expect(ordered.issues[0]?.fingerprint).not.toBe(changedOffset.issues[0]?.fingerprint);
  });
});
