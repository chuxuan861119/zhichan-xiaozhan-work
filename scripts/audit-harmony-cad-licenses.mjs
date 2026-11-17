import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yauzl from "yauzl";
import { sha256, verifyCadRuntime } from "./harmony-build.mjs";

export async function wheelLicenseNotices(file) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const notices = [];
  try {
    await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        if (!/(^|\/)(license[^/]*|copying[^/]*|notice[^/]*)$/iu.test(entry.fileName))
          return zip.readEntry();
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks = [];
          stream.on("error", reject);
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (!text.trim()) return reject(new Error(`Empty wheel license: ${entry.fileName}`));
            notices.push(`${entry.fileName}\n${text}`);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
    if (!notices.length) throw new Error(`Missing wheel licenses: ${file}`);
    return notices.join("\n\n");
  } finally {
    zip.close();
  }
}

export async function auditHarmonyCadLicenses(runtime, pins, licenseRoot) {
  await verifyCadRuntime(runtime, pins);
  const provenance = JSON.parse(await readFile(join(licenseRoot, "provenance.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(runtime, "python/pyodide-lock.json"), "utf8"));
  const packageInfo = JSON.parse(await readFile(join(runtime, "python/package.json"), "utf8"));
  if (
    pins.pyodide !== "0.29.3" ||
    provenance.pyodide !== pins.pyodide ||
    packageInfo.version !== pins.pyodide ||
    lock.info.python !== provenance.python ||
    provenance.python !== "3.13.2"
  )
    throw new Error("CAD runtime license/source versions need review");
  const notices = ["Harmony offline CAD third-party licenses"];
  for (const name of ["PYODIDE-MPL-2.0.txt", "CPYTHON-3.13.2-LICENSE.txt"]) {
    if ((await sha256(join(licenseRoot, name))) !== provenance.files[name])
      throw new Error(`CAD license checksum mismatch: ${name}`);
    notices.push(await readFile(join(licenseRoot, name), "utf8"));
  }
  const sourceAccess = await readFile(join(licenseRoot, "SOURCE-ACCESS.txt"), "utf8");
  if (
    !sourceAccess.includes(provenance.sources.pyodide) ||
    !sourceAccess.includes(provenance.sources.python)
  )
    throw new Error("Missing CAD corresponding-source access notice");
  notices.push(sourceAccess);
  for (const name of [
    "licenses/reader/ACadSharp-MIT.txt",
    "licenses/reader/CSUtilities-MIT.txt",
    "licenses/reader/DOTNET-LICENSE.TXT",
    "licenses/reader/DOTNET-THIRD-PARTY-NOTICES.TXT",
    "licenses/source-han-serif/LICENSE.txt",
  ]) {
    if (!pins.files[name]) throw new Error(`Missing pinned CAD license: ${name}`);
    notices.push(`${name}\n${await readFile(join(runtime, name), "utf8")}`);
  }
  for (const name of Object.keys(pins.files).filter((name) => name.endsWith(".whl")))
    notices.push(`${name}\n${await wheelLicenseNotices(join(runtime, name))}`);
  return notices.join("\n\n");
}
