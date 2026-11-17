import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { TextPolishConversationProjection } from "./text-polish-conversation-state";
import {
  applyConversationEvent,
  applyConversationSnapshot,
} from "./text-polish-conversation-state";

function projection(revision = 1): TextPolishConversationProjection {
  return {
    conversationId: "00000000-0000-4000-8000-000000000001",
    conversationRevision: revision,
    messages: [],
    summary: null,
    lastTurnOutcome: null,
    activeTurn: {
      turnId: "00000000-0000-4000-8000-000000000002",
      clientRequestId: randomUUID(),
      instruction: "请润色",
      status: "running",
    },
  };
}

describe("text polish conversation projection", () => {
  test("retains batch feedback for summarization and clears it before the answer", () => {
    const initial = projection();
    if (!initial.activeTurn) throw new Error("Missing active turn");
    const event = {
      type: "phase" as const,
      conversationId: initial.conversationId,
      conversationRevision: 2,
      turnId: initial.activeTurn.turnId,
      phase: "summarizing" as const,
      summaryBatch: 3,
    };
    const next = applyConversationEvent(initial, event).projection;
    expect(next.activeTurn?.summaryBatch).toBe(3);
    expect(
      applyConversationEvent(next, { ...event, conversationRevision: 3, phase: "connecting" })
        .projection.activeTurn?.summaryBatch,
    ).toBeUndefined();
  });
  test("applies the next event and ignores duplicates or old events", () => {
    const current = projection();
    const event = {
      type: "message" as const,
      conversationId: current.conversationId,
      conversationRevision: 2,
      message: {
        role: "assistant" as const,
        messageId: randomUUID(),
        turnId: current.activeTurn?.turnId ?? randomUUID(),
        reply: { kind: "answer" as const, message: "已完成" },
      },
    };
    const applied = applyConversationEvent(current, event);
    expect(applied.kind).toBe("applied");
    if (applied.kind !== "applied") return;
    expect(applied.projection.messages).toHaveLength(1);
    expect(applyConversationEvent(applied.projection, event).kind).toBe("ignored");
    expect(
      applyConversationEvent(applied.projection, { ...event, conversationRevision: 1 }).kind,
    ).toBe("ignored");
  });

  test("reports a revision gap so the hook can resync from main", () => {
    const summaryId = randomUUID();
    const result = applyConversationEvent(projection(), {
      type: "summary",
      conversationId: projection().conversationId,
      conversationRevision: 4,
      summary: {
        summaryId,
        coveredThroughMessageId: randomUUID(),
        items: [
          {
            kind: "context",
            text: "已知背景",
            sourceMessageIds: [randomUUID()],
            evidenceQuotes: ["背景"],
          },
        ],
      },
      message: {
        role: "system",
        messageId: randomUUID(),
        code: "context-compacted",
        summaryId,
        text: "已整理较早的对话内容",
      },
    });
    expect(result.kind).toBe("gap");
  });

  test("does not replace a newer local projection with an older snapshot", () => {
    const current = projection(4);
    const snapshot = {
      ...current,
      conversationRevision: 2,
    } as never;
    expect(applyConversationSnapshot(current, snapshot)).toBe(current);
  });

  test("applies transient reasoning at the current committed revision", () => {
    const current = projection(3);
    const result = applyConversationEvent(current, {
      type: "reasoning",
      conversationId: current.conversationId,
      conversationRevision: 3,
      turnId: current.activeTurn?.turnId ?? randomUUID(),
      delta: "正在比较措辞",
    });

    expect(result.kind).toBe("applied");
    expect(result.projection).toBe(current);
  });

  test("appends the committed summary system message", () => {
    const current = projection(3);
    const summaryId = randomUUID();
    const message = {
      role: "system" as const,
      messageId: randomUUID(),
      code: "context-compacted" as const,
      summaryId,
      text: "已整理较早的对话内容",
    };
    const result = applyConversationEvent(current, {
      type: "summary",
      conversationId: current.conversationId,
      conversationRevision: 4,
      summary: { summaryId, coveredThroughMessageId: null, items: [] },
      message,
    });

    expect(result.kind).toBe("applied");
    expect(result.projection.messages).toContainEqual(message);
  });
});
