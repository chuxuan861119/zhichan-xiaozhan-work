import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  TextPolishConversationMessage,
  TextPolishConversationSource,
  TextPolishConversationSummary,
} from "../../shared/ai-correction/text-polish-contract.js";
import {
  buildTextPolishContext,
  estimateTextPolishContextCharacters,
  splitTextPolishSummaryMessages,
  utf8ByteLength,
  validateTextPolishConversationSummary,
} from "./text-polish-context.js";

const source: TextPolishConversationSource = {
  kind: "selection",
  anchor: {
    bookKind: "description",
    blocks: [{ blockId: randomUUID(), blockType: "paragraph", startOffset: 0, endOffset: 4 }],
    originalText: "原始装置",
    originalTextHash: "a".repeat(64),
  },
};

test("keeps the active reference separate and charges its upload budget", () => {
  const input = {
    source,
    messages: [],
    summary: null,
    latestValidDraft: null,
    instruction: "解释",
    referenceText: "文".repeat(20000),
  };
  const result = buildTextPolishContext(input);
  expect(result.kind).toBe("ready");
  if (result.kind === "ready") expect(result.context.referenceText).toHaveLength(20000);
  expect(buildTextPolishContext({ ...input, maxUploadCharacters: 10000 }).kind).not.toBe("ready");
});

test("fragments reference material only once and accepts exact evidence from it", () => {
  const message = { ...user("分析材料"), referenceText: "参考事实。".repeat(3000) };
  const batches = splitTextPolishSummaryMessages([message], 4000);
  const reconstructed = batches
    .flat()
    .map((part) => (part.role === "user" ? part.text : ""))
    .join("");
  expect(reconstructed).toBe(`${message.text}\n${message.referenceText}`);
  expect(batches.flat().every((part) => part.role !== "user" || !part.referenceText)).toBe(true);
  expect(
    validateTextPolishConversationSummary(
      {
        summaryId: randomUUID(),
        coveredThroughMessageId: message.messageId,
        items: [
          {
            kind: "context",
            text: "参考事实",
            sourceMessageIds: [message.messageId],
            evidenceQuotes: ["参考事实。"],
          },
        ],
      },
      [message],
    ).items,
  ).toHaveLength(1);
});

function user(
  text: string,
  turnId = randomUUID(),
): Extract<TextPolishConversationMessage, { role: "user" }> {
  return { role: "user", messageId: randomUUID(), turnId, text };
}

function answer(text: string, turnId: string): TextPolishConversationMessage {
  return {
    role: "assistant",
    messageId: randomUUID(),
    turnId,
    reply: { kind: "answer", message: text },
  };
}

function revision(text: string, turnId: string): TextPolishConversationMessage {
  return {
    role: "assistant",
    messageId: randomUUID(),
    turnId,
    reply: { kind: "revision", message: "已完成", revisedText: text },
  };
}

function summaryFor(message: TextPolishConversationMessage): TextPolishConversationSummary {
  const text = message.role === "user" ? message.text : "已完成";
  return {
    summaryId: randomUUID(),
    coveredThroughMessageId: message.messageId,
    items: [
      {
        kind: "requirement",
        text,
        sourceMessageIds: [message.messageId],
        evidenceQuotes: [text],
      },
    ],
  };
}

