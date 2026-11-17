import { describe, expect, it } from "vitest";

import {
  compareInstallerBytes,
  DRAWIO_RESOURCE_BUDGET_BYTES,
  evaluateBundleBudgets,
  formatBytes,
  INSTALLER_BUDGET_BYTES,
  renderSizeReport,
  UNPACKED_BUDGET_BYTES,
} from "./measure-flowchart-bundle.mjs";

describe("flowchart bundle measurement", () => {
  it("accepts byte sizes at the approved resource and flowchart delta limits", () => {
    expect(
      evaluateBundleBudgets({
        drawioBytes: DRAWIO_RESOURCE_BUDGET_BYTES,
        installerBytes: 310_220_582,
        baselineInstallerBytes: 310_220_582 - INSTALLER_BUDGET_BYTES,
        unpackedBytes: 600_000_000,
        baselineUnpackedBytes: 600_000_000 - UNPACKED_BUDGET_BYTES,
      }),
    ).toEqual({
      drawioWithinBudget: true,
      installerWithinBudget: true,
      unpackedWithinBudget: true,
    });
  });

  it("rejects a flowchart installer delta above the approved limit", () => {
    expect(
      evaluateBundleBudgets({
        drawioBytes: DRAWIO_RESOURCE_BUDGET_BYTES + 1,
        installerBytes: 310_220_582,
        baselineInstallerBytes: 310_220_582 - INSTALLER_BUDGET_BYTES - 1,
        unpackedBytes: 600_000_000,
        baselineUnpackedBytes: 600_000_000 - UNPACKED_BUDGET_BYTES - 1,
      }),
    ).toEqual({
      drawioWithinBudget: false,
      installerWithinBudget: false,
      unpackedWithinBudget: false,
    });
  });

  it("does not treat total installer bytes as a flowchart gate without a baseline", () => {
    expect(
      evaluateBundleBudgets({
        drawioBytes: DRAWIO_RESOURCE_BUDGET_BYTES,
        installerBytes: 310_220_582,
      }),
    ).toEqual({
      drawioWithinBudget: true,
      installerWithinBudget: undefined,
      unpackedWithinBudget: undefined,
    });
  });

  it("formats binary byte measurements for a gate report", () => {
    expect(formatBytes(1_572_864)).toBe("1.50 MiB (1,572,864 bytes)");
  });

  it("reports the candidate installer delta from a genuine baseline", () => {
    expect(compareInstallerBytes(310_220_582, 301_466_841)).toEqual({
      deltaBytes: 8_753_741,
      deltaMiB: "8.35",
    });
  });

  it("renders a reproducible markdown report for all three final gates", () => {
    const report = renderSizeReport({
      drawioBytes: 23_495_550,
      installerBytes: 310_220_582,
      baselineInstallerBytes: 301_466_841,
      unpackedBytes: 700_000_000,
      baselineUnpackedBytes: 680_000_000,
      drawioWithinBudget: true,
      installerWithinBudget: true,
      unpackedWithinBudget: true,
      installerComparison: compareInstallerBytes(310_220_582, 301_466_841),
      unpackedComparison: compareInstallerBytes(700_000_000, 680_000_000),
    });

    expect(report).toContain("# 流程图功能最终体积报告");
    expect(report).toContain("基线为流程图设计提交 `02c5c49`");
    expect(report).toContain("安装包增量");
    expect(report).toContain("8.35 MiB");
    expect(report).toContain("解包目录增量");
    expect(report).toContain("19.07 MiB");
    expect(report).toContain("结论：三项体积门禁均通过");
  });
});
