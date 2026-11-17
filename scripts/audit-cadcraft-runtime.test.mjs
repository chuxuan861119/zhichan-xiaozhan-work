import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditCadcraftRuntime } from "./audit-cadcraft-runtime.mjs";

test("requires matching native codec and both browser runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cadcraft-audit-"));
  try {
    const binary = Buffer.from("fixture codec");
    await writeFile(join(root, "cadcraft-codec"), binary, { mode: 0o755 });
    const manifest = {
      platform: "darwin",
      arch: "arm64",
      revision: "00c7613f1af3c73f7157fa91d9fe2635c6f23c06",
      executable: "cadcraft-codec",
      sha256: createHash("sha256").update(binary).digest("hex"),
    };
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(auditCadcraftRuntime(root, "darwin", "arm64"), /ENOENT/);
    await mkdir(join(root, "wasm"));
    await writeFile(join(root, "wasm/cadcraft.js"), "export class CadcraftSession {}");
    await writeFile(
      join(root, "wasm/cadcraft_bg.wasm"),
      Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    await auditCadcraftRuntime(root, "darwin", "arm64");
    await assert.rejects(auditCadcraftRuntime(root, "darwin", "x64"), /架构/);
    await writeFile(join(root, "cadcraft-codec"), "tampered");
    await assert.rejects(auditCadcraftRuntime(root, "darwin", "arm64"), /校验/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