describe("text polish bounded context", () => {
  test("does not charge local selection anchors against the model context window", () => {
    const originalText = Array.from({ length: 1000 }, () => "原".repeat(19)).join("\n");
    const anchoredSource = {
      kind: "selection" as const,
      anchor: {
        ...source.anchor,
        originalText,
        blocks: Array.from({ length: 1000 }, () => ({
          blockId: randomUUID(),
          blockType: "paragraph" as const,
          startOffset: 0,
          endOffset: 19,
        })),
      },
    };
    const result = buildTextPolishContext({
      source: anchoredSource,
      messages: [],
      summary: null,
      latestValidDraft: null,
      instruction: "整理这段材料",
    });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.context.source).toEqual(anchoredSource);
  });
  test("batches an oversized old turn instead of rejecting it at the upload ceiling", () => {
    const first = user("起草");
    const result = buildTextPolishContext({
      source,
      messages: [first, answer("内容".repeat(9000), first.turnId)],
      summary: null,
      latestValidDraft: null,
      instruction: "继续",
      maxUploadCharacters: 12_500,
    });
    expect(result.kind).toBe("needs-summary");
  });

  test("supports summary batches below 2000 characters without losing user text", () => {
    const first = user("要求".repeat(800));
    const batches = splitTextPolishSummaryMessages([first, answer("回复", first.turnId)], 1000);
    expect(
      batches
        .flat()
        .filter((m) => m.role === "user")
        .map((m) => m.text)
        .join(""),
    ).toBe(first.text);
    expect(
      batches.every(
        (batch) =>
          batch.reduce(
            (n, m) => n + (m.role === "assistant" ? m.reply.message.length : m.text.length),
            0,
          ) <= 1000,
      ),
    ).toBe(true);
  });

  test("zero recent turns retains none rather than all turns", () => {
    const messages = Array.from({ length: 3 }, () => {
      const first = user("起草");
      return [first, answer("文".repeat(900), first.turnId)];
    }).flat();
    const result = buildTextPolishContext({
      source,
      messages,
      summary: null,
      latestValidDraft: null,
      instruction: "继续",
      recentTurnCount: 0,
      maxUploadCharacters: 1500,
    });
    expect(result.kind).toBe("needs-summary");
    if (result.kind === "needs-summary") expect(result.context.messages).toEqual([]);
  });
  test("keeps the entire explanation when deduplicating the latest revision", () => {
    const first = user("起草并解释");
    const explanation = `${"解释".repeat(9990)}不得采用焊接`;
    const result = buildTextPolishContext({
      source,
      summary: null,
      messages: [
        first,
        {
          role: "assistant",
          messageId: randomUUID(),
          turnId: first.turnId,
          reply: { kind: "revision", message: explanation, revisedText: "新稿" },
        },
      ],
      latestValidDraft: "新稿",
      instruction: "解释最后的限制",
    });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready")
      expect(result.context.messages[1]).toMatchObject({ reply: { message: explanation } });
  });
  test("splits large summary inputs without dropping text or changing source identities", () => {
    const first = user("起草");
    const text = `${"段落内容。\n".repeat(2400)}最后不得焊接`;
    const reply = answer(text, first.turnId);
    const batches = splitTextPolishSummaryMessages([first, reply], 12000);
    expect(batches.length).toBeGreaterThan(1);
    expect(
      batches
        .flat()
        .filter((item) => item.role === "assistant")
        .map((item) => (item.role === "assistant" ? item.reply.message : ""))
        .join(""),
    ).toBe(text);
    for (const batch of batches) {
      expect(
        batch.reduce(
          (n, item) =>
            n + (item.role === "assistant" ? item.reply.message.length : item.text.length),
          0,
        ),
      ).toBeLessThanOrEqual(12000);
      expect(
        batch.every(
          (item) => item.messageId === first.messageId || item.messageId === reply.messageId,
        ),
      ).toBe(true);
    }
  });
  test("summarizes a valid oversized complete turn without truncating it", () => {
    const first = user("起草并解释");
    const second = user("再修改");
    const large: TextPolishConversationMessage = {
      role: "assistant",
      messageId: randomUUID(),
      turnId: first.turnId,
      reply: { kind: "revision", message: "a".repeat(20_000), revisedText: "b".repeat(20_000) },
    };
    const result = buildTextPolishContext({
      source: { kind: "generation", requirement: "起草" },
      messages: [first, large, second, revision("c".repeat(20_000), second.turnId)],
      summary: null,
      latestValidDraft: "c".repeat(20_000),
      instruction: "继续",
      maxUploadCharacters: 50_000,
    });
    expect(result.kind).toBe("needs-summary");
    if (result.kind === "needs-summary") expect(result.summaryMessages).toEqual([first, large]);
  });
  test("does not resurrect unfinished user turns after compaction", () => {
    const stopped = user("采用铜材料");
    const done = user("精简表达");
    const messages = [stopped, done, answer("收到", done.turnId)];
    const result = buildTextPolishContext({
      source,
      messages,
      summary: summaryFor(done),
      latestValidDraft: null,
      instruction: "继续",
    });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.context.messages).not.toContainEqual(stopped);
  });
  test("counts preserved requirements against the upload limit instead of dropping them", () => {
    const first = user("不能删除冷却通道。".repeat(150));
    const later = user("改用新的术语。");
    const result = buildTextPolishContext({
      source,
      messages: [first, answer("收到", first.turnId), later, answer("收到", later.turnId)],
      summary: summaryFor(later),
      latestValidDraft: null,
      instruction: "继续",
      maxUploadCharacters: 1000,
    });
    expect(result.kind).toBe("upload-limit-exceeded");
  });
  test("keeps covered user requirements verbatim even when a valid summary omits them", () => {
    const first = user("必须保留冷却通道，不能删除。");
    const later = user("让句子更通顺。");
    const messages = [first, answer("收到", first.turnId), later, answer("收到", later.turnId)];
    const result = buildTextPolishContext({
      source,
      messages,
      summary: summaryFor(later),
      latestValidDraft: null,
      instruction: "继续",
    });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.context.messages).toContainEqual(first);
      expect(result.context.messages).toContainEqual(later);
    }
  });
  test("rejects an empty summary that would discard covered requirements", () => {
    const message = user("不得引入控制器");
    expect(() =>
      validateTextPolishConversationSummary(
        {
          summaryId: randomUUID(),
          coveredThroughMessageId: message.messageId,
          items: [],
        },
        [message],
      ),
    ).toThrow("摘要为空");
  });
  test("uses a verified summary instead of retransmitting its covered history", () => {
    const messages = Array.from({ length: 12 }, () => {
      const id = randomUUID();
      return [user("保持术语", id), answer("技术背景".repeat(700), id)];
    }).flat();
    const input = {
      source,
      messages,
      summary: null,
      latestValidDraft: null,
      instruction: "继续",
      maxEstimatedContextCharacters: 48_000,
      maxUploadCharacters: 50_000,
    };
    let result = buildTextPolishContext(input);
    expect(result.kind).toBe("needs-summary");
    const first = messages[0];
    if (!first) throw new Error("fixture");
    for (let i = 0; i < 12 && result.kind === "needs-summary"; i++) {
      result = buildTextPolishContext({
        ...input,
        summary: {
          summaryId: randomUUID(),
          coveredThroughMessageId: result.coveredThroughMessageId,
          items: summaryFor(first).items,
        },
      });
    }
    expect(result.kind).toBe("ready");
    if (result.kind === "ready")
      expect(result.context.messages.length).toBeLessThan(messages.length);
  });

  test("allows a long source and full latest draft without duplicating that draft in history", () => {
    const id = randomUUID();
    const draft = "改".repeat(20_000);
    const result = buildTextPolishContext({
      source: {
        kind: "selection",
        anchor: { ...source.anchor, originalText: "原".repeat(20_000) },
      },
      messages: [user("精简", id), revision(draft, id)],
      summary: null,
      latestValidDraft: draft,
      instruction: "再优化",
      maxUploadCharacters: 50_000,
    });
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.context.latestValidDraft).toBe(draft);
      expect(JSON.stringify(result.context.messages)).not.toContain(draft);
    }
  });

  test("compacts before enforcing the upload limit on the actual request", () => {
    const messages = Array.from({ length: 6 }, () => {
      const id = randomUUID();
      return [user("旧要求", id), answer("旧内容".repeat(100), id)];
    }).flat();
    const result = buildTextPolishContext({
      source,
      messages,
      summary: null,
      latestValidDraft: null,
      instruction: "继续",
      maxUploadCharacters: 1_000,
    });
    expect(result.kind).toBe("needs-summary");
  });
  test("keeps short history in priority order without requesting summary", () => {
    const firstTurn = randomUUID();
    const messages = [user("旧要求", firstTurn), answer("旧回答", firstTurn)];
    const result = buildTextPolishContext({
      source,
      messages,
      summary: null,
      latestValidDraft: "最近有效稿",
      instruction: "请继续收紧句式",
      maxEstimatedContextCharacters: 100_000,
      maxUploadCharacters: 100_000,
    });

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.context.source).toEqual(source);
    expect(result.context.latestValidDraft).toBe("最近有效稿");
    expect(result.context.messages).toEqual(messages);
    expect(result.context.instruction).toBe("请继续收紧句式");
    expect("summaryMessages" in result).toBe(false);
  });

  test("keeps the newer instruction verbatim and excludes local UI status rows", () => {
    const turnId = randomUUID();
    const messages: TextPolishConversationMessage[] = [
      user("旧要求", turnId),
      {
        role: "system",
        messageId: randomUUID(),
        code: "context-compacted",
        summaryId: randomUUID(),
        text: "已整理较早的对话内容",
      },
      answer("旧回答", turnId),
    ];
    const instruction = "不要采用旧摘要中的方向，保留当前参数并解释原因。";
    const result = buildTextPolishContext({
      source,
      messages,
      summary: null,
      latestValidDraft: null,
      instruction,
      maxEstimatedContextCharacters: 100_000,
      maxUploadCharacters: 100_000,
    });

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.context.instruction).toBe(instruction);
    expect(result.context.messages).toEqual([messages[0], messages[2]]);
    expect(JSON.stringify(result.context)).not.toContain("context-compacted");
  });

  test("compacts only older complete turns and excludes the active turn", () => {
    const oldTurn = randomUUID();
    const middleTurn = randomUUID();
    const activeTurn = randomUUID();
    const oldUser = user("旧要求", oldTurn);
    const messages = [
      oldUser,
      answer("旧回答".repeat(100), oldTurn),
      user("中间要求", middleTurn),
      revision("中间稿", middleTurn),
      user("当前要求", activeTurn),
    ];
    const result = buildTextPolishContext({
      source,
      messages,
      summary: null,
      latestValidDraft: "中间稿",
      instruction: "当前要求",
      activeTurnId: activeTurn,
      recentTurnCount: 1,
      maxEstimatedContextCharacters: 400,
      maxUploadCharacters: 100_000,
      maxSummaryInputCharacters: 2_000,
      systemPromptCharacters: 0,
      outputReserveCharacters: 0,
    });

    expect(result.kind).toBe("needs-summary");
    if (result.kind !== "needs-summary") return;
    expect(result.summaryMessages).toEqual([oldUser, messages[1]]);
    expect(result.context.messages.map((message) => message.messageId)).toEqual(
      [messages[2], messages[3]].map((message) => message?.messageId),
    );
    expect(result.context.messages).not.toContain(messages[4]);
    expect(result.context.instruction).toBe("当前要求");
  });

  test("excludes an unfinished cancelled turn from later context and upload accounting", () => {
    const completedTurn = randomUUID();
    const cancelledTurn = randomUUID();
    const completedMessages = [
      user("保留完成轮次", completedTurn),
      answer("完成轮次答复", completedTurn),
    ];
    const cancelledMessage = user("已停止但不应继续生效".repeat(100), cancelledTurn);
    const result = buildTextPolishContext({
      source,
      messages: [...completedMessages, cancelledMessage],
      summary: null,
      latestValidDraft: null,
      instruction: "采用新的要求",
      maxEstimatedContextCharacters: 100_000,
      maxUploadCharacters: 100,
    });

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.context.messages).toEqual(completedMessages);
    expect(JSON.stringify(result.context)).not.toContain("已停止但不应继续生效");
  });

  test("uses deterministic UTF-8 accounting rather than maxUploadCharacters as a token window", () => {
    expect(utf8ByteLength("汉字")).toBe(6);
    const input = {
      source,
      messages: [user("汉字")],
      summary: null,
      latestValidDraft: null,
      instruction: "继续",
    };
    expect(estimateTextPolishContextCharacters(input)).toBe(
      estimateTextPolishContextCharacters(input),
    );
    const result = buildTextPolishContext({
      ...input,
      maxEstimatedContextCharacters: 1_000,
      maxUploadCharacters: 2,
    });
    expect(result).toMatchObject({ kind: "upload-limit-exceeded" });
  });

  test("validates summary IDs and exact continuous evidence quotes", () => {
    const message = user("不得改变保护范围", randomUUID());
    const summary = summaryFor(message);
    const firstItem = summary.items.at(0);
    if (!firstItem) throw new Error("测试摘要项缺失");
    expect(validateTextPolishConversationSummary(summary, [message])).toEqual(summary);
    expect(() =>
      validateTextPolishConversationSummary(
        { ...summary, items: [{ ...firstItem, evidenceQuotes: ["不存在"] }] },
        [message],
      ),
    ).toThrow();
    expect(() =>
      validateTextPolishConversationSummary(
        { ...summary, items: [{ ...firstItem, sourceMessageIds: [randomUUID()] }] },
        [message],
      ),
    ).toThrow();
  });

  test("rejects duplicate references, oversized summaries, and unknown covered ranges", () => {
    const message = user("固定术语", randomUUID());
    const summary = summaryFor(message);
    const firstItem = summary.items.at(0);
    if (!firstItem) throw new Error("测试摘要项缺失");
    expect(() =>
      validateTextPolishConversationSummary(
        {
          ...summary,
          items: [firstItem, firstItem],
        },
        [message],
      ),
    ).toThrow();
    expect(() =>
      validateTextPolishConversationSummary({ ...summary, coveredThroughMessageId: randomUUID() }, [
        message,
      ]),
    ).toThrow();
    expect(() =>
      validateTextPolishConversationSummary(
        {
          ...summary,
          items: [{ ...firstItem, text: "摘要".repeat(3_000) }],
        },
        [message],
      ),
    ).toThrow();
  });

  test("fails without truncation when source and current instruction cannot fit", () => {
    const instruction = "用户要求".repeat(1_000);
    const result = buildTextPolishContext({
      source: {
        kind: "generation",
        requirement: "生成目标".repeat(500),
      },
      messages: [],
      summary: null,
      latestValidDraft: null,
      instruction,
      maxEstimatedContextCharacters: 100,
      maxUploadCharacters: 100_000,
    });
    expect(result).toMatchObject({ kind: "capacity-failure" });
    if (result.kind === "capacity-failure") {
      expect(result.code).toBe("CONTEXT_CAPACITY_EXCEEDED");
      expect(result.message).not.toContain("用户要求");
    }
  });
});
