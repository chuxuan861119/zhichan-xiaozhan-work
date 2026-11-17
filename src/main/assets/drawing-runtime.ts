import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppOperationError } from "../app-operation-error.js";

/** Include the entire pinned runtime inventory, not just a library version. */
export async function drawingRuntimeCacheIdentity(root: string) {
  const harmony = ["openharmony", "ohos"].includes(process.platform as string);
  try {
    const manifest = await readFile(join(root, harmony ? "wasm/manifest.json" : "manifest.json"));
    if (harmony) {
      if (JSON.parse(manifest.toString()).target !== "wasm32-offline")
        throw new Error("CAD target mismatch");
      await access(join(root, "wasm/worker.mjs"));
    }
    return createHash("sha256").update(manifest).digest("hex");
  } catch {
    throw new AppOperationError({
      code: "CAD_RUNTIME_UNAVAILABLE",
      message: "CAD runtime unavailable",
    });
  }
}

export async function drawingRuntimeCommands(
  root: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
) {
  let drawingTiles = false;
  const target =
    platform === "win32" && arch === "x64"
      ? "win-x64"
      : platform === "darwin" && (arch === "arm64" || arch === "x64")
        ? `osx-${arch}`
        : null;
  try {
    if (!target) throw new Error("Unsupported CAD architecture");
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    drawingTiles = manifest.drawingTiles === 1;
    if ((manifest.target ?? "win-x64") !== target) throw new Error("CAD target mismatch");
    const required =
      platform === "darwin"
        ? ["reader/CadReader", "renderer/render_svg"]
        : ["reader/CadReader.exe", "python/python.exe", "render_svg.py"];
    if (drawingTiles) required.push("tiled_svg.py");
    for (const name of required)
      await access(
        join(root, name),
        platform === "darwin" && !name.endsWith(".py") ? constants.X_OK : constants.R_OK,
      );
  } catch {
    throw new AppOperationError({
      code: "CAD_RUNTIME_UNAVAILABLE",
      message: "CAD runtime unavailable",
    });
  }
  if (platform === "darwin") {
    return {
      drawingTiles,
      reader: join(root, "reader", "CadReader"),
      renderer: join(root, "renderer", "render_svg"),
      rendererArguments: [] as string[],
    };
  }
  return {
    drawingTiles,
    reader: join(root, "reader", "CadReader.exe"),
    renderer: join(root, "python", "python.exe"),
    rendererArguments: ["-B", join(root, "render_svg.py")],
  };
}
