import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
const archive = join(root, "out-cadcraft-source.zip");
// Same immutable source as Windows/Mac. Prepare it through vendor:cad or place
// the verified upstream archive here; never fetch arbitrary code during assembly.
if (
  createHash("sha256")
    .update(await readFile(archive))
    .digest("hex") !== "723bcc079e7793716f27d9762dd8590fb8fd13bbac7a2125b928d60dfab6f844"
)
  throw new Error("Cadcraft source checksum mismatch");
try {
  await readFile(join(root, "out-cadcraft-archive/storytold-cadcraft-00c7613/Cargo.toml"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  run("unzip", ["-q", archive, "-d", join(root, "out-cadcraft-archive")]);
}
run(process.execPath, ["scripts/patch-cadcraft-source.mjs"]);
const bindgen =
  process.env.HARMONY_WASM_BINDGEN ?? join(root, "out-cadcraft-toolchain/bin/wasm-bindgen");
if (execFileSync(bindgen, ["--version"], { encoding: "utf8" }).trim() !== "wasm-bindgen 0.2.108")
  throw new Error("Expected wasm-bindgen 0.2.108");
process.env.CARGO_TARGET_DIR = resolve(
  process.env.CARGO_TARGET_DIR ?? join(root, "out-cadcraft-target"),
);
const wasm = join(
  process.env.CARGO_TARGET_DIR,
  "wasm32-unknown-unknown/release/patent_cadcraft_bridge.wasm",
);
for (const codec of [false, true]) {
  run("cargo", [
    "build",
    "--locked",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    "tools/cadcraft-bridge/Cargo.toml",
    "--lib",
    ...(codec ? ["--features", "harmony-codec"] : []),
  ]);
  const output = join(root, "resources/cadcraft", codec ? "harmony" : "wasm");
  await mkdir(output, { recursive: true });
  run(bindgen, [
    "--target",
    "web",
    "--out-dir",
    output,
    "--out-name",
    codec ? "cadcraft-codec" : "cadcraft",
    wasm,
  ]);
}
const output = join(root, "resources/cadcraft");
await copyFile(
  join(root, "tools/cadcraft-bridge/harmony-worker.mjs"),
  join(output, "harmony/worker.mjs"),
);
const files = {};
for (const file of [
  "harmony/worker.mjs",
  "harmony/cadcraft-codec.js",
  "harmony/cadcraft-codec_bg.wasm",
  "wasm/cadcraft.js",
  "wasm/cadcraft_bg.wasm",
])
  files[file] = createHash("sha256")
    .update(await readFile(join(output, file)))
    .digest("hex");
await writeFile(
  join(output, "harmony/manifest.json"),
  `${JSON.stringify({ target: "wasm32-offline", files }, null, 2)}\n`,
);
console.log("Harmony CAD editor and codec built from the same source.");
