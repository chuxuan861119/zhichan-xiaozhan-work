import { describe, expect, test } from "vitest";
import { EndpointPolicyError, resolveAiEndpoint } from "./endpoint-policy.js";

describe("AI endpoint policy", () => {
  test.each([
    "http://provider.example/v1",
    "http://localhost:11434/v1",
    "http://127.0.0.1:11434/api",
    "http://127.0.0.1:11435/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.1/v1",
    "https://[::1]/v1",
  ])("rejects a non-public endpoint: %s", async (value) => {
    await expect(resolveAiEndpoint(new URL(value), async () => [])).rejects.toBeInstanceOf(
      EndpointPolicyError,
    );
  });

  test("allows only Ollama's exact loopback OpenAI endpoint", async () => {
    await expect(
      resolveAiEndpoint(new URL("http://127.0.0.1:11434/v1"), async () => []),
    ).resolves.toEqual({ hostname: "127.0.0.1", addresses: ["127.0.0.1"] });
  });

  test("pins a validated public DNS response", async () => {
    await expect(
      resolveAiEndpoint(new URL("https://provider.example/v1"), async () => [
        { address: "93.184.216.34", family: 4 },
      ]),
    ).resolves.toEqual({ hostname: "provider.example", addresses: ["93.184.216.34"] });
  });
  test.each([
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:0:0:1",
    "ff02::1",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
    "100.64.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
  ])("rejects non-public DNS results including IPv6 aliases: %s", async (address) => {
    await expect(
      resolveAiEndpoint(new URL("https://provider.example/v1"), async () => [
        { address, family: address.includes(":") ? 6 : 4 },
      ]),
    ).rejects.toBeInstanceOf(EndpointPolicyError);
  });
  test("accepts literal public IPv6 without a DNS lookup", async () => {
    await expect(
      resolveAiEndpoint(new URL("https://[2606:4700:4700::1111]/v1"), async () => []),
    ).resolves.toEqual({ hostname: "2606:4700:4700::1111", addresses: ["2606:4700:4700::1111"] });
  });
  test("rejects a mixed public and private DNS answer", async () => {
    await expect(
      resolveAiEndpoint(new URL("https://provider.example/v1"), async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "::ffff:10.0.0.1", family: 6 },
      ]),
    ).rejects.toBeInstanceOf(EndpointPolicyError);
  });

  test("supports public DNS64 networks without allowing translated private IPv4", async () => {
    await expect(
      resolveAiEndpoint(new URL("https://provider.example/v1"), async () => [
        { address: "64:ff9b::5db8:d822", family: 6 },
      ]),
    ).resolves.toMatchObject({ addresses: ["64:ff9b::5db8:d822"] });
    await expect(
      resolveAiEndpoint(new URL("https://provider.example/v1"), async () => [
        { address: "64:ff9b::a00:1", family: 6 },
      ]),
    ).rejects.toBeInstanceOf(EndpointPolicyError);
  });
});
