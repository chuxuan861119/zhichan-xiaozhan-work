import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditMacTools } from "./audit-mac-tools.mjs";

test("rejects stale cleanup sources, wrong architecture and replaced native helpers", async () => {
  const root = await mkdtemp(join(tmpdir(), "mac-tool-audit-"));
  const tool = join(root, "resources/platform-tools");
  const source = join(root, "tools/platform");
  const digest = async (path) =>
    createHash("sha256").update(await readFile(path)).digest("hex");
  try {
    await mkdir(tool, { recursive: true });
    await mkdir(source, { recursive: true });
    for (const name of ["macos-move.c", "owned-cleanup.h", "macos-display-size.c"])
      await writeFile(join(source, name), name);
    for (const name of ["move-no-replace", "display-width-mm"])
      await writeFile(join(tool, name), name, { mode: 0o755 });
    const manifest = {
      target: "osx-arm64",
      sha256: await digest(join(tool, "move-no-replace")),
      sourceSha256: await digest(join(source, "macos-move.c")),
      cleanupSourceSha256: await digest(join(source, "owned-cleanup.h")),
      displayWidth: {
        sha256: await digest(join(tool, "display-width-mm")),
        sourceSha256: await digest(join(source, "macos-display-size.c")),
      },
    };
    await writeFile(join(tool, "manifest.json"), JSON.stringify(manifest));
    await auditMacTools(root, "arm64");
    await assert.rejects(auditMacTools(root, "x64"), /过期或架构/);
    await writeFile(join(source, "owned-cleanup.h"), "updated cleanup");
    await assert.rejects(auditMacTools(root, "arm64"), /过期或架构/);
    await writeFile(join(source, "owned-cleanup.h"), "owned-cleanup.h");
    await writeFile(join(tool, "move-no-replace"), "old binary");
    await assert.rejects(auditMacTools(root, "arm64"), /过期或架构/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
