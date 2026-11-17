import { describe, expect, test, vi } from "vitest";
import type { PostSse } from "./https-sse-client.js";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";
import { buildCorrectionMessages } from "./prompt.js";

const input = () => ({
  providerId: "deepseek" as const,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  apiKey: "synthetic-secret",
  timeoutMs: 600_000,
  thinkingEnabled: true,
  signal: new AbortController().signal,
  scopeKind: "current-book" as const,
  segments: [{ segmentId: "segment-1", bookKind: "description" as const, text: "合成正文。" }],
});

describe("DeepSeek empty final answer recovery", () => {
  test("retries once using final content only, announces recovery and records safe metadata", async () => {
    const phases: string[] = [];
    const diagnostic = vi.fn();
    const postSse = vi.fn<PostSse>(async (_url, _request, onData) => {
      if (postSse.mock.calls.length === 1) {
        onData({
          choices: [{ delta: { reasoning_content: '{"issues":[]}' }, finish_reason: "stop" }],
        });
      } else {
        onData({ choices: [{ delta: { content: '{"issues":[]}' }, finish_reason: "stop" }] });
      }
    });
    const provider = new OpenAiCompatibleProvider(vi.fn(), postSse, diagnostic);
    await expect(
      provider.correct({ ...input(), onPhase: (phase) => phases.push(phase) }),
    ).resolves.toMatchObject({ issues: [] });
    expect(postSse).toHaveBeenCalledTimes(2);
    expect(phases).toContain("retrying");
    for (const [, request] of postSse.mock.calls) {
      expect(request.body).toMatchObject({
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        max_tokens: 32_768,
      });
    }
    expect(diagnostic.mock.calls.map(([value]) => value)).toEqual([
      {
        attempt: 1,
        finishReason: "stop",
        reasoningCharacters: 13,
        contentCharacters: 0,
        streamCompleted: true,
      },
      {
        attempt: 2,
        finishReason: "stop",
        reasoningCharacters: 0,
        contentCharacters: 13,
        streamCompleted: true,
      },
    ]);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("合成正文");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-secret");
    expect(JSON.stringify(postSse.mock.calls[1]?.[1].body.messages)).not.toContain(
      'role":"assistant',
    );
  });

  test("does not promote even valid reasoning JSON and stops after two empty answers", async () => {
    const postSse = vi.fn<PostSse>(async (_url, _request, onData) => {
      onData({
        choices: [
          { delta: { reasoning_content: '{"issues":[]}', content: "  " }, finish_reason: "stop" },
        ],
      });
    });
    await expect(new OpenAiCompatibleProvider(vi.fn(), postSse).correct(input())).rejects.toThrow(
      "已自动重试一次，仍未收到正式纠错结果",
    );
    expect(postSse).toHaveBeenCalledTimes(2);
  });

  test("cancellation from the retry phase prevents the second request", async () => {
    const controller = new AbortController();
    const postSse = vi.fn<PostSse>(async (_url, _request, onData) => {
      onData({ choices: [{ delta: {}, finish_reason: "stop" }] });
    });
    await expect(
      new OpenAiCompatibleProvider(vi.fn(), postSse).correct({
        ...input(),
        signal: controller.signal,
        onPhase: (phase) => {
          if (phase === "retrying") controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(postSse).toHaveBeenCalledTimes(1);
  });

  test("retry uses only the remaining original deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const postSse = vi.fn<PostSse>(async (_url, _request, onData) => {
        now.mockReturnValue(301000);
        onData({
          choices: [
            {
              delta: { content: postSse.mock.calls.length === 1 ? "" : '{"issues":[]}' },
              finish_reason: "stop",
            },
          ],
        });
      });
      await new OpenAiCompatibleProvider(vi.fn(), postSse).correct(input());
      expect(postSse.mock.calls[1]?.[1].timeoutMs).toBe(300_000);
    } finally {
      now.mockRestore();
    }
  });

  test("does not restart a spent deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const postSse = vi.fn<PostSse>(async (_url, _request, onData) => {
        now.mockReturnValue(601001);
        onData({ choices: [{ delta: {}, finish_reason: "stop" }] });
      });
      await expect(new OpenAiCompatibleProvider(vi.fn(), postSse).correct(input())).rejects.toThrow(
        "超时",
      );
      expect(postSse).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  test.each(["length", "content_filter", undefined])(
    "does not retry abnormal/missing termination %s",
    async (finish_reason) => {
      const postSse = vi.fn<PostSse>(async (_url, _request, onData) => {
        onData({ choices: [{ delta: {}, finish_reason }] });
      });
      await expect(
        new OpenAiCompatibleProvider(vi.fn(), postSse).correct(input()),
      ).rejects.toThrow();
      expect(postSse).toHaveBeenCalledTimes(1);
    },
  );

  test("records transport failure without logging arbitrary error text or retrying", async () => {
    const diagnostic = vi.fn();
    const postSse = vi.fn<PostSse>(async () => {
      throw new Error("synthetic-secret");
    });
    await expect(
      new OpenAiCompatibleProvider(vi.fn(), postSse, diagnostic).correct(input()),
    ).rejects.toThrow();
    expect(postSse).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ streamCompleted: false, finishReason: "missing" }),
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-secret");
  });

  test("prompt distinguishes final JSON from intermediate reasoning", () => {
    const prompt = JSON.stringify(buildCorrectionMessages("current-book", input().segments));
    expect(prompt).toContain("最终回答必须输出");
    expect(prompt).toContain("不能代替最终回答");
  });
});
