// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { send } from "../../cli/client.js";
import { AutomationTransport, errorResponse } from "./transport.js";

const transports: AutomationTransport[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function transport(execute: () => Promise<unknown> = async () => ({ version: "test" })) {
  // macOS canonical temporary roots are long; leave room for the Unix socket name.
  const home = await mkdtemp(join(tmpdir(), "zt-"));
  roots.push(home);
  const server = new AutomationTransport(
    home,
    {
      instanceId: randomUUID(),
      libraryId: randomUUID(),
      protocolVersion: 2,
      version: "test",
      label: "isolated",
      pid: process.pid,
    },
    execute,
  );
  transports.push(server);
  return server;
}
test("concurrent start calls share one listener and descriptor", async () => {
  const server = await transport();
  const results = await Promise.allSettled([server.start(), server.start()]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(
    (
      await send(
        server.descriptor!,
        "version",
        {},
        { clientProof: "a".repeat(64) },
        randomUUID(),
        1000,
      )
    ).ok,
  ).toBe(true);
});
test("validated frames stop the idle-input timer while an operation is executing", async () => {
  const { Socket } = await import("node:net");
  const { vi } = await import("vitest");
  const timeouts = vi.spyOn(Socket.prototype, "setTimeout");
  try {
    const server = await transport();
    await server.start();
    expect(
      (
        await send(
          server.descriptor!,
          "version",
          {},
          { clientProof: "a".repeat(64) },
          randomUUID(),
          1000,
        )
      ).ok,
    ).toBe(true);
    expect(timeouts.mock.calls.some(([timeout]) => timeout === 0)).toBe(true);
  } finally {
    timeouts.mockRestore();
  }
});

test("old protocol requests are rejected explicitly before the command executes", async () => {
  const { createConnection } = await import("node:net");
  const { vi } = await import("vitest");
  const execute = vi.fn(async () => ({}));
  const server = await transport(execute);
  await server.start();
  const descriptor = server.descriptor!;
  const response = await new Promise<{ error: { code: string } }>((resolve, reject) => {
    const socket = createConnection(descriptor.endpoint);
    let bytes = Buffer.alloc(0);
    socket.once("error", reject);
    socket.once("connect", () => {
      const body = Buffer.from(
        JSON.stringify({
          ...descriptor,
          protocolVersion: 1,
          command: "patent.create",
          requestId: "old-client",
          payload: {},
        }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
    });
    socket.once("end", () => resolve(JSON.parse(bytes.subarray(4).toString("utf8"))));
  });
  expect(response.error.code).toBe("PROTOCOL_MISMATCH");
  expect(execute).not.toHaveBeenCalled();
});

test("a restart handoff runs after the successful response and can close the transport without losing it", async () => {
  const home = await mkdtemp(join(tmpdir(), "zxw-handoff-"));
  roots.push(home);
  let sent = 0;
  const server = new AutomationTransport(
    home,
    {
      instanceId: randomUUID(),
      libraryId: randomUUID(),
      protocolVersion: 2,
      version: "test",
      label: "test",
      pid: process.pid,
    },
    async () => ({ phase: "scheduled" }),
    undefined,
    () => {
      sent++;
      void server.close();
    },
  );
  transports.push(server);
  await server.start();
  const response = await send(
    server.descriptor!,
    "version",
    {},
    { clientProof: "a".repeat(64) },
    randomUUID(),
    1000,
  );
  expect(response).toMatchObject({ ok: true, value: { phase: "scheduled" } });
  // Windows pipes can deliver the response before the server's write callback runs.
  await expect.poll(() => sent).toBe(1);
});

test("invalid command payloads return actionable input errors without echoing values", () => {
  const error = z
    .object({ assetHandle: z.string().uuid() })
    .strict()
    .safeParse({ assetHandle: "private-value", patentId: "private-id" });
  if (error.success) throw Error("expected invalid fixture");
  const response = errorResponse(error.error);
  expect(response).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(JSON.stringify(response)).not.toContain("private-value");
  expect(JSON.stringify(response)).not.toContain("private-id");
});
