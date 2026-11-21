import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_NOTICES_MARKER,
  bundledLicenseIndex,
  generateBundledResourceNotices,
} from "./audit-bundled-notices.mjs";
import { generateDocumentFontNotices } from "./audit-document-fonts.mjs";
import { auditHarmonyCadLicenses } from "./audit-harmony-cad-licenses.mjs";
import {
  createBuildProfile,
  createOutputDirectory,
  sha256,
  validateDeviceAcceptance,
  validateReleaseInputs,
  verifyCadRuntime,
  verifyFile,
  verifyHapArchive,
  verifyAppArchive,
  verifyHarmonyCadcraftRuntime,
} from "./harmony-build.mjs";
import { installPlatformAdapters } from "./harmony-platform-adapters.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const local = process.argv.includes("--local");
const assembleApp = !local || process.argv.includes("--app");
const uiAcceptance = process.argv.includes("--ui-acceptance");
const acceptance = process.argv.includes("--acceptance") || uiAcceptance;
const smoke = process.argv.includes("--smoke") || acceptance;
const emulator = process.argv.includes("--emulator");
const outputIndex = process.argv.indexOf("--output");
const known = new Set([
  "--local",
  "--app",
  "--smoke",
  "--acceptance",
  "--ui-acceptance",
  "--emulator",
  "--output",
]);
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--output") {
    if (!process.argv[++i]) throw new Error("Missing --output directory");
  } else if (!known.has(process.argv[i])) throw new Error(`Unknown option: ${process.argv[i]}`);
}
if (smoke && !local)
  throw new Error("Smoke checks require --local and use a separate application/data directory.");
if (!local) validateReleaseInputs(process.env);
function required(key) {
  if (!process.env[key]) throw new Error(`Missing ${key}; see platforms/harmony/README.md.`);
  return resolve(process.env[key]);
}
const archive = required("HARMONY_ELECTRON_TAR");
const addon = required("HARMONY_SQLITE_ADDON");
const cad = required("HARMONY_CAD_WASM_ROOT");
const npmCli = process.env.npm_execpath ?? process.env.HARMONY_NPM_CLI;
if (!npmCli) throw new Error("请通过 npm run dist:harmony:local 启动，或设置 HARMONY_NPM_CLI。");
const signing = local
  ? undefined
  : JSON.parse(await readFile(required("HARMONY_SIGNING_CONFIG"), "utf8"));
if (signing && (!signing.name || !signing.type || !signing.material))
  throw new Error("Invalid external signing configuration");
const runtimeNotices = process.env.HARMONY_ELECTRON_NOTICES;
if (runtimeNotices && (await stat(runtimeNotices)).size === 0)
  throw new Error("Empty Harmony runtime notices");
const studio =
  process.env.DEVECO_STUDIO_HOME ??
  (process.platform === "darwin" ? "/Applications/DevEco-Studio.app/Contents" : undefined);
if (!studio) throw new Error("Set DEVECO_STUDIO_HOME to the DevEco installation directory.");
const hvigor = join(studio, "tools/hvigor/bin/hvigorw.js");
const ohpm = join(studio, "tools/ohpm/bin/pm-cli.js");
await stat(hvigor);
await stat(ohpm);
const buildEnv = {
  ...process.env,
  DEVECO_SDK_HOME: process.env.DEVECO_SDK_HOME ?? join(studio, "sdk"),
};
if (!buildEnv.JAVA_HOME && process.platform === "darwin")
  buildEnv.JAVA_HOME = join(studio, "jbr/Contents/Home");
// Registry/SDK tools must use their own configured proxy rather than host app proxy variables.
for (const key of [
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
])
  delete buildEnv[key];
