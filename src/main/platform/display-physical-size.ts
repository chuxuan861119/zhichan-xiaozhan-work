import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { platform } from "node:process";

export function validDisplayWidthMm(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 100 && value <= 3000
    ? value
    : null;
}

/** Hardware queries never require capturing screen contents. Unknown sizes stay conservative. */
export async function readPhysicalDisplayWidthMm(id: number, rotation = 0): Promise<number | null> {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) return null;
  if ((platform as string) === "ohos" || (platform as string) === "openharmony") {
    try {
      const native = createRequire(import.meta.url)(
        "/data/storage/el1/bundle/libs/arm64/move_no_replace.node",
      ) as { displayWidthMm?: (id: number) => number };
      return validDisplayWidthMm(native.displayWidthMm?.(id));
    } catch {
      // Older runtimes or unavailable display services must not prevent opening a document.
      return null;
    }
  }
  if (platform === "win32") {
    const dimension =
      rotation === 90 || rotation === 270 ? "MaxVerticalImageSize" : "MaxHorizontalImageSize";
    // EDID centimeters are hardware metadata. Ambiguous multi-monitor queries stay unknown.
    const query =
      "$m=@(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction Stop | Where-Object Active); if($m.Count -eq 1){[Console]::Write($m[0]." +
      dimension +
      " * 10)}";
    return new Promise((resolve) => {
      execFile(
        join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query],
        { timeout: 1500, maxBuffer: 128, windowsHide: true },
        (error, stdout) => resolve(error ? null : validDisplayWidthMm(Number(stdout.trim()))),
      );
    });
  }
  if (platform !== "darwin") return null;
  const base =
    process.versions.electron && !process.defaultApp ? process.resourcesPath : process.cwd();
  return new Promise((resolve) => {
    execFile(
      join(base, "resources", "platform-tools", "display-width-mm"),
      [String(id)],
      { timeout: 1500, maxBuffer: 128, windowsHide: true },
      (error, stdout) => {
        resolve(error ? null : validDisplayWidthMm(Number(stdout.trim())));
      },
    );
  });
}
