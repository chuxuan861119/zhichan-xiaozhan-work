import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function drawingTarget(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "win-x64";
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) return `osx-${arch}`;
  throw new Error(`Unsupported drawing runtime target: ${platform}-${arch}`);
}

export async function auditDrawingRuntime(
  root = resolve("resources/drawing-converter"),
  target = drawingTarget(),
) {
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if ((manifest.target ?? "win-x64") !== target)
    throw new Error(`图纸组件平台不匹配：需要 ${target}，实际 ${manifest.target ?? "win-x64"}`);
  if (manifest.drawingTiles !== 1)
    throw new Error("CAD 组件不支持当前分块图纸格式，请重新构建转换器。");
  const mac = target.startsWith("osx-");
  const required = [
    mac ? "reader/CadReader" : "reader/CadReader.exe",
    "reader/licenses/ACadSharp-MIT.txt",
    "reader/licenses/CSUtilities-MIT.txt",
    "reader/licenses/DOTNET-LICENSE.TXT",
    "reader/licenses/DOTNET-THIRD-PARTY-NOTICES.TXT",
    ...(mac
      ? ["renderer/render_svg", "licenses/PYTHON-LICENSE.txt", "licenses/python-components.json"]
      : ["python/python.exe", "python/LICENSE.txt"]),
    "render_svg.py",
    "tiled_svg.py",
  ];
  for (const name of required) {
    if (!manifest.files?.[name]) throw new Error(`图纸转换组件不完整：${name}`);
  }
  const canonicalRoot = await realpath(root);
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (name.includes("\\") || name.split("/").includes("..") || isAbsolute(name))
      throw new Error("运行环境清单路径无效。");
    const path = resolve(root, name);
    const rel = relative(canonicalRoot, await realpath(path));
    if (
      rel === ".." ||
      rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(rel)
    )
      throw new Error("运行环境清单路径越界。");
    const actual = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (actual !== expected) throw new Error(`图纸转换文件与构建清单不一致：${name}`);
  }
  if (mac)
    for (const name of ["reader/CadReader", "renderer/render_svg"])
      await access(join(root, name), constants.X_OK);
  if (mac) {
    const components = JSON.parse(
      await readFile(join(root, "licenses/python-components.json"), "utf8"),
    );
    for (const name of [
      "ezdxf",
      "numpy",
      "fonttools",
      "pyparsing",
      "typing_extensions",
      "Pillow",
      "pyinstaller",
    ]) {
      const component = components.find((item) => item.name === name);
      if (!component?.version || !component.notices?.length)
        throw new Error(`缺少 CAD Python 组件许可：${name}`);
      for (const notice of component.notices) {
        if (!manifest.files[`licenses/${notice}`])
          throw new Error(`CAD 许可未纳入校验清单：${notice}`);
      }
      if (name === "pyinstaller") {
        const texts = await Promise.all(
          component.notices.map((notice) => readFile(join(root, "licenses", notice), "utf8")),
        );
        if (!texts.some((text) => text.includes("Bootloader Exception")))
          throw new Error("缺少 PyInstaller Bootloader Exception 许可全文。");
      }
    }
  }
  return Object.keys(manifest.files).length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const count = await auditDrawingRuntime(undefined, process.argv[2] || drawingTarget());
  console.log(`图纸离线转换组件校验通过，共 ${count} 个文件。`);
}
