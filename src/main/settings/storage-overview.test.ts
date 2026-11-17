import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectStorageFolder } from "./storage-overview.js";

test("storage overview counts regular files and distinguishes unavailable folders", async () => {
  const folder = await mkdtemp(join(tmpdir(), "storage-overview-"));
  try {
    await writeFile(join(folder, "example.txt"), "12345");
    expect(await inspectStorageFolder(folder)).toEqual({ path: folder, bytes: 5, partial: false });
    expect(await inspectStorageFolder(join(folder, "missing"))).toMatchObject({ partial: true });
    expect(await inspectStorageFolder(null)).toEqual({ path: null, bytes: null, partial: false });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
