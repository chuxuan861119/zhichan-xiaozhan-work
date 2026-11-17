import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { isAbsolute, join } from "node:path";
import yauzl from "yauzl";

export function validateReleaseInputs(env) {
  for (const key of [
    "HARMONY_RELEASE_BUNDLE_NAME",
    "HARMONY_SIGNING_CONFIG",
    "HARMONY_ELECTRON_NOTICES",
  ])
    if (!env[key]) throw new Error(`正式鸿蒙发行需要 ${key}；本地体验使用 dist:harmony:local。`);
  if (
    ["com.zhichan.harmonyprobe", "com.zhichan.workbuildcheck"].includes(
      env.HARMONY_RELEASE_BUNDLE_NAME,
    )
  )
    throw new Error("正式发行不能使用体验或验收应用标识。");
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(env.HARMONY_RELEASE_BUNDLE_NAME))
    throw new Error("Invalid HARMONY_RELEASE_BUNDLE_NAME");
  if (!env.HARMONY_ACCEPTANCE_REPORT)
    throw new Error(
      "正式鸿蒙发行需要 HARMONY_ACCEPTANCE_REPORT；模拟器通过不能代替稳定版真机验收。",
    );
}

export const HARMONY_DEVICE_CHECKS = [
  "keyboard-ime",
  "mouse-touchpad",
  "file-open-cold-warm",
  "file-permission-restart",
  "public-file-safe-save",
  "clipboard-denial-retry",
  "tray-save-quit",
  "window-display-scaling",
  "physical-print-cancel",
  "backup-restore",
  "credential-restart",
  "cad-flowchart-export",
];

export function validateDeviceAcceptance(report, expected) {
  if (
    report?.sourceCommit !== expected.commit ||
    report?.runtimeRelease !== expected.runtimeRelease ||
    report?.bundleName !== expected.bundleName ||
    report?.physicalDevice !== true ||
    report?.stableSystem !== true ||
    !Number.isFinite(Date.parse(report?.testedAt)) ||
    Date.parse(report.testedAt) > Date.now() ||
    typeof report?.systemVersion !== "string" ||
    !report.systemVersion.trim()
  )
    throw new Error("鸿蒙真机验收信息不完整或与发行源码、运行库、应用标识不一致。");
  for (const id of HARMONY_DEVICE_CHECKS) {
    if (
      report.checks?.[id]?.status !== "passed" ||
      typeof report.checks[id].evidence !== "string" ||
      !report.checks[id].evidence.trim()
    )
      throw new Error(`鸿蒙真机验收未完成：${id}`);
  }
}

export function createBuildProfile(base, signing) {
  const result = structuredClone(base);
  result.app.signingConfigs = signing ? [signing] : [];
  for (const product of result.app.products) {
    if (signing) product.signingConfig = signing.name;
    else delete product.signingConfig;
  }
  return result;
}

export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

export async function verifyFile(file, expected) {
  if ((await sha256(file)) !== expected) throw new Error(`Runtime checksum mismatch: ${file}`);
}

export async function verifyHarmonyCadcraftRuntime(root) {
  const manifest = JSON.parse(await readFile(join(root, "harmony/manifest.json"), "utf8"));
  const required = [
    "harmony/worker.mjs",
    "harmony/cadcraft-codec.js",
    "harmony/cadcraft-codec_bg.wasm",
    "wasm/cadcraft.js",
    "wasm/cadcraft_bg.wasm",
  ];
  if (
    manifest.target !== "wasm32-offline" ||
    JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !== JSON.stringify(required.sort())
  )
    throw new Error("Missing Harmony CAD editor/codec manifest; run build-harmony-cadcraft.mjs.");
  for (const name of required) await verifyFile(join(root, name), manifest.files[name]);
  return manifest.files;
}

export async function verifyCadRuntime(directory, pinned) {
  const actual = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (actual.target !== "wasm32-offline") throw new Error("Expected offline CAD runtime");
  for (const [file, hash] of Object.entries(pinned.files)) {
    if (isAbsolute(file) || file.includes("\\") || file.split("/").includes(".."))
      throw new Error(`Invalid CAD resource path: ${file}`);
    if (actual.files[file] !== hash) throw new Error(`CAD manifest checksum mismatch: ${file}`);
    await verifyFile(join(directory, file), hash);
  }
  if (Object.keys(actual.files).length !== Object.keys(pinned.files).length)
    throw new Error("CAD manifest has unexpected resources");
  async function inventory(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await inventory(join(path, entry.name), `${name}/`);
      else if (!entry.isFile() || (name !== "manifest.json" && !Object.hasOwn(pinned.files, name)))
        throw new Error(`Unexpected CAD resource path: ${name}`);
    }
  }
  await inventory(directory);
}

export async function createOutputDirectory(directory) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`Refusing existing output directory: ${directory}`);
    throw error;
  }
}

export async function verifyHapArchive(file, expectedHashes) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const pending = new Set(Object.keys(expectedHashes));
  try {
    await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        if (
          /\.(dwg|patdoc|dylib|dll|exe)$/iu.test(entry.fileName) ||
          /(?:^|\/)cadcraft-codec$/u.test(entry.fileName)
        )
          return reject(new Error(`Unexpected document/host binary in HAP: ${entry.fileName}`));
        if (!pending.has(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const hash = createHash("sha256");
          stream.on("data", (bytes) => hash.update(bytes));
          stream.on("error", reject);
          stream.on("end", () => {
            if (hash.digest("hex") !== expectedHashes[entry.fileName])
              return reject(new Error(`HAP checksum mismatch: ${entry.fileName}`));
            pending.delete(entry.fileName);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
    if (pending.size) throw new Error(`Missing HAP resources: ${[...pending].join(", ")}`);
    return { verifiedFiles: Object.keys(expectedHashes).length };
  } finally {
    zip.close();
  }
}

// assembleApp repacks HAP metadata; verify the embedded resources rather than
// assuming its whole-file hash equals the separately emitted HAP.
export async function verifyAppArchive(file, expected, expectedHashes) {
  const temporary = await mkdtemp(join(tmpdir(), "harmony-app-audit-"));
  let zip;
  try {
    zip = await new Promise((resolve, reject) =>
      yauzl.open(file, { lazyEntries: true }, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    const seen = new Set();
    await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        const name = entry.fileName;
        if (!["pack.info", "pac.json", "electron-default.hap"].includes(name) || seen.has(name))
          return reject(new Error(`Unexpected APP entry: ${name}`));
        seen.add(name);
        if (name !== "electron-default.hap" && entry.uncompressedSize > 1024 * 1024)
          return reject(new Error("Oversized APP metadata"));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          pipeline(
            stream,
            createWriteStream(join(temporary, name), { flags: "wx", mode: 0o600 }),
          ).then(() => zip.readEntry(), reject);
        });
      });
      zip.readEntry();
    });
    if (!seen.has("electron-default.hap")) throw new Error("Missing APP HAP");
    if (!seen.has("pack.info")) throw new Error("Missing APP identity metadata");
    const app = JSON.parse(await readFile(join(temporary, "pack.info"), "utf8"))?.summary?.app;
    if (
      app?.bundleName !== expected.bundleName ||
      app?.version?.name !== expected.versionName ||
      app?.version?.code !== expected.versionCode
    )
      throw new Error("APP identity differs from the requested release");
    return await verifyHapArchive(join(temporary, "electron-default.hap"), expectedHashes);
  } finally {
    zip?.close();
    // Only this invocation's private audit directory is removed.
    await rm(temporary, { recursive: true, force: true });
  }
}
