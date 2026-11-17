const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, readFile, access } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const {
  collectSourceFiles,
  createSourceBundle,
  verifyPublishedBundle,
  externalizePackagedSources,
} = require("../build/open-source-distribution.cjs");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "work-source-distribution-"));
  const digest = (b) => createHash("sha256").update(b).digest("hex");
  async function put(path, content) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const base = "resources/licenses/sharp-libvips";
  await put(`${base}/sources/library.tar.gz`, "source");
  await put(`${base}/licenses/LGPL-3.0.txt`, "license");
  await put(
    `${base}/SOURCE_MANIFEST.json`,
    JSON.stringify({
      target: "win32-x64",
      dll: { path: "runtime.dll", sha256: digest("runtime") },
      components: { test: ["1", "LGPL"] },
      buildSources: [],
      lgplCorrespondingSource: [{ file: "sources/library.tar.gz", sha256: digest("source") }],
    }),
  );
  await put(
    `${base}/COMPONENT_MATERIALS.json`,
    JSON.stringify({
      test: {
        archive: ["sources/library.tar.gz", "https://example.org/source", digest("source")],
        materials: [["licenses/LGPL-3.0.txt", digest("license")]],
      },
    }),
  );
  await put("resources/cadcraft/sources/acadrust-0.6.3.crate", "cad source");
  await put(
    "resources/cadcraft/sources/Cargo.lock",
    `[[package]]\nname = "acadrust"\nversion = "0.6.3"\nchecksum = "${digest("cad source")}"\n`,
  );
  await put("resources/cadcraft/licenses/acadrust-0.6.3/LICENSE", "MPL");
  await put("resources/cadcraft/NOTICE.txt", digest("cad source"));
  await put("resources/cadcraft/cadcraft-codec.exe", "cad runtime");
  await put(
    "resources/cadcraft/manifest.json",
    JSON.stringify({
      platform: "win32",
      arch: "x64",
      executable: "cadcraft-codec.exe",
      sha256: digest("cad runtime"),
    }),
  );
  await put("resources/THIRD_PARTY_NOTICES.txt", "notices");
  return { root, put, base };
}

test("collects corresponding sources and fails on tampering or unsafe manifest paths", async () => {
  const f = await fixture();
  const files = await collectSourceFiles(f.root, "win32", "x64");
  assert(files.some((x) => x.path.endsWith("acadrust-0.6.3.crate")));
  await f.put(`${f.base}/sources/library.tar.gz`, "wrong");
  await assert.rejects(collectSourceFiles(f.root, "win32", "x64"), /checksum/i);
});

test("builds a deterministic archive and verifies full remote content, not only HEAD", async () => {
  const f = await fixture();
  const one = await createSourceBundle(f.root, {
    version: "1.1.7",
    platform: "win32",
    arch: "x64",
  });
  const two = await createSourceBundle(f.root, {
    version: "1.1.7",
    platform: "win32",
    arch: "x64",
  });
  assert.equal(one.sha256, two.sha256);
  const bytes = await readFile(one.archivePath);
  await verifyPublishedBundle(one, async () => new Response(bytes));
  await assert.rejects(
    verifyPublishedBundle(one, async () => new Response("wrong")),
    /checksum|size/i,
  );
  await assert.rejects(
    verifyPublishedBundle(one, async () => new Response("", { status: 404 })),
    /404/,
  );
  await assert.rejects(
    createSourceBundle(f.root, { version: "../bad", platform: "win32", arch: "x64" }),
    /version/i,
  );
});

test("excludes only verified source archives from copied app; keeps notices and runtime; rejects absent publication", async () => {
  const f = await fixture();
  const { cp } = require("node:fs/promises");
  const bundle = await createSourceBundle(f.root, {
    version: "1.1.7",
    platform: "win32",
    arch: "x64",
  });
  const resources = join(f.root, "package/resources");
  await mkdir(resources, { recursive: true });
  await cp(join(f.root, "resources"), join(resources, "resources"), { recursive: true });
  await writeFile(join(resources, "app.asar"), "application");
  await writeFile(join(resources, "runtime.dll"), "runtime");
  await mkdir(join(resources, "app.asar.unpacked"), { recursive: true });
  await writeFile(join(resources, "app.asar.unpacked/runtime.dll"), "runtime");
  await writeFile(join(resources, "app.asar.unpacked/runtime.dll"), "wrong binary");
  let requested = false;
  await assert.rejects(
    externalizePackagedSources(resources, bundle, async () => {
      requested = true;
      return new Response(await readFile(bundle.archivePath));
    }),
    /image library checksum/,
  );
  assert.equal(requested, false);
  await access(join(resources, "resources/cadcraft/sources/acadrust-0.6.3.crate"));
  await writeFile(join(resources, "app.asar.unpacked/runtime.dll"), "runtime");
  await assert.rejects(
    externalizePackagedSources(resources, bundle, async () => new Response("", { status: 404 })),
    /404/,
  );
  await access(join(resources, "resources/cadcraft/sources/acadrust-0.6.3.crate"));
  await externalizePackagedSources(
    resources,
    bundle,
    async () => new Response(await readFile(bundle.archivePath)),
  );
  await assert.rejects(access(join(resources, "resources/cadcraft/sources/acadrust-0.6.3.crate")));
  await access(join(resources, "resources/cadcraft/licenses/acadrust-0.6.3/LICENSE"));
  assert.equal(await readFile(join(resources, "runtime.dll"), "utf8"), "runtime");
  assert.match(
    await readFile(join(resources, "OPEN_SOURCE_DOWNLOADS.txt"), "utf8"),
    /zcxzz\.cn\/downloads\/open-source\//,
  );
  assert.match(
    await readFile(join(resources, "resources/OPEN_SOURCE_DOWNLOADS.json"), "utf8"),
    /1\.1\.7/,
  );
});

test("reuses an existing archive only for an identical complete source inventory", async () => {
  const f=await fixture();
  const one=await createSourceBundle(f.root,{version:"1.1.7",platform:"win32",arch:"x64"});
  const inventorySha256=createHash("sha256").update(JSON.stringify(one.files)).digest("hex");
  await f.put("resources/open-source-reference.win32-x64.json",JSON.stringify({sourceVersion:one.version,archiveName:one.archiveName,sha256:one.sha256,bytes:one.bytes,inventorySha256}));
  const {copyFile}=require("node:fs/promises");
  const dir=join(f.root,"release/open-source/1.1.8/win32-x64");await mkdir(dir,{recursive:true});await copyFile(one.archivePath,join(dir,one.archiveName));
  const two=await createSourceBundle(f.root,{version:"1.1.8",platform:"win32",arch:"x64"});
  assert.equal(two.version,"1.1.8");assert.equal(two.sourceVersion,"1.1.7");assert.equal(two.url,one.url);assert.equal(two.sha256,one.sha256);
  await verifyPublishedBundle(two,async url=>{assert.equal(url,one.url);return new Response(await readFile(one.archivePath));});
  await f.put("resources/THIRD_PARTY_NOTICES.txt","updated notices");
  const changed=await createSourceBundle(f.root,{version:"1.1.8",platform:"win32",arch:"x64"});
  assert.notEqual(changed.sha256,one.sha256);assert.match(changed.url,/\/1\.1\.8\//);
});
