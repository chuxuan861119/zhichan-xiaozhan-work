// CDP CaptureScreenshot requests a display wake lock. The Harmony runtime's
// power_save_blocker_ohos.cc rejects that request with a native fatal assertion.
// Use Electron's explicit no-wake capture from the main-process test bridge.
module.exports = async function capturePageWithoutWakeLock(window, rect) {
  const image = await window.capturePage(rect, { stayHidden: true, stayAwake: false });
  if (image.isEmpty()) throw new Error("Page capture returned an empty image");
  return image;
};
