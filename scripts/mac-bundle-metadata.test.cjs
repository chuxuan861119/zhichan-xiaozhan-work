const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");
const plist = require("plist");
const { hardenMacBundleMetadata } = require("../build/mac-bundle-metadata.cjs");
test("removes unused inherited capture declarations while retaining document handlers and ASAR integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "mac-metadata-"));
  try {
    const path = join(root, "Info.plist");
    const integrity = { "Resources/app.asar": { algorithm: "SHA256", hash: "fixture" } };
    const handlers = [{ CFBundleTypeExtensions: ["patdoc"], CFBundleTypeRole: "Editor" }];
    await writeFile(
      path,
      plist.build({
        CFBundleIdentifier: "cn.local.zhichanxiaozhanwork",
        ElectronAsarIntegrity: integrity,
        CFBundleDocumentTypes: handlers,
        NSCameraUsageDescription: "Electron default",
        NSMicrophoneUsageDescription: "Electron default",
        NSBluetoothAlwaysUsageDescription: "Electron default",
        NSAudioCaptureUsageDescription: "Electron default",
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      }),
    );
    await hardenMacBundleMetadata(path);
    const output = plist.parse(await readFile(path, "utf8"));
    assert.equal(output.NSCameraUsageDescription, undefined);
    assert.equal(output.NSMicrophoneUsageDescription, undefined);
    assert.equal(output.NSBluetoothAlwaysUsageDescription, undefined);
    assert.equal(output.NSAudioCaptureUsageDescription, undefined);
    assert.equal(output.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
    assert.deepEqual(output.ElectronAsarIntegrity, integrity);
    assert.deepEqual(output.CFBundleDocumentTypes, handlers);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
