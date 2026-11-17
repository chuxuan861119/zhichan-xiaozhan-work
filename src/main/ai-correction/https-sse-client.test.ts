import { describe, expect, test, vi } from "vitest";
import { createHttpsSseClient } from "./https-sse-client.js";

const endpoint = new URL("https://api.deepseek.com/chat/completions");
const resolved = { hostname: "api.deepseek.com", addresses: ["203.0.113.10"] };

function body(parts: readonly (string | Buffer)[]): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield Buffer.isBuffer(part) ? part : Buffer.from(part);
    },
  };
}

function request(overrides: Partial<{ timeoutMs: number; signal: AbortSignal }> = {}) {
  return {
    authorization: "Bearer test-key",
    timeoutMs: overrides.timeoutMs ?? 600_000,
    signal: overrides.signal ?? new AbortController().signal,
    body: { model: "deepseek-v4-pro", stream: true },
  };
}

describe("HTTPS SSE client", () => {
  test("includes DNS resolution in the deadline and reports the actual timeout", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn();
      const post = createHttpsSseClient({
        resolveEndpoint: () => new Promise(() => {}),
        transport,
      });
      const pending = expect(
        post(endpoint, request({ timeoutMs: 60_000 }), () => {}),
      ).rejects.toThrow("1 分钟");
      await vi.advanceTimersByTimeAsync(60_001);
      await pending;
      expect(transport).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  test("uses an explicitly injected endpoint for isolated end-to-end tests", async () => {
    const testEndpoint = new URL("http://127.0.0.1:11434/v1/chat/completions");
    const resolveEndpoint = vi.fn(async () => ({
      hostname: "127.0.0.1",
      addresses: ["127.0.0.1"],
    }));
    const transport = vi.fn(async () => ({
      statusCode: 200,
      contentType: "text/event-stream",
      body: body(["data: [DONE]\n\n"]),
    }));
    const postSse = createHttpsSseClient({
      endpointOverride: testEndpoint,
      resolveEndpoint,
      transport,
    });

    await postSse(endpoint, request(), () => undefined);

    expect(resolveEndpoint).toHaveBeenCalledWith(testEndpoint);
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ url: testEndpoint }));
  });

  test("parses CRLF events split across arbitrary UTF-8 network chunks", async () => {
    const reasoning = Buffer.from("正在分析");
    const chunks = [
      Buffer.concat([
        Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"'),
        reasoning.subarray(0, 4),
      ]),
      Buffer.concat([reasoning.subarray(4), Buffer.from('"}}]}\r')]),
      Buffer.from('\n\r\ndata: {"choices":[{"delta":{"content":"{\\"issues\\":[]}"}}]}\n\n'),
      Buffer.from("data: [DONE]\n\n"),
    ];
    const received: unknown[] = [];
    const postSse = createHttpsSseClient({
      resolveEndpoint: async () => resolved,
      transport: async () => ({
        statusCode: 200,
        contentType: "text/event-stream; charset=utf-8",
        body: body(chunks),
      }),
    });

    await postSse(endpoint, request(), (data) => received.push(data));

    expect(received).toEqual([
      { choices: [{ delta: { reasoning_content: "正在分析" } }] },
      { choices: [{ delta: { content: '{"issues":[]}' } }] },
    ]);
  });

  test.each([
    [401, "AI 服务鉴权失败，请重新检查 API Key。"],
    [429, "AI 服务请求过于频繁，请稍后重试。"],
    [400, "AI 服务拒绝了请求参数，请检查模型是否支持当前请求格式。"],
    [404, "AI 服务接口或模型不存在，请检查服务地址和模型配置。"],
    [503, "AI 服务暂时不可用，请稍后重试。"],
  ])("maps HTTP %i without exposing the response body", async (statusCode, message) => {
    const postSse = createHttpsSseClient({
      resolveEndpoint: async () => resolved,
      transport: async () => ({
        statusCode,
        contentType: "application/json",
        body: body(['{"secret":"must-not-leak"}']),
      }),
    });

    await expect(postSse(endpoint, request(), () => undefined)).rejects.toThrow(message);
  });

  test("rejects a successful response that is not an event stream", async () => {
    const postSse = createHttpsSseClient({
      resolveEndpoint: async () => resolved,
      transport: async () => ({
        statusCode: 200,
        contentType: "application/json",
        body: body(["{}"]),
      }),
    });

    await expect(postSse(endpoint, request(), () => undefined)).rejects.toThrow(
      "AI 服务未返回流式数据。",
    );
  });

  test("rejects a stream that ends before the DONE marker", async () => {
    const postSse = createHttpsSseClient({
      resolveEndpoint: async () => resolved,
      transport: async () => ({
        statusCode: 200,
        contentType: "text/event-stream",
        body: body(['data: {"choices":[]}\n\n']),
      }),
    });

    await expect(postSse(endpoint, request(), () => undefined)).rejects.toThrow(
      "AI 服务流式响应提前结束。",
    );
  });

  test("aborts at the total deadline even while the transport remains active", async () => {
    vi.useFakeTimers();
    try {
      const postSse = createHttpsSseClient({
        resolveEndpoint: async () => resolved,
        transport: async (input) =>
          await new Promise((_, reject) => {
            input.signal.addEventListener("abort", () => reject(input.signal.reason), {
              once: true,
            });
          }),
      });

      const pending = postSse(endpoint, request({ timeoutMs: 600_000 }), () => undefined);
      const rejection = expect(pending).rejects.toThrow(
        "AI 本次请求已超过 10 分钟，请缩短任务或稍后重试。",
      );
      await vi.advanceTimersByTimeAsync(600_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  test("forwards caller cancellation to the active transport", async () => {
    const controller = new AbortController();
    const postSse = createHttpsSseClient({
      resolveEndpoint: async () => resolved,
      transport: async (input) =>
        await new Promise((_, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
        }),
    });
    const pending = postSse(endpoint, request({ signal: controller.signal }), () => undefined);

    controller.abort(new Error("cancelled by user"));

    await expect(pending).rejects.toThrow("cancelled by user");
  });

  test("accepts a valid fine-grained stream larger than the former 2 MiB limit", async () => {
    const event = `data: ${JSON.stringify({
      choices: [
        {
          delta: { reasoning_content: "正在逐段核对" },
          finish_reason: null,
          index: 0,
          logprobs: null,
        },
      ],
      created: 1_718_345_013,
      id: "1f633d8bfc032625086f14113c411638",
      model: "deepseek-v4-pro",
      object: "chat.completion.chunk",
      system_fingerprint: "fp_a49d71b8a1",
    })}\n\n`;
    const events = Array.from({ length: 8_192 }, () => event);
    expect(Buffer.byteLength(events.join(""), "utf8")).toBeGreaterThan(2 * 1024 * 1024);
    const received: unknown[] = [];
    const postSse = createHttpsSseClient({
      resolveEndpoint: async () => resolved,
      transport: async () => ({
        statusCode: 200,
        contentType: "text/event-stream",
        body: body([...events, "data: [DONE]\n\n"]),
      }),
    });

    await postSse(endpoint, request(), (data) => received.push(data));

    expect(received).toHaveLength(8_192);
  });

  test("stops reading a single SSE event larger than 1 MiB", async () => {
    const postSse = createHttpsSseClient({
      resolveEndpoint: async () => resolved,
      transport: async () => ({
        statusCode: 200,
        contentType: "text/event-stream",
        body: body([`data: ${JSON.stringify({ payload: "x".repeat(1024 * 1024) })}\n\n`]),
      }),
    });

    await expect(postSse(endpoint, request(), () => undefined)).rejects.toThrow(
      "AI 服务响应过大，已中止读取。",
    );
  });

  test("stops reading a stream larger than 32 MiB", async () => {
    const event = `data: ${JSON.stringify({ payload: "x".repeat(512 * 1024) })}\n\n`;
    const postSse = createHttpsSseClient({
      resolveEndpoint: async () => resolved,
      transport: async () => ({
        statusCode: 200,
        contentType: "text/event-stream",
        body: body(Array.from({ length: 65 }, () => event)),
      }),
    });

    await expect(postSse(endpoint, request(), () => undefined)).rejects.toThrow(
      "AI 服务响应过大，已中止读取。",
    );
  });
});
