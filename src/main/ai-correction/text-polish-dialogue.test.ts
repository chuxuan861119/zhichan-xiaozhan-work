import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import type { PostSse } from "./https-sse-client.js";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";
import {
  buildTextPolishConversationMessages,
  buildTextPolishSummaryMessages,
} from "./text-polish-prompt.js";

const input = {
  providerId: "deepseek" as const,
  baseUrl: "https://example.invalid/v1",
  model: "test-model",
  apiKey: "test-only",
  timeoutMs: 600_000,
  thinkingEnabled: true,
  signal: new AbortController().signal,
  source: { kind: "generation" as const, bookKind: "claims" as const, requirement: "讨论装置" },
  messages: [],
  summary: null,
  latestValidDraft: null,
  instruction: "根据上述材料生成说明书摘要",
};

function streamed(replies: unknown[], afterReply?: () => void) {
  let index = 0;
  const post = vi.fn<PostSse>(async (_url, _request, emit) => {
    emit({
      choices: [{ delta: { content: JSON.stringify(replies[index++]) }, finish_reason: "stop" }],
    });
    afterReply?.();
  });
  return {
    post,
    provider: new OpenAiCompatibleProvider(async () => {
      throw new Error("Unexpected request");
    }, post),
  };
}

const revision = (text: string, deliverableType = "patent-abstract") => ({
  kind: "revision",
  message: "已完成",
  revisedText: text,
  deliverableType,
});

test("accepts detailed answers and reports excessive text without blaming model compatibility", async () => {
  const { provider } = streamed([
    { kind: "answer", message: "字".repeat(5000) },
    { kind: "answer", message: "字".repeat(20001) },
  ]);
  expect((await provider.converseTextPolish(input)).message).toHaveLength(5000);
  await expect(provider.converseTextPolish(input)).rejects.toThrow(/长度超过/);
});

test("uses the same dialogue core regardless of source type and original book", () => {
  const first = buildTextPolishConversationMessages(input)[0].content;
  const second = buildTextPolishConversationMessages({
    ...input,
    source: {
      kind: "selection",
      anchor: {
        bookKind: "abstract",
        blocks: [],
        originalText: "原文",
        originalTextHash: "a".repeat(64),
      },
    },
  })[0].content;
  expect(first).toBe(second);
  expect(first).toContain("参考材料与交付目标");
  expect(first).toContain("普通润色默认保留");
  expect(first).not.toContain("只改善措辞");
  expect(first).not.toContain("不强制300字");
});

test.each([
  "只生成背景技术",
  "生成说明书摘要",
  "为什么这样修改？",
  "再提出两种不同结构思路",
  "采用第二种，只完善连接方式",
  "先不写，讨论一下问题在哪里",
])("preserves free dialogue instruction: %s", (instruction) => {
  const messages = buildTextPolishConversationMessages({ ...input, instruction });
  expect(JSON.parse(messages[1].content).untrustedCurrentInstruction).toBe(instruction);
  expect(messages[0].content).toContain("本轮明确要求优先");
  expect(messages[0].content).toContain("不固定输出模板");
  expect(messages[0].content).toContain("只输出背景技术");
  expect(messages[0].content).toContain("deliverableType");
});

test("summarization retains task scope rather than making local constraints permanent", () => {
  const prompt = buildTextPolishSummaryMessages({ messages: [], coveredThroughMessageId: null })[0]
    .content;
  expect(prompt).toContain("长期约定与单轮任务要求");
  expect(prompt).toContain("不得扩展为所有后续回答");
  expect(prompt).toContain("建议不等于已证实事实");
});

test("accepts 300 Unicode characters and removes transport metadata", async () => {
  const text = `${"甲".repeat(298)}𠀀。`;
  const { provider, post } = streamed([revision(text)]);
  await expect(provider.converseTextPolish(input)).resolves.toEqual({
    kind: "revision",
    message: "已完成",
    revisedText: text,
  });
  expect(post).toHaveBeenCalledTimes(1);
});

test("compresses an oversized formal abstract once without truncating it", async () => {
  const { provider, post } = streamed([
    revision(`${"甲".repeat(300)}。`),
    revision("新的完整摘要。"),
  ]);
  await expect(provider.converseTextPolish(input)).resolves.toMatchObject({
    revisedText: "新的完整摘要。",
  });
  expect(post).toHaveBeenCalledTimes(2);
  const repair = post.mock.calls.at(1);
  if (!repair) throw new Error("Missing compression request");
  const body = repair[1].body;
  expect(JSON.stringify(body)).toContain("301");
  expect(JSON.stringify(body)).toContain("不要截断");
  expect(JSON.stringify(body)).toContain("本轮正式说明书摘要");
  expect(JSON.stringify(body)).not.toContain("untrustedConversationMessages");
  expect(repair[1].timeoutMs).toBeLessThanOrEqual(input.timeoutMs);
});

