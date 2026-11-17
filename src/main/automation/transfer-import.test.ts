// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { TransferHandoffStore } from "./transfer-handoff.js";
import {
  type AutomationTransferImportServices,
  AutomationTransferImports,
  supportsAutomationImportCommit,
} from "./transfer-import.js";

test.each([
  ["win32", true],
  ["darwin", true],
  ["linux", false],
  ["openharmony", false],
  ["ohos", false],
])("import commit support on %s is %s", (platform, supported) => {
  expect(supportsAutomationImportCommit(platform as string)).toBe(supported);
});

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zxw-ti-"));
  roots.push(root);
  const path = join(root, "data.zxwbackup");
  await writeFile(path, "fixture");
  let active = true;
  const owner = {
    grantId: randomUUID(),
    importDirectory: root,
    assertAuthorized: () => {
      if (!active) throw new Error("revoked");
    },
  };
  const services: AutomationTransferImportServices = {
    prepare: vi.fn<AutomationTransferImportServices["prepare"]>(
      async (_path, _password, operationId) => ({
        operationId,
        packageId: randomUUID(),
        exportedAt: new Date().toISOString(),
        summary: {
          activePatents: 0,
          trashedPatents: 0,
          documents: 0,
          legacyDrafts: 0,
          snapshots: 0,
          assets: 0,
          flowchartProjects: 0,
          totalBytes: 0,
        },
        packageVerified: true,
        versionCompatible: true,
        targetLibraryEmpty: true,
        settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"],
      }),
    ),
    discard: vi.fn(async () => {}),
    schedule: vi.fn(async () => {}),
    commit: vi.fn(async (_id, detach) => {
      await detach();
    }),
    fail: vi.fn(async () => {}),
  };
  return {
    root,
    path,
    owner,
    services,
    manager: new AutomationTransferImports(services),
    revoke: () => {
      active = false;
    },
  };
}
test("prepared packages bind to the grant, cannot commit twice, and detach only on execution", async () => {
  const f = await fixture();
  const prepared = await f.manager.prepare(
    f.path,
    "password",
    f.owner,
    new AbortController().signal,
  );
  expect(() => f.manager.read(prepared.importId, { ...f.owner, grantId: randomUUID() })).toThrow();
  expect(f.manager.read(prepared.importId, f.owner).preview.packageVerified).toBe(true);
  const detach = vi.fn(async () => {});
  expect(await f.manager.schedule(prepared.importId, f.owner)).toMatchObject({
    phase: "scheduled",
    restartPending: true,
  });
  expect(detach).not.toHaveBeenCalled();
  await expect(f.manager.schedule(prepared.importId, f.owner)).rejects.toThrow();
  await f.manager.commit(prepared.importId, f.owner, detach);
  expect(detach).toHaveBeenCalledOnce();
  await expect(f.manager.commit(prepared.importId, f.owner, detach)).rejects.toThrow();
});
test("revoked or expired prepared imports are discarded, including an unreceived scheduling receipt", async () => {
  const f = await fixture();
  const p = await f.manager.prepare(f.path, "password", f.owner, new AbortController().signal);
  await f.manager.schedule(p.importId, f.owner);
  f.revoke();
  await expect(f.manager.commit(p.importId, f.owner, async () => {})).rejects.toThrow("revoked");
  await f.manager.cleanup();
  expect(f.services.discard).toHaveBeenCalledWith(p.importId);
  expect(f.services.fail).toHaveBeenCalledWith(p.importId);
});
test("revocation during preparation disposes the newly created package and paths stay scoped", async () => {
  const f = await fixture();
  vi.mocked(f.services.prepare).mockImplementationOnce(async () => {
    f.revoke();
    return {} as never;
  });
  await expect(
    f.manager.prepare(f.path, "password", f.owner, new AbortController().signal),
  ).rejects.toThrow("revoked");
  expect(f.services.discard).toHaveBeenCalledOnce();
  const other = await fixture();
  await expect(
    other.manager.prepare(f.path, "password", other.owner, new AbortController().signal),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
});
test("an expired scheduled import cannot close the live database", async () => {
  const f = await fixture();
  const prepared = await f.manager.prepare(
    f.path,
    "password",
    f.owner,
    new AbortController().signal,
  );
  await f.manager.schedule(prepared.importId, f.owner);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 31 * 60_000);
  const detach = vi.fn(async () => {});
  await expect(f.manager.commit(prepared.importId, f.owner, detach)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(f.services.commit).not.toHaveBeenCalled();
  expect(detach).not.toHaveBeenCalled();
  await f.manager.cleanup();
  expect(f.services.fail).toHaveBeenCalledWith(prepared.importId);
  expect(f.services.discard).toHaveBeenCalledWith(prepared.importId);
});
test("handoff survives database replacement and is settled only against the matching recovery journal", async () => {
  const f = await fixture();
  const id = randomUUID();
  const store = new TransferHandoffStore(f.root, "/library");
  await store.write(id, "scheduled");
  expect(await new TransferHandoffStore(f.root, "/other-library").read()).toBeNull();
  await store.settle(randomUUID(), { status: "recovered" });
  expect(await store.read()).toMatchObject({ phase: "recovery-required" });
  await store.settle(id, { status: "recovered" });
  expect(await store.read()).toMatchObject({ importId: id, phase: "committed" });
  await store.write(id, "restart-validation-pending");
  await store.settle(id, { status: "rolled-back" });
  expect(await store.read()).toMatchObject({ phase: "rolled-back" });
});

test("concurrent scheduling reserves the preview before saving the restart receipt", async () => {
  const f = await fixture();
  const prepared = await f.manager.prepare(
    f.path,
    "password",
    f.owner,
    new AbortController().signal,
  );
  let finish!: () => void;
  vi.mocked(f.services.schedule).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const first = f.manager.schedule(prepared.importId, f.owner);
  await expect(f.manager.schedule(prepared.importId, f.owner)).rejects.toMatchObject({
    code: "OPERATION_IN_PROGRESS",
  });
  finish();
  await expect(first).resolves.toMatchObject({ phase: "scheduled" });
  const detach = vi.fn(async () => {});
  await f.manager.commit(prepared.importId, f.owner, detach);
  expect(detach).toHaveBeenCalledOnce();
});

test("a preview being discarded cannot also be scheduled for database replacement", async () => {
  const f = await fixture();
  const prepared = await f.manager.prepare(
    f.path,
    "password",
    f.owner,
    new AbortController().signal,
  );
  let finish!: () => void;
  vi.mocked(f.services.discard).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const discarding = f.manager.discard(prepared.importId, f.owner);
  await expect(f.manager.schedule(prepared.importId, f.owner)).rejects.toMatchObject({
    code: "OPERATION_IN_PROGRESS",
  });
  finish();
  await expect(discarding).resolves.toMatchObject({ discarded: true });
  expect(f.services.schedule).not.toHaveBeenCalled();
});

test("an executing import cannot enter database replacement twice", async () => {
  const f = await fixture();
  const prepared = await f.manager.prepare(
    f.path,
    "password",
    f.owner,
    new AbortController().signal,
  );
  await f.manager.schedule(prepared.importId, f.owner);
  let finish!: () => void;
  vi.mocked(f.services.commit).mockImplementationOnce(async (_id, detach) => {
    await detach();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const detach = vi.fn(async () => {});
  const first = f.manager.commit(prepared.importId, f.owner, detach);
  await expect(f.manager.commit(prepared.importId, f.owner, detach)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  finish();
  await first;
  expect(detach).toHaveBeenCalledOnce();
});
