import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function auditCadcraftRuntime(root, platform = process.platform, arch = process.arch) {
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const executable = platform === "win32" ? "cadcraft-codec.exe" : "cadcraft-codec";
  if (
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    manifest.executable !== executable ||
    manifest.revision !== "00c7613f1af3c73f7157fa91d9fe2635c6f23c06"
  )
    throw new Error("CAD 编辑组件版本或架构不匹配。");
  const bytes = await readFile(join(root, executable));
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256)
    throw new Error("CAD 编辑程序校验失败。");
  if (platform !== "win32") await access(join(root, executable), constants.X_OK);
  const javascript = await readFile(join(root, "wasm/cadcraft.js"), "utf8");
  const wasm = await readFile(join(root, "wasm/cadcraft_bg.wasm"));
  if (
    !javascript.includes("CadcraftSession") ||
    !wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
  )
    throw new Error("CAD 浏览器编辑组件校验失败。");
}
