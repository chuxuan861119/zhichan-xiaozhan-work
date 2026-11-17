import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import type {
  TextPolishConversationMessage,
  TextPolishConversationSource,
} from "../../shared/ai-correction/text-polish-contract.js";
import { createHttpsJsonClient } from "./https-json-client.js";
import type { PostSse } from "./https-sse-client.js";
import { createHttpsSseClient } from "./https-sse-client.js";
import { OpenAiCompatibleProvider, type PostJson } from "./openai-compatible-provider.js";

describe("OpenAI-compatible AI correction provider", () => {
  test.each([true, false])(
    "malformed correction output is a request error, not model incompatibility (stream=%s)",
    async (thinkingEnabled) => {
      const provider = new OpenAiCompatibleProvider(
        async () => ({ choices: [{ message: { content: '{"issues":[' }, finish_reason: "stop" }] }),
        async (_url, _request, onData) => {
          onData({ choices: [{ delta: { content: '{"issues":[' }, finish_reason: "stop" }] });
        },
      );
      await expect(
        provider.correct({
          providerId: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-flash",
          apiKey: "synthetic",
          timeoutMs: 1000,
          thinkingEnabled,
          signal: new AbortController().signal,
          scopeKind: "current-book",
          segments: [{ segmentId: "segment-1", bookKind: "description", text: "测试。" }],
        }),
      ).rejects.toMatchObject({
        code: "AI_REQUEST_FAILED",
        message: expect.stringContaining("本次纠错结果格式不正确"),
      });
    },
  );
  test("sends selection text but keeps local anchor metadata off the DeepSeek wire", async () => {
    const source: TextPolishConversationSource = {
      kind: "selection",
      anchor: {
        bookKind: "description",
        originalText: "测试选区原文",
        originalTextHash: "a".repeat(64),
        blocks: [{ blockId: randomUUID(), blockType: "paragraph", startOffset: 2, endOffset: 8 }],
      },
    };
    const before = structuredClone(source);
    const postSse = vi.fn<PostSse>(async (_url, _request, onData) => {
      onData({
        choices: [
          {
            delta: { content: JSON.stringify({ kind: "answer", message: "收到" }) },
            finish_reason: "stop",
          },
        ],
      });
    });
    const provider = new OpenAiCompatibleProvider(vi.fn<PostJson>(), postSse);
    await provider.converseTextPolish({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      apiKey: "synthetic",
      timeoutMs: 600_000,
      thinkingEnabled: true,
      signal: new AbortController().signal,
      source,
      messages: [],
      summary: null,
      latestValidDraft: null,
      instruction: "解释这段文字",
    });
    const body = JSON.stringify(postSse.mock.calls[0]?.[1].body);
    expect(body).toContain(source.anchor.originalText);
    expect(body).not.toContain(source.anchor.originalTextHash);
    expect(body).not.toContain(source.anchor.blocks[0]?.blockId);
    expect(body).not.toContain("startOffset");
    expect(source).toEqual(before);
  });
  test("an empty DeepSeek correction is not labelled model incompatibility", async () => {
    const provider = new OpenAiCompatibleProvider(vi.fn(), async (_url, _request, onData) => {
      onData({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] });
    });
    await expect(
      provider.correct({
        providerId: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        apiKey: "synthetic",
        timeoutMs: 1000,
        thinkingEnabled: true,
        signal: new AbortController().signal,
        scopeKind: "current-book",
        segments: [{ segmentId: "segment-1", bookKind: "description", text: "测试。" }],
      }),
    ).rejects.toMatchObject({
      code: "AI_REQUEST_FAILED",
      message: expect.stringContaining("未返回纠错结果"),
    });
  });
  test.each([true, false])(
    "empty DeepSeek reply is a retryable request failure (thinking=%s)",
    async (thinkingEnabled) => {
      const provider = new OpenAiCompatibleProvider(
        async () => ({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
        async (_url, _request, onData) => {
          onData({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] });
        },
      );
      await expect(
        provider.converseTextPolish({
          providerId: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-pro",
          apiKey: "synthetic",
          timeoutMs: 1000,
          thinkingEnabled,
          signal: new AbortController().signal,
          source: { kind: "generation", requirement: "测试" },
          messages: [],
          summary: null,
          latestValidDraft: null,
          instruction: "继续",
        }),
      ).rejects.toMatchObject({
        code: "AI_REQUEST_FAILED",
        message: expect.stringContaining("重试"),
      });
    },
  );
  test.each(["custom", "deepseek"] as const)(
    "recognizes a real HTTP context overflow through %s transport",
    async (providerId) => {
      const body = JSON.stringify({
        error: { code: "context_length_exceeded", message: "secret patent text" },
      });
      const resolveEndpoint = async () => ({
        hostname: "provider.example",
        addresses: ["93.184.216.34"],
      });
      const provider = new OpenAiCompatibleProvider(
        createHttpsJsonClient({
          resolveEndpoint,
          transport: async () => ({ statusCode: 400, body }),
        }),
        createHttpsSseClient({
          resolveEndpoint,
          transport: async () => ({
            statusCode: 400,
            contentType: "application/json",
            body: (async function* () {
              yield Buffer.from(body);
            })(),
          }),
        }),
      );
      await expect(
        provider.converseTextPolish({
          providerId,
          baseUrl: "https://provider.example/v1",
          model: "test",
          apiKey: "dummy",
          timeoutMs: 1000,
          thinkingEnabled: true,
          signal: new AbortController().signal,
          source: { kind: "generation", requirement: "起草" },
          messages: [],
          summary: null,
          latestValidDraft: null,
          instruction: "继续",
        }),
      ).rejects.toMatchObject({
        code: "CONTEXT_WINDOW_EXCEEDED",
        message: expect.not.stringContaining("secret"),
      });
    },
  );
  const source: TextPolishConversationSource = {
    kind: "generation",
    requirement: "起草一段背景技术",
  };
  const messages: TextPolishConversationMessage[] = [
    { role: "user", messageId: randomUUID(), turnId: randomUUID(), text: "保持术语一致" },
  ];

  test.each(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"])(
    "converses with %s and keeps reasoning out of the reply",
    async (model) => {
      const postSse = vi.fn<PostSse>(async (_url, _request, onData) => {
        onData({ choices: [{ delta: { reasoning_content: "先核对上下文" } }] });
        onData({
          choices: [
            {
              delta: {
                content: '{"kind":"clarification","message":"请确认是否保留该参数。"}',
              },
            },
          ],
        });
      });
      const reasoning: string[] = [];
      const provider = new OpenAiCompatibleProvider(vi.fn<PostJson>(), postSse);

      await expect(
        provider.converseTextPolish({
          providerId: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model,
          apiKey: "secret",
          timeoutMs: 60_000,
          thinkingEnabled: true,
          signal: new AbortController().signal,
          source,
          messages,
          summary: null,
          latestValidDraft: null,
          instruction: "继续处理",
          onReasoningDelta: (delta) => reasoning.push(delta),
        }),
      ).resolves.toEqual({ kind: "clarification", message: "请确认是否保留该参数。" });
      expect(reasoning).toEqual(["先核对上下文"]);
      expect(postSse.mock.calls[0]?.[1].body).toMatchObject({
        model,
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        response_format: { type: "json_object" },
      });
    },
  );

  test("parses a distinct summary response and never accepts it as a normal reply", async () => {
    const firstMessage = messages.at(0);
    if (!firstMessage) throw new Error("测试消息缺失");
    const messageId = firstMessage.messageId;
    const postJson = vi.fn<PostJson>(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              coveredThroughMessageId: messageId,
              items: [
                {
                  kind: "requirement",
                  text: "保持术语一致",
                  sourceMessageIds: [messageId],
                  evidenceQuotes: ["保持术语一致"],
                },
              ],
            }),
          },
        },
      ],
    }));
    const provider = new OpenAiCompatibleProvider(postJson);

    await expect(
      provider.summarizeTextPolishConversation({
        providerId: "custom",
        baseUrl: "https://provider.example/v1",
        model: "model-a",
        apiKey: "secret",
        timeoutMs: 60_000,
        thinkingEnabled: false,
        signal: new AbortController().signal,
        messages,
        coveredThroughMessageId: messageId,
      }),
    ).resolves.toEqual({
      coveredThroughMessageId: messageId,
      items: [
        {
          kind: "requirement",
          text: "保持术语一致",
          sourceMessageIds: [messageId],
          evidenceQuotes: ["保持术语一致"],
        },
      ],
    });
    expect(JSON.stringify(postJson.mock.calls[0]?.[1]?.body)).toContain("摘要不是对用户的回答");
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  test.each(["malformed", "oversized"])(
    "keeps a %s DeepSeek summary failure retryable",
    async (failure) => {
      const messageId = messages[0]?.messageId;
      if (!messageId) throw new Error("fixture");
      const content =
        failure === "malformed"
          ? "{invalid"
          : JSON.stringify({
              coveredThroughMessageId: messageId,
              items: [
                {
                  kind: "requirement",
                  text: "文".repeat(501),
                  sourceMessageIds: [messageId],
                  evidenceQuotes: ["保持术语一致"],
                },
              ],
            });
      const provider = new OpenAiCompatibleProvider(
        vi.fn<PostJson>(),
        async (_url, _request, onData) => {
          onData({ choices: [{ delta: { content }, finish_reason: "stop" }] });
        },
      );
      await expect(
        provider.summarizeTextPolishConversation({
          providerId: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-flash",
          apiKey: "synthetic-key",
          timeoutMs: 600_000,
          thinkingEnabled: true,
          signal: new AbortController().signal,
          messages,
          coveredThroughMessageId: messageId,
        }),
      ).rejects.toThrow(/摘要.*重试/);
    },
  );

  test("rejects a summary-shaped or oversized conversation reply", async () => {
    const firstMessage = messages.at(0);
    if (!firstMessage) throw new Error("测试消息缺失");
    const request = {
      providerId: "custom" as const,
      baseUrl: "https://provider.example/v1",
      model: "model-a",
      apiKey: "secret",
      timeoutMs: 60_000,
      thinkingEnabled: false,
      signal: new AbortController().signal,
      source,
      messages,
      summary: null,
      latestValidDraft: null,
      instruction: "继续处理",
    };
    const summaryShapedProvider = new OpenAiCompatibleProvider(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              coveredThroughMessageId: firstMessage.messageId,
              items: [],
            }),
          },
        },
      ],
    }));
    await expect(summaryShapedProvider.converseTextPolish(request)).rejects.toMatchObject({
      code: "INCOMPATIBLE_MODEL",
    });

    const oversizedProvider = new OpenAiCompatibleProvider(async () => ({
      choices: [
        { message: { content: JSON.stringify({ kind: "answer", message: "问".repeat(20_001) }) } },
      ],
    }));
    await expect(oversizedProvider.converseTextPolish(request)).rejects.toThrow(/长度超过/);

    const malformedStreamProvider = new OpenAiCompatibleProvider(
      vi.fn<PostJson>(),
      vi.fn<PostSse>(async (_url, _request, onData) => onData({ invalid: true })),
    );
    await expect(
      malformedStreamProvider.converseTextPolish({
        ...request,
        providerId: "deepseek",
        baseUrl: "https://api.deepseek.com",
        thinkingEnabled: true,
      }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_MODEL" });
  });

  test("maps provider context-window failures without exposing response text", async () => {
    const provider = new OpenAiCompatibleProvider(async () => {
      throw new Error("context_length_exceeded: user text should never be copied");
    });

    await expect(
      provider.converseTextPolish({
        providerId: "custom",
        baseUrl: "https://provider.example/v1",
        model: "model-a",
        apiKey: "secret",
        timeoutMs: 60_000,
        thinkingEnabled: false,
        signal: new AbortController().signal,
        source,
        messages,
        summary: null,
        latestValidDraft: null,
        instruction: "继续处理",
      }),
    ).rejects.toMatchObject({
      code: "CONTEXT_WINDOW_EXCEEDED",
      message: expect.not.stringContaining("user text"),
    });
  });

  test("streams reasoning and parses a strict text polish result", async () => {
    const postJson = vi.fn<PostJson>();
    const postSse = vi.fn<PostSse>(async (_url, _request, onData) => {
      onData({ choices: [{ delta: { reasoning_content: "先保持技术含义" } }] });
      onData({ choices: [{ delta: { content: '{"polishedText":"一种改进装置"}' } }] });
    });
    const reasoning: string[] = [];
    const provider = new OpenAiCompatibleProvider(postJson, postSse);

    await expect(
      provider.polish({
        providerId: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        apiKey: "secret",
        timeoutMs: 600_000,
        thinkingEnabled: true,
        signal: new AbortController().signal,
        mode: "selection",
        selectedText: "一种装置",
        requirement: "更专业严谨",
        onReasoningDelta: (delta) => reasoning.push(delta),
      }),
    ).resolves.toBe("一种改进装置");
    expect(reasoning).toEqual(["先保持技术含义"]);
    expect(postJson).not.toHaveBeenCalled();
  });

  test("reports incompatible text polish output with polish-specific wording", async () => {
    const provider = new OpenAiCompatibleProvider(async () => ({
      choices: [{ message: { content: '```json\n{"polishedText":"文字"}\n```' } }],
    }));

    await expect(
      provider.polish({
        providerId: "custom",
        baseUrl: "https://provider.example/v1",
        model: "model-a",
        apiKey: "secret",
        timeoutMs: 600_000,
        thinkingEnabled: true,
        signal: new AbortController().signal,
        mode: "selection",
        selectedText: "原文",
        requirement: "",
      }),
    ).rejects.toMatchObject({
      code: "INCOMPATIBLE_MODEL",
      message: "当前模型不兼容结构化润色结果。",
    });
  });

  test("uses the requirement-only prompt and generatedText contract for standalone drafting", async () => {
    const postJson = vi.fn<PostJson>(async () => ({
      choices: [{ message: { content: '{"generatedText":"现有技术中，电池冷却仍存在不足。"}' } }],
    }));
    const provider = new OpenAiCompatibleProvider(postJson);

    await expect(
      provider.polish({
        providerId: "custom",
        baseUrl: "https://provider.example/v1",
        model: "model-a",
        apiKey: "secret",
        timeoutMs: 600_000,
        thinkingEnabled: true,
        signal: new AbortController().signal,
        mode: "generation",
        requirement: "起草一段技术背景。",
      }),
    ).resolves.toBe("现有技术中，电池冷却仍存在不足。");

    expect(JSON.stringify(postJson.mock.calls[0]?.[1]?.body)).toContain("generatedText");
    expect(JSON.stringify(postJson.mock.calls[0]?.[1]?.body)).not.toContain(
      "untrustedSelectedText",
    );
  });

  test("sends patent text only as untrusted user data and parses strict JSON", async () => {
    const postJson = vi.fn<PostJson>(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              issues: [
                {
                  segmentId: "segment-1",
                  originalText: "错字",
                  category: "spelling",
                  risk: "low",
                  applicability: "replace",
                  replacement: "正确",
                  explanation: "错字。",
                },
              ],
            }),
          },
        },
      ],
    }));
    const provider = new OpenAiCompatibleProvider(postJson);

    const issues = await provider.correct({
      providerId: "custom",
      baseUrl: "https://provider.example/v1",
      model: "model-a",
      apiKey: "sk-secret",
      timeoutMs: 60_000,
      thinkingEnabled: false,
      signal: new AbortController().signal,
      scopeKind: "current-book",
      segments: [{ segmentId: "segment-1", bookKind: "claims", text: "错字" }],
    });

    expect(issues.issues).toHaveLength(1);
    expect(issues.issues[0]).toMatchObject({ originalText: "错字", replacement: "正确" });
    expect(issues).toMatchObject({ rejectedIssueCount: 0, resultLimitReached: false });
    expect(postJson).toHaveBeenCalledWith(
      new URL("https://provider.example/v1/chat/completions"),
      expect.objectContaining({
        authorization: "Bearer sk-secret",
        body: expect.objectContaining({ stream: false, model: "model-a" }),
      }),
    );
    const request = postJson.mock.calls[0]?.[1];
    expect(request?.body).not.toHaveProperty("temperature");
    expect(request?.body).not.toHaveProperty("thinking");
    expect(request?.body).not.toHaveProperty("max_tokens");
    expect(JSON.stringify(request?.body)).toContain("不可信数据");
    const messages = request?.body.messages as Array<{ role: string; content: string }>;
    const systemPrompt = messages.find(({ role }) => role === "system")?.content ?? "";
    expect(systemPrompt).toContain('"segmentId"');
    expect(systemPrompt).not.toContain('"startOffset"');
    expect(systemPrompt).not.toContain('"endOffset"');
    expect(systemPrompt).toContain("contextBefore");
    expect(systemPrompt).toContain('"originalText"');
    expect(systemPrompt).toContain('"applicability"');
    expect(systemPrompt).toContain('"analysis-only"');
    expect(systemPrompt).toContain("terminology、compliance");
    expect(systemPrompt).toContain('"replacement":null');
    expect(systemPrompt).toContain("不得照抄示例");
    expect(systemPrompt).toContain("权利要求编号、引用关系和从属关系表达");
    expect(systemPrompt).toContain("仅当同一项权利要求分成多个段落时");
    expect(systemPrompt).toContain("最后一段必须使用句号结尾");
    expect(systemPrompt).toContain("compliance");
    expect(systemPrompt).toContain("每次最多返回200条问题");
    const userPrompt = messages.find(({ role }) => role === "user")?.content ?? "";
    expect(JSON.parse(userPrompt).untrustedPatentText).toEqual([
      { segmentId: "segment-1", bookKind: "claims", text: "错字" },
    ]);
  });

  test("disables default DeepSeek thinking and bounds structured output", async () => {
    const postJson = vi.fn<PostJson>(async () => ({
      choices: [{ message: { content: '{"issues":[]}' } }],
    }));
    const provider = new OpenAiCompatibleProvider(postJson);

    await provider.correct({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "secret",
      timeoutMs: 60_000,
      thinkingEnabled: false,
      signal: new AbortController().signal,
      scopeKind: "current-book",
      segments: [{ segmentId: "segment-1", bookKind: "claims", text: "文本" }],
    });

    expect(postJson).toHaveBeenCalledWith(
      new URL("https://api.deepseek.com/chat/completions"),
      expect.objectContaining({
        body: expect.objectContaining({
          thinking: { type: "disabled" },
          max_tokens: 32_768,
        }),
      }),
    );
  });

  test("accepts compliance analysis, discards malformed items, and truncates beyond 200", async () => {
    const complianceIssue = {
      segmentId: "segment-1",
      originalText: "效果极佳",
      category: "compliance",
      risk: "medium",
      applicability: "analysis-only",
      replacement: null,
      explanation: "宣传性表述。该定位仅表示相关位置，不是替换目标。",
    } as const;
    const accepted = new OpenAiCompatibleProvider(async () => ({
      choices: [{ message: { content: JSON.stringify({ issues: [complianceIssue] }) } }],
    }));
    await expect(
      accepted.correct({
        providerId: "custom",
        baseUrl: "https://provider.example/v1",
        model: "model-a",
        apiKey: "secret",
        timeoutMs: 600_000,
        thinkingEnabled: true,
        signal: new AbortController().signal,
        scopeKind: "current-book",
        segments: [{ segmentId: "segment-1", bookKind: "abstract", text: "效果极佳" }],
      }),
    ).resolves.toEqual({
      issues: [{ ...complianceIssue, startOffset: 0, endOffset: 4 }],
      rejectedIssueCount: 0,
      resultLimitReached: false,
    });

    const partial = new OpenAiCompatibleProvider(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              issues: [complianceIssue, { ...complianceIssue, originalText: "" }],
            }),
          },
        },
      ],
    }));
    await expect(
      partial.correct({
        providerId: "custom",
        baseUrl: "https://provider.example/v1",
        model: "model-a",
        apiKey: "secret",
        timeoutMs: 600_000,
        thinkingEnabled: true,
        signal: new AbortController().signal,
        scopeKind: "current-book",
        segments: [{ segmentId: "segment-1", bookKind: "abstract", text: "效果极佳" }],
      }),
    ).resolves.toMatchObject({
      issues: [{ ...complianceIssue, startOffset: 0, endOffset: 4 }],
      rejectedIssueCount: 1,
    });

    const overflow = new OpenAiCompatibleProvider(async () => ({
      choices: [
        { message: { content: JSON.stringify({ issues: Array(201).fill(complianceIssue) }) } },
      ],
    }));
    await expect(
      overflow.correct({
        providerId: "custom",
        baseUrl: "https://provider.example/v1",
        model: "model-a",
        apiKey: "secret",
        timeoutMs: 600_000,
        thinkingEnabled: true,
        signal: new AbortController().signal,
        scopeKind: "current-book",
        segments: [{ segmentId: "segment-1", bookKind: "abstract", text: "效果极佳" }],
      }),
    ).resolves.toMatchObject({
      issues: expect.arrayContaining([{ ...complianceIssue, startOffset: 0, endOffset: 4 }]),
      rejectedIssueCount: 1,
      resultLimitReached: true,
    });
  });

  test("streams official DeepSeek reasoning separately from strict final JSON", async () => {
    const postJson = vi.fn<PostJson>();
    const postSse = vi.fn<PostSse>(async (_url, _request, onData) => {
      onData({ choices: [{ delta: { reasoning_content: "先核对术语" } }] });
      onData({ choices: [{ delta: { reasoning_content: "，再检查标点" } }] });
      onData({ choices: [{ delta: { content: '{"issues":[]}' } }] });
    });
    const phases: string[] = [];
    const reasoning: string[] = [];
    const provider = new OpenAiCompatibleProvider(postJson, postSse);

    const issues = await provider.correct({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "secret",
      timeoutMs: 300_000,
      thinkingEnabled: true,
      signal: new AbortController().signal,
      scopeKind: "current-book",
      segments: [{ segmentId: "segment-1", bookKind: "claims", text: "文本" }],
      onPhase: (phase) => phases.push(phase),
      onReasoningDelta: (delta) => reasoning.push(delta),
    });

    expect(issues).toEqual({ issues: [], rejectedIssueCount: 0, resultLimitReached: false });
    expect(postJson).not.toHaveBeenCalled();
    expect(postSse).toHaveBeenCalledWith(
      new URL("https://api.deepseek.com/chat/completions"),
      expect.objectContaining({
        timeoutMs: 300_000,
        body: expect.objectContaining({
          stream: true,
          thinking: { type: "enabled" },
          max_tokens: 32_768,
        }),
      }),
      expect.any(Function),
    );
    expect(reasoning).toEqual(["先核对术语", "，再检查标点"]);
    expect(phases).toEqual(["thinking", "structuring"]);
  });

  test("reports a truncated DeepSeek stream instead of calling the model incompatible", async () => {
    const postSse = vi.fn<PostSse>(async (_url, _request, onData) => {
      onData({ choices: [{ delta: { reasoning_content: "正在检查" }, finish_reason: null }] });
      onData({ choices: [{ delta: { content: '{"issues":[' }, finish_reason: null }] });
      onData({ choices: [{ delta: {}, finish_reason: "length" }] });
    });
    const provider = new OpenAiCompatibleProvider(vi.fn<PostJson>(), postSse);

    await expect(
      provider.correct({
        providerId: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        apiKey: "secret",
        timeoutMs: 600_000,
        thinkingEnabled: true,
        signal: new AbortController().signal,
        scopeKind: "current-book",
        segments: [{ segmentId: "segment-1", bookKind: "description", text: "文本" }],
      }),
    ).rejects.toMatchObject({
      code: "INCOMPLETE_MODEL_OUTPUT",
      message: "AI 输出达到长度上限，未能生成完整纠错结果，请缩小检查范围后重试。",
    });
  });

  test("rejects markdown-wrapped or structurally invalid model output", async () => {
    const provider = new OpenAiCompatibleProvider(async () => ({
      choices: [{ message: { content: '```json\n{"issues":[]}\n```' } }],
    }));
    await expect(
      provider.correct({
        providerId: "custom",
        baseUrl: "https://provider.example/v1",
        model: "model-a",
        apiKey: "secret",
        timeoutMs: 60_000,
        thinkingEnabled: false,
        signal: new AbortController().signal,
        scopeKind: "current-book",
        segments: [{ segmentId: "segment-1", bookKind: "claims", text: "文本" }],
      }),
    ).rejects.toMatchObject({ code: "AI_REQUEST_FAILED" });
  });

  test("accepts standard provider envelope metadata while keeping issue output strict", async () => {
    const provider = new OpenAiCompatibleProvider(async () => ({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1_723_000_000,
      model: "model-a",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", refusal: null, content: '{"issues":[]}' },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }));

    await expect(
      provider.correct({
        providerId: "custom",
        baseUrl: "https://provider.example/v1",
        model: "model-a",
        apiKey: "secret",
        timeoutMs: 60_000,
        thinkingEnabled: false,
        signal: new AbortController().signal,
        scopeKind: "current-book",
        segments: [{ segmentId: "segment-1", bookKind: "claims", text: "文本" }],
      }),
    ).resolves.toEqual({ issues: [], rejectedIssueCount: 0, resultLimitReached: false });
  });
});
