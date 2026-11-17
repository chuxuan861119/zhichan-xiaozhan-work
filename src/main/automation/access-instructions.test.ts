import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { formatAgentAccessInstructions, resolveAgentCliEntry } from "./access-instructions.js";

const instanceId = "00000000-0000-4000-8000-000000000102";
test.each(["development", "isolated", "packaged", "packaged-mac", "entry-file"])(
  "resolves a complete CLI in %s without relying on PATH",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "zxw-entry-"));
    try {
      const platform = mode === "packaged" ? "win32" : "darwin";
      const cli = join(
        root,
        mode === "development" || mode === "entry-file"
          ? "out"
          : mode.startsWith("packaged")
            ? "resources"
            : "app",
        "cli",
      );
      await mkdir(join(cli, "runtime"), { recursive: true });
      const entry = join(cli, platform === "win32" ? "zxw.cmd" : "zxw");
      await writeFile(entry, "fixture");
      await writeFile(join(cli, "index.cjs"), "fixture");
      const options = {
        platform: platform as NodeJS.Platform,
        isPackaged: mode.startsWith("packaged"),
        appPath:
          mode === "development" ? root : join(root, mode === "entry-file" ? "out/main" : "app"),
        resourcesPath: join(root, "resources"),
      };
      await expect(resolveAgentCliEntry(options)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await writeFile(join(cli, "runtime", platform === "win32" ? "node.exe" : "node"), "fixture");
      expect(await resolveAgentCliEntry(options)).toBe(entry);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("one macOS prompt supplies the manual, exact instance, isolated home and safe shell literals", () => {
  const text = formatAgentAccessInstructions({
    platform: "darwin",
    cliPath: "/Applications/Agent's $(echo private)`x`/zxw",
    home: "/private/tmp/CLI 测试",
    instanceId,
  });
  expect(text).toContain("'/Applications/Agent'\"'\"'s $(echo private)`x`/zxw' manual --json");
  expect(text).toContain(`connect --instance ${instanceId} --home '/private/tmp/CLI 测试' --json`);
  expect(text).toContain(`pair poll --instance ${instanceId}`);
  expect(text).toContain("退出码 4");
  expect(text).toContain("不要新建另一条授权请求");
  expect(text).toContain("获批后再次执行连接命令");
});
test("PowerShell instructions preserve paths with spaces and apostrophes without evaluating variables", () => {
  const text = formatAgentAccessInstructions({
    platform: "win32",
    cliPath: "C:\\Program Files\\Agent's $HOME\\zxw.cmd",
    home: "D:\\Agent's 测试",
    instanceId,
  });
  expect(text).toContain("& 'C:\\Program Files\\Agent''s $HOME\\zxw.cmd' manual --json");
  expect(text).toContain("--home 'D:\\Agent''s 测试'");
  expect(text).not.toContain("--output");
});
