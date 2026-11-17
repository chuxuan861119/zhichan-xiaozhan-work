const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { Arch } = require("builder-util");
module.exports = async (context) => {
  const root = context.packager.projectDir;
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const [major, minor, patch] = version.split(".").map(Number);
  if (major === 1 && (minor < 1 || (minor === 1 && patch < 7)))
    throw new Error("官网源码分发从 1.1.7 开始；不要重新打包已发布的 1.1.6。");
  const platform = context.electronPlatformName,
    arch = Arch[context.arch];
  const load = (name) => import(pathToFileURL(join(root, "scripts", name)).href);
  const { auditDrawingRuntime, drawingTarget } = await load("audit-drawing-converter.mjs");
  const target = drawingTarget(platform, arch);
  const cadRoot = join(root, "resources/cadcraft");
  const cad = JSON.parse(await readFile(join(cadRoot, "manifest.json"), "utf8"));
  const cadExecutable = platform === "win32" ? "cadcraft-codec.exe" : "cadcraft-codec";
  if (
    cad.platform !== platform ||
    cad.arch !== arch ||
    cad.executable !== cadExecutable ||
    cad.sha256 !==
      createHash("sha256")
        .update(await readFile(join(cadRoot, cadExecutable)))
        .digest("hex")
  )
    throw new Error("CAD 编辑内核缺失或目标架构不匹配，请在目标平台运行 npm run vendor:cad。");
  await readFile(join(cadRoot, "sources/acadrust-0.6.3.crate"));
  await auditDrawingRuntime(join(root, "resources/drawing-converter"), target);
  if (platform === "darwin") {
    const { MAC_ELECTRON_FUSES } = await load("mac-release-policy.mjs");
    context.packager.config.electronFuses = {
      ...context.packager.config.electronFuses,
      ...MAC_ELECTRON_FUSES,
    };
    await (await load("audit-mac-tools.mjs")).auditMacTools(root, arch);
  }
  await (await load("audit-licenses.mjs")).auditLicenses(root, { platform, arch });
  await require("./open-source-distribution.cjs").createSourceBundle(root, {
    version,
    platform,
    arch,
  });
  await require("./build-info.cjs")(context);
};
