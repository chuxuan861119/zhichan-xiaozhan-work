const { createHash, randomUUID } = require("node:crypto");
const { createWriteStream } = require("node:fs");
const { lstat, readFile, readdir, mkdir, rename, writeFile, unlink } = require("node:fs/promises");
const { join, resolve, relative, isAbsolute } = require("node:path");
const { pipeline } = require("node:stream/promises");
const { ZipFile } = require("yazl");

const SITE = "https://zcxzz.cn";
const PAGE = `${SITE}/open-source/`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function validateTarget(version, platform, arch) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid source release version");
  if (!["win32-x64", "darwin-arm64", "darwin-x64"].includes(`${platform}-${arch}`))
    throw new Error("Unsupported source target");
}
function safePath(path) {
  if (
    typeof path !== "string" ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.split("/").some((x) => !x || x === "." || x === "..")
  )
    throw new Error(`Unsafe source path: ${path}`);
  return path;
}
async function collectSourceFiles(root, platform, arch) {
  validateTarget("1.1.7", platform, arch);
  const files = new Map();
  async function add(path, expected) {
    safePath(path);
    const absolute = join(root, path);
    if (!(await lstat(absolute)).isFile()) throw new Error(`Not a regular source file: ${path}`);
    const sha256 = hash(await readFile(absolute));
    if (expected && sha256 !== expected.toLowerCase())
      throw new Error(`Source checksum mismatch: ${path}`);
    files.set(path, { path, sha256, bytes: (await lstat(absolute)).size });
  }
  async function walk(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) await add(name);
      else throw new Error(`Unexpected source entry: ${name}`);
    }
  }
  const base = "resources/licenses/sharp-libvips";
  const suffix = platform === "darwin" ? `.darwin-${arch}` : "";
  const manifestName = `${base}/SOURCE_MANIFEST${suffix}.json`;
  const materialsName = `${base}/COMPONENT_MATERIALS${suffix}.json`;
  const manifest = JSON.parse(await readFile(join(root, manifestName), "utf8"));
  const materials = JSON.parse(await readFile(join(root, materialsName), "utf8"));
  if (
    manifest.target !== `${platform}-${arch}` ||
    JSON.stringify(Object.keys(materials).sort()) !==
      JSON.stringify(Object.keys(manifest.components).sort())
  )
    throw new Error("Source component inventory mismatch");
  await add(manifestName);
  await add(materialsName);
  for (const item of [...manifest.buildSources, ...manifest.lgplCorrespondingSource])
    await add(`${base}/${safePath(item.file)}`, item.sha256);
  for (const item of Object.values(materials)) {
    await add(`${base}/${safePath(item.archive[0])}`, item.archive[2]);
    for (const [path, digest] of item.materials) await add(`${base}/${safePath(path)}`, digest);
  }
  await walk(`${base}/licenses`);
  for (const entry of await readdir(join(root, base), { withFileTypes: true }))
    if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) await add(`${base}/${entry.name}`);
  const cad = "resources/cadcraft";
  await walk(`${cad}/sources`);
  await walk(`${cad}/licenses`);
  await add(`${cad}/NOTICE.txt`);
  await add(`${cad}/manifest.json`);
  const cadManifest = JSON.parse(await readFile(join(root, cad, "manifest.json"), "utf8"));
  if (cadManifest.platform !== platform || cadManifest.arch !== arch)
    throw new Error("CAD source target mismatch");
  const sourceHash = files.get(`${cad}/sources/acadrust-0.6.3.crate`)?.sha256;
  const lock = await readFile(join(root, cad, "sources/Cargo.lock"), "utf8");
  const section = lock
    .split("[[package]]")
    .find((x) => x.includes('name = "acadrust"') && x.includes('version = "0.6.3"'));
  if (
    !sourceHash ||
    !section?.includes(`checksum = "${sourceHash}"`) ||
    !(await readFile(join(root, cad, "NOTICE.txt"), "utf8")).includes(sourceHash)
  )
    throw new Error("CAD corresponding source mismatch");
  await add("resources/THIRD_PARTY_NOTICES.txt");
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function createSourceBundle(root, { version, platform, arch }) {
  validateTarget(version, platform, arch);
  const files = await collectSourceFiles(root, platform, arch);
  const target = `${platform}-${arch}`;
  const manifest = { schemaVersion: 1, product: "知产小栈Work", version, target, files };
  const output = join(root, "release/open-source", version, target);
  await mkdir(output, { recursive: true });
  let reference;
  try {
    reference = JSON.parse(await readFile(join(root, "resources", `open-source-reference.${target}.json`), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (reference?.inventorySha256 === hash(Buffer.from(JSON.stringify(files)))) {
    validateTarget(reference.sourceVersion, platform, arch);
    if (!/^work-sources-[a-z0-9-]+\.zip$/.test(reference.archiveName) ||
        !/^[a-f0-9]{64}$/.test(reference.sha256) ||
        !Number.isSafeInteger(reference.bytes) || reference.bytes < 1)
      throw new Error("Invalid reusable source archive");
    const archivePath = join(output, reference.archiveName);
    const descriptor = {
      schemaVersion: 1, version, sourceVersion: reference.sourceVersion, target,
      archiveName: reference.archiveName, sha256: reference.sha256, bytes: reference.bytes,
      url: `${SITE}/downloads/open-source/work/${reference.sourceVersion}/${target}/${reference.archiveName}`,
      page: PAGE, files, archivePath,
    };
    let bytes;
    try {
      bytes = await readFile(archivePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const response = await fetch(descriptor.url, { signal: AbortSignal.timeout(180000), redirect: "error" });
      if (!response.ok) throw new Error(`Reusable source download failed: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256)
      throw new Error("Reusable source archive checksum/size mismatch");
    await writeFile(archivePath, bytes);
    const { archivePath: ignored, ...publicDescriptor } = descriptor;
    await writeFile(join(output, "source-release.json"), `${JSON.stringify(publicDescriptor, null, 2)}\n`);
    return descriptor;
  }
  const temp = join(output, `sources-${randomUUID()}.zip`);
  const zip = new ZipFile();
  const finished = pipeline(zip.outputStream, createWriteStream(temp, { flags: "wx" }));
  const options = { mtime: new Date("2020-01-01T00:00:00Z"), mode: 0o100644, compress: false };
  zip.addBuffer(
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    "SOURCE_RELEASE.json",
    options,
  );
  zip.addBuffer(
    Buffer.from(
      "Corresponding source for 知产小栈Work\n\nSee SOURCE_RELEASE.json for the exact application version, platform and checksums.\nThe resources/ tree contains component sources, original licenses, patches and build recipes.\nSharp replacement instructions: resources/licenses/sharp-libvips/LGPL_COMPLIANCE*.md.\nCAD source: resources/cadcraft/sources/acadrust-0.6.3.crate (tar -xzf).\nThis is not the proprietary Work application source. Component rights are governed by their original licenses, not the application personal/enterprise license.\n",
    ),
    "README.txt",
    options,
  );
  for (const file of files) zip.addFile(join(root, file.path), file.path, options);
  zip.end();
  await finished;
  const sha256 = hash(await readFile(temp));
  const archiveName = `work-sources-${target}-${sha256.slice(0, 16)}.zip`;
  const archivePath = join(output, archiveName);
  try {
    await lstat(archivePath);
    if (hash(await readFile(archivePath)) !== sha256)
      throw new Error("Existing source archive conflicts");
    await unlink(temp);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await rename(temp, archivePath);
  }
  const descriptor = {
    schemaVersion: 1,
    version,
    target,
    archiveName,
    sha256,
    bytes: (await lstat(archivePath)).size,
    url: `${SITE}/downloads/open-source/work/${version}/${target}/${archiveName}`,
    page: PAGE,
    files,
    archivePath,
  };
  const { archivePath: ignored, ...publicDescriptor } = descriptor;
  await writeFile(
    join(output, "source-release.json"),
    `${JSON.stringify(publicDescriptor, null, 2)}\n`,
  );
  return descriptor;
}

async function verifyPublishedBundle(bundle, request = fetch) {
  const sourceVersion = bundle.sourceVersion || bundle.version;
  validateTarget(sourceVersion, ...bundle.target.split("-"));
  const expected = `${SITE}/downloads/open-source/work/${sourceVersion}/${bundle.target}/${bundle.archiveName}`;
  if (bundle.url !== expected) throw new Error("Unexpected source publication URL");
  const response = await request(bundle.url, {
    signal: AbortSignal.timeout(180000),
    redirect: "error",
  });
  if (!response.ok || !response.body)
    throw new Error(`Source publication unavailable: HTTP ${response.status}`);
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > bundle.bytes) throw new Error("Published source size mismatch");
    digest.update(chunk);
  }
  if (bytes !== bundle.bytes || digest.digest("hex") !== bundle.sha256)
    throw new Error("Published source checksum/size mismatch");
  return true;
}

async function externalizePackagedSources(resources, bundle, request = fetch) {
  validateTarget(bundle.version, ...bundle.target.split("-"));
  const sourceRoot = resolve(bundle.archivePath, "../../../../..");
  const destination = resolve(resources);
  // Only an Electron package copy may be changed, never the repository resources.
  if (destination === join(sourceRoot, "resources"))
    throw new Error("Cannot modify repository source materials");
  if (!(await lstat(join(resources, "app.asar"))).isFile())
    throw new Error("Expected packaged app.asar");
  const [platform, arch] = bundle.target.split("-");
  const suffix = platform === "darwin" ? `.darwin-${arch}` : "";
  const manifests = [
    "resources/cadcraft/manifest.json",
    `resources/licenses/sharp-libvips/SOURCE_MANIFEST${suffix}.json`,
  ];
  for (const path of manifests) {
    if (
      hash(await readFile(join(resources, path))) !==
      bundle.files.find((x) => x.path === path)?.sha256
    )
      throw new Error(`Packaged runtime inventory mismatch: ${path}`);
  }
  const cad = JSON.parse(await readFile(join(resources, manifests[0]), "utf8"));
  const sharp = JSON.parse(await readFile(join(resources, manifests[1]), "utf8"));
  if (
    hash(await readFile(join(resources, "resources/cadcraft", safePath(cad.executable)))) !==
    cad.sha256.toLowerCase()
  )
    throw new Error("Packaged CAD binary checksum mismatch");
  if (
    hash(await readFile(join(resources, "app.asar.unpacked", safePath(sharp.dll.path)))) !==
    sharp.dll.sha256.toLowerCase()
  )
    throw new Error("Packaged image library checksum mismatch");
  const remove = bundle.files.filter(
    (x) =>
      x.path.startsWith("resources/cadcraft/sources/") ||
      x.path.startsWith("resources/licenses/sharp-libvips/sources/"),
  );
  for (const file of remove) {
    const target = resolve(resources, file.path);
    if (
      relative(destination, target).startsWith("..") ||
      !(await lstat(target)).isFile() ||
      hash(await readFile(target)) !== file.sha256
    )
      throw new Error(`Packaged source mismatch: ${file.path}`);
  }
  await verifyPublishedBundle(bundle, request);
  const { archivePath: ignored, ...record } = bundle;
  await writeFile(
    join(resources, "resources/OPEN_SOURCE_DOWNLOADS.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  const notice = `Corresponding source / 对应源码\nWork ${bundle.version} (${bundle.target})\n${PAGE}\n${bundle.url}\nSHA-256: ${bundle.sha256}\nBytes: ${bundle.bytes}\nFree access without registration. Ordinary offline use does not require this download. Original component licenses remain included; application terms do not restrict these source rights.\n`;
  // Keep the notice beside the component licenses and at the app resources root,
  // matching the path printed in the LGPL/CAD notices.
  await writeFile(join(resources, "resources/OPEN_SOURCE_DOWNLOADS.txt"), notice);
  await writeFile(join(resources, "OPEN_SOURCE_DOWNLOADS.txt"), notice);
  let removedBytes = 0;
  for (const file of remove) {
    await unlink(join(resources, file.path));
    removedBytes += file.bytes;
  }
  return { removedFiles: remove.length, removedBytes };
}
module.exports = {
  collectSourceFiles,
  createSourceBundle,
  verifyPublishedBundle,
  externalizePackagedSources,
};
