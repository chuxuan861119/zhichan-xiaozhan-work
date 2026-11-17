// @vitest-environment node
import { readFile } from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { expect, test, vi } from "vitest";
import { emptyBuckets } from "../../shared/usage-statistics/model.js";
import { sendUsageAggregate } from "./usage-statistics-transport.js";

vi.mock("node:https", async (original) => {
  const module = await original<typeof import("node:https")>();
  return { ...module, request: vi.fn(module.request) };
});

test("actual TLS request contains only the fixed daily fields, fixed UA and no cookies or redirects", async () => {
  const cert = await readFile(
    new URL("../../../tests/fixtures/usage-tls/test-cert.pem", import.meta.url),
  );
  const key = await readFile(
    new URL("../../../tests/fixtures/usage-tls/test-key.pem", import.meta.url),
  );
  const original = await vi.importActual<typeof import("node:https")>("node:https");
  vi.mocked(httpsRequest).mockImplementation(((
    url: URL,
    options: import("node:https").RequestOptions,
    callback: Parameters<typeof original.request>[2],
  ) => original.request(url, { ...options, ca: cert }, callback)) as typeof httpsRequest);
  const received: Array<{ headers: import("node:http").IncomingHttpHeaders; body: string }> = [];
  const server = createServer({ key, cert }, (request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.writeHead(received.length === 1 ? 204 : 302, {
        Location: "https://untrusted.example.com/",
      });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    const endpoint = `https://127.0.0.1:${address.port}/v1/usage/daily-aggregate`;
    const payload = {
      schema_version: 1 as const,
      day: "2026-10-05",
      version_group: "1.1",
      active_installation_days: 1 as const,
      duration_buckets: { ...emptyBuckets(), m1_5: 1 },
    };
    expect(await sendUsageAggregate(endpoint, payload, new AbortController().signal)).toBe(204);
    expect(JSON.parse(received[0]?.body ?? "")).toEqual(payload);
    expect(Object.keys(received[0]?.headers ?? {}).sort()).toEqual([
      "connection",
      "content-length",
      "content-type",
      "host",
      "user-agent",
    ]);
    expect(received[0]?.headers["user-agent"]).toBe("UsageStatistics/1");
    expect(await sendUsageAggregate(endpoint, payload, new AbortController().signal)).toBe(302);
    expect(received).toHaveLength(2);
    for (const platform of ["windows", "macos", "harmonyos"] as const) {
      const v2 = {
        schema_version: 2 as const,
        day: payload.day,
        platform,
        app_version: "1.2.3",
        release_channel: "stable" as const,
        active_installation_days: 1 as const,
        duration_buckets: payload.duration_buckets,
      };
      expect(await sendUsageAggregate(endpoint, v2, new AbortController().signal)).toBe(302);
      expect(JSON.parse(received.at(-1)?.body ?? "")).toEqual(v2);
      expect(received.at(-1)?.headers["user-agent"]).toBe("UsageStatistics/2");
      expect(received.at(-1)?.headers.cookie).toBeUndefined();
    }
  } finally {
    vi.mocked(httpsRequest).mockImplementation(original.request);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
