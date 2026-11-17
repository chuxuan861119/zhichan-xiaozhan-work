import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "out/cli");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manual = await readFile(resolve(root, "docs/agent-cli-manual.md"), "utf8");
await mkdir(destination, { recursive: true });
await build({
  entryPoints: [resolve(root, "src/cli/index.ts")],
  outfile: resolve(destination, "index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: false,
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
    __AUTOMATION_MANUAL__: JSON.stringify(manual),
  },
});
await writeFile(resolve(destination, "manual.md"), manual);
// Local standalone CLI uses the developer's runtime; release workflows vendor an official one.
if (process.platform === "win32") {
  await mkdir(resolve(destination, "runtime"), { recursive: true });
  // Preserve an already vendored runtime (and avoid overwriting a running CLI executable).
  await copyFile(
    process.execPath,
    resolve(destination, "runtime/node.exe"),
    constants.COPYFILE_EXCL,
  ).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}
if (process.platform !== "win32") {
  await mkdir(resolve(destination, "runtime"), { recursive: true });
  await copyFile(
    process.execPath,
    resolve(destination, "runtime/node"),
    constants.COPYFILE_EXCL,
  ).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  await chmod(resolve(destination, "runtime/node"), 0o755);
  await writeFile(
    resolve(destination, "zxw"),
    '#!/bin/sh\ncli_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$cli_dir/runtime/node" "$cli_dir/index.cjs" "$@"\n',
    { mode: 0o755 },
  );
  await chmod(resolve(destination, "zxw"), 0o755);
}
await writeFile(
  resolve(destination, "zxw.cmd"),
  '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0index.cjs" %*\r\nexit /b %errorlevel%\r\n',
);
console.log(`CLI ${pkg.version} built in out/cli`);
