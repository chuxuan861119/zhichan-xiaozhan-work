import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--manifest-path",
      join(root, "tools/cadcraft-bridge/Cargo.toml"),
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
  ),
);
const output = join(root, "resources/cadcraft");
const executable = process.platform === "win32" ? "cadcraft-codec.exe" : "cadcraft-codec";
await writeFile(
  join(output, "manifest.json"),
  `${JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      revision: "00c7613f1af3c73f7157fa91d9fe2635c6f23c06",
      executable,
      sha256: createHash("sha256")
        .update(await readFile(join(output, executable)))
        .digest("hex"),
    },
    null,
    2,
  )}\n`,
);
const acadrust = metadata.packages.find(
  (item) => item.name === "acadrust" && item.version === "0.6.3",
);
if (!acadrust || acadrust.license !== "MPL-2.0")
  throw new Error("Unexpected acadrust source or license");
const packageRoot = dirname(acadrust.manifest_path),
  registry = dirname(dirname(packageRoot));
const source = join(
  dirname(registry),
  "cache",
  basename(dirname(packageRoot)),
  "acadrust-0.6.3.crate",
);
const bytes = await readFile(source);
const hash = createHash("sha256").update(bytes).digest("hex");
const lock = await readFile(join(root, "tools/cadcraft-bridge/Cargo.lock"), "utf8");
const section = lock
  .split("[[package]]")
  .find((item) => item.includes('name = "acadrust"') && item.includes('version = "0.6.3"'));
if (!section?.includes(`checksum = "${hash}"`))
  throw new Error("MPL source checksum differs from locked library");
await mkdir(join(output, "sources"), { recursive: true });
await copyFile(
  join(root, "scripts/patch-cadcraft-source.mjs"),
  join(output, "sources/patch-cadcraft-source.mjs"),
);
await copyFile(source, join(output, "sources/acadrust-0.6.3.crate"));
const inventory = metadata.packages
  .filter((item) => item.source)
  .map((item) => ({
    name: item.name,
    version: item.version,
    license: item.license,
    repository: item.repository,
  }));
await writeFile(
  join(output, "licenses/DEPENDENCIES.json"),
  `${JSON.stringify(inventory, null, 2)}\n`,
);
await copyFile(join(root, "tools/cadcraft-bridge/Cargo.lock"), join(output, "sources/Cargo.lock"));
await writeFile(
  join(output, "NOTICE.txt"),
  `CAD editor core: Cadcraft 00c7613f1af3c73f7157fa91d9fe2635c6f23c06\nhttps://github.com/storytold/cadcraft/tree/00c7613f1af3c73f7157fa91d9fe2635c6f23c06\nCadcraft is used under its MIT option. Original copyright, attribution and notices are in licenses/. No endorsement or trademark license is claimed.\n\nDWG codec: acadrust 0.6.3, MPL-2.0, used without modifications.\nThe complete corresponding original source is available without registration or charge at https://zcxzz.cn/open-source/. Installed resources/OPEN_SOURCE_DOWNLOADS.txt records the exact versioned archive URL and SHA-256. Inside that archive it is sources/acadrust-0.6.3.crate (gzip-compressed tar archive), relative to resources/cadcraft/. Extract with tar -xzf; build the extracted crate with Cargo and the enclosed lockfile as appropriate. Source is available under MPL-2.0; the application's terms do not restrict recipients' rights to this source.\nSource archive SHA-256: ${hash}\nOriginal source: https://crates.io/crates/acadrust/0.6.3\nMPL terms: licenses/acadrust-0.6.3/LICENSE\nDependency inventory: licenses/DEPENDENCIES.json; original dependency licenses are in licenses/<name>-<version>/.\nFont: Source Han Serif CN, already bundled by the application under SIL OFL 1.1. No system font files are redistributed.\n`,
);
console.log(`Prepared CAD source and notices (${bytes.length} bytes of MPL source).`);
