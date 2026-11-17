import { AiConnectionGate } from "./connection-gate.js";

test("blocks queued batches after disabling and aborts active transport", async () => {
  let enabled = true;
  const gate = new AiConnectionGate(async () => enabled);
  let transportSignal: AbortSignal | undefined;
  let finish!: () => void;
  const work = gate.run(new AbortController().signal, async (signal) => {
    transportSignal = signal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  await Promise.resolve();
  enabled = false;
  gate.cancelAll();
  expect(transportSignal?.aborted).toBe(true);
  const next = vi.fn();
  await expect(gate.run(new AbortController().signal, next)).rejects.toThrow("AI 连接已关闭");
  expect(next).not.toHaveBeenCalled();
  finish();
  await work;
});

test.each(["ohos", "openharmony"])(
  "blocks %s transport even with stored AI enabled",
  async (platform) => {
    const transport = vi.fn();
    const gate = new AiConnectionGate(async () => true, platform);
    await expect(gate.run(new AbortController().signal, transport)).rejects.toMatchObject({
      code: "AI_DISABLED",
    });
    expect(transport).not.toHaveBeenCalled();
  },
);
test.each(["darwin", "win32"])("retains %s AI transport", async (platform) => {
  const gate = new AiConnectionGate(async () => true, platform);
  await expect(gate.run(new AbortController().signal, async () => "ok")).resolves.toBe("ok");
});
