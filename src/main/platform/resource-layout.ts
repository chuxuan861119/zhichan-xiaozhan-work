import { join } from "node:path";

/** Harmony's installed Electron runtime reports isPackaged=false and cwd="/". */
export function usesInstalledResources(isPackaged: boolean, platform: string): boolean {
  return isPackaged || platform === "openharmony" || platform === "ohos";
}

export function drawingRuntimeRoot(
  isPackaged: boolean,
  platform: string,
  resourcesPath: string,
  applicationPath: string,
): string {
  return join(
    usesInstalledResources(isPackaged, platform) ? resourcesPath : applicationPath,
    "resources",
    "drawing-converter",
  );
}
