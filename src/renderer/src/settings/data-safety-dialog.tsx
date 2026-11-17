import { useCallback, useEffect, useRef, useState } from "react";
import {
  BACKUP_INTERVAL_OPTIONS,
  type BackupSettings,
  BackupSettingsSchema,
  type BackupStatus,
  DEFAULT_BACKUP_SETTINGS,
} from "../../../shared/backup/model";
import type { AppError } from "../../../shared/ipc/result";
import {
  DEFAULT_SNAPSHOT_SETTINGS,
  SNAPSHOT_INTERVAL_OPTIONS,
  type SnapshotSettings,
  type SnapshotStatus,
} from "../../../shared/snapshot/model";
import { MotionPresence } from "../app/motion-presence";
import { DialogCloseIcon } from "../shared/dialog-close-icon";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { SpatialPresence } from "../shared/spatial-presence";
import { SpatialView } from "../shared/spatial-view";
import { StandardDialog } from "../shared/standard-dialog";
import { useModalDialog } from "../shared/use-modal-dialog";
import { useSettingsDraft } from "./settings-drafts";

type DataSafetyDialogProps = {
  open: boolean;
  onClose: () => void;
  embedded?: boolean;
  section?: "backup" | "snapshot";
};

export function DataSafetyDialog({
  open,
  onClose,
  embedded = false,
  section = "backup",
}: DataSafetyDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [backupSettings, setBackupSettings] = useState<BackupSettings>(DEFAULT_BACKUP_SETTINGS);
  const [savedBackup, setSavedBackup] = useState<BackupSettings>(DEFAULT_BACKUP_SETTINGS);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [snapshotSettings, setSnapshotSettings] =
    useState<SnapshotSettings>(DEFAULT_SNAPSHOT_SETTINGS);
  const [snapshotStatus, setSnapshotStatus] = useState<SnapshotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [backupStatusWarning, setBackupStatusWarning] = useState<string | null>(null);
  const [snapshotStatusWarning, setSnapshotStatusWarning] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [backupSaving, setBackupSaving] = useState(false);
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  const [folderChoiceOpen, setFolderChoiceOpen] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const migrationButtonRef = useRef<HTMLButtonElement>(null);
  const choiceResolver = useRef<((choice: boolean | null) => void) | null>(null);
  const closeSafely = () => {
    if (!backupSaving) onClose();
  };
  function resolveChoice(choice: boolean | null) {
    setFolderChoiceOpen(false);
    choiceResolver.current?.(choice);
    choiceResolver.current = null;
  }
  useEffect(
    () => () => {
      choiceResolver.current?.(null);
    },
    [],
  );

  useModalDialog({
    open: open && !embedded,
    active: true,
    onClose: closeSafely,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
  });

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setSettingsLoaded(false);
    setLoadError(null);
    setBackupStatusWarning(null);
    setSnapshotStatusWarning(null);
    setOperationError(null);
    setSuccess(null);
    try {
      const settings = await window.patentApi.settings.read();
      if (!settings.ok) {
        setLoadError(formatAppError(settings.error));
        return;
      }
      setBackupSettings(settings.value.backup);
      setSavedBackup(settings.value.backup);
      setSnapshotSettings(settings.value.snapshot);
      setSettingsLoaded(true);

      const [backupResult, snapshotResult] = await Promise.allSettled([
        section === "backup" ? window.patentApi.backup.status() : Promise.resolve(null),
        section === "snapshot" ? window.patentApi.snapshot.status() : Promise.resolve(null),
      ]);
      if (backupResult.status === "fulfilled" && backupResult.value) {
        if (backupResult.value.ok) setBackupStatus(backupResult.value.value);
        else setBackupStatusWarning(`定时备份状态：${formatAppError(backupResult.value.error)}`);
      } else if (backupResult.status === "rejected") {
        setBackupStatusWarning(`定时备份状态：${errorMessage(backupResult.reason)}`);
      }
      if (snapshotResult.status === "fulfilled" && snapshotResult.value) {
        if (snapshotResult.value.ok) setSnapshotStatus(snapshotResult.value.value);
        else
          setSnapshotStatusWarning(`自动快照状态：${formatAppError(snapshotResult.value.error)}`);
      } else if (snapshotResult.status === "rejected") {
        setSnapshotStatusWarning(`自动快照状态：${errorMessage(snapshotResult.reason)}`);
      }
    } catch (error) {
      setLoadError(`无法读取数据安全设置：${errorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [section]);

  const refreshBackupStatus = useCallback(async () => {
    try {
      const result = await window.patentApi.backup.status();
      if (result.ok) {
        setBackupStatus(result.value);
        setBackupStatusWarning(null);
      } else {
        setBackupStatusWarning(`定时备份状态：${formatAppError(result.error)}`);
      }
    } catch (error) {
      setBackupStatusWarning(`定时备份状态：${errorMessage(error)}`);
    }
  }, []);

  useEffect(() => {
    if (open) void loadSettings();
  }, [open, loadSettings]);

  useEffect(() => {
    if (section !== "backup") return;
    const changed = (event: Event) => {
      const parsed = BackupSettingsSchema.safeParse((event as CustomEvent).detail);
      if (!parsed.success) return;
      const next = parsed.data;
      setBackupSettings((draft) => ({
        ...(next.waitOnExit !== undefined || draft.waitOnExit !== undefined
          ? {
              waitOnExit:
                draft.waitOnExit === savedBackup.waitOnExit ? next.waitOnExit : draft.waitOnExit,
            }
          : {}),
        enabled: draft.enabled === savedBackup.enabled ? next.enabled : draft.enabled,
        folder: draft.folder === savedBackup.folder ? next.folder : draft.folder,
        intervalMinutes:
          draft.intervalMinutes === savedBackup.intervalMinutes
            ? next.intervalMinutes
            : draft.intervalMinutes,
      }));
      setSavedBackup(next);
    };
    window.addEventListener("backup-settings-changed", changed);
    return () => window.removeEventListener("backup-settings-changed", changed);
  }, [savedBackup, section]);

  useEffect(() => {
    if (!open || section !== "backup") return;
    const timerId = setInterval(() => void refreshBackupStatus(), 2_000);
    return () => clearInterval(timerId);
  }, [open, refreshBackupStatus, section]);

  async function saveBackupSettings() {
    if (!settingsLoaded || backupSaving) return false;
    if (backupSettings.enabled && !backupSettings.folder) {
      setOperationError("启用定时备份前，请先选择备份文件夹。");
      return false;
    }
    setBackupSaving(true);
    setOperationError(null);
    setSuccess(null);
    try {
      const latest = await window.patentApi.settings.read();
      if (!latest.ok) {
        setOperationError(formatAppError(latest.error));
        return false;
      }
      const current = latest.value.backup;
      const next = {
        ...(current.waitOnExit !== undefined || backupSettings.waitOnExit !== undefined
          ? {
              waitOnExit:
                backupSettings.waitOnExit === savedBackup.waitOnExit
                  ? current.waitOnExit
                  : backupSettings.waitOnExit,
            }
          : {}),
        enabled:
          backupSettings.enabled === savedBackup.enabled ? current.enabled : backupSettings.enabled,
        folder:
          backupSettings.folder === savedBackup.folder ? current.folder : backupSettings.folder,
        intervalMinutes:
          backupSettings.intervalMinutes === savedBackup.intervalMinutes
            ? current.intervalMinutes
            : backupSettings.intervalMinutes,
      };
      const changingFolder = Boolean(
        current.folder && next.folder && current.folder !== next.folder,
      );
      let migrateExisting = false;
      if (changingFolder) {
        const choice = await new Promise<boolean | null>((resolve) => {
          choiceResolver.current = resolve;
          setFolderChoiceOpen(true);
        });
        if (choice === null) return false;
        migrateExisting = choice;
      }
      setMigrating(migrateExisting);
      const configured = await window.patentApi.backup.configure({
        ...next,
        expectedSourceFolder: current.folder,
        ...(changingFolder ? { migrateExisting } : {}),
      });
      if (!configured.ok) {
        setOperationError(formatAppError(configured.error));
        return false;
      }
      const report = configured.value;
      setSuccess(
        report
          ? `已迁移 ${report.migratedCount} 个备份并切换位置。${report.skippedCount ? ` ${report.skippedCount} 个无法确认归属或损坏的文件保留在原位置。` : ""}${report.retainedSourceCount ? ` 原位置还有 ${report.retainedSourceCount} 个副本未删除。` : ""}`
          : "定时备份设置已保存。",
      );
      setBackupSettings(next);
      setSavedBackup(next);
      window.dispatchEvent(new CustomEvent("backup-settings-changed", { detail: next }));
      await refreshBackupStatus();
      return true;
    } catch (error) {
      setOperationError(`备份设置保存失败：${errorMessage(error)}`);
      return false;
    } finally {
      setMigrating(false);
      setBackupSaving(false);
    }
  }

  async function saveSnapshotSettings(
    nextSettings: SnapshotSettings,
    previousSettings: SnapshotSettings,
  ) {
    setSnapshotSettings(nextSettings);
    setSnapshotSaving(true);
    setOperationError(null);
    setSuccess(null);
    try {
      const configured = await window.patentApi.snapshot.configure(nextSettings);
      if (!configured.ok) {
        setSnapshotSettings(previousSettings);
        setOperationError("快照设置保存失败，请稍后重试。");
        return;
      }
      setSuccess("快照设置已保存。");
      const status = await window.patentApi.snapshot.status();
      if (status.ok) setSnapshotStatus(status.value);
      else setSnapshotStatusWarning(`自动快照状态：${formatAppError(status.error)}`);
    } catch (error) {
      setSnapshotSettings(previousSettings);
      setOperationError(`快照设置保存失败：${errorMessage(error)}`);
    } finally {
      setSnapshotSaving(false);
    }
  }

  async function selectBackupFolder() {
    setOperationError(null);
    try {
      const result = await window.patentApi.backup.selectFolder();
      if (!result.ok) {
        setOperationError(formatAppError(result.error));
      } else if (result.value) {
        setBackupSettings((previous) => ({ ...previous, folder: result.value }));
      }
    } catch (error) {
      setOperationError(`无法选择备份文件夹：${errorMessage(error)}`);
    }
  }

  const backupDirty =
    settingsLoaded &&
    (savedBackup.enabled !== backupSettings.enabled ||
      savedBackup.folder !== backupSettings.folder ||
      savedBackup.intervalMinutes !== backupSettings.intervalMinutes ||
      (savedBackup.waitOnExit ?? false) !== (backupSettings.waitOnExit ?? false));
  useSettingsDraft({
    label: "定时备份",
    dirty: section === "backup" && backupDirty,
    save: saveBackupSettings,
    discard: () => setBackupSettings(savedBackup),
  });
  if (!open) return null;
  const surfaceProps = embedded
    ? { role: "region" as const, "aria-label": "数据安全设置" }
    : {
        role: "dialog" as const,
        "aria-modal": true,
        "aria-labelledby": "data-safety-dialog-title",
      };

  return (
    <div
      className={embedded ? "data-safety-dialog--embedded settings-page" : undefined}
      style={embedded ? embeddedRootStyle : overlayStyle}
    >
      {!embedded ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={closeSafely}
          style={{ position: "absolute", inset: 0, border: 0, background: "transparent" }}
        />
      ) : null}
      <div
        ref={dialogRef}
        className={
          embedded
            ? "settings-page__card data-safety-dialog__card"
            : "data-safety-dialog__card dialog-with-standard-close"
        }
        {...surfaceProps}
        tabIndex={-1}
        style={embedded ? embeddedPanelStyle : dialogStyle}
      >
        <p className="settings-save-status">
          {section === "backup"
            ? backupDirty
              ? "定时备份有未保存修改"
              : "定时备份需点击保存"
            : "快照设置即时生效。"}
        </p>
        {!embedded ? (
          <button
            type="button"
            className="dialog-close-button dialog-close-button--corner dialog-close-control"
            aria-label="关闭数据安全设置"
            onClick={closeSafely}
          >
            <DialogCloseIcon />
          </button>
        ) : null}
        {!embedded ? (
          <h2
            id="data-safety-dialog-title"
            style={{ margin: "0 28px 16px 0", fontSize: 16, fontWeight: 600 }}
          >
            数据安全设置
          </h2>
        ) : null}

        {
          <SpatialPresence>
            {operationError ? (
              <div role="alert" style={{ color: "#b91c1c", fontSize: 13, marginBottom: 12 }}>
                {operationError}
              </div>
            ) : null}
          </SpatialPresence>
        }
        {
          <SpatialPresence>
            {success ? (
              <div role="status" style={{ color: "#166534", fontSize: 13, marginBottom: 12 }}>
                {success}
              </div>
            ) : null}
          </SpatialPresence>
        }
        {
          <SpatialPresence>
            {backupStatusWarning ? (
              <div role="alert" style={{ color: "#92400e", fontSize: 13, marginBottom: 12 }}>
                {backupStatusWarning}
              </div>
            ) : null}
          </SpatialPresence>
        }
        {
          <SpatialPresence>
            {snapshotStatusWarning ? (
              <div role="alert" style={{ color: "#92400e", fontSize: 13, marginBottom: 12 }}>
                {snapshotStatusWarning}
              </div>
            ) : null}
          </SpatialPresence>
        }

        {
          <SpatialPresence>
            {loading ? (
              <p style={{ color: "#4b5563" }}>正在读取数据安全设置…</p>
            ) : !settingsLoaded ? (
              <div>
                <p role="alert" style={{ color: "#b91c1c", fontSize: 13 }}>
                  {loadError ?? "无法读取数据安全设置。"}
                </p>
                <button
                  type="button"
                  onClick={() => void loadSettings()}
                  style={secondaryButtonStyle}
                >
                  重新读取
                </button>
              </div>
            ) : (
              <div className="data-safety-dialog__grid">
                {section === "backup" ? (
                  <section className="data-safety-dialog__section" aria-label="定时备份设置">
                    <div className="data-safety-dialog__section-header">
                      <SectionTitle>定时备份</SectionTitle>
                      <label className="data-safety-dialog__switch">
                        <input
                          type="checkbox"
                          aria-label="启用定时备份"
                          checked={backupSettings.enabled}
                          disabled={backupSaving}
                          onChange={(event) =>
                            setBackupSettings((previous) => ({
                              ...previous,
                              enabled: event.target.checked,
                            }))
                          }
                        />
                        <span className="data-safety-dialog__switch-control" aria-hidden="true" />
                      </label>
                    </div>
                    <label className="data-safety-dialog__field" style={fieldStyle}>
                      <span style={fieldLabelStyle}>备份文件夹</span>
                      <span className="data-safety-dialog__path">
                        <input
                          type="text"
                          readOnly
                          value={backupSettings.folder ?? "（未选择）"}
                          style={{ ...inputStyle, flex: 1, backgroundColor: "#f9fafb" }}
                        />
                        <button
                          type="button"
                          onClick={() => void selectBackupFolder()}
                          disabled={backupSaving}
                          style={secondaryButtonStyle}
                        >
                          选择…
                        </button>
                      </span>
                    </label>
                    <label className="data-safety-dialog__field" style={fieldStyle}>
                      <span style={fieldLabelStyle}>备份间隔</span>
                      <select
                        value={backupSettings.intervalMinutes}
                        disabled={backupSaving}
                        onChange={(event) =>
                          setBackupSettings((previous) => ({
                            ...previous,
                            intervalMinutes: Number(event.target.value),
                          }))
                        }
                        style={inputStyle}
                      >
                        {BACKUP_INTERVAL_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="data-safety-dialog__field" style={fieldStyle}>
                      <span>
                        <input
                          type="checkbox"
                          checked={backupSettings.waitOnExit === true}
                          disabled={backupSaving}
                          onChange={(event) =>
                            setBackupSettings((previous) => ({
                              ...previous,
                              waitOnExit: event.target.checked,
                            }))
                          }
                        />{" "}
                        退出前确保外部备份完成
                      </span>
                      <span className="data-safety-dialog__note">
                        默认快速退出，未完成的外部备份下次启动补齐；需要带走最新备份时开启。
                      </span>
                    </label>
                    {backupStatus ? <BackupStatusView status={backupStatus} /> : null}
                    {
                      <SpatialCollapse open={Boolean(backupSettings.enabled)}>
                        {backupSettings.enabled ? (
                          <p className="data-safety-dialog__note">
                            已保存的修改在闲置 20
                            秒或关闭专利后补齐备份；无新修改不重复备份。本地保存不受退出备份选项影响。
                          </p>
                        ) : null}
                      </SpatialCollapse>
                    }
                    <p className="data-safety-dialog__warning">
                      定时备份文件为未加密的 PATDOC，请存放在仅自己可访问的文件夹或受保护磁盘。
                    </p>
                    <div className="data-safety-dialog__backup-actions">
                      <button
                        className="settings-action-button"
                        type="button"
                        disabled={backupSaving || !backupDirty}
                        onClick={() => {
                          setBackupSettings(savedBackup);
                          setOperationError(null);
                          setSuccess(null);
                        }}
                      >
                        还原未保存修改
                      </button>
                      <button
                        className="settings-action-button is-primary"
                        type="button"
                        onClick={() => void saveBackupSettings()}
                        disabled={backupSaving}
                      >
                        {migrating
                          ? "正在迁移，请勿关闭软件…"
                          : backupSaving
                            ? "保存中…"
                            : "保存定时备份设置"}
                      </button>
                    </div>
                  </section>
                ) : null}

                {section === "snapshot" ? (
                  <section
                    className="data-safety-dialog__section snapshot-settings-section"
                    aria-label="快照版本设置"
                  >
                    <div className="data-safety-dialog__section-header">
                      <SectionTitle>自动快照</SectionTitle>
                      <label className="data-safety-dialog__switch">
                        <input
                          type="checkbox"
                          aria-label="启用自动快照"
                          checked={snapshotSettings.enabled}
                          disabled={snapshotSaving}
                          onChange={(event) =>
                            void saveSnapshotSettings(
                              { ...snapshotSettings, enabled: event.target.checked },
                              snapshotSettings,
                            )
                          }
                        />
                        <span className="data-safety-dialog__switch-control" aria-hidden="true" />
                      </label>
                    </div>
                    <p className="data-safety-dialog__note">
                      仅为已打开且有新修改的专利创建自动快照。关闭后，手动、保存及关闭时的恢复点仍可用。
                    </p>
                    <label className="data-safety-dialog__field" style={fieldStyle}>
                      <span style={fieldLabelStyle}>检查间隔</span>
                      <select
                        aria-label="自动快照检查间隔"
                        disabled={!snapshotSettings.enabled || snapshotSaving}
                        value={snapshotSettings.intervalMinutes}
                        onChange={(event) =>
                          void saveSnapshotSettings(
                            {
                              ...snapshotSettings,
                              intervalMinutes: Number(
                                event.target.value,
                              ) as SnapshotSettings["intervalMinutes"],
                            },
                            snapshotSettings,
                          )
                        }
                        style={disabledInputStyle(!snapshotSettings.enabled)}
                      >
                        {SNAPSHOT_INTERVAL_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="data-safety-dialog__retention">
                      <strong>快照保留规则</strong>
                      <dl className="settings-retention-list">
                        <div>
                          <dt>最近 1 小时</dt>
                          <dd>按检查间隔保留</dd>
                        </div>
                        <div>
                          <dt>1 小时至 24 小时</dt>
                          <dd>每小时 2 个</dd>
                        </div>
                        <div>
                          <dt>24 小时至 1 周</dt>
                          <dd>每天 2 个</dd>
                        </div>
                        <div>
                          <dt>1 周至 1 个月</dt>
                          <dd>每周 2 个</dd>
                        </div>
                        <div>
                          <dt>1 个月至 1 年</dt>
                          <dd>每月 2 个</dd>
                        </div>
                        <div>
                          <dt>超过 1 年</dt>
                          <dd>每年 2 个</dd>
                        </div>
                      </dl>
                      <p>各时段保留最新的版本，必要的有效恢复点会额外保留。</p>
                    </div>
                    {snapshotSaving ? (
                      <div role="status" style={{ fontSize: 12, color: "#4b5563", marginTop: 8 }}>
                        快照设置保存中…
                      </div>
                    ) : null}
                    {snapshotStatus ? <SnapshotStatusView status={snapshotStatus} /> : null}
                  </section>
                ) : null}
              </div>
            )}
          </SpatialPresence>
        }

        {!embedded ? (
          <div style={{ marginTop: 20, textAlign: "right" }}>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeSafely}
              style={secondaryButtonStyle}
            >
              关闭
            </button>
          </div>
        ) : null}
      </div>
      <MotionPresence>
        {folderChoiceOpen ? (
          <StandardDialog
            open
            title="切换备份文件夹"
            size="s"
            onCancel={() => resolveChoice(null)}
            initialFocusRef={migrationButtonRef}
            footer={
              <>
                <button
                  type="button"
                  className="settings-action-button"
                  onClick={() => resolveChoice(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="settings-action-button"
                  onClick={() => resolveChoice(false)}
                >
                  仅切换位置
                </button>
                <button
                  ref={migrationButtonRef}
                  type="button"
                  className="settings-action-button is-primary"
                  onClick={() => resolveChoice(true)}
                >
                  迁移备份并切换
                </button>
              </>
            }
          >
            <p>是否将原位置的备份一起迁移？</p>
            <p>迁移完成并校验后才删除原副本。其他文件保留不动；仅切换位置则保留全部旧备份。</p>
          </StandardDialog>
        ) : null}
      </MotionPresence>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="data-safety-dialog__section-title">{children}</h3>;
}

function BackupStatusView({ status }: { status: BackupStatus }) {
  return (
    <SpatialView viewKey={JSON.stringify(status)}>
      <div
        className={`data-safety-dialog__status${status.lastError ? " is-error" : ""}`}
        aria-live="polite"
      >
        <div>
          {status.lastBackupAt ? `上次成功：${formatTime(status.lastBackupAt)}` : "尚无成功备份"}
        </div>
        {status.lastAttemptAt ? <div>上次尝试：{formatTime(status.lastAttemptAt)}</div> : null}
        {status.lastAttemptAt ? (
          <div>
            {`本轮写入成功：${status.lastRunSuccessCount}；待处理失败：${status.lastRunFailureCount}`}
          </div>
        ) : null}
        {status.nextBackupAt ? <div>下次备份：{formatTime(status.nextBackupAt)}</div> : null}
        {status.lastError ? <div>失败原因: {status.lastError}</div> : null}
      </div>
    </SpatialView>
  );
}

function SnapshotStatusView({ status }: { status: SnapshotStatus }) {
  return (
    <SpatialView viewKey={JSON.stringify(status)}>
      <div
        className={`data-safety-dialog__status${status.lastError ? " is-error" : ""}`}
        aria-live="polite"
      >
        <div>自动快照：{status.enabled ? "已启用" : "已关闭"}</div>
        <div>{status.lastCheckAt ? `上次检查：${formatTime(status.lastCheckAt)}` : "尚未检查"}</div>
        <div>
          {status.lastAutomaticSnapshotAt
            ? `上次成功快照：${formatTime(status.lastAutomaticSnapshotAt)}`
            : "尚无成功快照"}
        </div>
        {status.nextCheckAt ? <div>下次检查：{formatTime(status.nextCheckAt)}</div> : null}
        {status.lastError ? <div>失败原因：{status.lastError}</div> : null}
      </div>
    </SpatialView>
  );
}

function formatAppError(error: AppError): string {
  return `${error.message}${error.nextAction ? ` ${error.nextAction}` : ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN");
}

const overlayStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  backgroundColor: "rgba(0,0,0,0.3)",
} as const;
const embeddedRootStyle = { position: "relative", width: "100%" } as const;
const dialogStyle = {
  position: "relative",
  backgroundColor: "#fff",
  border: "1px solid #cbd5e1",
  borderRadius: 12,
  boxShadow: "0 12px 36px rgb(15 23 42 / 16%)",
  fontSize: 14,
  lineHeight: 1.6,
  width: "min(520px, calc(100vw - 32px))",
  maxHeight: "calc(100vh - 32px)",
  overflow: "auto",
  padding: 20,
} as const;
const embeddedPanelStyle = { position: "relative", width: "100%" } as const;
const fieldStyle = { display: "block", marginBottom: 12 } as const;
const fieldLabelStyle = {
  display: "block",
  fontSize: 13,
  color: "#4b5563",
  marginBottom: 4,
} as const;
const inputStyle = {
  padding: "5px 8px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  fontSize: 13,
} as const;
const secondaryButtonStyle = {
  padding: "6px 14px",
  border: "1px solid #c7cdd4",
  borderRadius: 4,
  backgroundColor: "#fff",
  color: "#374151",
  cursor: "pointer",
  fontSize: 13,
} as const;

function disabledInputStyle(disabled: boolean) {
  return {
    ...inputStyle,
    color: disabled ? "#9ca3af" : "#111827",
    backgroundColor: disabled ? "#f3f4f6" : "#fff",
    cursor: disabled ? "not-allowed" : "default",
  };
}
