// @vitest-environment node
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("development CLI build includes a runnable local runtime without vendoring", async () => {
  const root = await mkdtemp(join(tmpdir(), "zxw-cli-build 中文 空格-"));
  try {
    for (const part of ["scripts", "src/cli", "docs"])
      await mkdir(join(root, part), { recursive: true });
    await symlink(
      resolve("node_modules"),
      join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await copyFile(resolve("scripts/build-cli.mjs"), join(root, "scripts/build-cli.mjs"));
    await writeFile(join(root, "package.json"), '{"type":"module","version":"0.0.0"}');
    await writeFile(join(root, "docs/agent-cli-manual.md"), "fixture");
    await writeFile(join(root, "src/cli/index.ts"), 'console.log("cli-fixture");');
    await promisify(execFile)(process.execPath, [join(root, "scripts/build-cli.mjs")], {
      windowsHide: true,
    });
    const runtime = join(
      root,
      "out/cli/runtime",
      process.platform === "win32" ? "node.exe" : "node",
    );
    expect(
      await access(runtime).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    const result = await promisify(execFile)(runtime, [join(root, "out/cli/index.cjs")], {
      windowsHide: true,
    });
    expect(result.stdout.trim()).toBe("cli-fixture");
    await promisify(execFile)(process.execPath, [join(root, "scripts/build-cli.mjs")], {
      windowsHide: true,
    });
    if (process.platform === "win32") {
      const entry = join(root, "out/cli/zxw.cmd").replaceAll("'", "''");
      const launched = await promisify(execFile)(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `& '${entry}' version --json`],
        { windowsHide: true },
      );
      expect(launched.stdout.trim()).toBe("cli-fixture");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