function run(command, args, cwd = root, env = buildEnv) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${basename(command)} failed (${result.status ?? result.signal})`);
}
const pins = JSON.parse(await readFile(join(root, "platforms/harmony/runtime-pins.json"), "utf8"));
const cadPins = JSON.parse(
  await readFile(join(root, "platforms/harmony/cad-runtime-pins.json"), "utf8"),
);
await verifyFile(archive, pins.archiveSha256);
await verifyFile(addon, pins.sqliteSha256);
await verifyCadRuntime(cad, cadPins);
const cadcraftFiles = await verifyHarmonyCadcraftRuntime(join(root, "resources/cadcraft"));
const cadLicenseNotices = await auditHarmonyCadLicenses(
  cad,
  cadPins,
  join(root, "resources/licenses/harmony-cad"),
);
await generateDocumentFontNotices(root);
const lock = JSON.parse(
  await readFile(join(root, "tools/harmony-probe/compat-dependencies/package-lock.json"), "utf8"),
);
const packages = Object.entries(lock.packages).filter(([name, pkg]) => name && !pkg.optional);
const { captureBuildInfo, validateBuildPair } = createRequire(import.meta.url)(
  "../build/build-info.cjs",
);
const before = captureBuildInfo(root, "production");
if (!before.commit)
  throw new Error("A Git commit is required to attribute the Harmony package source.");
if (!local && before.dirty) throw new Error("Formal release requires a clean source checkout.");
if (!local)
  validateDeviceAcceptance(
    JSON.parse(await readFile(required("HARMONY_ACCEPTANCE_REPORT"), "utf8")),
    {
      commit: before.commit,
      runtimeRelease: pins.release,
      bundleName: process.env.HARMONY_RELEASE_BUNDLE_NAME,
    },
  );
if (!local) run(process.execPath, [npmCli, "run", "build"]);
else
  run(process.execPath, [join(root, "node_modules/electron-vite/bin/electron-vite.js"), "build"]);
const info = validateBuildPair(
  JSON.parse(await readFile(join(root, "out/main/build-info.json"), "utf8")),
  JSON.parse(await readFile(join(root, "out/renderer/build-info.json"), "utf8")),
  JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
);
if (info.commit !== before.commit) throw new Error("Source commit changed during build.");
const parent = join(root, "release/harmony");
await mkdir(parent, { recursive: true });
const output =
  outputIndex === -1
    ? join(parent, `${info.buildId}-${randomUUID()}`)
    : resolve(process.argv[outputIndex + 1]);
await mkdir(dirname(output), { recursive: true });
await createOutputDirectory(output);
console.log(`Harmony assembly: ${output}`);
const dependencyRoot = join(output, "compat-dependencies");
await cp(join(root, "tools/harmony-probe/compat-dependencies"), dependencyRoot, {
  recursive: true,
  filter: (path) =>
    ["compat-dependencies", "package.json", "package-lock.json"].includes(basename(path)),
});
run(
  process.execPath,
  [npmCli, "ci", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"],
  dependencyRoot,
);
const dependencies = join(dependencyRoot, "node_modules");
await mkdir(join(output, "runtime"));
run(process.env.HARMONY_TAR_COMMAND ?? "tar", [
  "-xzf",
  archive,
  "-C",
  join(output, "runtime"),
  "libelectron/ohos_hap",
]);
const template = join(output, "runtime/libelectron/ohos_hap");
const project = join(output, "project");
await cp(template, project, {
  recursive: true,
  filter: (path) => {
    const name = relative(template, path).split(sep).join("/");
    return (
      !name
        .split("/")
        .some((part) => [".idea", ".hvigor", "oh_modules", "build", "docs"].includes(part)) &&
      !name.startsWith("web_engine/src/main/resources/resfile/resources/app")
    );
  },
});
await cp(join(root, "platforms/harmony/project"), project, { recursive: true });
run(process.execPath, [join(root, "tools/harmony-probe/patch-window-decoration.mjs"), project]);
run(process.execPath, [
  join(root, "scripts/build-harmony-tools.mjs"),
  join(project, "electron/libs/arm64-v8a/move_no_replace.node"),
  join(template, "docs/electron-napi-library.zip"),
]);
const source = join(output, "source");
await mkdir(source);
await cp(join(root, "src"), join(source, "src"), { recursive: true });
await cp(join(root, "build"), join(source, "build"), { recursive: true });
await copyFile(join(root, "package.json"), join(source, "package.json"));
await cp(join(root, "resources"), join(source, "resources"), {
  recursive: true,
  filter: (path) => {
    const name = relative(join(root, "resources"), path).split(sep).join("/");
    return (
      name !== "platform-tools" &&
      !name.startsWith("platform-tools/") &&
      name !== "licenses/electron" &&
      !name.startsWith("licenses/electron/") &&
      name !== "drawing-converter" &&
      !name.startsWith("drawing-converter/") &&
      ![
        "cadcraft/cadcraft-codec",
        "cadcraft/cadcraft-codec.exe",
        "cadcraft/manifest.json",
      ].includes(name)
    );
  },
});
await mkdir(join(output, "companion-sources"));
await rename(
  join(source, "resources/licenses/sharp-libvips/sources"),
  join(output, "companion-sources/sharp-libvips"),
);
await symlink(
  await realpath(join(root, "node_modules")),
  join(source, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);
await writeFile(
  join(source, "harmony-source.json"),
  JSON.stringify({ ...info, scope: "shared repository source; Harmony build" }, null, 2),
);
const app = join(project, "web_engine/src/main/resources/resfile/resources/app");
await mkdir(app, { recursive: true });
await writeFile(
  join(app, "package.json"),
  JSON.stringify({
    name: "zhichan-harmony-dependency-probe",
    version: info.version,
    main: "workbench-main.cjs",
  }),
);
for (const [name] of packages) {
  const module = name.replace(/^node_modules\//u, "");
  const from = await realpath(join(dependencies, module));
  await cp(from, join(app, "node_modules", module), {
    recursive: true,
    dereference: true,
    filter: (path) => {
      const rel = relative(from, path).split(sep).join("/");
      if (module === "better-sqlite3")
        return (
          !rel ||
          rel === "lib" ||
          rel.startsWith("lib/") ||
          ["LICENSE", "package.json"].includes(rel)
        );
      return !rel.split("/").includes("node_modules") && !/\.(node|dylib|dll|so)$/u.test(rel);
    },
  });
}
await copyFile(addon, join(project, "electron/libs/arm64-v8a/better_sqlite3.node"));
run(process.execPath, [join(root, "tools/harmony-probe/prepare-compat.mjs"), app]);
run(process.execPath, [
  join(root, "tools/harmony-probe/prepare-workbench.mjs"),
  source,
  join(root, "out"),
  app,
  "--interactive",
]);
await copyFile(join(root, "platforms/harmony/launch.cjs"), join(app, "workbench-main.cjs"));
await copyFile(
  join(root, "platforms/harmony/startup-diagnostics.cjs"),
  join(app, "startup-diagnostics.cjs"),
);
await copyFile(join(root, "out/main/build-info.json"), join(app, "workbench/main/build-info.json"));
if (acceptance) {
  for (const name of ["acceptance-main.cjs", "acceptance-flow.cjs", "acceptance-fixture.dxf"])
    await copyFile(join(root, "tools/harmony-probe", name), join(app, name));
  await copyFile(
    join(root, "tests/fixtures/images/sample.png"),
    join(app, "acceptance-fixture.png"),
  );
}
const bundleName = smoke
  ? "com.zhichan.workbuildcheck"
  : local
    ? "com.zhichan.harmonyprobe"
    : process.env.HARMONY_RELEASE_BUNDLE_NAME;
await installPlatformAdapters(project, root, bundleName);
await writeFile(
  join(app, "harmony-build.json"),
  JSON.stringify({ local, smoke, acceptance, uiAcceptance, emulator, source: info }, null, 2),
);
await writeFile(
  join(app, "package.json"),
  JSON.stringify(
    {
      name: "zhichan-work-harmony",
      version: info.version,
      main: "workbench-main.cjs",
      private: true,
    },
    null,
    2,
  ),
);
const appScope = JSON.parse(await readFile(join(project, "AppScope/app.json5"), "utf8"));
appScope.app.bundleName = bundleName;
appScope.app.versionName = info.version;
await writeFile(join(project, "AppScope/app.json5"), JSON.stringify(appScope, null, 2));
await copyFile(
  join(root, "build/icon.png"),
  join(project, "AppScope/resources/base/media/app_icon.png"),
);
await writeFile(
  join(project, "AppScope/resources/base/element/string.json"),
  JSON.stringify({ string: [{ name: "app_name", value: "知产小栈Work" }] }, null, 2),
);
const entryStrings = JSON.parse(
  await readFile(join(project, "electron/src/main/resources/base/element/string.json"), "utf8"),
);
for (const item of entryStrings.string)
  if (item.name === "EntryAbility_label") item.value = "知产小栈Work";
await writeFile(
  join(project, "electron/src/main/resources/base/element/string.json"),
  JSON.stringify(entryStrings, null, 2),
);
const baseProfile = JSON.parse(await readFile(join(project, "build-profile.json5"), "utf8"));
await writeFile(
  join(project, "build-profile.json5"),
  JSON.stringify(createBuildProfile(baseProfile, signing), null, 2),
  { mode: 0o600 },
);
const combinedNotices = join(
  project,
  "web_engine/src/main/resources/resfile/resources/resources/THIRD_PARTY_NOTICES.txt",
);
await writeFile(
  combinedNotices,
  `${(await readFile(combinedNotices, "utf8")).split(BUNDLED_NOTICES_MARKER)[0]}${await generateBundledResourceNotices(root, { includeDrawingConverter: false, includeElectron: false })}\n\n${cadLicenseNotices}`,
);
await writeFile(
  join(project, "web_engine/src/main/resources/resfile/resources/resources/licenses/INDEX.md"),
  bundledLicenseIndex({ includeDrawingConverter: false, includeElectron: false }),
);
if (runtimeNotices) {
  await copyFile(
    runtimeNotices,
    join(
      project,
      "web_engine/src/main/resources/resfile/resources/resources/HARMONY_ELECTRON_NOTICES.txt",
    ),
  );
  const notices = join(
    project,
    "web_engine/src/main/resources/resfile/resources/resources/THIRD_PARTY_NOTICES.txt",
  );
  await writeFile(
    notices,
    `${await readFile(notices, "utf8")}\n\nHarmony Electron runtime ${pins.release}\n${await readFile(runtimeNotices, "utf8")}`,
  );
}
run(process.execPath, [ohpm, "install", "--all"], project);
run(
  process.execPath,
  [
    hvigor,
    "--mode",
    "module",
    "-p",
    "product=default",
    "-p",
    "module=electron@default",
    "assembleHap",
    "--no-daemon",
  ],
  project,
);
const hap = join(
  project,
  `electron/build/default/outputs/default/electron-default-${local ? "unsigned" : "signed"}.hap`,
);
const resfile = join(project, "web_engine/src/main/resources/resfile");
const expectedHashes = {
  "resources/rawfile/arkdata/utd/utd.json5": await sha256(
    join(project, "electron/src/main/resources/rawfile/arkdata/utd/utd.json5"),
  ),
  "libs/arm64-v8a/better_sqlite3.node": pins.sqliteSha256,
  "libs/arm64-v8a/move_no_replace.node": await sha256(
    join(project, "electron/libs/arm64-v8a/move_no_replace.node"),
  ),
};
for (const library of ["libelectron.so", "libadapter.so", "libffmpeg.so"])
  expectedHashes[`libs/arm64-v8a/${library}`] = await sha256(
    join(template, "electron/libs/arm64-v8a", library),
  );
for (const name of [
  "harmony-build.json",
  "package.json",
  "workbench-main.cjs",
  "startup-diagnostics.cjs",
  "workbench/main/index.cjs",
  "workbench/main/temporary-image-worker.cjs",
  "workbench/design-editor/index.html",
  "workbench/design-editor/editor.js",
  "workbench/design-editor/Klecks-LICENSE.txt",
  "workbench/design-editor/Klecks-UPSTREAM.md",
  "workbench/main/build-info.json",
  "workbench/preload/index.cjs",
  "workbench/renderer/build-info.json",
])
  expectedHashes[`resources/resfile/resources/app/${name}`] = await sha256(join(app, name));
if (acceptance)
  for (const name of [
    "acceptance-main.cjs",
    "acceptance-flow.cjs",
    "acceptance-fixture.dxf",
    "acceptance-fixture.png",
  ])
    expectedHashes[`resources/resfile/resources/app/${name}`] = await sha256(join(app, name));
for (const [name, hash] of Object.entries(cadPins.files))
  expectedHashes[`resources/resfile/resources/resources/drawing-converter/wasm/${name}`] = hash;
for (const [name, hash] of Object.entries(cadcraftFiles))
  expectedHashes[`resources/resfile/resources/resources/cadcraft/${name}`] = hash;
expectedHashes["resources/resfile/resources/resources/cadcraft/harmony/manifest.json"] =
  await sha256(join(root, "resources/cadcraft/harmony/manifest.json"));
// The new renderer runs CAD and PDF workers from emitted JS/WASM assets.
// Verify the actual packaged files, not just the source build identity.
async function collectRendererHashes(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collectRendererHashes(file, name);
    else expectedHashes[name] = await sha256(file);
  }
}
await collectRendererHashes(
  join(app, "workbench/renderer"),
  "resources/resfile/resources/app/workbench/renderer",
);
for (const [name, hash] of Object.entries({
  "SourceHanSerifCN-Regular.otf":
    "3754ea669c530e2473354f8f6d9f79680a44d7e26ec7d00eeabee4a7e0753c5d",
  "SourceHanSerifCN-SemiBold.otf":
    "50d3f12201ce2dd840650b6bfa47ebb8572ecf767eec0e5ccb20a247b5bfa805",
})) {
  expectedHashes[`resources/resfile/resources/app/fonts/${name}`] = hash;
  expectedHashes[
    `resources/resfile/resources/app/workbench/main/assets/${hash.slice(0, 12)}-${name}`
  ] = hash;
}
for (const name of [
  "resources/resources/THIRD_PARTY_NOTICES.txt",
  "resources/resources/licenses/source-han-serif/LICENSE.txt",
  "resources/resources/drawing-converter/wasm/manifest.json",
  "resources/resources/licenses/harmony-cad/PYODIDE-MPL-2.0.txt",
  "resources/resources/licenses/harmony-cad/CPYTHON-3.13.2-LICENSE.txt",
  "resources/resources/licenses/harmony-cad/SOURCE-ACCESS.txt",
  "resources/resources/licenses/harmony-cad/provenance.json",
])
  expectedHashes[`resources/resfile/${name}`] = await sha256(join(resfile, name));
const archiveAudit = await verifyHapArchive(hap, expectedHashes);
let appPackage;
try {
  if (assembleApp) {
    run(
      process.execPath,
      [hvigor, "--mode", "project", "-p", "product=default", "assembleApp", "--no-daemon"],
      project,
    );
    const appOutput = join(project, "build/outputs/default");
    const candidates = (await readdir(appOutput)).filter((name) =>
      name.endsWith(local ? "-unsigned.app" : "-signed.app"),
    );
    if (candidates.length !== 1)
      throw new Error("Expected exactly one Harmony APP distribution package");
    const path = join(appOutput, candidates[0]);
    const audit = await verifyAppArchive(
      path,
      {
        bundleName,
        versionName: info.version,
        versionCode: appScope.app.versionCode,
      },
      expectedHashes,
    );
    appPackage = { path, byteLength: (await stat(path)).size, sha256: await sha256(path), audit };
  }
} finally {
  // Avoid leaving signing passwords in an otherwise shareable generated project.
  if (signing)
    await writeFile(
      join(project, "build-profile.json5"),
      JSON.stringify(createBuildProfile(baseProfile), null, 2),
      { mode: 0o600 },
    );
}
const report = {
  source: info,
  bundleName,
  local,
  smoke,
  acceptance,
  emulator,
  hap,
  byteLength: (await stat(hap)).size,
  sha256: await sha256(hap),
  runtime: pins,
  companionSources: join(output, "companion-sources"),
  signed: !local,
  installed: false,
  archiveAudit,
  appPackage,
};
await writeFile(join(output, "build-report.json"), JSON.stringify(report, null, 2));
console.log(`Harmony ${local ? "local unsigned" : "signed"} package: ${hap}`);
if (appPackage) console.log(`Harmony APP distribution package: ${appPackage.path}`);
