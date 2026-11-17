import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import yauzl from "yauzl";

// Fixed official runtime, verified against the official HTTPS release checksum list.
const version = "24.15.0";
const origin = `https://nodejs.org/dist/v${version}/`;
async function download(path) {
  const url = new URL(path, origin);
  // macOS curl follows system networking settings without adding a downloader dependency.
  if (process.platform === "darwin")
    return execFileSync(
      "/usr/bin/curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "15",
        "--max-time",
        "120",
        url.href,
      ],
      { maxBuffer: 150 * 1024 * 1024 },
    );
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Official Node runtime download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}
const checksums = (await download("SHASUMS256.txt")).toString("utf8");
if (process.platform === "darwin") {
  if (!["arm64", "x64"].includes(process.arch))
    throw new Error("Unsupported Mac CLI architecture.");
  const archiveName = `node-v${version}-darwin-${process.arch}.tar.gz`;
  const archiveHash = checksums
    .split("\n")
    .find((line) => line.endsWith(`  ${archiveName}`))
    ?.split(/\s+/u)[0];
  const archive = await download(archiveName);
  if (!archiveHash || createHash("sha256").update(archive).digest("hex") !== archiveHash)
    throw new Error("Node archive checksum mismatch.");
  // Read only exact members into memory; never extract archive paths to disk.
  const member = (name) =>
    execFileSync("/usr/bin/tar", ["-xzOf", "-", `${archiveName.slice(0, -7)}/${name}`], {
      input: archive,
      maxBuffer: 150 * 1024 * 1024,
    });
  const binary = member("bin/node");
  const license = member("LICENSE");
  if (!binary.length || !license.length)
    throw new Error("Official runtime archive lacks binary/license.");
  const destination = resolve(import.meta.dirname, "../out/cli/runtime");
  await mkdir(destination, { recursive: true });
  const stagedBinary = resolve(destination, `.node-vendor-${process.pid}`);
  await writeFile(stagedBinary, binary, { flag: "wx", mode: 0o755 });
  await chmod(stagedBinary, 0o755);
  await rename(stagedBinary, resolve(destination, "node"));
  await writeFile(resolve(destination, "LICENSE.txt"), license);
  await writeFile(
    resolve(destination, "provenance.json"),
    JSON.stringify(
      {
        version,
        platform: "darwin",
        arch: process.arch,
        url: `${origin}${archiveName}`,
        archiveSha256: archiveHash,
        sha256: createHash("sha256").update(binary).digest("hex"),
      },
      null,
      2,
    ),
  );
  console.log(`Verified official Node ${version} Mac ${process.arch} CLI runtime.`);
} else {
  const expected = checksums
    .split("\n")
    .find((line) => line.endsWith("  win-x64/node.exe"))
    ?.split(/\s+/u)[0];
  if (!expected || !/^[a-f0-9]{64}$/u.test(expected))
    throw new Error("Node release checksum unavailable.");
  const zipName = `node-v${version}-win-x64.zip`;
  const archive = await download(zipName);
  const zipHash = checksums
    .split("\n")
    .find((line) => line.endsWith(`  ${zipName}`))
    ?.split(/\s+/u)[0];
  if (createHash("sha256").update(archive).digest("hex") !== zipHash)
    throw new Error("Node archive checksum mismatch.");
  const files = await new Promise((resolveFiles, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error);
        return;
      }
      const result = new Map();
      zip.on("error", reject);
      zip.on("end", () => resolveFiles(result));
      zip.on("entry", (entry) => {
        const name = entry.fileName;
        if (
          name !== `node-v${version}-win-x64/node.exe` &&
          name !== `node-v${version}-win-x64/LICENSE`
        ) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > 150 * 1024 * 1024) {
          reject(new Error("Runtime entry too large."));
          zip.close();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError);
            zip.close();
            return;
          }
          const chunks = [];
          stream.on("error", reject);
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            result.set(name.split("/").at(-1), Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
  const binary = files.get("node.exe"),
    license = files.get("LICENSE");
  if (!binary || !license) throw new Error("Official runtime archive lacks binary/license.");
  if (createHash("sha256").update(binary).digest("hex") !== expected)
    throw new Error("Node runtime checksum mismatch.");
  const destination = resolve(import.meta.dirname, "../out/cli/runtime");
  await mkdir(destination, { recursive: true });
  await writeFile(resolve(destination, "node.exe"), binary);
  await writeFile(resolve(destination, "LICENSE.txt"), license);
  await writeFile(
    resolve(destination, "provenance.json"),
    JSON.stringify({ version, url: `${origin}win-x64/node.exe`, sha256: expected }, null, 2),
  );
  console.log(`Verified official Node ${version} Windows x64 CLI runtime.`);
}
