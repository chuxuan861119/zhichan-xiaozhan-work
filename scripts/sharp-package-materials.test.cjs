const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { prunePackagedSharpMaterials } = require("../build/audit-package.cjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "sharp-package-materials-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const base = join(root, "resources/licenses/sharp-libvips");
  await mkdir(join(base, "sources"), { recursive: true });
  await mkdir(join(base, "licenses/components"), { recursive: true });
  await writeFile(join(root, "app.asar"), "application fixture");
  await writeFile(join(root, "runtime.bin"), "unchanged runtime");
  const descriptor = async (file) => {
    const bytes = Buffer.from(file);
    await writeFile(join(base, file), bytes);
    return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const license = await descriptor("licenses/components/COPYING");
  for (const platform of ["win32-x64", "darwin-arm64", "darwin-x64"]) {
    const suffix = platform === "win32-x64" ? "" : `.${platform}`;
    const build = await descriptor(`sources/build-${platform}.tar.gz`);
    const lgpl = await descriptor(`sources/lgpl-${platform}.tar.xz`);
    const component = await descriptor(`sources/component-${platform}.tar.gz`);
    await writeFile(
      join(base, `SOURCE_MANIFEST${suffix}.json`),
      JSON.stringify({
        target: platform,
        buildSources: [build],
        lgplCorrespondingSource: [lgpl],
        components: { image: ["1.0.0", "LGPL"] },
      }),
    );
    await writeFile(
      join(base, `COMPONENT_MATERIALS${suffix}.json`),
      JSON.stringify({
        image: {
          archive: [component.file, "https://example.invalid/source", component.sha256],
          materials: [[license.file, license.sha256]],
        },
      }),
    );
  }
  await descriptor("sources/historical-source.tar.gz");
  for (const name of [
    "LGPL_COMPLIANCE.md",
    "LGPL_COMPLIANCE.macos.md",
    "licenses/Apache-2.0.txt",
    "licenses/GPL-3.0.txt",
    "licenses/LGPL-3.0.txt",
  ])
    await writeFile(join(base, name), "original license or notice");
  return { root, base };
}

for (const [platform, arch] of [
  ["win32", "x64"],
  ["darwin", "arm64"],
  ["darwin", "x64"],
]) {
  test(`${platform}-${arch}: keeps all referenced sources and licenses, removes only unrelated packaged materials`, async (t) => {
    assert.equal(typeof prunePackagedSharpMaterials, "function");
    const { root, base } = await fixture(t);
    const result = await prunePackagedSharpMaterials(root, platform, arch);
    assert.equal(result.removedFiles, 12);
    assert.ok(result.removedBytes > 0);
    assert.deepEqual((await readdir(join(base, "sources"))).sort(), [
      `build-${platform}-${arch}.tar.gz`,
      `component-${platform}-${arch}.tar.gz`,
      `lgpl-${platform}-${arch}.tar.xz`,
    ]);
    assert.equal(await readFile(join(root, "runtime.bin"), "utf8"), "unchanged runtime");
    assert.equal(
      await readFile(join(base, "licenses/components/COPYING"), "utf8"),
      "licenses/components/COPYING",
    );
    assert.equal(
      await readFile(join(base, "licenses/LGPL-3.0.txt"), "utf8"),
      "original license or notice",
    );
    const suffix = platform === "win32" ? "" : `.darwin-${arch}`;
    assert.ok(await readFile(join(base, `SOURCE_MANIFEST${suffix}.json`)));
    assert.deepEqual(await prunePackagedSharpMaterials(root, platform, arch), {
      removedFiles: 0,
      removedBytes: 0,
    });
  });
}

for (const problem of ["missing", "changed", "wrong-target", "unsafe-path"]) {
  test(`rejects ${problem} required material before removing any archive`, async (t) => {
    assert.equal(typeof prunePackagedSharpMaterials, "function");
    const { root, base } = await fixture(t);
    const source = join(base, "sources/lgpl-win32-x64.tar.xz");
    if (problem === "missing") await rm(source);
    if (problem === "changed") await writeFile(source, "changed bytes");
    if (problem === "wrong-target" || problem === "unsafe-path") {
      const path = join(base, "SOURCE_MANIFEST.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      if (problem === "wrong-target") manifest.target = "darwin-arm64";
      else manifest.buildSources[0].file = "../outside.tar.gz";
      await writeFile(path, JSON.stringify(manifest));
    }
    await assert.rejects(prunePackagedSharpMaterials(root, "win32", "x64"));
    assert.ok(await readFile(join(base, "sources/historical-source.tar.gz")));
  });
}

test("does not prune checkout resources or unsupported package targets", async (t) => {
  assert.equal(typeof prunePackagedSharpMaterials, "function");
  const { root, base } = await fixture(t);
  await assert.rejects(prunePackagedSharpMaterials(root, "linux", "x64"), /target/);
  await rm(join(root, "app.asar"));
  await assert.rejects(prunePackagedSharpMaterials(root, "win32", "x64"), /app.asar|ENOENT/);
  assert.ok(await readFile(join(base, "sources/historical-source.tar.gz")));
});
