const { getRawHeader } = require("@electron/asar");
const { join } = require("node:path");
const { accessSync, constants, readFileSync, statSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { prunePackagedSharpMaterials } = require("./sharp-package-materials.cjs");

function auditHeader(header, target) {
  const forbidden = [];
  const entries = new Set();
  function visit(directory, prefix = "") {
    for (const [name, entry] of Object.entries(directory.files || {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.files) visit(entry, path);
      else {
        entries.add(path);
        if (
          (path.startsWith("out/") && !/^out\/(main|preload|renderer)\//u.test(path)) ||
          path.endsWith(".map") ||
          path.includes(".hidden-test-") ||
          /(^|\/)(user-data|Cache_Data)(\/|$)/u.test(path)
        )
          forbidden.push(path);
      }
    }
  }
  visit(header);
  if (forbidden.length)
    throw new Error(`Unexpected development files in package (${forbidden.length})`);
  for (const path of ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html"]) {
    if (!entries.has(path)) throw new Error(`Missing application entry: ${path}`);
  }
  if (["win32", "darwin"].includes(target?.platform)) {
    for (const fragment of [
      "node_modules/detect-libc/",
      "node_modules/semver/",
      "node_modules/@img/colour/",
    ]) {
      if (![...entries].some((path) => path.startsWith(fragment)))
        throw new Error(`Missing Sharp runtime dependency: ${fragment}`);
    }
  }
  if (target?.platform === "win32") {
    const fragment = "node_modules/@img/sharp-win32-x64/lib/";
    if (![...entries].some((path) => path.startsWith(fragment)))
      throw new Error(`Missing native dependency: ${fragment}`);
  }
  if (target?.platform === "darwin") {
    for (const fragment of [
      `node_modules/@img/sharp-darwin-${target.arch}/lib/`,
      `node_modules/@img/sharp-libvips-darwin-${target.arch}/lib/`,
    ]) {
      if (![...entries].some((path) => path.startsWith(fragment)))
        throw new Error(`Missing native dependency: ${fragment}`);
    }
  }
}

function auditCli(directory, platform = "win32", arch = "x64") {
  const mac = platform === "darwin";
  const runtime = mac ? "runtime/node" : "runtime/node.exe";
  for (const name of [
    "index.cjs",
    "manual.md",
    mac ? "zxw" : "zxw.cmd",
    runtime,
    "runtime/LICENSE.txt",
    "runtime/provenance.json",
  ])
    if (!statSync(join(directory, name)).isFile() || statSync(join(directory, name)).size === 0)
      throw new Error(`Missing CLI resource: ${name}`);
  const provenance = JSON.parse(readFileSync(join(directory, "runtime/provenance.json"), "utf8"));
  if (
    provenance.version !== "24.15.0" ||
    provenance.url !==
      (mac
        ? `https://nodejs.org/dist/v24.15.0/node-v24.15.0-darwin-${arch}.tar.gz`
        : "https://nodejs.org/dist/v24.15.0/win-x64/node.exe") ||
    (mac &&
      (!["arm64", "x64"].includes(arch) ||
        provenance.platform !== "darwin" ||
        provenance.arch !== arch ||
        !/^[a-f0-9]{64}$/u.test(provenance.archiveSha256)))
  )
    throw new Error("Unexpected CLI runtime provenance");
  const hash = createHash("sha256")
    .update(readFileSync(join(directory, runtime)))
    .digest("hex");
  if (hash !== provenance.sha256) throw new Error("CLI runtime checksum mismatch");
  if (mac) {
    accessSync(join(directory, "zxw"), constants.X_OK);
    accessSync(join(directory, runtime), constants.X_OK);
  }
}

module.exports = async ({ appOutDir, packager, electronPlatformName, arch }) => {
  if (electronPlatformName === "darwin") {
    await require("./mac-bundle-metadata.cjs").hardenMacBundleMetadata(
      join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Info.plist"),
    );
  }
  auditHeader(getRawHeader(join(packager.getResourcesDir(appOutDir), "app.asar")).header, {
    platform: electronPlatformName,
    arch: require("builder-util").Arch[arch],
  });
  if (["win32", "darwin"].includes(electronPlatformName))
    auditCli(
      join(packager.getResourcesDir(appOutDir), "cli"),
      electronPlatformName,
      require("builder-util").Arch[arch],
    );
  const sharpMaterials = await prunePackagedSharpMaterials(
    packager.getResourcesDir(appOutDir),
    electronPlatformName,
    require("builder-util").Arch[arch],
  );
  console.info(
    `Sharp sources: omitted ${sharpMaterials.removedFiles} unrelated packaged files (${sharpMaterials.removedBytes} bytes).`,
  );
  const {
    createSourceBundle,
    externalizePackagedSources,
  } = require("./open-source-distribution.cjs");
  const version = JSON.parse(
    readFileSync(join(packager.projectDir, "package.json"), "utf8"),
  ).version;
  const bundle = await createSourceBundle(packager.projectDir, {
    version,
    platform: electronPlatformName,
    arch: require("builder-util").Arch[arch],
  });
  const externalized = await externalizePackagedSources(
    packager.getResourcesDir(appOutDir),
    bundle,
  );
  console.info(
    `Published corresponding source verified: ${bundle.url}; removed ${externalized.removedBytes} bytes of source archives.`,
  );
  await auditPackagedDrawing(
    packager.getResourcesDir(appOutDir),
    electronPlatformName,
    require("builder-util").Arch[arch],
  );
};
async function auditPackagedDrawing(resources, platform, arch) {
  const { drawingTarget } = await import("../scripts/audit-drawing-converter.mjs");
  const { smokeDrawingRuntime } = await import("../scripts/smoke-drawing-converter.mjs");
  return smokeDrawingRuntime(
    join(resources, "resources/drawing-converter"),
    drawingTarget(platform, arch),
  );
}
module.exports.auditHeader = auditHeader;
module.exports.auditCli = auditCli;
module.exports.auditPackagedDrawing = auditPackagedDrawing;
module.exports.prunePackagedSharpMaterials = prunePackagedSharpMaterials;
