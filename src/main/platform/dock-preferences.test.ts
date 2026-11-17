import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDockPreferences } from "./dock-preferences.js";

const exec = promisify(execFile);

// A file-based preferences domain: never com.apple.dock, never refresh the real Dock.
test.skipIf(process.platform !== "darwin")(
  "real macOS tools append one escaped tile and preserve other settings",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "dock-preferences-test-"));
    const domain = join(directory, "test-dock");
    const fixture = {
      "persistent-apps": [{ "tile-type": "spacer-tile", GUID: 17 }],
      "persistent-others": [{ GUID: 22 }],
      magnification: false,
      tilesize: 44,
    };
    await writeFile(`${domain}.plist`, JSON.stringify(fixture));
    await exec("/usr/bin/plutil", ["-convert", "xml1", `${domain}.plist`]);
    const refresh = vi.fn(async () => undefined);
    const preferences = createDockPreferences({
      domain,
      bundle: "/Applications/知产 & <测试> '路径'.app",
      bundleId: "test.dock.fixture",
      label: "知产 & <测试>",
      refresh,
    });
    expect(await preferences.contains()).toBe(false);
    await preferences.add();
    await preferences.add();
    const { stdout } = await exec("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      `${domain}.plist`,
    ]);
    const saved = JSON.parse(stdout);
    expect(saved["persistent-apps"]).toHaveLength(2);
    expect(saved["persistent-apps"][0]).toEqual(fixture["persistent-apps"][0]);
    expect(saved["persistent-others"]).toEqual(fixture["persistent-others"]);
    expect(saved.magnification).toBe(false);
    expect(saved.tilesize).toBe(44);
    expect(saved["persistent-apps"][1]["tile-data"]["file-label"]).toBe("知产 & <测试>");
    expect(fileURLToPath(saved["persistent-apps"][1]["tile-data"]["file-data"]._CFURLString)).toBe(
      "/Applications/知产 & <测试> '路径'.app",
    );
    expect(refresh).toHaveBeenCalledOnce();
  },
);

test.skipIf(process.platform !== "darwin")(
  "invalid preferences fail closed without refreshing",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "dock-preferences-test-"));
    const domain = join(directory, "test-dock");
    await writeFile(`${domain}.plist`, JSON.stringify({ "persistent-apps": "invalid" }));
    await exec("/usr/bin/plutil", ["-convert", "xml1", `${domain}.plist`]);
    const refresh = vi.fn(async () => undefined);
    const preferences = createDockPreferences({
      domain,
      bundle: "/Applications/test.app",
      bundleId: "test.dock.fixture",
      label: "test",
      refresh,
    });
    await expect(preferences.add()).rejects.toThrow("Invalid Dock items");
    expect(refresh).not.toHaveBeenCalled();
  },
);
