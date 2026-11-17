const { readFile, writeFile } = require("node:fs/promises");
const plist = require("plist");

// The application denies renderer media permissions and has no native capture feature.
// File import uses the file picker, not Photos/Camera/Bluetooth permission APIs.
function hardenMacMetadata(info) {
  const output = { ...info };
  for (const key of [
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSAudioCaptureUsageDescription",
    "NSScreenCaptureUsageDescription",
    "NSPhotoLibraryUsageDescription",
    "NSSpeechRecognitionUsageDescription",
  ])
    delete output[key];
  output.NSAppTransportSecurity = {
    ...output.NSAppTransportSecurity,
    NSAllowsArbitraryLoads: false,
  };
  return output;
}
async function hardenMacBundleMetadata(path) {
  const input = plist.parse(await readFile(path, "utf8"));
  await writeFile(path, plist.build(hardenMacMetadata(input)), "utf8");
}
module.exports = { hardenMacMetadata, hardenMacBundleMetadata };
