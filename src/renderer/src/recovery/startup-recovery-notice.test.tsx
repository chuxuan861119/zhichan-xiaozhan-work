import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { StartupRecoveryReport } from "../../../shared/recovery/startup-recovery";
import { StartupRecoveryNotice, shouldShowStartupRecoveryNotice } from "./startup-recovery-notice";

const baseReport: StartupRecoveryReport = {
  previousShutdown: "unclean",
  mode: "read-write",
  replayedEditCount: 3,
  recoveredPatentCount: 1,
  quarantinedPatentCount: 0,
  backupCreated: false,
  checkedAt: "2026-08-11T00:00:00.000Z",
};

describe("startup recovery notice", () => {
  test("explains unfinished asset isolation and the read-only safety boundary", () => {
    render(
      <StartupRecoveryNotice
        report={{ ...baseReport, mode: "read-only", assetIsolationPending: true }}
        onDismiss={vi.fn()}
        onOpenDataSafety={vi.fn()}
      />,
    );
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toContain("资源独立保存尚未完成");
    expect(text).toContain("原数据已保留");
    expect(text).toContain("只读保护模式");
    expect(text).toContain("查看和导出");
  });
  test("offers snapshot and backup recovery directly for quarantined patents", () => {
    const snapshots = vi.fn();
    const backups = vi.fn();
    render(
      <StartupRecoveryNotice
        report={{ ...baseReport, quarantinedPatentCount: 1 }}
        onDismiss={vi.fn()}
        onOpenDataSafety={vi.fn()}
        onOpenSnapshots={snapshots}
        onOpenBackups={backups}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看快照" }));
    fireEvent.click(screen.getByRole("button", { name: "从备份恢复" }));
    expect(snapshots).toHaveBeenCalledOnce();
    expect(backups).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert").textContent).not.toContain("技术支持");
  });

  test.each([
    "incomplete-library",
    "invalid-library-root",
    "backup-failed",
    "migration-failed",
    "unknown",
  ] as const)(
    "distinguishes initialization failure from integrity failures (%s)",
    (libraryInitializationFailure) => {
      render(
        <StartupRecoveryNotice
          report={{
            ...baseReport,
            mode: "read-only",
            recoverySourcesUnavailable: true,
            libraryInitializationFailure,
          }}
          onDismiss={vi.fn()}
          onOpenDataSafety={vi.fn()}
        />,
      );
      const notice = screen.getByRole("alert");
      expect(notice.querySelector("h2")?.textContent).toBe("专利库初始化失败");
      expect(notice.textContent).not.toContain("完整性检查未能安全完成");
      expect(notice.textContent).not.toContain("数据损坏");
      if (libraryInitializationFailure === "incomplete-library")
        expect(notice.textContent).toContain("缺少数据库文件");
    },
  );
  test("keeps a separate warning when library validation did not pass", () => {
    render(
      <StartupRecoveryNotice
        report={{
          ...baseReport,
          mode: "read-only",
          recoverySourcesUnavailable: true,
          libraryInitializationFailure: "validation-failed",
        }}
        onDismiss={vi.fn()}
        onOpenDataSafety={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("文档库校验未通过");
    expect(screen.getByRole("alert").querySelector("h2")?.textContent).toBe("文档库校验需要处理");
  });

  test("does not offer unavailable snapshots after a failed source initialization", () => {
    render(
      <StartupRecoveryNotice
        report={{ ...baseReport, mode: "read-only", recoverySourcesUnavailable: true }}
        onDismiss={vi.fn()}
        onOpenDataSafety={vi.fn()}
        onOpenSnapshots={vi.fn()}
        onOpenBackups={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "查看快照" })).toBeNull();
    expect(screen.getByRole("button", { name: "从备份恢复" })).toBeDefined();
  });
  test.each(["first-run", "clean", "unclean", "unknown"] as const)(
    "stays silent after a healthy recovery check (%s)",
    (previousShutdown) => {
      expect(
        shouldShowStartupRecoveryNotice({
          ...baseReport,
          previousShutdown,
          replayedEditCount: 0,
          recoveredPatentCount: 0,
        }),
      ).toBe(false);
    },
  );

  test("stays silent when automatic recovery succeeded without unresolved problems", () => {
    expect(shouldShowStartupRecoveryNotice(baseReport)).toBe(false);
  });

  test.each([
    { mode: "read-only" as const },
    { quarantinedPatentCount: 1 },
    { historyCleanupPendingCount: 1 },
  ])("retains warnings for unresolved recovery problems: %j", (problem) => {
    expect(shouldShowStartupRecoveryNotice({ ...baseReport, ...problem })).toBe(true);
  });

  test("shows a cleanup warning after a clean exit without blocking normal documents", () => {
    const report = {
      ...baseReport,
      previousShutdown: "clean" as const,
      historyCleanupPendingCount: 1,
    };
    expect(shouldShowStartupRecoveryNotice(report)).toBe(true);
    render(
      <StartupRecoveryNotice report={report} onDismiss={vi.fn()} onOpenDataSafety={vi.fn()} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("小栈AI助手历史尚未清理");
    expect(screen.getByRole("alert").textContent).toContain("下次启动时重试");
    expect(screen.getByRole("button", { name: "知道了" })).toBeDefined();
  });
  test("shows a reassuring recovery result after an unclean shutdown", () => {
    const onDismiss = vi.fn();
    render(
      <StartupRecoveryNotice
        report={baseReport}
        onDismiss={onDismiss}
        onOpenDataSafety={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("已恢复 3 项编辑");
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test("keeps a blocking recovery problem visible and links to data safety", () => {
    const onOpenDataSafety = vi.fn();
    render(
      <StartupRecoveryNotice
        report={{ ...baseReport, mode: "read-only", quarantinedPatentCount: 1 }}
        onDismiss={vi.fn()}
        onOpenDataSafety={onOpenDataSafety}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("只读保护模式");
    expect(screen.queryByRole("button", { name: "知道了" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看数据安全" }));
    expect(onOpenDataSafety).toHaveBeenCalledOnce();
  });

  test("does not describe a plaintext library failure as an encryption-service problem", () => {
    render(
      <StartupRecoveryNotice
        report={{ ...baseReport, previousShutdown: "first-run", mode: "read-only" }}
        onDismiss={vi.fn()}
        onOpenDataSafety={vi.fn()}
      />,
    );

    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toContain("本地专利库");
    expect(text).not.toContain("加密服务");
    expect(text).not.toContain("Windows");
  });

  test("does not offer a notice after a normal exit", () => {
    expect(shouldShowStartupRecoveryNotice({ ...baseReport, previousShutdown: "clean" })).toBe(
      false,
    );
  });
});
