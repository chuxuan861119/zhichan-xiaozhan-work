import { createHash, randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  AiApiKeyRequestSchema,
  AiCorrectionEventSchema,
  AiCorrectionIssueSchema,
  AiCorrectionProfileRequestSchema,
  AiCorrectionSettingsStateSchema,
  AiCorrectionStartRequestSchema,
  AiTextHashRequestSchema,
} from "./contract.js";
import { DEFAULT_AI_CORRECTION_SETTINGS } from "./model.js";

const hash = createHash("sha256").update("示例文本").digest("hex");
const patentId = randomUUID();
const blockId = randomUUID();
const jobId = randomUUID();

describe("AI correction contract", () => {
  test("accepts large continuous selections without character or block count caps", () => {
    expect(AiTextHashRequestSchema.safeParse("字".repeat(120_000)).success).toBe(true);
    expect(
      AiCorrectionStartRequestSchema.safeParse({
        jobId,
        patentId,
        sessionId: randomUUID(),
        expectedRevision: 8,
        scope: {
          kind: "selection",
          bookKind: "description",
          selectedTextHash: hash,
          blocks: Array.from({ length: 1_100 }, () => ({
            blockId: randomUUID(),
            blockType: "paragraph",
            startOffset: 0,
            endOffset: 110,
          })),
        },
        thinkingEnabled: true,
        uploadConfirmed: true,
      }).success,
    ).toBe(true);
  });
  test("accepts a confirmed selection request without carrying its text", () => {
    const request = AiCorrectionStartRequestSchema.parse({
      jobId,
      patentId,
      sessionId: randomUUID(),
      expectedRevision: 8,
      scope: {
        kind: "selection",
        bookKind: "description",
        blocks: [{ blockId, blockType: "paragraph", startOffset: 2, endOffset: 6 }],
        selectedTextHash: hash,
      },
      thinkingEnabled: true,
      uploadConfirmed: true,
    });

    expect(request.scope.kind).toBe("selection");
    expect("text" in request.scope).toBe(false);
  });

  test("rejects the removed full-patent scope", () => {
    expect(() =>
      AiCorrectionStartRequestSchema.parse({
        jobId,
        patentId,
        sessionId: randomUUID(),
        expectedRevision: 8,
        scope: { kind: "full-patent" },
        thinkingEnabled: true,
        uploadConfirmed: true,
      }),
    ).toThrow();
  });

  test("accepts Thinking task snapshots and bounded runtime events", () => {
    const request = AiCorrectionStartRequestSchema.parse({
      jobId,
      patentId,
      sessionId: randomUUID(),
      expectedRevision: 8,
      scope: { kind: "current-book", bookKind: "description" },
      thinkingEnabled: true,
      uploadConfirmed: true,
    });

    expect(request.thinkingEnabled).toBe(true);
    expect(request.jobId).toBe(jobId);
    expect(AiCorrectionEventSchema.parse({ type: "phase", jobId, phase: "thinking" })).toEqual({
      type: "phase",
      jobId,
      phase: "thinking",
    });
    expect(
      AiCorrectionEventSchema.parse({ type: "reasoning", jobId, delta: "正在核对术语" }),
    ).toEqual({ type: "reasoning", jobId, delta: "正在核对术语" });
    expect(() =>
      AiCorrectionEventSchema.parse({
        type: "reasoning",
        jobId,
        delta: "x".repeat(4_001),
      }),
    ).toThrow();
  });

  test("rejects a high-risk replaceable issue", () => {
    expect(() =>
      AiCorrectionIssueSchema.parse({
        issueId: randomUUID(),
        category: "terminology",
        risk: "high",
        applicability: "replace",
        anchor: {
          bookKind: "claims",
          blockId,
          startOffset: 0,
          endOffset: 4,
          originalText: "装置",
          originalTextHash: hash,
        },
        replacement: "系统",
        explanation: "可能改变保护范围。",
      }),
    ).toThrow();
  });

  test("accepts anchored compliance analysis and exposes result limit state", () => {
    const compliance = AiCorrectionIssueSchema.parse({
      issueId: randomUUID(),
      category: "compliance",
      risk: "medium",
      applicability: "analysis-only",
      anchor: {
        bookKind: "abstract",
        blockId,
        startOffset: 0,
        endOffset: 4,
        originalText: "本发明具有",
        originalTextHash: hash,
      },
      replacement: null,
      explanation: "存在宣传性表述。该定位仅表示相关位置，不是替换目标。",
    });
    expect(compliance.category).toBe("compliance");
    expect(
      AiCorrectionEventSchema.parse({
        type: "completed",
        jobId,
        issues: [compliance],
        resultLimitReached: true,
        discardedIssueCount: 3,
      }),
    ).toMatchObject({ resultLimitReached: true, discardedIssueCount: 3 });
    expect(() =>
      AiCorrectionIssueSchema.parse({
        ...compliance,
        applicability: "replace",
        replacement: "本发明",
      }),
    ).toThrow();
  });

  test("exposes only profile credential presence and bounds key writes", () => {
    const profileId = randomUUID();
    expect(
      AiCorrectionSettingsStateSchema.parse({
        settings: DEFAULT_AI_CORRECTION_SETTINGS,
        credentialProfileIds: [profileId],
      }),
    ).not.toHaveProperty("apiKey");
    expect(() => AiApiKeyRequestSchema.parse({ profileId, apiKey: "x".repeat(4_001) })).toThrow();
    expect(AiCorrectionProfileRequestSchema.parse({ profileId })).toEqual({ profileId });
  });
});
