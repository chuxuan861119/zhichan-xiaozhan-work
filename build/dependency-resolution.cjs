const { existsSync, readFileSync, realpathSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join, resolve } = require("node:path");

// Inspect the same nearest node_modules package Node resolves, including scoped
// packages whose exports deliberately hide package.json or omit a root entry.
exports.findInstalledPackage = (root, name) => {
  const requireFromRoot = createRequire(join(resolve(root), "package.json"));
  for (const modulesDirectory of requireFromRoot.resolve.paths(name) ?? []) {
    const packageFile = join(modulesDirectory, name, "package.json");
    if (!existsSync(packageFile)) continue;
    return {
      modulesDirectory: realpathSync(modulesDirectory),
      directory: realpathSync(join(modulesDirectory, name)),
      manifest: JSON.parse(readFileSync(packageFile, "utf8")),
    };
  }
  return null;
};

exports.dependencyAllowPaths = (root) => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const paths = new Set([root]);
  const localModules = join(root, "node_modules");
  if (existsSync(localModules)) paths.add(realpathSync(localModules));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const installed = exports.findInstalledPackage(root, name);
    if (!installed) continue;
    paths.add(installed.modulesDirectory);
    paths.add(installed.directory);
  }
  return [...paths];
};
