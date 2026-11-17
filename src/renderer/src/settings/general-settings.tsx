import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import type { StorageOverviewSchema } from "../../../shared/ipc/contract";
import {
  type AppSettings,
  type AppSettingsPatch,
  DEFAULT_DUAL_COLUMN_FLOW,
  type DualColumnFlow,
} from "../../../shared/settings/model";
import { MotionPresence } from "../app/motion-presence";
import { confirmAppAction } from "../shared/app-dialog";
import { SpatialPresence } from "../shared/spatial-presence";
import "./preference-pages.css";
import { DEFAULT_EDITOR_COLORS } from "../../../shared/settings/editor-colors";
import { EditorColorSettings } from "./editor-color-settings";

export type PreferenceProps = {
  preferences?: Pick<AppSettings, "uiScalePercent" | "reducedMotion" | "aiConnectionsEnabled"> &
    Partial<Pick<AppSettings, "closeToTray" | "dualColumnFlow" | "editorColors">>;
  onSavePreferences?: (patch: AppSettingsPatch) => Promise<boolean>;
};

export function GeneralSettings({
  kind,
  preferences,
  onSavePreferences,
}: PreferenceProps & { kind: "display" | "ai-connections" }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (status !== "已自动保存。") return;
    const timer = window.setTimeout(() => setStatus(""), 3000);
    return () => window.clearTimeout(timer);
  }, [status]);
  const save = async (patch: AppSettingsPatch) => {
    if (busy || !onSavePreferences) return false;
    setBusy(true);
    setStatus("");
    try {
      const saved = await onSavePreferences(patch);
      setStatus(saved ? "已自动保存。" : "保存失败，原设置未改变，请重试。");
      return saved;
    } catch {
      setStatus("保存失败，请重试。");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || !preferences || !onSavePreferences;
  const flow = preferences?.dualColumnFlow ?? DEFAULT_DUAL_COLUMN_FLOW;
  return (
    <section
      className={`settings-page settings-preferences settings-compact${kind === "display" ? " display-preferences" : " ai-connection-preferences"}`}
      aria-label={kind === "display" ? "显示偏好" : "AI 连接权限"}
    >
      <MotionPresence>
        {kind !== "display" && (busy || status) && (
          <p className="settings-save-status" role="status">
            {busy ? "正在保存…" : status}
          </p>
        )}
      </MotionPresence>
      {kind === "display" ? (
        <>
          <EditorColorSettings
            value={preferences?.editorColors ?? DEFAULT_EDITOR_COLORS}
            disabled={disabled}
            onApply={(editorColors) => save({ editorColors })}
          />
          <div className="preference-group">
            <h4>界面大小</h4>
            <div className="preference-card">
              <label className="preference-row">
                <span className="preference-copy">
                  菜单与工具栏大小<small>不影响正文和导出字号</small>
                </span>
                <select
                  aria-label="菜单与工具栏大小"
                  disabled={disabled}
                  value={preferences?.uiScalePercent ?? 100}
                  onChange={(event) => void save({ uiScalePercent: Number(event.target.value) })}
                >
                  {[85, 100, 110, 125].map((size) => (
                    <option key={size} value={size}>
                      {size}%{size === 100 ? "（默认）" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div className="preference-group display-motion-settings">
            <h4>动画与双列效果</h4>
            <div className="preference-card">
              <label className="preference-row">
                <input
                  type="checkbox"
                  aria-label="减少界面动画"
                  disabled={disabled}
                  checked={preferences?.reducedMotion ?? false}
                  onChange={(event) => void save({ reducedMotion: event.target.checked })}
                />
                <span className="preference-copy">
                  减少界面动画<small>适合偏好较少动效的用户</small>
                </span>
              </label>
            </div>
            <details className="preference-group settings-advanced-options spatial-disclosure">
              <summary>双列效果</summary>
              <div className="preference-card">
                <label className="preference-row">
                  双列衔接效果
                  <select
                    aria-label="双列衔接效果"
                    disabled={disabled}
                    value={flow.mode}
                    onChange={(event) =>
                      void save({
                        dualColumnFlow: {
                          ...flow,
                          mode: event.target.value as DualColumnFlow["mode"],
                        },
                      })
                    }
                  >
                    <option value="cable">传送盒＋电缆</option>
                    <option value="boxes">仅传送盒</option>
                    <option value="off">关闭效果</option>
                  </select>
                </label>
                <label className="preference-row">
                  传送盒风格
                  <select
                    aria-label="传送盒风格"
                    disabled={disabled || flow.mode === "off"}
                    value={flow.style}
                    onChange={(event) =>
                      void save({
                        dualColumnFlow: {
                          ...flow,
                          style: event.target.value as DualColumnFlow["style"],
                        },
                      })
                    }
                  >
                    <option value="classic">经典银色</option>
                    <option value="slim">纤薄铝合金</option>
                    <option value="ceramic">陶瓷白</option>
                    <option value="graphite">石墨灰（默认）</option>
                  </select>
                </label>
                <label className="preference-row">
                  页边特效
                  <select
                    aria-label="页边特效"
                    disabled={disabled || flow.mode === "off"}
                    value={flow.margin ?? "dust"}
                    onChange={(event) =>
                      void save({
                        dualColumnFlow: {
                          ...flow,
                          margin: event.target.value as DualColumnFlow["margin"],
                        },
                      })
                    }
                  >
                    <option value="dust">微光粒子（默认）</option>
                    <option value="threads">细光丝</option>
                    <option value="ticks">纸边刻度</option>
                    <option value="chevrons">折线流标</option>
                    <option value="none">不加特效</option>
                  </select>
                </label>
              </div>
            </details>
          </div>
          <div className="preference-footer">
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void (async () => {
                  if (
                    await confirmAppAction(
                      "恢复界面大小、配色、动画及双列衔接效果的默认设置？不会改变文档、模板或模型配置。",
                    )
                  )
                    await save({
                      uiScalePercent: 100,
                      reducedMotion: false,
                      editorColors: { ...DEFAULT_EDITOR_COLORS },
                      dualColumnFlow: { ...DEFAULT_DUAL_COLUMN_FLOW },
                    });
                })()
              }
            >
              恢复显示默认设置
            </button>
            <span className="preference-status" data-error={status.includes("失败")} role="status">
              {busy ? "保存中…" : status === "已自动保存。" ? "已保存" : status}
            </span>
          </div>
        </>
      ) : (
        <div className="preference-group">
          <h4>连接权限</h4>
          <div className="preference-card">
            <label className="preference-row">
              <input
                type="checkbox"
                aria-label="允许连接 AI 服务"
                disabled={disabled}
                checked={preferences?.aiConnectionsEnabled ?? true}
                onChange={(event) => void save({ aiConnectionsEnabled: event.target.checked })}
              />
              <span className="preference-copy">
                允许连接 AI 服务
                <small>
                  控制 AI 纠错、小栈AI助手、模型验证与模型列表读取，仅连接 DeepSeek 官方接口。
                </small>
              </span>
            </label>
          </div>
        </div>
      )}
    </section>
  );
}

export function StorageOverview() {
  const [value, setValue] = useState<z.infer<typeof StorageOverviewSchema> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [relocating, setRelocating] = useState(false);
  const [migratingBackup, setMigratingBackup] = useState(false);
  const [backupNotice, setBackupNotice] = useState("");
  const relocate = async () => {
    if (relocating) return;
    setRelocating(true);
    setError("");
    try {
      const result = await window.patentApi.application.relocateLibrary();
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("无法迁移文档库，请重试。若实例刚更新，请先重启实例。");
    } finally {
      setRelocating(false);
    }
  };
  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const result = await window.patentApi.application.storageOverview();
      if (result.ok) setValue(result.value);
      else setError(result.error.message);
    } catch {
      setError("无法读取存储信息，请重试。若开发实例刚更新，请重新打开实例。");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const changed = () => void refresh();
    window.addEventListener("backup-settings-changed", changed);
    return () => window.removeEventListener("backup-settings-changed", changed);
  }, [refresh]);
  const relocateBackup = async () => {
    if (migratingBackup || relocating) return;
    setMigratingBackup(true);
    setError("");
    setBackupNotice("");
    try {
      const settings = await window.patentApi.settings.read();
      if (!settings.ok) {
        setError(settings.error.message);
        return;
      }
      const backup = settings.value.backup;
      if (!backup.folder) {
        setError("请先在定时备份中设置备份文件夹。");
        return;
      }
      const selected = await window.patentApi.backup.selectFolder();
      if (!selected.ok) {
        setError(selected.error.message);
        return;
      }
      if (!selected.value || selected.value === backup.folder) return;
      if (
        !(await confirmAppAction(
          `将定时备份迁移到“${selected.value}”？迁移并校验完成后才删除原副本，其他文件保留不动。`,
        ))
      )
        return;
      const result = await window.patentApi.backup.configure({
        ...backup,
        folder: selected.value,
        migrateExisting: true,
        expectedSourceFolder: backup.folder,
      });
      if (!result.ok) {
        setError(
          `${result.error.message}${result.error.nextAction ? ` ${result.error.nextAction}` : ""}`,
        );
        return;
      }
      const report = result.value;
      window.dispatchEvent(
        new CustomEvent("backup-settings-changed", {
          detail: { ...backup, folder: selected.value },
        }),
      );
      setBackupNotice(
        report
          ? `已迁移 ${report.migratedCount} 个备份并切换位置。${report.skippedCount ? ` ${report.skippedCount} 个无法确认归属或损坏的文件保留在原位置。` : ""}${report.retainedSourceCount ? ` 原位置还有 ${report.retainedSourceCount} 个副本未删除。` : ""}`
          : "备份位置已更新。",
      );
    } catch {
      setError("无法迁移定时备份，请重试。");
    } finally {
      setMigratingBackup(false);
    }
  };
  const open = async (kind: "library" | "backup") => {
    try {
      const result = await window.patentApi.application.openStorageFolder(kind);
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("无法打开文件夹，请确认路径仍然可用。");
    }
  };
  return (
    <section className="settings-page settings-preferences settings-compact" aria-label="存储概览">
      {<SpatialPresence>{error ? <p role="alert">{error}</p> : null}</SpatialPresence>}
      {
        <SpatialPresence>
          {migratingBackup || backupNotice ? (
            <p role="status">
              {migratingBackup ? "正在处理备份迁移，请勿关闭软件…" : backupNotice}
            </p>
          ) : null}
        </SpatialPresence>
      }
      <div className="preference-group">
        <h4>存储位置</h4>
        <div className="preference-card">
          {value
            ? (["library", "backup"] as const).map((kind) => {
                const folder = value[kind];
                return (
                  <div className="preference-row settings-storage-row" key={kind}>
                    <span className="preference-copy">
                      {kind === "library" ? "文档库" : "定时备份"}
                      <small className="settings-storage-path">{folder.path ?? "尚未配置"}</small>
                      <small>
                        {folder.bytes === null
                          ? "暂无统计"
                          : `${folder.partial ? "已统计至少 " : "文件大小 "}${(folder.bytes / 1024 / 1024).toFixed(2)} MB`}
                        {folder.partial ? "（部分目录不可读或已达到统计上限）" : ""}
                      </small>
                    </span>
                    <div className="settings-storage-actions">
                      <button type="button" disabled={!folder.path} onClick={() => void open(kind)}>
                        打开文件夹
                      </button>
                      {kind === "library" ? (
                        <button
                          type="button"
                          disabled={!folder.path || busy || relocating || migratingBackup}
                          onClick={() => void relocate()}
                        >
                          {relocating ? "正在准备…" : "迁移文档库"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={!folder.path || busy || relocating || migratingBackup}
                          onClick={() => void relocateBackup()}
                        >
                          迁移定时备份
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            : null}
        </div>
      </div>
      <div className="settings-storage-heading">
        <p>文档库可独立存放在其他磁盘。请通过按钮迁移，不要手动移动内部文件。</p>
        <button
          type="button"
          disabled={busy || relocating || migratingBackup}
          onClick={() => void refresh()}
        >
          {busy ? "统计中…" : "刷新存储信息"}
        </button>
      </div>
    </section>
  );
}
