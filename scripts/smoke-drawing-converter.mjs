import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { auditDrawingRuntime, drawingTarget } from "./audit-drawing-converter.mjs";

export async function smokeDrawingRuntime(root, target = drawingTarget()) {
  await auditDrawingRuntime(root, target);
  if (target !== drawingTarget())
    throw new Error("CAD 转换验收必须在对应系统及架构上执行，不能跳过安装包验收。");
  const directory = await mkdtemp(join(tmpdir(), "cad-package-smoke-"));
  try {
    const run = promisify(execFile);
    const mac = target.startsWith("osx-");
    const options = { timeout: 120_000, maxBuffer: 5 * 1024 * 1024, windowsHide: true };
    await run(
      join(root, mac ? "reader/CadReader" : "reader/CadReader.exe"),
      [
        fileURLToPath(new URL("../tests/fixtures/cad/sample_AC1032.dwg", import.meta.url)),
        join(directory, "read"),
      ],
      options,
    );
    await run(
      join(root, mac ? "renderer/render_svg" : "python/python.exe"),
      [
        ...(mac ? [] : ["-B", join(root, "render_svg.py")]),
        join(directory, "read/drawing.dxf"),
        join(directory, "render"),
      ],
      options,
    );
    const svg = await readFile(join(directory, "render/drawing.svg"), "utf8");
    if (!/<svg\b/u.test(svg) || !/viewBox="[^"]+"/u.test(svg) || !/<path\b/u.test(svg))
      throw new Error("CAD 安装资源未能生成有效图纸。");
    JSON.parse(await readFile(join(directory, "read/reader-report.json"), "utf8"));
    JSON.parse(await readFile(join(directory, "render/render-report.json"), "utf8"));
    return { svgBytes: Buffer.byteLength(svg) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
