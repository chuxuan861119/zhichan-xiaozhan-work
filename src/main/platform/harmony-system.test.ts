// @vitest-environment node
import { createHarmonySystem } from "./harmony-system.js";

test("Harmony activity uses native display/lock values and rejects malformed replies", async () => {
  let result = '{"active":true,"locked":false}';
  const bridge = {
    callArkTSFunction: vi.fn((_name: string, _type: string, args: unknown[]) =>
      (args[0] as (value: string) => void)(result),
    ),
  };
  const system = createHarmonySystem(bridge);
  expect(await system.readUsageActivity()).toEqual({ active: true, locked: false });
  expect(bridge.callArkTSFunction).toHaveBeenCalledWith("Workbench.ReadUsageActivity", "void", [
    expect.any(Function),
  ]);
  result = '{"active":true}';
  await expect(system.readUsageActivity()).rejects.toThrow();
});

test("Harmony startup reads real state asynchronously and opens system management", async () => {
  const call = vi.fn((name: string, _type: string, args: unknown[]) => {
    if (name === "Workbench.ReadStartup")
      (args[0] as (value: string) => void)('{"ok":true,"enabled":true}');
    else if (name === "Workbench.OpenStartupSettings") (args[0] as (value: number) => void)(0);
  });
  const system = createHarmonySystem({ callArkTSFunction: call });
  expect(await system.readStartup()).toBe(true);
  await system.openStartupSettings();
  expect(call).toHaveBeenLastCalledWith("Workbench.OpenStartupSettings", "void", [
    expect.any(Function),
  ]);
});

test("clipboard denied or unknown permission never returns success and allows a fresh retry", async () => {
  let permission = -1;
  const system = createHarmonySystem({
    callArkTSFunction: (_name, _type, args) => (args[1] as (value: number) => void)(permission),
  });
  await expect(system.requireClipboardAccess()).rejects.toMatchObject({
    code: "CLIPBOARD_PERMISSION_DENIED",
  });
  permission = 0;
  await expect(system.requireClipboardAccess()).resolves.toBeUndefined();
});

test("missing callbacks time out, ignore late results, and unavailable native bridges fail closed", async () => {
  vi.useFakeTimers();
  try {
    const pending = createHarmonySystem({ callArkTSFunction: () => undefined }, 50).readStartup();
    const assertion = expect(pending).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    await expect(createHarmonySystem({}).readStartup()).rejects.toThrow("不可用");
  } finally {
    vi.useRealTimers();
  }
});

test("external grants are restored without treating partial failures as full success", async () => {
  const system = createHarmonySystem({
    callArkTSFunction: (_name, _type, args) =>
      (args[0] as (value: string) => void)('{"restored":2,"failed":1}'),
  });
  expect(await system.restoreFileAccess()).toEqual({ restored: 2, failed: 1 });
});
