import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  TEXT_POLISH_MAX_CONVERSATION_TEXT_BYTES,
  TEXT_POLISH_MAX_TURN_COUNT,
  TextPolishCompletedEventSchema,
  TextPolishConversationEventSchema,
  TextPolishConversationSendRequestSchema,
  TextPolishConversationSnapshotSchema,
  TextPolishConversationStartRequestSchema,
  TextPolishConversationSummarySchema,
  TextPolishInputDraftSchema,
  TextPolishStartRequestSchema,
} from "./text-polish-contract.js";

const selection = {
  kind: "selection" as const,
  bookKind: "description" as const,
  blocks: [
    { blockId: randomUUID(), blockType: "paragraph" as const, startOffset: 2, endOffset: 6 },
    { blockId: randomUUID(), blockType: "paragraph" as const, startOffset: 0, endOffset: 4 },
  ],
  selectedTextHash: "a".repeat(64),
};

describe("text polish contract", () => {
  test("persists independent bounded reference material without breaking old drafts", () => {
    expect(TextPolishInputDraftSchema.parse({ text: "要求", presets: [] })).toEqual({
      text: "要求",
      presets: [],
    });
    expect(
      TextPolishInputDraftSchema.parse({
        text: "要求",
        presets: [],
        referenceText: "文".repeat(20000),
      }).referenceText,
    ).toHaveLength(20000);
    expect(
      TextPolishInputDraftSchema.safeParse({
        text: "要求",
        presets: [],
        referenceText: "文".repeat(20001),
      }).success,
    ).toBe(false);
  });
  test("accepts a bounded selection request and rejects oversized requirements", () => {
    const request = {
      jobId: randomUUID(),
      patentId: randomUUID(),
      sessionId: randomUUID(),
      expectedRevision: 3,
      scope: selection,
      requirement: "表达更专业严谨",
      uploadConfirmed: true as const,
    };

    expect(TextPolishStartRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      TextPolishStartRequestSchema.parse({ ...request, requirement: "需".repeat(2_001) }),
    ).toThrow();
  });

  test("accepts a strict conversation start and a three-way assistant reply snapshot", () => {
    const request = {
      clientRequestId: randomUUID(),
      patentId: randomUUID(),
      sessionId: randomUUID(),
      expectedPatentRevision: 3,
      scope: selection,
      instruction: "保持术语不变并改得更严谨",
      uploadConfirmed: true as const,
    };
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const turnId = randomUUID();
    const snapshot = {
      conversationId,
      patentId: request.patentId,
      sessionId: request.sessionId,
      bookKind: "description" as const,
      conversationRevision: 2,
      source: {
        kind: "selection" as const,
        anchor: {
          bookKind: "description" as const,
          blocks: selection.blocks,
          originalText: "一种测试装置",
          originalTextHash: "b".repeat(64),
        },
      },
      model: {
        profileId: randomUUID(),
        providerId: "custom",
        displayName: "测试模型",
        baseUrl: "https://provider.example/v1",
        model: "model-a",
      },
      messages: [
        { role: "user" as const, messageId, turnId, text: "保持术语不变并改得更严谨" },
        {
          role: "assistant" as const,
          messageId: randomUUID(),
          turnId,
          reply: {
            kind: "revision" as const,
            message: "已保持术语并收紧表述。",
            revisedText: "一种测试装置，包括主体和连接组件。",
          },
        },
      ],
      latestValidDraft: "一种测试装置，包括主体和连接组件。",
      summary: null,
      activeTurn: null,
      lastTurnOutcome: { status: "completed" as const, turnId },
    };

    expect(TextPolishConversationStartRequestSchema.parse(request)).toEqual(request);
    expect(TextPolishConversationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      TextPolishConversationEventSchema.parse({
        type: "message",
        conversationId,
        conversationRevision: 2,
        message: snapshot.messages[1],
      }),
    ).toMatchObject({ type: "message", conversationRevision: 2 });
  });

  test("keeps an authoritative failed or cancelled turn outcome in snapshots", () => {
    const base = {
      conversationId: randomUUID(),
      patentId: randomUUID(),
      sessionId: randomUUID(),
      bookKind: "claims" as const,
      conversationRevision: 4,
      source: {
        kind: "generation" as const,
        requirement: "起草权利要求",
      },
      model: {
        profileId: randomUUID(),
        providerId: "custom",
        displayName: "测试模型",
        baseUrl: "https://provider.example/v1",
        model: "model-a",
      },
      messages: [],
      latestValidDraft: null,
      summary: null,
      activeTurn: null,
    };
    const turnId = randomUUID();

    expect(
      TextPolishConversationSnapshotSchema.parse({
        ...base,
        lastTurnOutcome: {
          status: "failed",
          turnId,
          message: "服务暂不可用",
          retryable: true,
        },
      }).lastTurnOutcome,
    ).toEqual({ status: "failed", turnId, message: "服务暂不可用", retryable: true });
    expect(
      TextPolishConversationSnapshotSchema.parse({
        ...base,
        lastTurnOutcome: { status: "cancelled", turnId },
      }).lastTurnOutcome,
    ).toEqual({ status: "cancelled", turnId });
    expect(() =>
      TextPolishConversationSnapshotSchema.parse({
        ...base,
        lastTurnOutcome: {
          status: "failed",
          turnId,
          message: "服务暂不可用",
          retryable: true,
          secret: "unexpected",
        },
      }),
    ).toThrow();
  });

  test("summary events carry the committed system message", () => {
    const summaryId = randomUUID();
    const summary = {
      summaryId,
      coveredThroughMessageId: randomUUID(),
      items: [],
    };
    const message = {
      role: "system" as const,
      messageId: randomUUID(),
      code: "context-compacted" as const,
      summaryId,
      text: "已整理较早的对话内容",
    };

    expect(
      TextPolishConversationEventSchema.parse({
        type: "summary",
        conversationId: randomUUID(),
        conversationRevision: 8,
        summary,
        message,
      }),
    ).toMatchObject({ type: "summary", message });
  });

  test("accepts new and retry sends but rejects duplicate or unknown fields", () => {
    const identity = {
      conversationId: randomUUID(),
      patentId: randomUUID(),
      sessionId: randomUUID(),
      bookKind: "claims" as const,
    };
    const fresh = {
      kind: "new" as const,
      identity,
      expectedConversationRevision: 2,
      clientRequestId: randomUUID(),
      instruction: "不要改变保护范围",
    };
    const retry = {
      kind: "retry" as const,
      identity,
      expectedConversationRevision: 3,
      clientRequestId: randomUUID(),
      turnId: randomUUID(),
    };

    expect(TextPolishConversationSendRequestSchema.parse(fresh)).toEqual(fresh);
    expect(TextPolishConversationSendRequestSchema.parse(retry)).toEqual(retry);
    expect(() =>
      TextPolishConversationSendRequestSchema.parse({ ...fresh, instruction: "" }),
    ).toThrow();
    expect(() =>
      TextPolishConversationSendRequestSchema.parse({ ...fresh, unexpected: true }),
    ).toThrow();
  });

  test("requires summary evidence to point at bounded source messages", () => {
    const summary = {
      summaryId: randomUUID(),
      coveredThroughMessageId: randomUUID(),
      items: [
        {
          kind: "requirement" as const,
          text: "不得改变保护范围",
          sourceMessageIds: [randomUUID()],
          evidenceQuotes: ["不得改变保护范围"],
        },
      ],
    };

    expect(TextPolishConversationSummarySchema.parse(summary)).toEqual(summary);
    expect(() =>
      TextPolishConversationSummarySchema.parse({
        ...summary,
        items: Array.from({ length: 101 }, () => summary.items[0]),
      }),
    ).toThrow();
  });

  test("exports the bounded conversation limits as shared constants", () => {
    expect(TEXT_POLISH_MAX_TURN_COUNT).toBe(100);
    expect(TEXT_POLISH_MAX_CONVERSATION_TEXT_BYTES).toBe(2 * 1024 * 1024);
  });

  test("accepts a requirement-only generation request and returns an unanchored result", () => {
    const request = {
      jobId: randomUUID(),
      patentId: randomUUID(),
      sessionId: randomUUID(),
      expectedRevision: 3,
      scope: { kind: "generation" as const, bookKind: "description" as const },
      requirement: "起草一段电池冷却机构的技术背景。",
      uploadConfirmed: true as const,
    };
    const event = {
      type: "polish-completed" as const,
      jobId: request.jobId,
      result: { kind: "generated" as const, generatedText: "现有技术中，电池冷却仍存在不足。" },
    };

    expect(TextPolishStartRequestSchema.parse(request)).toEqual(request);
    expect(TextPolishCompletedEventSchema.parse(event)).toEqual(event);
  });

  test("requires a precise anchor and non-empty polished text in completed events", () => {
    const event = {
      type: "polish-completed" as const,
      jobId: randomUUID(),
      result: {
        anchor: {
          bookKind: "description" as const,
          blocks: selection.blocks,
          originalText: "原始文字\n第二段落",
          originalTextHash: "b".repeat(64),
        },
        polishedText: "润色后的文字",
      },
    };

    expect(TextPolishCompletedEventSchema.parse(event)).toEqual(event);
    expect(() =>
      TextPolishCompletedEventSchema.parse({
        ...event,
        result: { ...event.result, polishedText: "" },
      }),
    ).toThrow();
  });
});
