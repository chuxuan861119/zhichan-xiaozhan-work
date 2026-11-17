import { RendererSaveRecovery } from "./renderer-save-recovery";

test("retains failed tasks for retry without duplicating an in-flight save", async () => {
  const recovery = new RendererSaveRecovery();
  let release!: () => void;
  let failing = true;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = vi.fn(async () => {
    await gate;
    if (failing) throw Error("disk unavailable");
  });
  recovery.retain({}, save);
  const first = recovery.flush();
  const second = recovery.flush();
  await Promise.resolve();
  expect(save).toHaveBeenCalledOnce();
  release();
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  failing = false;
  expect(await recovery.flush()).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
  expect(await recovery.flush()).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
});

test("includes tasks detached while earlier saves are being awaited", async () => {
  const recovery = new RendererSaveRecovery();
  let release!: () => void;
  recovery.retain(
    {},
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = recovery.flush();
  await Promise.resolve();
  const second = vi.fn(async () => {
    throw Error("not saved");
  });
  recovery.retain({}, second);
  release();
  expect(await pending).toBe(false);
});
