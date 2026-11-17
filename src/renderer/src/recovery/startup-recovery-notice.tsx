import type {
  LibraryInitializationFailure,
  StartupRecoveryReport,
} from "../../../shared/recovery/startup-recovery";

type StartupRecoveryNoticeProps = {
  report: StartupRecoveryReport;
  onDismiss(): void;
  onOpenDataSafety(): void;
  onOpenSnapshots?(): void;
  onOpenBackups?(): void;
};

export function shouldShowStartupRecoveryNotice(report: StartupRecoveryReport): boolean {
  return (
    report.mode === "read-only" ||
    report.quarantinedPatentCount > 0 ||
    (report.historyCleanupPendingCount ?? 0) > 0
  );
}

const initializationMessages: Record<LibraryInitializationFailure, string> = {
  "incomplete-library":
    "文档库缺少数据库文件，暂时无法打开。原目录已保留。请选择完整的文档库，或从已有备份恢复到新的文档库；请勿删除原目录。",
  "invalid-library-root":
    "无法安全访问文档库目录，初始化未能完成。请检查目录位置及访问权限，并保留原目录。",
  "backup-failed":
    "文档库升级前的安全备份未能完成，已暂停初始化。请检查磁盘空间及访问权限，然后重新启动；原目录已保留。",
  "migration-failed":
    "文档库升级未能完成，已暂停打开。请保留原目录，检查磁盘空间及访问权限；如仍无法打开，可从已有备份恢复到新的文档库。",
  "validation-failed":
    "文档库校验未通过，暂时无法打开。请保留原目录，并从可用备份恢复到新的文档库；请勿继续修改原库文件。",
  unknown:
    "专利库初始化未能完成，暂时无法打开。请检查文档库的位置、磁盘空间及访问权限；如仍无法打开，可从已有备份恢复到新的文档库。原目录已保留。",
};

function recoveryMessage(report: StartupRecoveryReport): string {
  if (report.libraryInitializationFailure)
    return initializationMessages[report.libraryInitializationFailure];
  if (report.assetIsolationPending) {
    return "旧专利的资源独立保存尚未完成，原数据已保留，专利库已进入只读保护模式。可查看和导出可用专利，暂不能编辑或导入。请检查磁盘空间和存储权限后重新启动；如仍无法完成，请通过快照或 PATDOC 备份创建恢复副本。";
  }
  if (report.previousShutdown === "first-run" && report.mode === "read-only") {
    return "本地专利库暂时无法安全初始化，已进入只读保护模式。请从已有 PATDOC 备份恢复到新的文档库，原库将保留。";
  }
  if (report.mode === "read-only") {
    return "数据完整性检查未能安全完成，专利库已进入只读保护模式。请优先查看快照，或从定时备份恢复到新的文档库，原库将保留。";
  }
  if (report.quarantinedPatentCount > 0) {
    return `有 ${report.quarantinedPatentCount} 件专利需要进一步恢复处理，请先查看快照，或从定时备份创建恢复副本，其他可用数据不受影响。`;
  }
  if (report.replayedEditCount > 0) {
    return `检测到上次未正常退出，已恢复 ${report.replayedEditCount} 项编辑，并恢复到最后确认保存状态。`;
  }
  return "检测到上次未正常退出。完整性检查已经完成，未发现待恢复编辑，现有文档可以继续使用。";
}

export function StartupRecoveryNotice({
  report,
  onDismiss,
  onOpenDataSafety,
  onOpenSnapshots,
  onOpenBackups,
}: StartupRecoveryNoticeProps) {
  const requiresAction = report.mode === "read-only" || report.quarantinedPatentCount > 0;
  const cleanupPending = (report.historyCleanupPendingCount ?? 0) > 0;
  const warning = requiresAction || cleanupPending;
  return (
    <section
      className={`startup-recovery-notice${warning ? " is-warning" : ""}`}
      role={warning ? "alert" : "status"}
      aria-label="启动恢复状态"
    >
      <div>
        <h2>
          {report.libraryInitializationFailure === "validation-failed"
            ? "文档库校验需要处理"
            : report.libraryInitializationFailure
              ? "专利库初始化失败"
              : requiresAction
                ? "数据恢复需要处理"
                : cleanupPending
                  ? "历史清理尚未完成"
                  : "文档恢复检查完成"}
        </h2>
        {requiresAction || !cleanupPending || report.previousShutdown === "unclean" ? (
          <p>{recoveryMessage(report)}</p>
        ) : null}
        {cleanupPending ? (
          <p>
            有 {report.historyCleanupPendingCount}{" "}
            件已删除专利的小栈AI助手历史尚未清理。待清理记录已保留，将在下次启动时重试；其他文档可以继续使用。
          </p>
        ) : null}
      </div>
      <div className="startup-recovery-notice__actions">
        {requiresAction && onOpenSnapshots && !report.recoverySourcesUnavailable ? (
          <button type="button" className="primary-button" onClick={onOpenSnapshots}>
            查看快照
          </button>
        ) : null}
        {requiresAction && onOpenBackups ? (
          <button type="button" onClick={onOpenBackups}>
            从备份恢复
          </button>
        ) : null}
        <button type="button" onClick={onOpenDataSafety}>
          查看数据安全
        </button>
        {requiresAction ? null : (
          <button type="button" className="primary-button" onClick={onDismiss}>
            知道了
          </button>
        )}
      </div>
    </section>
  );
}
