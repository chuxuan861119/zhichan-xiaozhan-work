import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
if (process.platform === "win32") {
  run("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "scripts/build-cadcraft.ps1",
    "-Mode",
    "all",
  ]);
} else {
  const archive = join(root, "out-cadcraft-source.zip");
  try {
    await access(archive);
  } catch {
    const response = await fetch(
      "https://api.github.com/repos/storytold/cadcraft/zipball/00c7613f1af3c73f7157fa91d9fe2635c6f23c06",
    );
    if (!response.ok) throw new Error(`Cadcraft source download: ${response.status}`);
    await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
  }
  if (
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex")
      .toUpperCase() !== "723BCC079E7793716F27D9762DD8590FB8FD13BBAC7A2125B928D60DFAB6F844"
  )
    throw new Error("Cadcraft source checksum mismatch");
  const source = join(root, "out-cadcraft-archive/storytold-cadcraft-00c7613");
  try {
    await access(join(source, "Cargo.toml"));
  } catch {
    run("unzip", ["-q", archive, "-d", join(root, "out-cadcraft-archive")]);
  }
  run(process.execPath, ["scripts/patch-cadcraft-source.mjs"]);
  process.env.CARGO_TARGET_DIR = join(root, "out-cadcraft-target");
  const manifest = join(root, "tools/cadcraft-bridge/Cargo.toml"),
    output = join(root, "resources/cadcraft");
  run("cargo", ["test", "--locked", "--manifest-path", manifest]);
  run("cargo", [
    "build",
    "--locked",
    "--release",
    "--jobs",
    "1",
    "--manifest-path",
    manifest,
    "--bin",
    "cadcraft-codec",
  ]);
  await mkdir(output, { recursive: true });
  await copyFile(
    join(process.env.CARGO_TARGET_DIR, "release/cadcraft-codec"),
    join(output, "cadcraft-codec"),
  );
  run("chmod", ["755", join(output, "cadcraft-codec")]);
  run("rustup", ["target", "add", "wasm32-unknown-unknown"]);
  const toolchain = join(root, "out-cadcraft-toolchain"),
    bindgen = join(toolchain, "bin/wasm-bindgen");
  try {
    await access(bindgen);
  } catch {
    run("cargo", [
      "install",
      "wasm-bindgen-cli",
      "--version",
      "0.2.108",
      "--locked",
      "--root",
      toolchain,
    ]);
  }
  if (execFileSync(bindgen, ["--version"], { encoding: "utf8" }).trim() !== "wasm-bindgen 0.2.108")
    throw new Error("Unexpected wasm-bindgen version");
  run("cargo", [
    "build",
    "--locked",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    manifest,
    "--lib",
  ]);
  run(bindgen, [
    "--target",
    "web",
    "--out-dir",
    join(output, "wasm"),
    "--out-name",
    "cadcraft",
    join(
      process.env.CARGO_TARGET_DIR,
      "wasm32-unknown-unknown/release/patent_cadcraft_bridge.wasm",
    ),
  ]);
  run(process.execPath, ["--test", "tools/cadcraft-bridge/tests/wasm-smoke.mjs"]);
  await mkdir(join(output, "licenses"), { recursive: true });
  for (const name of ["LICENSE-MIT", "LICENSE-APACHE", "NOTICE", "ATTRIBUTION.md"])
    await copyFile(join(source, name), join(output, "licenses", name));
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--format-version", "1", "--manifest-path", manifest],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    ),
  );
  for (const dependency of metadata.packages.filter((item) => item.source)) {
    const location = dirname(dependency.manifest_path),
      target = join(output, "licenses", `${dependency.name}-${dependency.version}`);
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(location, { withFileTypes: true }))
      if (entry.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE)/u.test(entry.name))
        await copyFile(join(location, entry.name), join(target, entry.name));
  }
}
run(process.execPath, ["scripts/prepare-cadcraft-notices.mjs"]);
