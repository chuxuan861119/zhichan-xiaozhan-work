import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ImportStagingOwnership } from "./import-staging-ownership.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const operationId = "00000000-0000-4000-8000-000000000052";
test("failed receipt publication can be cancelled without leaving a partial that blocks retries", async () => {
  const f = await fixture();
  const store = new ImportStagingOwnership({
    ...f.options,
    renameReceipt: async () => {
      throw new Error("simulated rename failure");
    },
  });
  await expect(store.begin(operationId)).rejects.toThrow("simulated rename failure");
  await store.finish();
  expect(await readdir(f.options.applicationDataRoot)).toEqual([]);
  await f.store.begin(operationId);
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "staging-ownership-"));
  roots.push(root);
  const options = {
    applicationDataRoot: join(root, "app"),
    libraryRoot: join(root, "app", "Library"),
    userDataRoot: join(root, "user"),
  };
  await mkdir(options.applicationDataRoot);
  await mkdir(options.userDataRoot);
  const staging = join(dirname(options.libraryRoot), `.import-staging-${operationId}`);
  const store = new ImportStagingOwnership(options);
  return { root, options, staging, store };
}
test("recovers abandoned preparation after restart and removes its durable ownership receipt", async () => {
  const f = await fixture();
  await f.store.begin(operationId);
  await mkdir(f.staging);
  const info = await lstat(f.staging, { bigint: true });
  await f.store.register(f.staging, {
    device: String(info.dev),
    inode: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
  });
  await writeFile(join(f.staging, "temporary.bin"), "owned");
  await new ImportStagingOwnership(f.options).recover({ exclusiveStartup: true });
  expect(await readdir(f.options.applicationDataRoot)).toEqual([]);
});
test("never deletes a replaced preparation directory", async () => {
  const f = await fixture();
  await f.store.begin(operationId);
  await mkdir(f.staging);
  const info = await lstat(f.staging, { bigint: true });
  await f.store.register(f.staging, {
    device: String(info.dev),
    inode: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
  });
  const { rename } = await import("node:fs/promises");
  await rename(f.staging, `${f.staging}.moved`);
  await mkdir(f.staging);
  await writeFile(join(f.staging, "foreign.txt"), "preserve");
  await expect(f.store.recover({ exclusiveStartup: true })).rejects.toThrow();
  expect(await readFile(join(f.staging, "foreign.txt"), "utf8")).toBe("preserve");
});
test("a swap journal protects staging from pre-swap cleanup", async () => {
  const f = await fixture();
  await f.store.begin(operationId);
  await mkdir(f.staging);
  await writeFile(join(f.options.applicationDataRoot, "pending-data-import.json"), "swap journal");
  await f.store.recover({ exclusiveStartup: true });
  await expect(lstat(f.staging)).resolves.toBeDefined();
});
test("an unresolved quarantined journal protects candidates across repeated cleanups", async () => {
  const f = await fixture();
  await f.store.begin(operationId);
  await mkdir(f.staging);
  const info = await lstat(f.staging, { bigint: true });
  await f.store.register(f.staging, {
    device: String(info.dev),
    inode: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
  });
  await writeFile(join(f.staging, "candidate.txt"), "retain recovery candidate");
  await writeFile(
    join(f.options.applicationDataRoot, `pending-data-import.json.failed-${operationId}`),
    "original damaged recovery bytes",
  );
  for (let restart = 0; restart < 3; restart++) {
    await new ImportStagingOwnership(f.options).recover({ exclusiveStartup: true });
    expect(await readFile(join(f.staging, "candidate.txt"), "utf8")).toBe(
      "retain recovery candidate",
    );
  }
});
test("a truncated first receipt write is safely recoverable before any root is created", async () => {
  const f = await fixture();
  await writeFile(
    join(f.options.applicationDataRoot, "data-import-staging.json.partial"),
    '{"version":',
  );
  await f.store.recover({ exclusiveStartup: true });
  expect(await readdir(f.options.applicationDataRoot)).toEqual([]);
});
test("publishes newer partial identities before cleanup, retaining them when a foreign child blocks cleanup", async () => {
  const f = await fixture();
  await f.store.begin(operationId);
  await mkdir(f.staging);
  const receiptPath = join(f.options.applicationDataRoot, "data-import-staging.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const info = await lstat(f.staging, { bigint: true });
  receipt.roots[0].identity = {
    device: String(info.dev),
    inode: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
  };
  await writeFile(`${receiptPath}.partial`, JSON.stringify(receipt));
  // A directory junction must not be followed or removed by owned cleanup.
  const { symlink } = await import("node:fs/promises");
  await symlink(f.options.userDataRoot, join(f.staging, "foreign"), "junction");
  await expect(f.store.recover({ exclusiveStartup: true })).rejects.toThrow();
  expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(receipt);
});
