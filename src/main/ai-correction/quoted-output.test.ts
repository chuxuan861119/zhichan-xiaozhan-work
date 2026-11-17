import { describe, expect, test, vi } from "vitest";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";
import type { ProviderSegment } from "./prompt.js";

const quote = {
  segmentId: "segment-1",
  originalText: "。。",
  replacement: "。",
  category: "punctuation",
  risk: "low",
  applicability: "replace",
  explanation: "删除重复句号。",
};
async function parse(
  text: string,
  overrides: Record<string, unknown> = {},
  extra: ProviderSegment[] = [],
) {
  const provider = new OpenAiCompatibleProvider(vi.fn(), async (_url, _request, onData) => {
    onData({
      choices: [
        {
          delta: { content: JSON.stringify({ issues: [{ ...quote, ...overrides }] }) },
          finish_reason: "stop",
        },
      ],
    });
  });
  return provider.correct({
    providerId: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    apiKey: "synthetic",
    timeoutMs: 600_000,
    thinkingEnabled: true,
    signal: new AbortController().signal,
    scopeKind: "current-book",
    segments: [{ segmentId: "segment-1", bookKind: "description", text }, ...extra],
  });
}

describe("exact quoted correction output", () => {
  test("computes UTF-16 offsets locally without selecting the preceding character", async () => {
    const text = "😀防护壳与支撑底座之间留有通风缝隙。。";
    const result = await parse(text);
    expect(result.rejectedIssueCount).toBe(0);
    expect(result.issues[0]).toMatchObject({
      startOffset: text.length - 2,
      endOffset: text.length,
      originalText: "。。",
    });
    const issue = result.issues[0];
    expect(issue && text.slice(0, issue.startOffset) + issue.replacement).toBe(
      "😀防护壳与支撑底座之间留有通风缝隙。",
    );
  });
  test("uses adjacent context to distinguish duplicate text in one segment", async () => {
    const result = await parse("甲。。乙。。", { contextBefore: "乙", contextAfter: "" });
    expect(result.issues[0]).toMatchObject({ startOffset: 4, endOffset: 6 });
  });
  test.each([
    ["甲。。乙。。", {}],
    ["甲。。乙。。", { contextBefore: "丙" }],
    ["甲。。", { contextBefore: "乙" }],
    ["甲。 。", {}],
    ["甲。。。", {}],
    ["甲。。", { segmentId: "missing" }],
    ["甲。。", { originalText: "甲。", replacement: "" }],
    ["甲。。", { startOffset: 1, endOffset: 3 }],
  ])(
    "rejects ambiguous, inexact, or old model-computed anchors: %s %j",
    async (text, overrides) => {
      const result = await parse(text, overrides);
      expect(result).toMatchObject({ issues: [], rejectedIssueCount: 1 });
    },
  );
  test("does not join text across separate segments", async () => {
    const result = await parse("甲。", {}, [
      { segmentId: "segment-2", bookKind: "description", text: "。乙" },
    ]);
    expect(result).toMatchObject({ issues: [], rejectedIssueCount: 1 });
  });
  test("same quote in another segment does not interfere with an exact segmentId", async () => {
    const result = await parse("甲。。", {}, [
      { segmentId: "segment-2", bookKind: "description", text: "乙。。" },
    ]);
    expect(result.issues[0]).toMatchObject({
      segmentId: "segment-1",
      startOffset: 1,
      endOffset: 3,
    });
  });
  const consistency = {
    originalText: "固定在轴上",
    replacement: null,
    category: "consistency",
    risk: "high",
    applicability: "analysis-only",
    explanation: "同一部件的固定位置描述不同，需人工核对。",
    evidence: [
      { segmentId: "segment-1", originalText: "固定在轴上" },
      { segmentId: "segment-2", originalText: "固定在杆上" },
    ],
  };
  test("accepts analysis-only consistency issues backed by two actual source quotes", async () => {
    const result = await parse("棉块固定在轴上。", consistency, [
      { segmentId: "segment-2", bookKind: "description", text: "棉块固定在杆上。" },
    ]);
    expect(result.issues[0]).toMatchObject({
      category: "consistency",
      applicability: "analysis-only",
      replacement: null,
      startOffset: 2,
      endOffset: 7,
    });
  });
  test("does not treat overlapping quotes of one statement as two pieces of evidence", async () => {
    const result = await parse("棉块固定在轴上。", {
      ...consistency,
      evidence: [
        consistency.evidence[0],
        { segmentId: "segment-1", originalText: "棉块固定在轴上" },
      ],
    });
    expect(result).toMatchObject({ issues: [], rejectedIssueCount: 1 });
  });
  test("accepts two separate statements within the same segment", async () => {
    const result = await parse("棉块固定在轴上。棉块固定在杆上。", {
      ...consistency,
      evidence: [consistency.evidence[0], { segmentId: "segment-1", originalText: "固定在杆上" }],
    });
    expect(result.issues).toHaveLength(1);
  });
  test.each([
    { evidence: undefined },
    { evidence: [consistency.evidence[0], consistency.evidence[0]] },
    { evidence: [consistency.evidence[0], { segmentId: "missing", originalText: "固定在杆上" }] },
    { applicability: "replace", replacement: "固定在杆上" },
    { risk: "low" },
  ])("rejects unsafe or unsupported consistency output: %j", async (overrides) => {
    const result = await parse("棉块固定在轴上。", { ...consistency, ...overrides });
    expect(result).toMatchObject({ issues: [], rejectedIssueCount: 1 });
  });
});
