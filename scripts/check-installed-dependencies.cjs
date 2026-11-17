const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { findInstalledPackage } = require("../build/dependency-resolution.cjs");

exports.checkInstalledDependencies = (root) => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const issues = [];
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const lockedDeclarations = {
    ...lock.packages?.[""]?.dependencies,
    ...lock.packages?.[""]?.devDependencies,
  };
  for (const [name, declaration] of Object.entries(dependencies)) {
    const expected = lock.packages?.[`node_modules/${name}`]?.version;
    if (lockedDeclarations[name] !== declaration || !expected) {
      issues.push(`${name}: package.json 与锁文件不一致。`);
      continue;
    }
    const installed = findInstalledPackage(root, name);
    if (!installed) issues.push(`${name}: 未安装，锁定版本 ${expected}。`);
    else if (installed.manifest.name !== name || installed.manifest.version !== expected)
      issues.push(`${name}: 锁定版本 ${expected}，实际版本 ${installed.manifest.version}。`);
  }
  return { checkedCount: Object.keys(dependencies).length, issues };
};

if (require.main === module) {
  try {
    const result = exports.checkInstalledDependencies(process.cwd());
    if (result.issues.length) {
      console.error(
        `依赖版本检查失败：\n${result.issues.join("\n")}\n请在当前工作树运行 npm ci 后重试。`,
      );
      process.exitCode = 1;
    } else console.log(`依赖版本与锁文件一致（${result.checkedCount} 项）。`);
  } catch (error) {
    console.error(`无法核验依赖版本：${error.message}\n请在当前工作树运行 npm ci 后重试。`);
    process.exitCode = 1;
  }
}
