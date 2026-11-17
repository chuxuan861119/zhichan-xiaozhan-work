// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AutomationTransport } from "../main/automation/transport.js";
import type { AutomationRequest } from "../shared/automation/protocol.js";
import { discover, runCli } from "./client.js";

const roots: string[] = [],
  transports: AutomationTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(execute?: (request: AutomationRequest) => Promise<unknown>) {
  // macOS canonical temporary roots are long; leave room for the Unix socket name.
  const home = await mkdtemp(join(tmpdir(), "zc-"));
  roots.push(home);
  const transport = new AutomationTransport(
    home,
    {
      instanceId: randomUUID(),
      libraryId: randomUUID(),
      protocolVersion: 2,
      version: "test",
      label: "isolated",
      pid: process.pid,
    },
    async (request) =>
      request.command === "version"
        ? { version: "test" }
        : execute
          ? execute(request)
          : Promise.reject(Object.assign(new Error("denied"), { code: "SCOPE_DENIED" })),
  );
  transports.push(transport);
  await transport.start();
  return { home, transport };
}
test("corrupt and stale discovery records cannot hide a healthy instance", async () => {
  const { home, transport } = await fixture();
  await writeFile(join(home, "instances", `${randomUUID()}.json`), "{partial");
  const dead = {
    ...transport.descriptor,
    instanceId: randomUUID(),
    endpoint: join(home, "absent.sock"),
  };
  await writeFile(join(home, "instances", `${dead.instanceId}.json`), JSON.stringify(dead));
  expect((await discover(home)).map((item) => item.instanceId)).toEqual([
    transport.descriptor!.instanceId,
  ]);
});
test("remote scope refusal uses documented permission exit code", async () => {
  const { home } = await fixture();
  const lines: string[] = [];
  const code = await runCli(
    ["patent", "list", "--home", home, "--instance", transports[0]!.descriptor!.instanceId],
    { stdout: (s) => lines.push(s), stderr: () => {} },
  );
  expect(JSON.parse(lines.join("")).error.code).toBe("SCOPE_DENIED");
  expect(code).toBe(6);
});
test("simultaneous first connect creates one intact client profile", async () => {
  const identities = new Set<string>();
  const { home, transport } = await fixture(async (request) => {
    identities.add(request.clientProof!);
    return { status: "pending" };
  });
  const io = { stdout: () => {}, stderr: () => {} };
  const codes = await Promise.all([
    runCli(["connect", "--home", home, "--instance", transport.descriptor!.instanceId], io),
    runCli(["connect", "--home", home, "--instance", transport.descriptor!.instanceId], io),
  ]);
  expect(codes).toEqual([4, 4]);
  expect(identities.size).toBe(1);
  expect(
    identities.has(
      JSON.parse(await readFile(join(home, "profiles", "default.json"), "utf8")).clientProof,
    ),
  ).toBe(true);
});
test("long Unicode request IDs retain separate journal entries", async () => {
  const { home, transport } = await fixture(async () => ({}));
  const ids = ["中".repeat(80) + "甲", "中".repeat(80) + "乙"];
  for (const id of ids) {
    expect(
      await runCli(
        [
          "patent",
          "create",
          "--name",
          "日志测试",
          "--patent-type",
          "invention",
          "--home",
          home,
          "--instance",
          transport.descriptor!.instanceId,
          "--request-id",
          id,
        ],
        { stdout: () => {}, stderr: () => {} },
      ),
    ).toBe(0);
  }
  const directory = join(home, "profiles", "requests");
  const entries = await Promise.all(
    (await readdir(directory)).map(async (file) =>
      JSON.parse(await readFile(join(directory, file), "utf8")),
    ),
  );
  expect(entries.map((entry) => entry.requestId).sort()).toEqual(ids.sort());
});
test("UTF-8 BOM input preserves Chinese text and oversized files are rejected before sending", async () => {
  const received: AutomationRequest[] = [];
  const { home, transport } = await fixture(async (request) => {
    received.push(request);
    return {};
  });
  const input = join(home, "input.json");
  await writeFile(input, '\uFEFF{"patentType":"invention","name":"中文题目"}');
  const lines: string[] = [];
  const io = { stdout: (s: string) => lines.push(s), stderr: () => {} };
  const args = [
    "patent",
    "create",
    "--input",
    input,
    "--home",
    home,
    "--instance",
    transport.descriptor!.instanceId,
  ];
  expect(await runCli(args, io)).toBe(0);
  expect(received[0]!.payload.name).toBe("中文题目");
  await writeFile(input, Buffer.alloc(16 * 1024 * 1024 + 1));
  lines.length = 0;
  expect(await runCli(args, io)).toBe(2);
  expect(JSON.parse(lines.join("")).error.code).toBe("TOO_LARGE");
  expect(received).toHaveLength(1);
  await writeFile(input, Buffer.from([123, 34, 110, 97, 109, 101, 34, 58, 34, 255, 34, 125]));
  lines.length = 0;
  expect(await runCli(args, io)).toBe(2);
  expect(received).toHaveLength(1);
});
test("socket errors after sending report an uncertain operation with its original request ID", async () => {
  const { Socket } = await import("node:net");
  const { vi } = await import("vitest");
  const { home, transport } = await fixture();
  const original = Socket.prototype.write;
  const write = vi.spyOn(Socket.prototype, "write").mockImplementation(function (
    this: import("node:net").Socket,
    ...args: Parameters<typeof original>
  ) {
    const body = args[0];
    if (Buffer.isBuffer(body) && body.toString().includes('"requestId":"reset-request"'))
      queueMicrotask(() =>
        this.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" })),
      );
    return original.apply(this, args);
  });
  try {
    const { send } = await import("./client.js");
    await expect(
      send(
        transport.descriptor!,
        "patent.create",
        {},
        { clientProof: "a".repeat(64) },
        "reset-request",
        1000,
      ),
    ).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      details: { requestId: "reset-request", command: "patent.create" },
    });
  } finally {
    write.mockRestore();
  }
});

