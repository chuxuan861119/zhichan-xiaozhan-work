import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function command(file: string, args: string[], input = ""): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolveResult(stdout)),
    );
    child.stdin?.on("error", () => {
      /* Process errors are handled by the callback. */
    });
    child.stdin?.end(input);
  });
}
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** Append only our tile. Never replace the user's Dock array or other preferences. */
export function createDockPreferences(options: {
  bundle: string;
  bundleId: string;
  label: string;
  domain?: string;
  refresh(): Promise<void>;
}) {
  const domain = options.domain ?? "com.apple.dock";
  const contains = async () => {
    const xml = await command("/usr/bin/defaults", ["export", domain, "-"]);
    const value: unknown = JSON.parse(
      await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], xml),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Dock preferences");
    const entries = (value as Record<string, unknown>)["persistent-apps"] ?? [];
    if (!Array.isArray(entries)) throw new Error("Invalid Dock items");
    return entries.some((entry) => {
      const data = entry?.["tile-data"];
      if (data?.["bundle-identifier"] === options.bundleId) return true;
      try {
        return (
          resolve(fileURLToPath(data?.["file-data"]?._CFURLString)) === resolve(options.bundle)
        );
      } catch {
        return false;
      }
    });
  };
  return {
    contains,
    async add() {
      if (await contains()) return;
      const tile = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>GUID</key><integer>${randomInt(1, 2147483647)}</integer><key>tile-type</key><string>file-tile</string><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${escapeXml(pathToFileURL(options.bundle).href)}</string><key>_CFURLStringType</key><integer>15</integer></dict><key>file-label</key><string>${escapeXml(options.label)}</string><key>bundle-identifier</key><string>${escapeXml(options.bundleId)}</string></dict></dict></plist>`;
      await command("/usr/bin/defaults", ["write", domain, "persistent-apps", "-array-add", tile]);
      if (!(await contains())) throw new Error("Dock item was not saved");
      await options.refresh();
    },
  };
}

export async function refreshCurrentUserDock(uid: number) {
  await command("/usr/bin/killall", ["-u", String(uid), "Dock"]);
}
