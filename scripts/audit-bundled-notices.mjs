import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { generateDrawioEmbeddedNotices } from "./audit-drawio-licenses.mjs";

export const BUNDLED_NOTICES_MARKER = "\nBUNDLED RESOURCE NOTICES\n";
const FIXED_MATERIALS = [
  ["Product attributions", "licenses/PRODUCT_ATTRIBUTIONS.txt"],
  ["Selection cursor: xbitmaps 1.1.3", "licenses/xbitmaps/LICENSE.txt"],
  ["draw.io LICENSE", "licenses/drawio/LICENSE"],
  ["draw.io NOTICE", "licenses/drawio/NOTICE"],
  ["draw.io third-party inventory", "licenses/drawio/THIRD_PARTY_NOTICES.md"],
  ["IPC data center: Tailwind CSS (MIT)", "ipc-data-center/licenses/tailwind-MIT.txt"],
  ["IPC data center: Font Awesome 4.7 CSS (MIT)", "ipc-data-center/licenses/font-awesome-MIT.txt"],
  [
    "IPC data center: Font Awesome 4.7 fonts (SIL OFL 1.1)",
    "ipc-data-center/licenses/SIL-OFL-1.1.txt",
  ],
];

async function licenseFiles(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`License material is a symbolic link: ${path}`);
    if (entry.isDirectory()) files.push(...(await licenseFiles(root, path)));
    else if (
      entry.isFile() &&
      /^(license|licence|copying|copyright|notice|third[-_]party|dotnet-|acadsharp-|csutilities-|python-license)/iu.test(
        entry.name,
      )
    )
      files.push(path);
  }
  return files.sort();
}

export async function syncElectronLicenseMaterials(root) {
  const dist = join(root, "node_modules/electron/dist");
  const manifest = JSON.parse(
    await readFile(join(root, "node_modules/electron/package.json"), "utf8"),
  );
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const runtimeVersion = (await readFile(join(dist, "version"), "utf8")).trim().replace(/^v/, "");
  if (
    lock.packages["node_modules/electron"].version !== manifest.version ||
    runtimeVersion !== manifest.version
  )
    throw new Error("Electron license input does not match the locked runtime version");
  const materialRoot = join(root, "resources/licenses/electron");
  const license = await readFile(join(dist, "LICENSE"));
  const chromium = await readFile(join(dist, "LICENSES.chromium.html"));
  if (!license.length || !chromium.length)
    throw new Error("Electron runtime license material is empty");
  await mkdir(materialRoot, { recursive: true });
  await writeFile(join(materialRoot, "LICENSE.txt"), license);
  await writeFile(join(materialRoot, "LICENSES.chromium.html.gz"), gzipSync(chromium));
  await writeFile(
    join(materialRoot, "provenance.json"),
    `${JSON.stringify({ version: manifest.version, source: `https://github.com/electron/electron/releases/tag/v${manifest.version}`, files: { "LICENSE.txt": createHash("sha256").update(license).digest("hex"), "LICENSES.chromium.html": createHash("sha256").update(chromium).digest("hex") } }, null, 2)}\n`,
  );
}

