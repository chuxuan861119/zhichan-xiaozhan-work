import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import yazl from "yazl";
import {
  createBuildProfile,
  createOutputDirectory,
  HARMONY_DEVICE_CHECKS,
  validateDeviceAcceptance,
  validateReleaseInputs,
  verifyCadRuntime,
  verifyFile,
  verifyHapArchive,
  verifyAppArchive,
  verifyHarmonyCadcraftRuntime,
} from "./harmony-build.mjs";

test("formal builds require an explicit application ID, signing material and runtime notices", () => {
  assert.throws(() => validateReleaseInputs({}), /HARMONY_RELEASE_BUNDLE_NAME/u);
  assert.throws(
    () => validateReleaseInputs({ HARMONY_RELEASE_BUNDLE_NAME: "com.example.work" }),
    /HARMONY_SIGNING_CONFIG/u,
  );
  assert.throws(
    () =>
      validateReleaseInputs({
        HARMONY_RELEASE_BUNDLE_NAME: "com.example.work",
        HARMONY_SIGNING_CONFIG: "external.json",
      }),
    /HARMONY_ELECTRON_NOTICES/u,
  );
  assert.throws(
    () =>
      validateReleaseInputs({
        HARMONY_RELEASE_BUNDLE_NAME: "com.zhichan.harmonyprobe",
        HARMONY_SIGNING_CONFIG: "external.json",
        HARMONY_ELECTRON_NOTICES: "notices.txt",
      }),
    /体验/u,
  );
});

test("formal device evidence must cover every platform boundary and match the exact release", () => {
  const expected = {
    commit: "a".repeat(40),
    runtimeRelease: "fixed-runtime",
    bundleName: "com.example.work",
  };
  const report = {
    sourceCommit: expected.commit,
    runtimeRelease: expected.runtimeRelease,
    bundleName: expected.bundleName,
    physicalDevice: true,
    stableSystem: true,
    systemVersion: "tested-stable-system",
    testedAt: "2026-01-01T00:00:00Z",
    checks: Object.fromEntries(
      HARMONY_DEVICE_CHECKS.map((id) => [id, { status: "passed", evidence: "test record" }]),
    ),
  };
  assert.doesNotThrow(() => validateDeviceAcceptance(report, expected));
  for (const patch of [
    { physicalDevice: false },
    { stableSystem: false },
    { sourceCommit: "other" },
  ])
    assert.throws(() => validateDeviceAcceptance({ ...report, ...patch }, expected), /验收/u);
  assert.throws(
    () => validateDeviceAcceptance({ ...report, checks: {} }, expected),
    /keyboard-ime/u,
  );
});

async function zipFixture(files) {
  const dir = await mkdtemp(join(tmpdir(), "harmony-hap-"));
  const file = join(dir, "application.hap");
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of Object.entries(files)) zip.addBuffer(Buffer.from(bytes), name);
  const output = createWriteStream(file);
  zip.outputStream.pipe(output);
  zip.end();
  await new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
  });
  return file;
}

test("store APP validates its identity and the actual embedded HAP resources", async () => {
  const hashes = { "resources/reader.wasm": createHash("sha256").update("reader").digest("hex") };
  const identity = { bundleName: "cn.zcxzz.work", versionName: "1.1.5", versionCode: 1000000 };
  const pack = JSON.stringify({
    summary: {
      app: {
        bundleName: identity.bundleName,
        version: { name: identity.versionName, code: identity.versionCode },
      },
    },
  });
  const hap = await readFile(await zipFixture({ "resources/reader.wasm": "reader" }));
  const app = await zipFixture({ "pack.info": pack, "electron-default.hap": hap });
  assert.equal((await verifyAppArchive(app, identity, hashes)).verifiedFiles, 1);
  await assert.rejects(
    verifyAppArchive(app, { ...identity, bundleName: "wrong.bundle" }, hashes),
    /identity/u,
  );
  await assert.rejects(verifyAppArchive(app, { ...identity, versionCode: 1 }, hashes), /identity/u);
  const tampered = await readFile(await zipFixture({ "resources/reader.wasm": "wrong" }));
  await assert.rejects(
    verifyAppArchive(
      await zipFixture({ "pack.info": pack, "electron-default.hap": tampered }),
      identity,
      hashes,
    ),
    /checksum/u,
  );
  await assert.rejects(
    verifyAppArchive(await zipFixture({ "pack.info": pack }), identity, hashes),
    /HAP/u,
  );
  await assert.rejects(
    verifyAppArchive(
      await zipFixture({ "pack.info": pack, "electron-default.hap": hap, "extra.hap": hap }),
      identity,
      hashes,
    ),
    /Unexpected/u,
  );
});