test("documented DOCX session flag reaches the protocol unchanged", async () => {
  const received: AutomationRequest[] = [];
  const { home, transport } = await fixture(async (request) => {
    received.push(request);
    return {};
  });
  const sessionId = randomUUID();
  expect(
    await runCli(
      [
        "docx",
        "preview",
        "--session-id",
        sessionId,
        "--home",
        home,
        "--instance",
        transport.descriptor!.instanceId,
      ],
      { stdout: () => {}, stderr: () => {} },
    ),
  ).toBe(0);
  expect(received[0]).toMatchObject({ command: "docx.preview", payload: { sessionId } });
});

test("new global mutations persist retry metadata without recording credentials", async () => {
  const { home, transport } = await fixture(async () => ({}));
  const input = join(home, "probe.json");
  await writeFile(
    input,
    JSON.stringify({ profileId: randomUUID(), apiKey: "fixture-secret-never-log" }),
  );
  expect(
    await runCli(
      [
        "global",
        "models",
        "set-key",
        "--input",
        input,
        "--request-id",
        "global-key-once",
        "--home",
        home,
        "--instance",
        transport.descriptor!.instanceId,
      ],
      { stdout: () => {}, stderr: () => {} },
    ),
  ).toBe(0);
  const directory = join(home, "profiles", "requests");
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const journal = await readFile(join(directory, files[0]!), "utf8");
  expect(JSON.parse(journal)).toMatchObject({
    command: "global.models.set-key",
    requestId: "global-key-once",
  });
  expect(journal).not.toContain("fixture-secret-never-log");
});

test("renewal and exact-request polling report pending without a mutation journal or token disclosure", async () => {
  const pairId = randomUUID();
  let approved = false;
  const { home, transport } = await fixture(async (request) => {
    if (request.command === "pair.poll") {
      expect(request.payload.id).toBe(pairId);
      return approved
        ? { status: "authorized", token: "private-session-token", creationRemaining: 5 }
        : { status: "pending", pairId };
    }
    return { status: "pending", pairId };
  });
  const lines: string[] = [];
  const io = { stdout: (s: string) => lines.push(s), stderr: () => {} };
  const target = ["--home", home, "--instance", transport.descriptor!.instanceId];
  expect(await runCli(["pair", "renew-create", ...target], io)).toBe(4);
  expect(await runCli(["pair", "poll", "--id", pairId, ...target], io)).toBe(4);
  await expect(readdir(join(home, "profiles", "default", "requests"))).rejects.toThrow();
  approved = true;
  lines.length = 0;
  expect(await runCli(["pair", "poll", "--id", pairId, ...target], io)).toBe(0);
  expect(JSON.parse(lines.join("")).value).toEqual({ status: "authorized", creationRemaining: 5 });
  expect(lines.join("")).not.toContain("private-session-token");
});

test("failed operation receipts preserve documented conflict exit codes", async () => {
  const { home, transport } = await fixture(async () => ({
    status: "failed",
    result: { ok: false, error: { code: "REVISION_CONFLICT", message: "stale" } },
  }));
  const output: string[] = [];
  expect(
    await runCli(
      ["change", "apply", "--home", home, "--instance", transport.descriptor!.instanceId],
      { stdout: (s) => output.push(s), stderr: () => {} },
    ),
  ).toBe(5);
  expect(JSON.parse(output.join("")).value.result.error.code).toBe("REVISION_CONFLICT");
});

test("asset preview flag and JSON produce the same strict payload", async () => {
  const received: AutomationRequest[] = [];
  const { home, transport } = await fixture(async (request) => {
    received.push(request);
    return {};
  });
  const handle = randomUUID();
  const input = join(home, "preview.json");
  await writeFile(input, JSON.stringify({ assetHandle: handle }));
  const common = [
    "asset",
    "preview",
    "--home",
    home,
    "--instance",
    transport.descriptor!.instanceId,
  ];
  const io = { stdout: () => {}, stderr: () => {} };
  expect(await runCli([...common, "--asset-handle", handle], io)).toBe(0);
  expect(await runCli([...common, "--input", input], io)).toBe(0);
  expect(received.map((r) => r.payload)).toEqual([
    { assetHandle: handle },
    { assetHandle: handle },
  ]);
});
