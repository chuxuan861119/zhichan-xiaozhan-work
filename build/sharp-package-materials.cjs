const { createHash } = require("node:crypto");
const { lstat, readFile, readdir, unlink } = require("node:fs/promises");
const { join } = require("node:path");

// Only the freshly copied app bundle is changed; repository source archives stay intact.
async function prunePackagedSharpMaterials(resources, platform, arch) {
  const target = `${platform}-${arch}`;
  if (!["win32-x64", "darwin-arm64", "darwin-x64"].includes(target))
    throw new Error(`Unsupported Sharp package target: ${target}`);
  if (!(await lstat(join(resources, "app.asar"))).isFile())
    throw new Error("Sharp material pruning requires a packaged app.asar");
  const base = join(resources, "resources/licenses/sharp-libvips");
  for (const directory of [base, join(base, "sources")]) {
    if (!(await lstat(directory)).isDirectory())
      throw new Error(`Unexpected Sharp material directory: ${directory}`);
  }
  const suffix = platform === "darwin" ? `.darwin-${arch}` : "";
  const manifestName = `SOURCE_MANIFEST${suffix}.json`;
  const materialsName = `COMPONENT_MATERIALS${suffix}.json`;
  const manifest = JSON.parse(await readFile(join(base, manifestName), "utf8"));
  const materials = JSON.parse(await readFile(join(base, materialsName), "utf8"));
  if (manifest.target !== target)
    throw new Error(`Sharp source manifest target mismatch: ${manifest.target} / ${target}`);
  if (
    JSON.stringify(Object.keys(materials).sort()) !==
    JSON.stringify(Object.keys(manifest.components).sort())
  )
    throw new Error("Sharp component source inventory mismatch");
  const required = new Map();
  function include(file, digest) {
    if (
      !/^(sources|licenses)\//u.test(file) ||
      file.includes("\\") ||
      file.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error(`Unsafe Sharp material path: ${file}`);
    if (required.has(file) && required.get(file) !== digest)
      throw new Error(`Conflicting Sharp material checksum: ${file}`);
    required.set(file, digest);
  }
  for (const source of [...manifest.buildSources, ...manifest.lgplCorrespondingSource])
    include(source.file, source.sha256);
  for (const component of Object.values(materials)) {
    include(component.archive[0], component.archive[2]);
    for (const [file, digest] of component.materials) include(file, digest);
  }
  // Verify everything retained before deleting anything, including all build recipes.
  for (const [file, expected] of required) {
    const path = join(base, file);
    if (!(await lstat(path)).isFile()) throw new Error(`Unexpected Sharp material: ${file}`);
    const actual = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (actual.toUpperCase() !== expected.toUpperCase())
      throw new Error(`Sharp material checksum mismatch: ${file}`);
  }
  const compliance = platform === "darwin" ? "LGPL_COMPLIANCE.macos.md" : "LGPL_COMPLIANCE.md";
  for (const file of [
    compliance,
    "licenses/Apache-2.0.txt",
    "licenses/GPL-3.0.txt",
    "licenses/LGPL-3.0.txt",
  ]) {
    if (!(await readFile(join(base, file))).length)
      throw new Error(`Empty Sharp license notice: ${file}`);
  }
  const remove = [];
  for (const entry of await readdir(join(base, "sources"), { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`Unexpected Sharp source entry: ${entry.name}`);
    const file = `sources/${entry.name}`;
    if (!required.has(file)) remove.push(file);
  }
  const retainedMetadata = new Set([manifestName, materialsName, compliance]);
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (
      /^(SOURCE_MANIFEST(?:\.darwin-(?:arm64|x64))?\.json|COMPONENT_MATERIALS(?:\.darwin-(?:arm64|x64))?\.json|LGPL_COMPLIANCE(?:\.macos)?\.md)$/u.test(
        entry.name,
      ) &&
      !retainedMetadata.has(entry.name)
    ) {
      if (!entry.isFile()) throw new Error(`Unexpected Sharp metadata entry: ${entry.name}`);
      remove.push(entry.name);
    }
  }
  let removedBytes = 0;
  for (const file of remove) {
    const path = join(base, file);
    removedBytes += (await lstat(path)).size;
    await unlink(path);
  }
  return { removedFiles: remove.length, removedBytes };
}

module.exports = { prunePackagedSharpMaterials };
