import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Development and packaging must use helpers built from the current recovery protocol. */
export async function auditMacTools(root, arch = process.arch) {
  const tools = join(root, "resources/platform-tools");
  const manifest = JSON.parse(await readFile(join(tools, "manifest.json"), "utf8"));
  const digest = async (path) =>
    createHash("sha256").update(await readFile(path)).digest("hex");
  if (
    manifest.target !== `osx-${arch}` ||
    manifest.sha256 !== (await digest(join(tools, "move-no-replace"))) ||
    manifest.sourceSha256 !== (await digest(join(root, "tools/platform/macos-move.c"))) ||
    manifest.cleanupSourceSha256 !== (await digest(join(root, "tools/platform/owned-cleanup.h"))) ||
    manifest.displayWidth?.sha256 !== (await digest(join(tools, "display-width-mm"))) ||
    manifest.displayWidth?.sourceSha256 !==
      (await digest(join(root, "tools/platform/macos-display-size.c")))
  )
    throw new Error("Mac 文件迁移组件缺失、过期或架构错误，请运行 npm run vendor:mac-tools。");
  await access(join(tools, "move-no-replace"), constants.X_OK);
  await access(join(tools, "display-width-mm"), constants.X_OK);
}
