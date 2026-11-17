import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AiUploadConsent } from "./upload-consent.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ai-consent-"));
  roots.push(root);
  return { root, path: join(root, "ai-upload-consent.json"), consent: new AiUploadConsent(root) };
}
test("requires explicit approval, persists only an origin hash and reconfirms new destinations", async () => {
  const { root, path, consent } = await fixture();
  const ask = vi.fn(async () => true);
  await consent.ensure(new URL("https://provider.example/v1/chat/completions"), ask);
  await new AiUploadConsent(root).ensure(new URL("https://provider.example/other"), ask);
  expect(ask).toHaveBeenCalledTimes(1);
  expect(await readFile(path, "utf8")).not.toContain("provider.example");
  await consent.ensure(new URL("https://other.example/v1"), ask);
  expect(ask).toHaveBeenCalledTimes(2);
});
test("cancellation, unreadable receipt and abort never silently authorize", async () => {
  const { path, consent } = await fixture();
  const endpoint = new URL("https://provider.example/v1");
  await expect(consent.ensure(endpoint, async () => false)).rejects.toMatchObject({
    code: "AI_UPLOAD_CANCELLED",
  });
  await writeFile(path, "corrupted");
  const ask = vi.fn(async () => false);
  await expect(consent.ensure(endpoint, ask)).rejects.toThrow();
  expect(ask).toHaveBeenCalledOnce();
  const controller = new AbortController();
  await expect(
    consent.ensure(
      endpoint,
      async () => {
        controller.abort();
        return true;
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("corrupted");
});
test("only the supported local Ollama origin skips external permission", async () => {
  const { consent } = await fixture();
  const ask = vi.fn(async () => false);
  await consent.ensure(new URL("http://127.0.0.1:11434/v1"), ask);
  expect(ask).not.toHaveBeenCalled();
  await expect(consent.ensure(new URL("http://127.0.0.1:11435/v1"), ask)).rejects.toThrow();
});
test("concurrent requests do not duplicate prompts and retain both approved origins", async () => {
  const { root, consent } = await fixture();
  const ask = vi.fn(async () => true);
  await Promise.all(
    ["a", "a", "b"].map((host) => consent.ensure(new URL(`https://${host}.example/v1`), ask)),
  );
  expect(ask).toHaveBeenCalledTimes(2);
  await new AiUploadConsent(root).ensure(new URL("https://a.example/v1"), async () => false);
  await new AiUploadConsent(root).ensure(new URL("https://b.example/v1"), async () => false);
});

test("disabling connections during approval prevents both authorization and transport", async () => {
  const { consent, path } = await fixture();
  let enabled = true;
  const { AiConnectionGate } = await import("./connection-gate.js");
  const gate = new AiConnectionGate(async () => enabled);
  let answer!: (approved: boolean) => void;
  let asking!: () => void;
  const started = new Promise<void>((resolve) => {
    asking = resolve;
  });
  const pending = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  const transport = vi.fn();
  const request = gate.run(new AbortController().signal, async (signal) => {
    await consent.ensure(
      new URL("https://provider.example/v1"),
      () => {
        asking();
        return pending;
      },
      signal,
    );
    signal.throwIfAborted();
    transport();
  });
  const rejection = expect(request).rejects.toThrow();
  await started;
  enabled = false;
  gate.cancelAll();
  answer(true);
  await rejection;
  expect(transport).not.toHaveBeenCalled();
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});
