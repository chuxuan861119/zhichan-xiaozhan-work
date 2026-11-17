import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drawingRuntimeCommands } from "./drawing-runtime.js";

async function binaries(root: string, names: string[]) {
  for (const name of names) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "fixture");
    await chmod(path, 0o755);
  }
}

test("missing or unusable components have a recoverable CAD error instead of INTERNAL", async () => {
  const root = await mkdtemp(join(tmpdir(), "drawing-missing-"));
  await expect(drawingRuntimeCommands(root, "darwin", "arm64")).rejects.toMatchObject({
    code: "CAD_RUNTIME_UNAVAILABLE",
  });
  await writeFile(join(root, "manifest.json"), JSON.stringify({ target: "osx-arm64" }));
  await expect(drawingRuntimeCommands(root, "darwin", "arm64")).rejects.toMatchObject({
    code: "CAD_RUNTIME_UNAVAILABLE",
  });
});

test("selects native Mac converters and preserves input/output as separate arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "drawing-runtime-"));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ target: "osx-arm64" }));
  await binaries(root, ["reader/CadReader", "renderer/render_svg"]);
  const commands = await drawingRuntimeCommands(root, "darwin", "arm64");
  expect(commands.reader).toBe(join(root, "reader", "CadReader"));
  expect(commands.renderer).toBe(join(root, "renderer", "render_svg"));
  expect(commands.rendererArguments).toEqual([]);
});

test("a tiled Mac runtime requires readable Python modules without an executable bit", async () => {
  const root = await mkdtemp(join(tmpdir(), "drawing-runtime-tiles-"));
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({ target: "osx-arm64", drawingTiles: 1 }),
  );
  await binaries(root, ["reader/CadReader", "renderer/render_svg"]);
  await writeFile(join(root, "tiled_svg.py"), "fixture", { mode: 0o644 });
  expect((await drawingRuntimeCommands(root, "darwin", "arm64")).drawingTiles).toBe(true);
});

test("refuses a runtime built for another operating system or architecture", async () => {
  const root = await mkdtemp(join(tmpdir(), "drawing-runtime-"));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ target: "win-x64" }));
  await expect(drawingRuntimeCommands(root, "darwin", "arm64")).rejects.toThrow("架构");
  await writeFile(join(root, "manifest.json"), JSON.stringify({ target: "osx-x64" }));
  await expect(drawingRuntimeCommands(root, "darwin", "arm64")).rejects.toThrow("架构");
});

test("keeps the existing Windows embedded Python runtime compatible", async () => {
  const root = await mkdtemp(join(tmpdir(), "drawing-runtime-"));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ files: {} }));
  await binaries(root, ["reader/CadReader.exe", "python/python.exe", "render_svg.py"]);
  const commands = await drawingRuntimeCommands(root, "win32", "x64");
  expect(commands.reader).toBe(join(root, "reader", "CadReader.exe"));
  expect(commands.rendererArguments).toEqual(["-B", join(root, "render_svg.py")]);
  await expect(drawingRuntimeCommands(root, "darwin", "arm64")).rejects.toThrow("架构");
});
