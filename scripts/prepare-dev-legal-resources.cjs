const fs = require("node:fs");
const path = require("node:path");

function copyTree(source, target) {
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      copyTree(path.join(source, name), path.join(target, name));
    }
  } else {
    fs.copyFileSync(source, target);
  }
}

function verifyTree(source, target) {
  if (fs.statSync(source).isDirectory()) {
    for (const name of fs.readdirSync(source)) {
      verifyTree(path.join(source, name), path.join(target, name));
    }
  } else if (!fs.readFileSync(source).equals(fs.readFileSync(target))) {
    throw new Error(`Legal resource differs: ${target}`);
  }
}

function prepareDevLegalResources(sourceResources, applicationRoot) {
  const entries = ["THIRD_PARTY_NOTICES.txt", "licenses"];
  // Validate inputs before changing the isolated application's resources.
  if (
    !fs.statSync(path.join(sourceResources, entries[0])).isFile() ||
    !fs.statSync(path.join(sourceResources, entries[1])).isDirectory()
  ) {
    throw new Error("Legal resources are incomplete");
  }
  const destination = path.join(applicationRoot, "resources");
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const source = path.join(sourceResources, entry);
    const target = path.join(destination, entry);
    copyTree(source, target);
    verifyTree(source, target);
  }
}
module.exports = { prepareDevLegalResources };
if (require.main === module) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target)
    throw new Error(
      "Usage: node prepare-dev-legal-resources.cjs <source-resources> <application-root>",
    );
  prepareDevLegalResources(source, target);
  console.log("Legal resources copied and verified.");
}
