import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedMacBundle, runDockOnboarding } from "./dock-onboarding.js";

async function fixture() {
  const userData = await mkdtemp(join(tmpdir(), "dock-onboarding-test-"));
  let pinned = false;
  const ask = vi.fn(async () => true);
  const add = vi.fn(async () => {
    pinned = true;
  });
  const reportFailure = vi.fn(async () => undefined);
  const options = { userData, ask, add, contains: async () => pinned, reportFailure };
  return {
    options,
    ask,
    add,
    reportFailure,
    remove: () => {
      pinned = false;
    },
  };
}

test("first choice is durable: later removal never causes another prompt or add", async () => {
  const f = await fixture();
  await runDockOnboarding(f.options);
  expect(f.add).toHaveBeenCalledOnce();
  f.remove();
  await runDockOnboarding(f.options);
  expect(f.ask).toHaveBeenCalledOnce();
  expect(f.add).toHaveBeenCalledOnce();
  expect(await readFile(join(f.options.userData, "mac-dock-onboarding-v1.json"), "utf8")).toContain(
    "prompted",
  );
});

test("decline, existing pin, and concurrent window activation do not duplicate work", async () => {
  const f = await fixture();
  f.ask.mockResolvedValue(false);
  await Promise.all([runDockOnboarding(f.options), runDockOnboarding(f.options)]);
  await runDockOnboarding(f.options);
  expect(f.ask).toHaveBeenCalledOnce();
  expect(f.add).not.toHaveBeenCalled();
  const existing = await fixture();
  existing.options.contains = async () => true;
  await runDockOnboarding(existing.options);
  expect(existing.ask).not.toHaveBeenCalled();
  expect(existing.add).not.toHaveBeenCalled();
});

test("failed addition is reported once and never silently retried", async () => {
  const f = await fixture();
  f.add.mockRejectedValue(new Error("write rejected"));
  await runDockOnboarding(f.options);
  await runDockOnboarding(f.options);
  expect(f.reportFailure).toHaveBeenCalledOnce();
  expect(f.add).toHaveBeenCalledOnce();
});

test("cannot write marker means no prompt and no system mutation", async () => {
  const f = await fixture();
  const file = join(f.options.userData, "file");
  await writeFile(file, "existing");
  await expect(runDockOnboarding({ ...f.options, userData: file })).rejects.toThrow();
  expect(f.ask).not.toHaveBeenCalled();
  expect(f.add).not.toHaveBeenCalled();
});

test("bundle eligibility excludes development, mounted images and isolated instances", () => {
  const options = {
    platform: "darwin",
    packaged: true,
    isolated: false,
    executable: "/Applications/知产小栈Work.app/Contents/MacOS/知产小栈Work",
    home: "/Users/test",
  };
  expect(installedMacBundle(options)).toBe("/Applications/知产小栈Work.app");
  for (const patch of [
    { platform: "win32" },
    { packaged: false },
    { isolated: true },
    { executable: "/Volumes/install/知产小栈Work.app/Contents/MacOS/知产小栈Work" },
    { executable: "/Applications-other/a.app/Contents/MacOS/a" },
  ])
    expect(installedMacBundle({ ...options, ...patch })).toBeNull();
  expect(
    installedMacBundle({
      ...options,
      executable: "/Users/test/Applications/知产小栈Work.app/Contents/MacOS/知产小栈Work",
    }),
  ).toBe("/Users/test/Applications/知产小栈Work.app");
});
