import { describe, expect, test, vi } from "vitest";
import { aiHttpError, createHttpsJsonClient, createHttpsJsonGetter } from "./https-json-client.js";

describe("AI HTTPS JSON client", () => {
  test("explains insufficient account balance", () => {
    expect(aiHttpError(402).message).toContain("余额不足");
  });
  test("validates and pins the endpoint before sending JSON", async () => {
    const resolveEndpoint = vi.fn(async () => ({
      hostname: "provider.example",
      addresses: ["93.184.216.34"],
    }));
    const transport = vi.fn(async () => ({ statusCode: 200, body: '{"ok":true}' }));
    const post = createHttpsJsonClient({ resolveEndpoint, transport });

    await expect(
      post(new URL("https://provider.example/v1/chat/completions"), {
        authorization: "Bearer secret",
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        body: { model: "m" },
      }),
    ).resolves.toEqual({ ok: true });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ addresses: ["93.184.216.34"], authorization: "Bearer secret" }),
    );
  });

  test("rejects redirects instead of forwarding credentials", async () => {
    const post = createHttpsJsonClient({
      resolveEndpoint: async () => ({ hostname: "provider.example", addresses: ["93.184.216.34"] }),
      transport: async () => ({ statusCode: 302, body: "" }),
    });
    await expect(
      post(new URL("https://provider.example/v1/chat/completions"), {
        authorization: "Bearer secret",
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        body: {},
      }),
    ).rejects.toMatchObject({ code: "AI_REQUEST_FAILED" });
  });

  test("preserves the validated Ollama HTTP URL for the transport", async () => {
    const transport = vi.fn(async () => ({ statusCode: 200, body: '{"ok":true}' }));
    const post = createHttpsJsonClient({ transport });
    await post(new URL("http://127.0.0.1:11434/v1/chat/completions"), {
      authorization: "Bearer ollama",
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      body: { model: "qwen3:8b" },
    });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.objectContaining({ protocol: "http:" }),
        addresses: ["127.0.0.1"],
      }),
    );
  });

  test("reads a model list with GET without sending a request body", async () => {
    const resolveEndpoint = vi.fn(async () => ({
      hostname: "provider.example",
      addresses: ["93.184.216.34"],
    }));
    const transport = vi.fn(async () => ({
      statusCode: 200,
      body: '{"data":[{"id":"model-a"}]}',
    }));
    const get = createHttpsJsonGetter({ resolveEndpoint, transport });

    await expect(
      get(new URL("https://provider.example/v1/models"), {
        authorization: "Bearer secret",
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ data: [{ id: "model-a" }] });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ method: "GET" }));
    expect(transport).toHaveBeenCalledWith(
      expect.not.objectContaining({ body: expect.anything() }),
    );
  });
});
