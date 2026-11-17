import type { BrowserWindowConstructorOptions } from "electron";

export function windowDecorationOptions(
  platform: string,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay"> {
  // Harmony packages must also apply tools/harmony-probe/patch-window-decoration.mjs
  // to retain native caption buttons when the system title bar is hidden.
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: platform === "win32" ? "#e7ebf1" : "#f4f5f7",
      symbolColor: "#202124",
      height: 38,
    },
  };
}

export function initializeWindowControls(
  target: { setWindowButtonVisibility: (visible: boolean) => void },
  platform: string,
): void {
  // The first Harmony ability starts with caption permissions false, before Electron
  // applies the BrowserWindow options. Explicitly initialize this main window only.
  if (platform === "openharmony" || platform === "ohos") target.setWindowButtonVisibility(true);
}