test("retains user requirements and summary evidence when shortening a formal abstract", async () => {
  const first = {
    role: "user" as const,
    messageId: randomUUID(),
    turnId: randomUUID(),
    text: "必须保留冷却通道这一名称",
  };
  const summary = {
    summaryId: randomUUID(),
    coveredThroughMessageId: first.messageId,
    items: [
      {
        kind: "requirement" as const,
        text: first.text,
        sourceMessageIds: [first.messageId],
        evidenceQuotes: [first.text],
      },
    ],
  };
  const { provider, post } = streamed([
    revision("原稿".repeat(200)),
    revision("冷却通道与连接结构。"),
  ]);
  await provider.converseTextPolish({
    ...input,
    messages: [first],
    summary,
    instruction: "摘要保留连接关系，不添加宣传语",
  });
  const body = JSON.stringify(post.mock.calls[1]?.[1].body);
  expect(body).toContain(first.text);
  expect(body).toContain("摘要保留连接关系，不添加宣传语");
  expect(body).toContain("evidenceQuotes");
});

test("counts retained requirements in the abstract shortening upload budget", async () => {
  const first = {
    role: "user" as const,
    messageId: randomUUID(),
    turnId: randomUUID(),
    text: "要求".repeat(300),
  };
  const { provider, post } = streamed([revision("原稿".repeat(300)), revision("新稿")]);
  await expect(
    provider.converseTextPolish({ ...input, messages: [first], maxUploadCharacters: 1000 }),
  ).rejects.toThrow("上传上限");
  expect(post).toHaveBeenCalledTimes(1);
});

test.each([revision("甲".repeat(400), "other"), { kind: "answer", message: "乙".repeat(400) }])(
  "does not impose an abstract limit on discussion replies",
  async (reply) => {
    const { provider, post } = streamed([reply]);
    await expect(
      provider.converseTextPolish({ ...input, instruction: "讨论方案，不要写摘要" }),
    ).resolves.toHaveProperty("kind", reply.kind);
    expect(post).toHaveBeenCalledTimes(1);
  },
);

test.each([
  revision("甲".repeat(301)),
  revision("伪装成其他类型", "other"),
  { kind: "answer", message: "请自己压缩" },
])("fails clearly if compression does not produce a valid abstract", async (second) => {
  const { provider, post } = streamed([revision("甲".repeat(301)), second]);
  await expect(provider.converseTextPolish(input)).rejects.toThrow("摘要压缩后仍未满足");
  expect(post).toHaveBeenCalledTimes(2);
});

test("does not start compression after cancellation", async () => {
  const controller = new AbortController();
  const { provider, post } = streamed([revision("甲".repeat(301))], () =>
    controller.abort(new Error("已停止")),
  );
  await expect(
    provider.converseTextPolish({ ...input, signal: controller.signal }),
  ).rejects.toThrow("已停止");
  expect(post).toHaveBeenCalledTimes(1);
});

test("does not grant compression a fresh timeout budget", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    const { provider, post } = streamed([revision("甲".repeat(301))], () =>
      now.mockReturnValue(600_001),
    );
    await expect(provider.converseTextPolish(input)).rejects.toThrow("超时");
    expect(post).toHaveBeenCalledTimes(1);
  } finally {
    now.mockRestore();
  }
});

test("rejects a new revision missing its deliverable type instead of skipping validation", async () => {
  const { provider } = streamed([
    { kind: "revision", message: "完成", revisedText: "甲".repeat(400) },
  ]);
  await expect(provider.converseTextPolish(input)).rejects.toMatchObject({
    code: "INCOMPATIBLE_MODEL",
  });
});

test("respects the upload boundary before sending the generated text for compression", async () => {
  const { provider, post } = streamed([revision("甲".repeat(1_001))]);
  await expect(
    provider.converseTextPolish({ ...input, maxUploadCharacters: 1_000 }),
  ).rejects.toThrow("上传上限");
  expect(post).toHaveBeenCalledTimes(1);
});

test("accepts the new envelope through nonstream transport without changing stored reply shape", async () => {
  const provider = new OpenAiCompatibleProvider(async () => ({
    choices: [{ message: { content: JSON.stringify(revision("讨论稿".repeat(150), "other")) } }],
  }));
  await expect(provider.converseTextPolish({ ...input, thinkingEnabled: false })).resolves.toEqual({
    kind: "revision",
    message: "已完成",
    revisedText: "讨论稿".repeat(150),
  });
});

test("cancellation during compression cannot return a completed reply", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const { provider, post } = streamed([revision("甲".repeat(301)), revision("完整摘要。")], () => {
    if (++attempts === 2) controller.abort(new Error("已停止压缩"));
  });
  await expect(
    provider.converseTextPolish({ ...input, signal: controller.signal }),
  ).rejects.toThrow("已停止压缩");
  expect(post).toHaveBeenCalledTimes(2);
});
