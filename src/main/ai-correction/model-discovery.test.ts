import { describe, expect, test, vi } from "vitest";
import { AiModelDiscoveryService } from "./model-discovery.js";

describe("AI model discovery", () => {
  test("returns unique safe model identifiers from an OpenAI-compatible models endpoint", async () => {
    const getJson = vi.fn(async () => ({
      object: "list",
      data: [
        { id: "kimi-k3", object: "model" },
        { id: "kimi-k2.6", object: "model" },
        { id: "kimi-k3", object: "model" },
        { id: "" },
      ],
    }));
    const service = new AiModelDiscoveryService(getJson);

    await expect(
      service.discover({
        baseUrl: "https://api.moonshot.cn/v1",
        apiKey: "secret",
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(["kimi-k3", "kimi-k2.6"]);
    expect(getJson).toHaveBeenCalledWith(
      new URL("https://api.moonshot.cn/v1/models"),
      expect.objectContaining({ authorization: "Bearer secret" }),
    );
  });

  test("rejects malformed or unbounded model lists", async () => {
    const service = new AiModelDiscoveryService(async () => ({ data: "invalid" }));

    await expect(
      service.discover({
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "AI_REQUEST_FAILED" });
  });
});
