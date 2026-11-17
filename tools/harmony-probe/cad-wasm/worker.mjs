import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

// Each conversion has a disposable worker and in-memory filesystems. All runtime
// modules, Python wheels and fonts are bundled locally; no document leaves the device.
const root = dirname(fileURLToPath(import.meta.url));
function emitProgressLine(line) {
  if (typeof line !== "string" || line.length > 4096 || !line.startsWith("ZXW_CAD_PROGRESS "))
    return;
  try {
    parentPort.postMessage({ type: "progress", value: JSON.parse(line.slice(17)) });
  } catch {
    /* Ignore diagnostics. */
  }
}
async function convert() {
  const input = workerData.bytes;
  if (!(input instanceof Uint8Array) || input.length > 100 * 1024 * 1024)
    throw new Error("Invalid CAD input size");
  parentPort.postMessage({
    type: "progress",
    value: { phase: "read", completed: null, total: null },
  });
  const { dotnet } = await import("./dotnet/dotnet.js");
  const reader = await dotnet.withModuleConfig({ print() {}, printErr: emitProgressLine }).create();
  const fs = reader.Module.FS;
  fs.writeFile("/source.dwg", input);
  const code = await reader.runMain("CadWasm.dll", ["/source.dwg", "/output"]);
  if (code !== 0) throw new Error("DWG reader rejected the file");
  const dxf = fs.readFile("/output/drawing.dxf");
  const readerReport = JSON.parse(fs.readFile("/output/reader-report.json", { encoding: "utf8" }));
  fs.unlink("/source.dwg");
  fs.unlink("/output/drawing.dxf");
  parentPort.postMessage({
    type: "progress",
    value: { phase: "write", completed: null, total: null },
  });
  const { loadPyodide } = await import("./python/pyodide.mjs");
  const python = await loadPyodide({
    indexURL: join(root, "python/"),
    stdout() {},
    stderr: emitProgressLine,
  });
  await python.loadPackage(["ezdxf", "pillow"], { messageCallback() {}, errorCallback() {} });
  python.FS.mkdir("/fonts");
  python.FS.writeFile(
    "/fonts/SourceHanSerifCN-Regular.otf",
    await readFile(join(root, "font.otf")),
  );
  python.FS.writeFile("/input.dxf", dxf);
  python.FS.writeFile("/render.py", await readFile(join(root, "render_svg.py")));
  python.FS.writeFile("/tiled_svg.py", await readFile(join(root, "tiled_svg.py")));
  await python.runPythonAsync(`
import sys
sys.path.insert(0, "/")
from ezdxf.fonts import fonts
fonts.font_manager.build(["/fonts"], support_dirs=False)
fonts.font_manager.add_synonyms({"SourceHanSerifCN-Regular.otf":"Arial.ttf"}, reverse=False)
sys.argv=["render.py", "/input.dxf", "/output", "--source-bytes", "${input.length}"]
exec(compile(open("/render.py").read(), "/render.py", "exec"), {"__name__":"__main__"})
`);
  const rendererReport = JSON.parse(
    python.FS.readFile("/output/render-report.json", { encoding: "utf8" }),
  );
  if (python.FS.analyzePath("/output/index.json").exists) {
    if (typeof workerData.outputDirectory !== "string")
      throw new Error("Missing tile output directory");
    const indexBytes = python.FS.readFile("/output/index.json");
    if (indexBytes.length > 2 * 1024 * 1024) throw new Error("CAD_OUTPUT_TOO_LARGE");
    const index = JSON.parse(new TextDecoder().decode(indexBytes));
    if (!Array.isArray(index.tiles) || index.tiles.length > 4094) throw new Error("Invalid tiles");
    await mkdir(workerData.outputDirectory, { mode: 0o700 });
    let total = 0;
    for (const tile of index.tiles) {
      if (!/^tile-[0-9]{1,4}$/.test(tile.id)) throw new Error("Invalid tile name");
      const path = `/output/${tile.id}.svg`,
        bytes = python.FS.readFile(path);
      total += bytes.length;
      if (bytes.length > 8 * 1024 * 1024 || total > 512 * 1024 * 1024)
        throw new Error("CAD_OUTPUT_TOO_LARGE");
      await writeFile(join(workerData.outputDirectory, `${tile.id}.svg`), bytes, {
        flag: "wx",
        mode: 0o600,
      });
      python.FS.unlink(path);
    }
    await writeFile(join(workerData.outputDirectory, "index.json"), indexBytes, {
      flag: "wx",
      mode: 0o600,
    });
    parentPort.postMessage({ tiled: true, reader: readerReport, renderer: rendererReport });
  } else {
    const svg = python.FS.readFile("/output/drawing.svg");
    if (svg.length > 50 * 1024 * 1024) throw new Error("CAD_OUTPUT_TOO_LARGE");
    parentPort.postMessage({ svg, reader: readerReport, renderer: rendererReport });
  }
}
convert().catch((error) => {
  // Detailed converter exceptions can contain private drawing text and paths.
  parentPort.postMessage({
    error: "离线 CAD 转换失败，请核对图纸版本或完整性。",
    ...(error.message?.includes("CAD_OUTPUT_TOO_LARGE") ? { code: "CAD_OUTPUT_TOO_LARGE" } : {}),
  });
});
