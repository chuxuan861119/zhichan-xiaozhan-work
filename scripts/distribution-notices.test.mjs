import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateBundledResourceNotices } from "./audit-bundled-notices.mjs";
import { generateDrawioEmbeddedNotices } from "./audit-drawio-licenses.mjs";
import {
  markDrawioModification,
  sanitizeDrawioIndexHtml,
  sanitizeDrawioRuntime,
} from "./vendor-drawio.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("distributed notices retain the selection cursor's original copyright and permission", async () => {
  const notices = await generateBundledResourceNotices(root);
  const original = await readFile(
    join(root, "src/renderer/src/assets/selection-gutter-cursor.LICENSE.txt"),
    "utf8",
  );
  assert.ok(notices.includes(original.replace(/\r\n?/gu, "\n").trim()));
});

test("binary distribution expressly credits the FreeType Team", async () => {
  const notices = await generateBundledResourceNotices(root);
  assert.ok(notices.includes("This software is based in part on the work of the FreeType Team."));
});

test("draw.io embedded dependencies retain version-specific notices outside npm", async () => {
  const notices = await generateBundledResourceNotices(root);
  for (const name of [
    "spin.js 2.0.0",
    "CryptoJS 3.1.2",
    "Bridge.NET 15.6.0",
    "DOMPurify 3.4.5",
    "DOMPurify 3.3.1",
    "pako 2.1.0",
    "JSZip 3.10.0",
    "Felix Gnass",
    "Jeff Mott",
    "Object.NET",
  ]) {
    assert.ok(notices.includes(name), name);
  }
});

test("modified upstream HTML and resource files carry modification notices", () => {
  assert.match(
    sanitizeDrawioIndexHtml('<!DOCTYPE html><html><script src="js/main.js"></script></html>'),
    /<!-- Modified by 知产小栈Work:/u,
  );
  assert.match(
    sanitizeDrawioRuntime("help=https://example.com/help"),
    /^# Modified by 知产小栈Work:/u,
  );
});

test("modification notices preserve HTML doctype and remain idempotent", async () => {
  const html = sanitizeDrawioIndexHtml("<!DOCTYPE html><html></html>");
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.equal(markDrawioModification(html, "html"), html);
  for (const path of [
    "index.html",
    "js/bootstrap.js",
    "resources/dia.txt",
    "resources/dia_zh.txt",
    "resources/patent_zh.txt",
  ]) {
    assert.ok(
      (await readFile(join(root, "resources/drawio/app", path), "utf8")).includes(
        "Modified by 知产小栈Work:",
      ),
      path,
    );
  }
});

test("changing a draw.io embedded library blocks outdated license attribution", async () => {
  const fixture = await licenseFixture();
  await writeFile(join(fixture, "resources/drawio/app/js/app.min.js"), "changed runtime");
  await assert.rejects(
    generateDrawioEmbeddedNotices(fixture),
    /versions changed; review licenses/u,
  );
});

test("corrupting an embedded license blocks distribution notice generation", async () => {
  const fixture = await licenseFixture();
  await writeFile(
    join(fixture, "resources/licenses/drawio/EMBEDDED_DEPENDENCIES.txt"),
    "incomplete license",
  );
  await assert.rejects(generateDrawioEmbeddedNotices(fixture), /material checksum mismatch/u);
});

async function licenseFixture() {
  const fixture = await mkdtemp(join(tmpdir(), "drawio-license-inventory-"));
  await cp(join(root, "resources/licenses/drawio"), join(fixture, "resources/licenses/drawio"), {
    recursive: true,
  });
  const js = join(fixture, "resources/drawio/app/js");
  await mkdir(js, { recursive: true });
  for (const name of ["app.min.js", "extensions.min.js"])
    await cp(join(root, "resources/drawio/app/js", name), join(js, name));
  return fixture;
}
