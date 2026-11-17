import { ArrowUpRight, Check, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppSettingsPatch } from "../../../shared/settings/model";
import { UPDATE_RECOMMENDATION } from "../../../shared/updates/model";
import { openSoftwareUpdates, useSoftwareUpdates } from "./use-software-updates";
import "../settings/preference-pages.css";
import "./software-updates.css";

export function SoftwareUpdateSettings({
  enabled,
  onSave,
}: {
  enabled: boolean;
  onSave?: (patch: AppSettingsPatch) => Promise<boolean>;
}) {
  const { state, check, supported } = useSoftwareUpdates();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [checked, setChecked] = useState(enabled);
  useEffect(() => setChecked(enabled), [enabled]);
  const toggle = async (next: boolean) => {
    if (!onSave || busy) return;
    const previous = checked;
    setChecked(next);
    setBusy(true);
    setMessage("");
    try {
      if (await onSave({ autoCheckUpdates: next })) {
        setChecked(next);
        setMessage(next ? "自动检测已开启" : "自动检测已关闭，仍可手动检查更新");
      } else {
        setChecked(previous);
        setMessage("保存失败，请重试。");
      }
    } catch {
      setChecked(previous);
      setMessage("保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const checking = state.status === "checking";
  return (
    <section
      className="settings-page settings-preferences settings-compact software-update-settings"
      aria-label="软件更新设置"
    >
      <div className="update-version-card">
        <div className="update-version-card__icon" aria-hidden="true">
          <Sparkles size={24} />
        </div>
        <div className="update-version-card__heading">
          <span>知产小栈Work</span>
          <h3>持续完善，安心创作</h3>
          <p>
            当前版本 {state.currentVersion}{" "}
            <span className="update-channel-badge">
              {state.channel === "preview" ? "预览通道" : "稳定通道"}
            </span>
          </p>
        </div>
        <div
          className="update-version-card__status"
          role="status"
          aria-live="polite"
          data-status={state.status}
        >
          {state.status === "latest" ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <RefreshCw
              size={16}
              className={checking ? "update-check-spinner" : ""}
              aria-hidden="true"
            />
          )}
          <span>{state.message}</span>
        </div>
        <div className="update-version-card__actions">
          <small>
            {state.lastCheckedAt
              ? `上次成功检查：${new Date(state.lastCheckedAt).toLocaleString("zh-CN", { hour12: false })}`
              : "检查更新不会影响本地文档"}
          </small>
          <div>
            {state.release && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => openSoftwareUpdates(false)}
              >
                查看新版本 <ArrowUpRight size={14} />
              </button>
            )}
            <button
              className="primary-button"
              type="button"
              disabled={checking || busy || !supported}
              onClick={() => void check()}
            >
              {checking ? "正在检查…" : "检查更新"}
            </button>
          </div>
        </div>
      </div>
      <div className="preference-group">
        <h4>更新检测</h4>
        <div className="preference-card">
          <div className="preference-row">
            <div className="preference-copy">
              <span>自动检查新版本</span>
              <small id="update-toggle-hint">{UPDATE_RECOMMENDATION}</small>
            </div>
            <label className="update-toggle">
              <input
                type="checkbox"
                aria-label="自动检查新版本"
                aria-describedby="update-toggle-hint"
                checked={checked}
                disabled={busy || !onSave || !supported}
                onChange={(event) => void toggle(event.target.checked)}
              />
              <span aria-hidden="true" />
            </label>
          </div>
          {!checked && (
            <p className="update-disabled-hint">
              已关闭后台检测。您仍可点击“检查更新”获取新版本信息。
            </p>
          )}
        </div>
        <span className="preference-status" role="status">
          {busy ? "保存中…" : message}
        </span>
      </div>
    </section>
  );
}
