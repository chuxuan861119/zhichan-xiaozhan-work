import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DRAWIO_RESOURCE_BUDGET_BYTES = 30 * 1024 * 1024;
export const INSTALLER_BUDGET_BYTES = 30 * 1024 * 1024;
export const UNPACKED_BUDGET_BYTES = 50 * 1024 * 1024;

export function evaluateBundleBudgets({
  drawioBytes,
  installerBytes,
  baselineInstallerBytes,
  unpackedBytes,
  baselineUnpackedBytes,
}) {
  return {
    drawioWithinBudget: drawioBytes <= DRAWIO_RESOURCE_BUDGET_BYTES,
    installerWithinBudget:
      installerBytes === undefined || baselineInstallerBytes === undefined
        ? undefined
        : installerBytes - baselineInstallerBytes <= INSTALLER_BUDGET_BYTES,
    unpackedWithinBudget:
      unpackedBytes === undefined || baselineUnpackedBytes === undefined
        ? undefined
        : unpackedBytes - baselineUnpackedBytes <= UNPACKED_BUDGET_BYTES,
  };
}

export function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB (${bytes.toLocaleString("en-US")} bytes)`;
}

export function compareInstallerBytes(candidateBytes, baselineBytes) {
  const deltaBytes = candidateBytes - baselineBytes;
  return { deltaBytes, deltaMiB: (deltaBytes / 1024 / 1024).toFixed(2) };
}

function gateLabel(value) {
  return value === undefined ? "未评估" : value ? "通过" : "未通过";
}

function deltaLabel(comparison) {
  if (comparison === undefined) return "未提供可比基线";
  const sign = comparison.deltaBytes >= 0 ? "+" : "";
  return `${sign}${comparison.deltaMiB} MiB（${sign}${comparison.deltaBytes.toLocaleString("en-US")} bytes）`;
}

export function renderSizeReport(measurement) {
  const allPassed =
    measurement.drawioWithinBudget &&
    measurement.installerWithinBudget === true &&
    measurement.unpackedWithinBudget === true;
  return `# 流程图功能最终体积报告

更新日期：2026-08-11

测量口径：基线为流程图设计提交 \`02c5c49\`，候选为当前流程图功能分支；两者都在独立目录执行锁定依赖安装、应用构建和 Windows x64 NSIS 打包。旧的共享依赖构建结果不参与最终差值。

| 检查项 | 实测结果 | 门槛 | 结论 |
| --- | ---: | ---: | --- |
| draw.io 本地资源 | ${formatBytes(measurement.drawioBytes)} | ≤ 30.00 MiB | ${gateLabel(measurement.drawioWithinBudget)} |
| 候选安装包总量 | ${measurement.installerBytes === undefined ? "未测量" : formatBytes(measurement.installerBytes)} | 观察值 | 不单独判定 |
| 安装包增量 | ${deltaLabel(measurement.installerComparison)} | ≤ 30.00 MiB | ${gateLabel(measurement.installerWithinBudget)} |
| 候选解包目录总量 | ${measurement.unpackedBytes === undefined ? "未测量" : formatBytes(measurement.unpackedBytes)} | 观察值 | 不单独判定 |
| 解包目录增量 | ${deltaLabel(measurement.unpackedComparison)} | ≤ 50.00 MiB | ${gateLabel(measurement.unpackedWithinBudget)} |

结论：${allPassed ? "三项体积门禁均通过" : "存在未评估或未通过的体积门禁"}。安装包和解包目录只以相同构建方式生成的基线差值评估流程图增量，不把应用既有体积归因于本功能。
`;
}

export async function measureDirectoryBytes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) bytes += await measureDirectoryBytes(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}

