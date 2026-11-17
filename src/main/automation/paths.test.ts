// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { privateDirectory } from "./paths.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function cleanPowerShellEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"),
  );
}

test.skipIf(process.platform !== "win32")(
  "Windows private directories accept inherited PowerShell 7 module paths",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zxw-private-modules-"));
    roots.push(root);
    await expect(privateDirectory(join(root, "中文 配置"))).resolves.toBeTruthy();
  },
);

test.skipIf(process.platform !== "win32")(
  "repeated Windows directory protection requires no audit privilege and keeps files private",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zxw-private-repeat-"));
    roots.push(root);
    const originalModules = process.env.PSModulePath;
    delete process.env.PSModulePath;
    try {
      const directory = join(root, "中文 配置");
      const canonical = await privateDirectory(directory);
      const file = join(canonical, "credentials.json");
      await writeFile(file, "isolated-test-content", { mode: 0o600 });
      await expect(privateDirectory(directory)).resolves.toBe(canonical);
      await expect(privateDirectory(directory)).resolves.toBe(canonical);
      expect(await readFile(file, "utf8")).toBe("isolated-test-content");

      const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sections = [System.Security.AccessControl.AccessControlSections]::Access
$directory = New-Object System.IO.DirectoryInfo($env:ZXW_TEST_DIRECTORY)
$file = New-Object System.IO.FileInfo($env:ZXW_TEST_FILE)
$acl = $directory.GetAccessControl($sections)
$fileAcl = $file.GetAccessControl($sections)
$sidType = [System.Security.Principal.SecurityIdentifier]
@{ protected = $acl.AreAccessRulesProtected; identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { @{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString(); inherited = $_.IsInherited } }); fileRules = @($fileAcl.GetAccessRules($true, $true, $sidType) | ForEach-Object { @{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString() } }) } | ConvertTo-Json -Depth 4 -Compress`;
      const acl = JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          {
            windowsHide: true,
            encoding: "utf8",
            env: {
              ...cleanPowerShellEnvironment(),
              ZXW_TEST_DIRECTORY: canonical,
              ZXW_TEST_FILE: file,
            },
          },
        ),
      );
      expect(acl.protected).toBe(true);
      expect(acl.rules).toEqual([
        { identity: acl.identity, type: "Allow", rights: "FullControl", inherited: false },
      ]);
      expect(acl.fileRules).toEqual([{ identity: acl.identity, type: "Allow" }]);
    } finally {
      if (originalModules === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = originalModules;
    }
  },
);
