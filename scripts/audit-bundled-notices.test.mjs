import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  bundledLicenseIndex,
  generateBundledResourceNotices,
  syncElectronLicenseMaterials,
} from "./audit-bundled-notices.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("CAD distribution retains MPL corresponding source and original dependency notices", async () => {
  const source = await readFile(join(root, "resources/cadcraft/sources/acadrust-0.6.3.crate"));
  const notice = await readFile(join(root, "resources/cadcraft/NOTICE.txt"), "utf8");
  assert.ok(notice.includes(createHash("sha256").update(source).digest("hex")));
  const notices = await generateBundledResourceNotices(root, {
    includeDrawingConverter: false,
    includeElectron: false,
  });
  assert.ok(notices.includes("MPL-2.0"));
  assert.ok(notices.includes("cadcraft/licenses/LICENSE-MIT"));
  assert.ok(notices.includes("cadcraft/licenses/acadrust-0.6.3/LICENSE"));
});

test("bundled resource notices retain originals and identify every material", async () => {
  const notices = await generateBundledResourceNotices(root);
  for (const name of [
    "Tailwind CSS",
    "Font Awesome 4.7 fonts",
    "draw.io NOTICE",
    "ACadSharp-MIT.txt",
    "DOTNET-THIRD-PARTY-NOTICES.TXT",
    "PyInstaller",
    "Electron",
    "Cadcraft and acadrust source availability",
  ])
    assert.ok(notices.includes(name), name);
  assert.match(notices, /CAD converter: (?:licenses\/PYTHON-LICENSE\.txt|python\/LICENSE\.txt)/u);
  const materials = [
    ...notices.matchAll(/^Bundled material: resources\/(.+)\nSHA-256: ([a-f0-9]+)$/gm),
  ];
  assert.ok(materials.length > 6);
  for (const [, path, expected] of materials) {
    const bytes = await readFile(join(root, "resources", path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
    assert.ok(
      notices.includes(
        bytes
          .toString("utf8")
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t]+$/gm, "")
          .trim(),
      ),
    );
  }
});

test("Chromium archive preserves the complete installed runtime notice", async () => {
  const bundled = gunzipSync(
    await readFile(join(root, "resources/licenses/electron/LICENSES.chromium.html.gz")),
  );
  assert.ok(
    bundled.equals(await readFile(join(root, "node_modules/electron/dist/LICENSES.chromium.html"))),
  );
  const provenance = JSON.parse(
    await readFile(join(root, "resources/licenses/electron/provenance.json"), "utf8"),
  );
  assert.equal(
    createHash("sha256").update(bundled).digest("hex"),
    provenance.files["LICENSES.chromium.html"],
  );
  assert.equal(
    provenance.version,
    JSON.parse(await readFile(join(root, "node_modules/electron/package.json"), "utf8")).version,
  );
});

test("Harmony supplement excludes desktop converters and Electron material", async () => {
  const options = { includeDrawingConverter: false, includeElectron: false };
  const notices = await generateBundledResourceNotices(root, options);
  assert.ok(notices.includes("Font Awesome"));
  assert.ok(!notices.includes("CAD converter:"));
  assert.ok(!notices.includes("Electron/Chromium runtime notices:"));
  const index = bundledLicenseIndex(options);
  assert.ok(!index.includes("electron/LICENSE.txt"));
  assert.ok(!index.includes("../drawing-converter/"));
});

test("missing original resource licenses block notice generation", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "bundled-license-missing-"));
  await cp(join(root, "resources/licenses"), join(fixture, "resources/licenses"), {
    recursive: true,
    filter: (path) => !path.includes("sharp-libvips") && !path.includes("electron"),
  });
  await cp(join(root, "resources/licenses/drawio"), join(fixture, "resources/licenses/drawio"), {
    recursive: true,
  });
  await cp(
    join(root, "resources/ipc-data-center/licenses"),
    join(fixture, "resources/ipc-data-center/licenses"),
    { recursive: true },
  );
  await writeFile(join(fixture, "resources/ipc-data-center/licenses/tailwind-MIT.txt"), "");
  await assert.rejects(
    generateBundledResourceNotices(fixture, {
      includeDrawingConverter: false,
      includeElectron: false,
      includeCad: false,
    }),
    /Empty license material/,
  );
});

test("runtime version mismatch blocks Electron license attribution", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "electron-license-version-"));
  await mkdir(join(fixture, "node_modules/electron/dist"), { recursive: true });
  await writeFile(
    join(fixture, "node_modules/electron/package.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  await writeFile(
    join(fixture, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/electron": { version: "1.0.0" } } }),
  );
  await writeFile(join(fixture, "node_modules/electron/dist/version"), "2.0.0");
  await assert.rejects(syncElectronLicenseMaterials(fixture), /locked runtime version/);
});

test("CAD licensing rejects a substituted source archive before producing notices", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "cad-source-license-"));
  const target = join(fixture, "resources/cadcraft");
  await mkdir(join(target, "sources"), { recursive: true });
  await cp(join(root, "resources/cadcraft/sources/Cargo.lock"), join(target, "sources/Cargo.lock"));
  await cp(join(root, "resources/cadcraft/NOTICE.txt"), join(target, "NOTICE.txt"));
  await writeFile(join(target, "sources/acadrust-0.6.3.crate"), "incorrect source archive");
  await assert.rejects(generateBundledResourceNotices(fixture, {
    includeDrawingConverter: false, includeElectron: false,
  }), /MPL corresponding source does not match/);
});