export async function measureFlowchartBundle({
  installerPath,
  baselineInstallerPath,
  unpackedPath,
  baselineUnpackedPath,
} = {}) {
  const drawioBytes = await measureDirectoryBytes(resolve(ROOT, "resources", "drawio", "app"));
  const installerBytes = installerPath === undefined ? undefined : (await stat(installerPath)).size;
  const baselineInstallerBytes =
    baselineInstallerPath === undefined ? undefined : (await stat(baselineInstallerPath)).size;
  const unpackedBytes =
    unpackedPath === undefined ? undefined : await measureDirectoryBytes(unpackedPath);
  const baselineUnpackedBytes =
    baselineUnpackedPath === undefined
      ? undefined
      : await measureDirectoryBytes(baselineUnpackedPath);
  return {
    drawioBytes,
    installerBytes,
    baselineInstallerBytes,
    unpackedBytes,
    baselineUnpackedBytes,
    installerComparison:
      installerBytes === undefined || baselineInstallerBytes === undefined
        ? undefined
        : compareInstallerBytes(installerBytes, baselineInstallerBytes),
    unpackedComparison:
      unpackedBytes === undefined || baselineUnpackedBytes === undefined
        ? undefined
        : compareInstallerBytes(unpackedBytes, baselineUnpackedBytes),
    ...evaluateBundleBudgets({
      drawioBytes,
      installerBytes,
      baselineInstallerBytes,
      unpackedBytes,
      baselineUnpackedBytes,
    }),
  };
}

function readPathArgument(argv, name) {
  const flag = argv.find((argument) => argument.startsWith(`--${name}=`));
  return flag === undefined ? undefined : resolve(ROOT, flag.slice(name.length + 3));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const measurement = await measureFlowchartBundle({
      installerPath:
        readPathArgument(process.argv, "candidate-installer") ??
        readPathArgument(process.argv, "installer"),
      baselineInstallerPath: readPathArgument(process.argv, "baseline-installer"),
      unpackedPath: readPathArgument(process.argv, "candidate-unpacked"),
      baselineUnpackedPath: readPathArgument(process.argv, "baseline-unpacked"),
    });
    console.log(`draw.io resources: ${formatBytes(measurement.drawioBytes)} / 30.00 MiB`);
    console.log(`draw.io resource budget: ${measurement.drawioWithinBudget ? "PASS" : "FAIL"}`);
    if (measurement.installerBytes !== undefined) {
      console.log(
        `candidate installer (project-wide observation): ${formatBytes(measurement.installerBytes)}`,
      );
      if (measurement.installerComparison) {
        const sign = measurement.installerComparison.deltaBytes >= 0 ? "+" : "";
        console.log(
          `installer delta from baseline: ${sign}${measurement.installerComparison.deltaMiB} MiB (${sign}${measurement.installerComparison.deltaBytes.toLocaleString("en-US")} bytes)`,
        );
        console.log(
          `flowchart installer delta budget: ${measurement.installerWithinBudget ? "PASS" : "FAIL"} / 30.00 MiB`,
        );
      } else {
        console.log(
          "flowchart installer delta budget: not evaluated (baseline installer required)",
        );
      }
    } else {
      console.log(
        "installer: not measured (pass --installer=<path> after a Windows package build)",
      );
    }
    if (measurement.unpackedBytes !== undefined) {
      console.log(`candidate unpacked directory: ${formatBytes(measurement.unpackedBytes)}`);
      if (measurement.unpackedComparison) {
        const sign = measurement.unpackedComparison.deltaBytes >= 0 ? "+" : "";
        console.log(
          `unpacked delta from baseline: ${sign}${measurement.unpackedComparison.deltaMiB} MiB (${sign}${measurement.unpackedComparison.deltaBytes.toLocaleString("en-US")} bytes)`,
        );
        console.log(
          `flowchart unpacked delta budget: ${measurement.unpackedWithinBudget ? "PASS" : "FAIL"} / 50.00 MiB`,
        );
      } else {
        console.log("flowchart unpacked delta budget: not evaluated (baseline directory required)");
      }
    }
    const reportPath = readPathArgument(process.argv, "out");
    if (reportPath !== undefined) {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, renderSizeReport(measurement), "utf8");
      console.log(`size report: ${reportPath}`);
    }
    if (
      !measurement.drawioWithinBudget ||
      measurement.installerWithinBudget === false ||
      measurement.unpackedWithinBudget === false
    ) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `flowchart bundle measurement failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
