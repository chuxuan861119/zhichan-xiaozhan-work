import { useEffect, useRef, useState } from "react";
import {
  AI_PROVIDER_PRESETS,
  type AiCorrectionSettings,
  AiCorrectionSettingsSchema,
  type AiModelProfile,
  type AiProviderId,
  DEFAULT_AI_CORRECTION_SETTINGS,
} from "../../../shared/ai-correction/model";
import { createSettingsId } from "../../../shared/settings/model";
import { MotionPresence } from "../app/motion-presence";
import { AiDataPolicy } from "../shared/ai-data-policy";
import { confirmAppAction } from "../shared/app-dialog";
import { DialogCloseIcon } from "../shared/dialog-close-icon";
import { SpatialPresence } from "../shared/spatial-presence";
import { useSpatialViewMotion } from "../shared/use-spatial-view-motion";
import { useSettingsDraft } from "./settings-drafts";

export type AiModelEditorState = AiModelProfile & { apiKey: string; isNew: boolean };

function presetFor(providerId: AiProviderId) {
  return AI_PROVIDER_PRESETS.find((preset) => preset.providerId === providerId);
}

function newEditor(): AiModelEditorState {
  const preset = AI_PROVIDER_PRESETS[0];
  const model = preset.models[0];
  return {
    profileId: createSettingsId(),
    providerId: preset.providerId,
    displayName: `${preset.label.split(" /")[0]} · ${model.label}`,
    baseUrl: preset.baseUrl,
    model: model.id,
    apiKey: "",
    isNew: true,
  };
}