export async function generateBundledResourceNotices(
  root,
  { includeDrawingConverter = true, includeElectron = true, includeCad = true } = {},
) {
  const resources = join(root, "resources");
  const materials = [...FIXED_MATERIALS];
  const context = [];
  // The editable CAD runtime must ship its MPL source alongside executable code.
  if (includeCad) {
    const cadRoot = join(resources, "cadcraft");
    const source = await readFile(join(cadRoot, "sources/acadrust-0.6.3.crate"));
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const lock = await readFile(join(cadRoot, "sources/Cargo.lock"), "utf8");
    const dependency = lock.split("[[package]]").find(section =>
      section.includes('name = "acadrust"') && section.includes('version = "0.6.3"'));
    const notice = await readFile(join(cadRoot, "NOTICE.txt"), "utf8");
    if (!dependency?.includes(`checksum = "${sourceHash}"`) || !notice.includes(sourceHash))
      throw new Error("CAD MPL corresponding source does not match the locked dependency and NOTICE");
    await readFile(join(cadRoot, "licenses/LICENSE-MIT"));
    await readFile(join(cadRoot, "licenses/acadrust-0.6.3/LICENSE"));
    materials.push(["Cadcraft and acadrust source availability", "cadcraft/NOTICE.txt"]);
    for (const path of await licenseFiles(join(cadRoot, "licenses")))
      materials.push([`CAD editor: ${path}`, `cadcraft/licenses/${path}`]);
  }
  if (includeElectron) {
    const provenance = JSON.parse(
      await readFile(join(resources, "licenses/electron/provenance.json"), "utf8"),
    );
    materials.push([`Electron ${provenance.version} (MIT)`, "licenses/electron/LICENSE.txt"]);
    context.push(
      `Electron/Chromium runtime notices: resources/licenses/electron/LICENSES.chromium.html.gz (lossless gzip of original HTML; extract to read). Original HTML SHA-256: ${provenance.files["LICENSES.chromium.html"]}. Source: ${provenance.source}`,
    );
  }

  if (includeDrawingConverter) {
    const converter = join(resources, "drawing-converter");
    let present = false;
    try {
      present = (await stat(converter)).isDirectory();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (present) {
      const manifest = JSON.parse(await readFile(join(converter, "manifest.json"), "utf8"));
      for (const name of [
        "ACadSharp-MIT.txt",
        "CSUtilities-MIT.txt",
        "DOTNET-LICENSE.TXT",
        "DOTNET-THIRD-PARTY-NOTICES.TXT",
      ]) {
        await readFile(join(converter, "reader/licenses", name));
      }
      const paths = await licenseFiles(converter);
      if (!paths.some((path) => /(?:PYTHON-LICENSE\.txt|python\/LICENSE\.txt)$/iu.test(path)))
        throw new Error("Drawing converter: Python license is missing");
      for (const path of paths)
        materials.push([`CAD converter: ${path}`, `drawing-converter/${path}`]);
      context.push(
        `CAD converter target: ${manifest.target ?? "win-x64"}; ACadSharp ${manifest.reader}; ezdxf ${manifest.ezdxf}; ${manifest.python ?? "Python version recorded by converter distribution"}.`,
      );
      context.push(
        "PyInstaller materials retain the upstream bootloader exception and file-specific license terms; no blanket GPL-only classification is applied to the frozen application.",
      );
    }
  }
  const sections = [];
  for (const [label, path] of materials) {
    const text = (await readFile(join(resources, path), "utf8")).replace(/\r\n?/gu, "\n");
    if (!text.trim()) throw new Error(`Empty license material: ${path}`);
    sections.push(
      [
        "================================================================================",
        label,
        `Bundled material: resources/${path}`,
        `SHA-256: ${createHash("sha256")
          .update(await readFile(join(resources, path)))
          .digest("hex")}`,
        "--------------------------------------------------------------------------------",
        text.replace(/[ \t]+$/gmu, "").trim(),
      ].join("\n"),
    );
  }
  return (
    [
      BUNDLED_NOTICES_MARKER,
      "Original bundled resource notices supplement the npm dependency inventory.",
      ...context,
      ...sections,
      await generateDrawioEmbeddedNotices(root),
      "",
    ]
      .join("\n")
      .trimEnd() + "\n"
  );
}

export function bundledLicenseIndex({
  includeDrawingConverter = true,
  includeElectron = true,
} = {}) {
  return `# 开源许可证与第三方声明索引\n\n完整汇总：[THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt)。其中保留原始许可、版权和 NOTICE；界面中的组件说明是摘要。\n\n- [产品署名](PRODUCT_ATTRIBUTIONS.txt)；[选区光标 xbitmaps](xbitmaps/LICENSE.txt)。\n- [npm 许可材料](npm/)：React、Tiptap/ProseMirror、Lucide、DOCX、PDF.js、DOMPurify 及其生产依赖，逐项版本与文本见完整汇总。\n- [draw.io](drawio/)：LICENSE、NOTICE、内嵌依赖原始许可与版本来源。\n- [Ketcher / Indigo](ketcher/)：原始 LICENSE、NOTICE；WASM 来源及哈希见完整汇总。\n- [Sharp / libvips](sharp-libvips/)：许可证、对应源码及动态库替换说明。\n- [思源宋体](source-han-serif/)：OFL、版权和字体来源说明。\n- [IPC 数据中心](../ipc-data-center/licenses/)：Tailwind CSS MIT、Font Awesome 4.7 CSS MIT 与字体 SIL OFL 1.1。\n${includeDrawingConverter ? "- [CAD 转换器](../drawing-converter/)：reader/licenses 中的 ACadSharp、CSUtilities、.NET 声明，以及 licenses 或 python 目录中的 Python 组件许可。具体版本以该目录 manifest.json 为准。\n" : ""}- [CAD 编辑与 DWG/DXF 导出](../cadcraft/NOTICE.txt)：Cadcraft 按 MIT 选项使用，原始署名及依赖许可证位于 \`cadcraft/licenses/\`；DWG 编解码使用未修改的 acadrust 0.6.3（MPL-2.0），完整对应源码可在 https://zcxzz.cn/open-source/ 免费获取，版本化下载地址和校验值见安装目录的 OPEN_SOURCE_DOWNLOADS.txt；源码权利不受应用条款限制。原始许可与 NOTICE 随应用保留。\n- [鸿蒙 CAD 材料](harmony-cad/)：Pyodide、CPython 及源码获取说明，仅相关运行时使用；实际打包清单与汇总以目标平台为准。\n\n${includeElectron ? "Electron / Chromium：[Electron MIT](electron/LICENSE.txt)、[Chromium 完整声明](electron/LICENSES.chromium.html.gz)（解压后以浏览器打开原始 HTML）；版本、来源和原始文件哈希见 electron/provenance.json。" : "鸿蒙运行时声明见 ../HARMONY_ELECTRON_NOTICES.txt（发行方提供时），不引用桌面 Electron 的材料。"}Windows Agent CLI 独立 Node.js 的许可在 cli/runtime/LICENSE.txt。\n\n系统已有字体只引用本机文件，不随应用重新分发。许可证约束和例外以原始文本为准。\n`;
}