test("actual HAP bytes must retain every required component", async () => {
  const expected = { "resources/reader.wasm": createHash("sha256").update("reader").digest("hex") };
  const file = await zipFixture({ "resources/reader.wasm": "reader" });
  assert.deepEqual(await verifyHapArchive(file, expected), { verifiedFiles: 1 });
  await assert.rejects(
    verifyHapArchive(await zipFixture({ "resources/reader.wasm": "wrong" }), expected),
    /checksum/u,
  );
  await assert.rejects(
    verifyHapArchive(await zipFixture({ "resources/other": "other" }), expected),
    /Missing HAP/u,
  );
});

test("customer drawings and host native libraries are rejected from a HAP", async () => {
  for (const name of [
    "resources/customer.dwg",
    "resources/secret.patdoc",
    "node_modules/host.dylib",
    "node_modules/host.dll",
    "resources/cadcraft/cadcraft-codec",
    "resources/cadcraft/cadcraft-codec.exe",
  ])
    await assert.rejects(
      verifyHapArchive(await zipFixture({ [name]: "unexpected" }), {}),
      /Unexpected/u,
    );
});

test("Harmony CAD assembly requires both verified editor and codec resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "harmony-cadcraft-"));
  const files = {};
  for (const name of [
    "harmony/worker.mjs",
    "harmony/cadcraft-codec.js",
    "harmony/cadcraft-codec_bg.wasm",
    "wasm/cadcraft.js",
    "wasm/cadcraft_bg.wasm",
  ]) {
    await mkdir(join(root, name.split("/")[0]), { recursive: true });
    await writeFile(join(root, name), name);
    files[name] = createHash("sha256").update(name).digest("hex");
  }
  const manifest = { target: "wasm32-offline", files };
  await writeFile(join(root, "harmony/manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(await verifyHarmonyCadcraftRuntime(root), files);
  await writeFile(join(root, "harmony/cadcraft-codec_bg.wasm"), "stale");
  await assert.rejects(verifyHarmonyCadcraftRuntime(root), /checksum/u);
  delete files["harmony/cadcraft-codec_bg.wasm"];
  await writeFile(join(root, "harmony/manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyHarmonyCadcraftRuntime(root), /manifest/u);
});

test("local unsigned profile has no signing identity and signed profile uses the external identity", () => {
  const base = {
    app: { products: [{ name: "default", signingConfig: "default" }], signingConfigs: [] },
    modules: [],
  };
  const local = createBuildProfile(base);
  assert.equal(local.app.products[0].signingConfig, undefined);
  const signing = {
    name: "private-local-identity",
    type: "HarmonyOS",
    material: { storeFile: "external.p12" },
  };
  const signed = createBuildProfile(base, signing);
  assert.equal(signed.app.products[0].signingConfig, signing.name);
  assert.deepEqual(signed.app.signingConfigs, [signing]);
  assert.equal(base.app.products[0].signingConfig, "default");
});

test("runtime checksum mismatches reject modified components", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-checksum-"));
  const file = join(dir, "runtime.tar.gz");
  await writeFile(file, "known runtime");
  const hash = createHash("sha256").update("known runtime").digest("hex");
  await verifyFile(file, hash);
  await writeFile(file, "replaced runtime");
  await assert.rejects(verifyFile(file, hash), /checksum/u);
});

test("CAD checks every pinned resource and rejects tampered or escaping entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-cad-"));
  await mkdir(join(dir, "dotnet"));
  await writeFile(join(dir, "dotnet/reader.wasm"), "reader");
  const hash = createHash("sha256").update("reader").digest("hex");
  const manifest = { target: "wasm32-offline", files: { "dotnet/reader.wasm": hash } };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  await verifyCadRuntime(dir, manifest);
  await writeFile(join(dir, "customer.dwg"), "not a runtime resource");
  await assert.rejects(verifyCadRuntime(dir, manifest), /Unexpected CAD/u);
  await writeFile(join(dir, "dotnet/reader.wasm"), "bad");
  await assert.rejects(verifyCadRuntime(dir, manifest), /checksum/u);
  const escaping = { target: "wasm32-offline", files: { "../outside": hash } };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(escaping));
  await assert.rejects(verifyCadRuntime(dir, escaping), /path/u);
});

test("existing output is never overwritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-output-"));
  const output = join(dir, "build");
  await createOutputDirectory(output);
  await writeFile(join(output, "keep.txt"), "existing result");
  await assert.rejects(createOutputDirectory(output), /existing/u);
  assert.equal(await readFile(join(output, "keep.txt"), "utf8"), "existing result");
});
