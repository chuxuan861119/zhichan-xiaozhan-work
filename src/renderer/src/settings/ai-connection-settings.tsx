import { useState } from "react";
import { AI_POLICY_VERSION } from "../../../shared/ai-correction/policy";
import { MotionPresence } from "../app/motion-presence";
import { AiDataPolicyDialog } from "../shared/ai-data-policy";
import type { PreferenceProps } from "./general-settings";

export function AiConnectionSettings({ preferences, onSavePreferences }: PreferenceProps) {
  const [consentOpen, setConsentOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (enabled: boolean) => {
    if (busy || !onSavePreferences) return false;
    setBusy(true);
    setError("");
    try {
      const ok = await onSavePreferences({
        aiConnectionsEnabled: enabled,
        ...(enabled ? { aiPolicyAcceptedVersion: AI_POLICY_VERSION } : {}),
      });
      if (!ok && !enabled) setError("保存失败，原设置未改变，请重试。");
      return ok;
    } catch {
      if (!enabled) setError("保存失败，原设置未改变，请重试。");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="settings-page settings-preferences settings-compact ai-connection-preferences"
      aria-label="AI 连接权限"
    >
      <MotionPresence>{error && <p role="alert">{error}</p>}</MotionPresence>
      <div className="preference-group">
        <h4>连接权限</h4>
        <div className="preference-card">
          <label className="preference-row">
            <input
              type="checkbox"
              aria-label="允许连接 AI 服务"
              disabled={busy || !preferences || !onSavePreferences || consentOpen}
              checked={preferences?.aiConnectionsEnabled ?? false}
              onChange={(event) => {
                if (event.target.checked) setConsentOpen(true);
                else void save(false);
              }}
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
      <AiDataPolicyDialog
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        onAccept={() => save(true)}
      />
    </section>
  );
}
