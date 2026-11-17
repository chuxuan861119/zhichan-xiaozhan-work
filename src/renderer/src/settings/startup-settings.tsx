import { useEffect, useState } from "react";
import type { AppSettingsPatch } from "../../../shared/settings/model";
import type { StartupState } from "../../../shared/settings/startup";
import "./preference-pages.css";

export function StartupSettings({
  closeToTray,
  onSave,
}: {
  closeToTray: boolean;
  onSave?: (patch: AppSettingsPatch) => Promise<boolean>;
}) {
  const [startup, setStartup] = useState<StartupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let mounted = true;
    let sequence = 0;
    const refresh = async () => {
      const current = ++sequence;
      try {
        const result = await window.patentApi.application.readStartup?.();
        if (!mounted || current !== sequence) return;
        if (result?.ok) setStartup(result.value);
        else setMessage("读取失败，请重新打开设置。");
      } catch {
        if (mounted && current === sequence) setMessage("读取失败，请重新打开设置。");
      }
    };
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  const change = async (kind: "tray" | "login", enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (kind === "tray") {
        setMessage((await onSave?.({ closeToTray: enabled })) ? "已保存" : "保存失败，请重试。");
      } else {
        const result = await window.patentApi.application.updateStartup?.(enabled);
        if (result?.ok) {
          setStartup(result.value);
          setMessage(
            result.value.management === "system"
              ? "已打开系统设置，修改后返回刷新状态。"
              : "已保存",
          );
        } else setMessage("设置失败，请检查系统登录或启动项设置。");
      }
    } catch {
      setMessage("保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="settings-page settings-preferences settings-compact"
      aria-label="启动与关闭设置"
    >
      <div className="preference-group">
        <h4>启动</h4>
        <div className="preference-card">
          <div className="preference-row startup-setting-row">
            <div className="preference-copy">
              <span>开机启动</span>
              <small id="startup-login-hint">
                {startup?.unavailableReason ??
                  (startup?.management === "system"
                    ? "由鸿蒙系统管理启动权限"
                    : startup && !startup.supported
                      ? "仅安装版支持"
                      : "开机后在后台运行")}
              </small>
            </div>
            {startup?.management === "system" ? (
              <div>
                <span>{startup.enabled ? "已开启" : "未开启"}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void change("login", startup.enabled)}
                >
                  前往系统设置
                </button>
              </div>
            ) : (
              <input
                type="checkbox"
                aria-label="开机启动"
                aria-describedby="startup-login-hint"
                checked={startup?.enabled ?? false}
                disabled={busy || !startup?.supported}
                onChange={(event) => void change("login", event.target.checked)}
              />
            )}
          </div>
        </div>
      </div>
      <div className="preference-group">
        <h4>关闭</h4>
        <div className="preference-card">
          <div className="preference-row startup-setting-row">
            <div className="preference-copy">
              <span>关闭窗口时最小化到系统托盘</span>
              <small id="startup-tray-hint">右键托盘图标可退出软件</small>
            </div>
            <input
              type="checkbox"
              aria-label="关闭窗口时最小化到系统托盘"
              aria-describedby="startup-tray-hint"
              checked={closeToTray}
              disabled={busy || !onSave}
              onChange={(event) => void change("tray", event.target.checked)}
            />
          </div>
        </div>
      </div>
      <div className="preference-footer">
        <span className="preference-status" data-error={message.includes("失败")} role="status">
          {busy ? "保存中…" : message}
        </span>
      </div>
    </section>
  );
}