export function AiCorrectionSettingsDialog({
  open,
  embedded = false,
  mode = "models",
  onClose,
  onSettingsChanged = () => undefined,
  onOpenModelEditor,
  onBack,
}: {
  open: boolean;
  embedded?: boolean;
  mode?: "models" | "editor";
  onClose(): void;
  onSettingsChanged?(): void;
  onOpenModelEditor?(isNew: boolean): void;
  onBack?(): void;
}) {
  const [settings, setSettings] = useState<AiCorrectionSettings>(() =>
    structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
  );
  const [credentialProfileIds, setCredentialProfileIds] = useState<string[]>([]);
  const [credentialStatusUnknown, setCredentialStatusUnknown] = useState(false);
  const [editor, setEditor] = useState<AiModelEditorState | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 4000);
    return () => window.clearTimeout(timer);
  }, [message]);
  const [error, setError] = useState<string | null>(null);
  const [savedSettings, setSavedSettings] = useState(settings);
  const [savedEditor, setSavedEditor] = useState<AiModelEditorState | null>(null);

  useEffect(() => {
    if (!open) return;
    setEditor(null);
    setDiscoveredModels([]);
    setDiscoveringModels(false);
    setMessage(null);
    setError(null);
    void window.patentApi.aiCorrection.getSettings().then((result) => {
      if (!result.ok) return setError(result.error.message);
      const supported = AiCorrectionSettingsSchema.parse(result.value.settings);
      setSettings(supported);
      setSavedSettings(supported);
      setCredentialProfileIds(result.value.credentialProfileIds);
      setCredentialStatusUnknown(result.value.credentialStatusUnknown ?? false);
    });
  }, [open]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI 设置操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const applyState = (
    state: {
      settings: AiCorrectionSettings;
      credentialProfileIds: string[];
      credentialStatusUnknown?: boolean | undefined;
    },
    preserveGeneral = false,
  ) => {
    setSettings(
      preserveGeneral && generalDirty
        ? {
            ...state.settings,
            timeoutMs: settings.timeoutMs,
            maxUploadCharacters: settings.maxUploadCharacters,
          }
        : state.settings,
    );
    setSavedSettings(state.settings);
    setCredentialProfileIds(state.credentialProfileIds);
    setCredentialStatusUnknown(state.credentialStatusUnknown ?? false);
  };

  const saveEditor = async (resetUnavailable = false) => {
    if (!editor) return;
    const wasNew = editor.isNew;
    const preset = presetFor(editor.providerId);
    const modelLabel = preset?.models.find((model) => model.id === editor.model)?.label;
    const profile: AiModelProfile = {
      profileId: editor.profileId,
      providerId: "deepseek",
      displayName: `${preset?.label.split(" /")[0]} · ${modelLabel ?? editor.model}`,
      baseUrl: preset?.baseUrl ?? editor.baseUrl.trim(),
      model: editor.model.trim(),
    };
    if (!profile.displayName || !profile.baseUrl || !profile.model) {
      throw new Error("请选择有效的 DeepSeek 模型。");
    }
    if (editor.isNew && !editor.apiKey.trim()) {
      throw new Error("请输入 API Key。");
    }
    const profiles = editor.isNew
      ? [...settings.profiles, profile]
      : settings.profiles.map((candidate) =>
          candidate.profileId === profile.profileId ? profile : candidate,
        );
    const updated = await window.patentApi.aiCorrection.updateSettings({
      ...settings,
      profiles,
      activeProfileId: settings.activeProfileId ?? profile.profileId,
    });
    if (!updated.ok) throw new Error(updated.error.message);
    applyState(updated.value);
    onSettingsChanged();
    if (wasNew) setEditor({ ...editor, isNew: false });
    if (editor.apiKey.trim()) {
      const keyed = await window.patentApi.aiCorrection.setApiKey({
        profileId: profile.profileId,
        apiKey: editor.apiKey,
        ...(resetUnavailable ? { resetUnavailable: true } : {}),
      });
      if (!keyed.ok) throw new Error(keyed.error.message);
      applyState(keyed.value);
      onSettingsChanged();
    }
    if (embedded && onBack) {
      setEditor(null);
      onBack();
      return;
    }
    setEditor(null);
    setSavedEditor(null);
    setMessage(wasNew ? "模型已添加。" : "模型配置已更新。");
  };

  const closeEditor = async () => {
    if (editorDirty && !(await confirmAppAction("放弃此模型尚未保存的修改？"))) return;
    setEditor(null);
    setSavedEditor(null);
    if (embedded && onBack) {
      onBack();
      return;
    }
    setEditor(null);
  };

  const startEditing = async (nextEditor: AiModelEditorState) => {
    if (
      editorDirty &&
      editor?.profileId !== nextEditor.profileId &&
      !(await confirmAppAction("放弃当前模型尚未保存的修改并切换？"))
    )
      return;
    setEditor(nextEditor);
    if (editor?.profileId !== nextEditor.profileId) setSavedEditor(nextEditor);
    if (embedded && onOpenModelEditor) onOpenModelEditor(nextEditor.isNew);
  };

  const discoverEditorModels = async () => {
    if (!editor) return;
    const preset = presetFor(editor.providerId);
    const baseUrl = preset?.baseUrl ?? editor.baseUrl.trim();
    if (!baseUrl) throw new Error("请先填写服务地址。");
    if (!editor.apiKey.trim()) {
      throw new Error("请先输入 API Key。");
    }
    const result = await window.patentApi.aiCorrection.discoverModels({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: editor.apiKey,
    });
    if (!result.ok) throw new Error(result.error.message);
    setDiscoveredModels(result.value.models);
    if (result.value.models.length > 0 && !result.value.models.includes(editor.model)) {
      setEditor({ ...editor, model: result.value.models[0] ?? editor.model });
    }
    setMessage(`连接验证成功，已读取 ${result.value.models.length} 个可用模型。`);
  };

  const runModelDiscovery = async () => {
    setDiscoveringModels(true);
    try {
      await run(discoverEditorModels);
    } finally {
      setDiscoveringModels(false);
    }
  };

  const saveGeneralSettings = async (nextSettings: AiCorrectionSettings) => {
    const result = await window.patentApi.aiCorrection.updateSettings(nextSettings);
    if (!result.ok) throw new Error(result.error.message);
    applyState(result.value);
    onSettingsChanged();
    setMessage("模型连接设置已保存。");
  };

  const removeProfile = async (profile: AiModelProfile) => {
    if (!(await confirmAppAction(`确定删除“${profile.displayName}”吗？`))) return;
    const profiles = settings.profiles.filter(
      (candidate) => candidate.profileId !== profile.profileId,
    );
    const activeProfileId =
      settings.activeProfileId === profile.profileId
        ? (profiles[0]?.profileId ?? null)
        : settings.activeProfileId;
    if (credentialProfileIds.includes(profile.profileId)) {
      const cleared = await window.patentApi.aiCorrection.clearApiKey({
        profileId: profile.profileId,
      });
      if (!cleared.ok) throw new Error(cleared.error.message);
      applyState(cleared.value, true);
      onSettingsChanged();
    }
    const updated = await window.patentApi.aiCorrection.updateSettings({
      ...savedSettings,
      enabled: profiles.length === 0 ? false : settings.enabled,
      profiles,
      activeProfileId,
    });
    if (!updated.ok) throw new Error(updated.error.message);
    applyState(updated.value, true);
    onSettingsChanged();
    setMessage("模型已删除。");
  };

  const editorDirty = editor !== null && JSON.stringify(editor) !== JSON.stringify(savedEditor);
  const generalDirty =
    settings.timeoutMs !== savedSettings.timeoutMs ||
    settings.maxUploadCharacters !== savedSettings.maxUploadCharacters;
  useSettingsDraft({
    label: "AI 模型",
    dirty: editorDirty || generalDirty,
    save: async () => {
      if (busy) return false;
      setBusy(true);
      try {
        if (editorDirty) await saveEditor();
        else if (generalDirty) await saveGeneralSettings(settings);
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "保存失败");
        return false;
      } finally {
        setBusy(false);
      }
    },
    discard: () => {
      setEditor(null);
      setSavedEditor(null);
      setSettings(savedSettings);
    },
  });
  const editorStage = useRef<HTMLDivElement>(null);
  useSpatialViewMotion(editorStage, editor?.providerId ?? "closed");
  if (!open) return null;

  const containerAccessibility = embedded
    ? {
        role: "region" as const,
        "aria-label": mode === "editor" ? (editor?.isNew ? "添加新模型" : "编辑模型") : "AI 设置",
      }
    : { role: "dialog" as const, "aria-modal": true, "aria-label": "AI 设置" };
  const editorAccessibility = embedded
    ? {}
    : {
        role: "dialog" as const,
        "aria-modal": true,
        "aria-label": editor?.isNew ? "添加模型" : "编辑模型",
      };
  const openNewModelEditor = () => {
    setDiscoveredModels([]);
    setDiscoveringModels(false);
    setMessage(null);
    setError(null);
    startEditing(embedded && editor?.isNew ? editor : newEditor());
  };

  return (
    <div
      className={embedded ? "ai-settings-workspace-panel" : "ai-settings-overlay"}
      {...containerAccessibility}
    >
      {!embedded ? (
        <button
          className="ai-settings-overlay__backdrop"
          type="button"
          aria-label="关闭 AI 设置"
          onClick={onClose}
        />
      ) : null}
      <section
        className={
          embedded
            ? "ai-model-manager ai-model-manager--embedded"
            : "ai-settings-dialog ai-model-manager"
        }
        hidden={mode === "editor"}
      >
        {!embedded ? (
          <header>
            <div>
              <span className="ai-kicker">智能辅助</span>
              <h2>AI 模型管理</h2>
            </div>
            <button
              type="button"
              className="ai-icon-button dialog-close-button dialog-close-control"
              aria-label="关闭"
              onClick={onClose}
            >
              <DialogCloseIcon />
            </button>
          </header>
        ) : null}

        <div className="ai-model-manager__section-heading">
          <div>
            <h3>已添加的模型</h3>
          </div>
          {settings.profiles.length > 0 ? (
            <button
              type="button"
              className="is-primary"
              aria-label="添加模型"
              onClick={openNewModelEditor}
            >
              ＋ 添加模型
            </button>
          ) : null}
        </div>
        <div className="ai-model-list">
          {settings.profiles.length === 0 ? (
            <div className="ai-model-empty">
              <span>AI</span>
              <strong>还没有可用模型</strong>
              <p>仅支持 DeepSeek 官方接口，填写您自己的 API Key 后使用。</p>
              <button
                type="button"
                className="is-primary"
                aria-label="添加模型"
                onClick={openNewModelEditor}
              >
                ＋ 添加模型
              </button>
            </div>
          ) : (
            settings.profiles.map((profile) => {
              const preset = presetFor(profile.providerId);
              const hasCredential = credentialProfileIds.includes(profile.profileId);
              const isDefault = settings.activeProfileId === profile.profileId;
              return (
                <article
                  className={`ai-model-card${isDefault ? " is-default" : ""}`}
                  key={profile.profileId}
                >
                  <div className="ai-model-card__brand">{preset?.label.slice(0, 1) ?? "自"}</div>
                  <div className="ai-model-card__body">
                    <div>
                      <strong>{profile.displayName}</strong>
                      {isDefault ? <span className="ai-model-badge">默认</span> : null}
                    </div>
                    <code>{profile.model}</code>
                    <span
                      className={
                        hasCredential || profile.providerId === "ollama" ? "is-ready" : "is-warning"
                      }
                    >
                      {profile.providerId === "ollama"
                        ? "本机服务，无需 API Key"
                        : hasCredential
                          ? "API Key 已安全保存"
                          : credentialStatusUnknown
                            ? "旧版加密密钥，使用时验证"
                            : "尚未配置 API Key"}
                    </span>
                  </div>
                  <div className="ai-model-card__actions">
                    {!isDefault ? (
                      <button
                        type="button"
                        onClick={() =>
                          void run(async () => {
                            const result = await window.patentApi.aiCorrection.updateSettings({
                              ...savedSettings,
                              activeProfileId: profile.profileId,
                            });
                            if (!result.ok) throw new Error(result.error.message);
                            applyState(result.value, true);
                            onSettingsChanged();
                            setMessage("默认模型已切换。");
                          })
                        }
                      >
                        设为默认
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={
                        busy ||
                        (!hasCredential &&
                          !credentialStatusUnknown &&
                          profile.providerId !== "ollama")
                      }
                      onClick={() =>
                        void run(async () => {
                          const result = await window.patentApi.aiCorrection.testConnection({
                            profileId: profile.profileId,
                          });
                          if (!result.ok) throw new Error(result.error.message);
                          setMessage("连接验证成功。");
                        })
                      }
                    >
                      验证
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDiscoveredModels([]);
                        setDiscoveringModels(false);
                        setMessage(null);
                        setError(null);
                        startEditing({ ...profile, apiKey: "", isNew: false });
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => void run(async () => await removeProfile(profile))}
                    >
                      删除
                    </button>
                  </div>
                </article>
              );
            })
          )}
        </div>

        <AiDataPolicy />
        <details className="ai-model-advanced spatial-disclosure">
          <summary>高级设置</summary>
          <div className="ai-settings-grid">
            <label>
              模型验证与读取超时（毫秒）
              <input
                type="number"
                min={5000}
                max={120000}
                value={settings.timeoutMs}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    timeoutMs: Number(event.target.value),
                  }))
                }
                disabled={busy}
              />
            </label>
            <label>
              当前文档检查字数上限
              <input
                type="number"
                min={1000}
                max={100000}
                value={settings.maxUploadCharacters}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    maxUploadCharacters: Number(event.target.value),
                  }))
                }
                disabled={busy}
              />
            </label>
          </div>
          <div className="settings-page__actions settings-connection-actions">
            <button
              className="settings-action-button is-primary"
              type="button"
              disabled={busy || !generalDirty}
              onClick={() => void run(() => saveGeneralSettings(settings))}
            >
              保存连接设置
            </button>
            <button
              className="settings-action-button"
              type="button"
              hidden={!generalDirty}
              disabled={busy}
              onClick={() => setSettings(savedSettings)}
            >
              还原未保存修改
            </button>
          </div>
        </details>

        <MotionPresence>
          {(editorDirty || generalDirty) && (
            <p className="settings-save-status" role="status">
              有未保存修改。
            </p>
          )}
        </MotionPresence>

        <MotionPresence>
          {error ? (
            <p role="alert" className="ai-form-error">
              {error}
            </p>
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {message ? (
            <p role="status" className="ai-form-success">
              {message}
            </p>
          ) : null}
        </MotionPresence>
      </section>

      <MotionPresence clearSensitiveInputs>
        {editor && (mode === "editor" || !embedded) ? (
          <div
            ref={editorStage}
            className={`ai-model-editor-layer${embedded ? " ai-model-editor-layer--embedded" : ""}`}
            {...editorAccessibility}
          >
            <section className={`ai-model-editor${embedded ? " ai-model-editor--embedded" : ""}`}>
              {!embedded ? (
                <header>
                  <div>
                    <span className="ai-kicker">模型配置</span>
                    <h2>{editor.isNew ? "添加模型" : "编辑模型"}</h2>
                  </div>
                  <button
                    type="button"
                    className="ai-icon-button dialog-close-button dialog-close-control"
                    aria-label="关闭添加模型"
                    onClick={closeEditor}
                  >
                    <DialogCloseIcon />
                  </button>
                </header>
              ) : null}
              <label className="ai-model-field">
                模型提供商
                <select
                  aria-label="模型提供商"
                  value={editor.providerId}
                  onChange={(event) => {
                    const providerId = event.target.value as AiProviderId;
                    const preset = presetFor(providerId);
                    const model = preset?.models[0];
                    setDiscoveredModels([]);
                    setDiscoveringModels(false);
                    setMessage(null);
                    setError(null);
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            providerId,
                            displayName: preset ? "" : current.displayName,
                            baseUrl: preset?.baseUrl ?? "",
                            model: model?.id ?? "",
                          }
                        : current,
                    );
                  }}
                >
                  {AI_PROVIDER_PRESETS.map((preset) => (
                    <option key={preset.providerId} value={preset.providerId}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>

              {presetFor(editor.providerId) ? (
                <>
                  <div className="ai-provider-endpoint">
                    <div>
                      <span>服务地址</span>
                      <code>{presetFor(editor.providerId)?.baseUrl}</code>
                    </div>
                    <button
                      type="button"
                      aria-label="查看文档"
                      onClick={() => {
                        const providerId = editor.providerId;
                        if (providerId !== "custom")
                          void run(async () => {
                            const result = await window.patentApi.aiCorrection.openProviderDocs({
                              providerId: "deepseek",
                            });
                            if (!result.ok) throw new Error(result.error.message);
                          });
                      }}
                    >
                      查看文档 ↗
                    </button>
                  </div>
                  <label className="ai-model-field">
                    模型
                    <select
                      aria-label="模型"
                      value={editor.model}
                      onChange={(event) => setEditor({ ...editor, model: event.target.value })}
                    >
                      {presetFor(editor.providerId)?.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                          {"recommended" in model && model.recommended ? "（推荐）" : ""}
                        </option>
                      ))}
                      {discoveredModels.filter(
                        (modelId) =>
                          !presetFor(editor.providerId)?.models.some(({ id }) => id === modelId),
                      ).length > 0 ? (
                        <optgroup label="账户可用的其他模型">
                          {discoveredModels
                            .filter(
                              (modelId) =>
                                !presetFor(editor.providerId)?.models.some(
                                  ({ id }) => id === modelId,
                                ),
                            )
                            .map((modelId) => (
                              <option key={modelId} value={modelId}>
                                {modelId}
                              </option>
                            ))}
                        </optgroup>
                      ) : null}
                    </select>
                  </label>
                </>
              ) : null}

              {
                <label className="ai-model-field">
                  API Key
                  <input
                    aria-label="API Key"
                    type="password"
                    autoComplete="new-password"
                    value={editor.apiKey}
                    placeholder={editor.isNew ? "输入 API Key" : "留空则保留已保存的密钥"}
                    onChange={(event) => setEditor({ ...editor, apiKey: event.target.value })}
                  />
                  <small>
                    Key 在本机加密保存，调用时在本机解密并直连
                    DeepSeek。开发／运营方服务器不解密、不中转、不留存 Key 与交互内容。
                  </small>
                </label>
              }
              <div className="ai-model-discovery-row">
                <button
                  type="button"
                  disabled={busy || !editor.baseUrl.trim() || !editor.apiKey.trim()}
                  onClick={() => void runModelDiscovery()}
                >
                  {discoveringModels ? "正在验证…" : "验证并读取模型"}
                </button>
                <span>读取结果只用于当前配置，API Key 不会因此保存。</span>
              </div>
              <SpatialPresence>
                {discoveringModels ? (
                  <p role="status" className="ai-model-discovery-feedback is-loading">
                    正在验证连接并读取模型…
                  </p>
                ) : message ? (
                  <p role="status" className="ai-model-discovery-feedback is-success">
                    {message}
                  </p>
                ) : null}
              </SpatialPresence>
              <SpatialPresence>
                {error ? (
                  <p role="alert" className="ai-form-error">
                    {error}
                  </p>
                ) : null}
              </SpatialPresence>
              <footer>
                {error?.includes("AI 服务密钥不可用") && editor.apiKey.trim() ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => saveEditor(true))}
                  >
                    重置不可用密钥并保存
                  </button>
                ) : (
                  <span />
                )}
                <button type="button" onClick={closeEditor}>
                  取消
                </button>
                <button
                  type="button"
                  className="is-primary"
                  disabled={busy}
                  onClick={() => void run(() => saveEditor())}
                >
                  保存模型
                </button>
              </footer>
            </section>
          </div>
        ) : null}
      </MotionPresence>
    </div>
  );
}
