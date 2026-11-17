import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { auditDrawingRuntime, drawingTarget } from "./audit-drawing-converter.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cad-runtime-audit-"));
  const files = {};
  for (const name of [
    "reader/CadReader",
    "renderer/render_svg",
    "reader/licenses/ACadSharp-MIT.txt",
    "reader/licenses/CSUtilities-MIT.txt",
    "reader/licenses/DOTNET-LICENSE.TXT",
    "reader/licenses/DOTNET-THIRD-PARTY-NOTICES.TXT",
    "licenses/PYTHON-LICENSE.txt",
    "licenses/python-components.json",
    "render_svg.py",
    "tiled_svg.py",
  ]) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    const text =
      name === "licenses/python-components.json"
        ? JSON.stringify(
            [
              "ezdxf",
              "numpy",
              "fonttools",
              "pyparsing",
              "typing_extensions",
              "Pillow",
              "pyinstaller",
            ].map((name) => ({ name, version: "fixture", notices: ["PYTHON-LICENSE.txt"] })),
          )
        : name === "licenses/PYTHON-LICENSE.txt"
          ? "Bootloader Exception fixture"
          : name;
    await writeFile(join(root, name), text);
    await chmod(join(root, name), 0o755);
    files[name] = createHash("sha256").update(text).digest("hex");
  }
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({ target: "osx-arm64", drawingTiles: 1, files }),
  );
  return root;
}

test("selects native targets and rejects unsupported architectures", () => {
  assert.equal(drawingTarget("darwin", "arm64"), "osx-arm64");
  assert.equal(drawingTarget("darwin", "x64"), "osx-x64");
  assert.equal(drawingTarget("win32", "x64"), "win-x64");
  assert.throws(() => drawingTarget("win32", "arm64"));
});
test("rejects an empty Python license index even when the file hash matches", async () => {
  const root = await fixture();
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  await writeFile(join(root, "licenses/python-components.json"), "[]");
  manifest.files["licenses/python-components.json"] = createHash("sha256")
    .update("[]")
    .digest("hex");
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(auditDrawingRuntime(root, "osx-arm64"), /组件许可/);
});
test("rejects a wrong-platform runtime and any altered binary", async () => {
  const root = await fixture();
  assert.equal(await auditDrawingRuntime(root, "osx-arm64"), 10);
  await assert.rejects(auditDrawingRuntime(root, "win-x64"), /平台不匹配/);
  await writeFile(join(root, "reader/CadReader"), "tampered");
  await assert.rejects(auditDrawingRuntime(root, "osx-arm64"), /不一致/);
});
test("rejects manifest traversal and escaping symlinks", async () => {
  const root = await fixture();
  const path = join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.files["../escape"] = "unused";
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(auditDrawingRuntime(root, "osx-arm64"), /路径无效/);
  if (process.platform !== "win32") {
    delete manifest.files["../escape"];
    const outside = join(await mkdtemp(join(tmpdir(), "cad-external-")), "data");
    await writeFile(outside, "external");
    await symlink(outside, join(root, "escape"));
    manifest.files.escape = createHash("sha256").update("external").digest("hex");
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(auditDrawingRuntime(root, "osx-arm64"), /路径越界/);
  }
});
