import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import yazl from "yazl";
import { auditHarmonyCadLicenses, wheelLicenseNotices } from "./audit-harmony-cad-licenses.mjs";

async function wheel(file, entries) {
  const zip = new yazl.ZipFile();
  for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name);
  const done = new Promise((resolve, reject) =>
    zip.outputStream.pipe(createWriteStream(file)).on("finish", resolve).on("error", reject),
  );
  zip.end();
  await done;
}

test("wheel notices retain both distribution and bundled-library licenses; absent notices fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "cad-license-wheel-"));
  try {
    const file = join(root, "fixture.whl");
    await wheel(file, {
      "package.dist-info/LICENSE": "MIT fixture",
      "package/random/LICENSE.md": "BSD fixture",
    });
    const notices = await wheelLicenseNotices(file);
    assert.match(notices, /MIT fixture/);
    assert.match(notices, /BSD fixture/);
    await wheel(join(root, "absent.whl"), { "package/main.py": "fixture" });
    await assert.rejects(wheelLicenseNotices(join(root, "absent.whl")), /Missing wheel licenses/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CAD license audit couples source versions and notices to the pinned runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "cad-license-audit-"));
  try {
    const licenses = join(root, "notices");
    await cp(new URL("../resources/licenses/harmony-cad", import.meta.url), licenses, {
      recursive: true,
    });
    const files = {};
    for (const [name, text] of Object.entries({
      "python/package.json": JSON.stringify({ version: "0.29.3" }),
      "python/pyodide-lock.json": JSON.stringify({ info: { python: "3.13.2" } }),
      "licenses/reader/ACadSharp-MIT.txt": "MIT fixture",
      "licenses/reader/CSUtilities-MIT.txt": "MIT fixture",
      "licenses/reader/DOTNET-LICENSE.TXT": "MIT fixture",
      "licenses/reader/DOTNET-THIRD-PARTY-NOTICES.TXT": "Third party fixture",
      "licenses/source-han-serif/LICENSE.txt": "OFL fixture",
    })) {
      await mkdir(dirname(join(root, "runtime", name)), { recursive: true });
      await writeFile(join(root, "runtime", name), text);
      files[name] = createHash("sha256").update(text).digest("hex");
    }
    const pins = { target: "wasm32-offline", pyodide: "0.29.3", files };
    await writeFile(join(root, "runtime/manifest.json"), JSON.stringify(pins));
    assert.match(
      await auditHarmonyCadLicenses(join(root, "runtime"), pins, licenses),
      /Mozilla Public License/,
    );
    await writeFile(join(licenses, "SOURCE-ACCESS.txt"), "missing source links");
    await assert.rejects(
      auditHarmonyCadLicenses(join(root, "runtime"), pins, licenses),
      /source access notice/,
    );
    await assert.rejects(
      auditHarmonyCadLicenses(join(root, "runtime"), { ...pins, pyodide: "new-version" }, licenses),
      /versions need review/,
    );
    await writeFile(join(licenses, "PYODIDE-MPL-2.0.txt"), "tampered");
    await assert.rejects(
      auditHarmonyCadLicenses(join(root, "runtime"), pins, licenses),
      /checksum mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
