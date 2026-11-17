import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { isNetworkAiAvailable } from "../../../shared/platform";
import {
  type CustomDualViewPreset,
  customDualViewFullLabel,
  customDualViewShortcutId,
} from "../../../shared/settings/custom-dual-view";
import {
  type ConfigurableShortcutActionId,
  CUSTOM_SHORTCUT_ACTIONS,
  FIXED_SHORTCUTS,
  normalizeShortcutInput,
  type ShortcutSettings,
  shortcutConflicts,
} from "../../../shared/settings/shortcuts";
import { confirmAppAction } from "../shared/app-dialog";
import { DialogCloseIcon } from "../shared/dialog-close-icon";
import { SpatialPresence } from "../shared/spatial-presence";
import { SpatialView } from "../shared/spatial-view";

type ShortcutSettingsDialogProps = {
  open: boolean;
  embedded?: boolean;
  value: ShortcutSettings;
  customDualViewPresets?: readonly CustomDualViewPreset[];
  onOpenCustomDualView?: () => void;
  onClose(): void;
  onSave(value: ShortcutSettings): Promise<boolean>;
};

const CUSTOM_GROUPS = ["全局", "权利要求书", "说明书", "说明书附图", "同屏双显"] as const;
type ShortcutSettingsTab = "custom" | "fixed";

function copySettings(value: ShortcutSettings): ShortcutSettings {
  return { ...value };
}

export function ShortcutSettingsDialog({
  open,
  embedded = false,
  value,
  customDualViewPresets = [],
  onOpenCustomDualView,
  onClose,
  onSave,
}: ShortcutSettingsDialogProps) {
  const [draft, setDraft] = useState<ShortcutSettings>(() => copySettings(value));
  const [recordingActionId, setRecordingActionId] = useState<ConfigurableShortcutActionId | null>(
    null,
  );
  const [recordingInitialValue, setRecordingInitialValue] = useState<string | null>(null);
  const [inputErrors, setInputErrors] = useState<
    Partial<Record<ConfigurableShortcutActionId, string>>
  >({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<ShortcutSettingsTab>("custom");

  useEffect(() => {
    if (!open) return;
    setDraft(copySettings(value));
    setRecordingActionId(null);
    setRecordingInitialValue(null);
    setInputErrors({});
    setSaveError(null);
    setSaveSuccess(null);
    setActiveTab("custom");
  }, [open, value]);

  const configurableActions = useMemo(
    () => [
      ...CUSTOM_SHORTCUT_ACTIONS.filter(
        (action) =>
          action.group !== "同屏双显" && (action.id !== "ai-correction" || isNetworkAiAvailable()),
      ),
      ...customDualViewPresets.map((preset, index) => ({
        id: customDualViewShortcutId(index),
        group: "同屏双显" as const,
        label: customDualViewFullLabel(preset),
      })),
    ],
    [customDualViewPresets],
  );

  const conflictErrors = useMemo(() => {
    const entries = configurableActions.flatMap((action) => {
      const conflict = shortcutConflicts(draft, action.id, draft[action.id] ?? null);
      return conflict
        ? [
            [
              action.id,
              `与${conflict.label}（${platformShortcut(conflict.shortcut)}）冲突`,
            ] as const,
          ]
        : [];
    });
    return Object.fromEntries(entries) as Partial<Record<ConfigurableShortcutActionId, string>>;
  }, [configurableActions, draft]);

  const actionsForGroup = (group: (typeof CUSTOM_GROUPS)[number]) =>
    configurableActions.filter((action) => action.group === group);

  if (!open) return null;

  const errors = { ...conflictErrors, ...inputErrors };
  const beginRecording = (actionId: ConfigurableShortcutActionId) => {
    setRecordingActionId(actionId);
    setRecordingInitialValue(draft[actionId] ?? null);
    setSaveError(null);
    setSaveSuccess(null);
    setInputErrors((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
  };

  const cancelRecording = (actionId: ConfigurableShortcutActionId) => {
    if (recordingActionId !== actionId) return;
    setDraft((current) => ({ ...current, [actionId]: recordingInitialValue }));
    setRecordingActionId(null);
    setRecordingInitialValue(null);
    setInputErrors((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
  };

  const clearAction = (actionId: ConfigurableShortcutActionId) => {
    const nextDraft = { ...draft, [actionId]: null };
    setDraft(nextDraft);
    setRecordingActionId(null);
    setRecordingInitialValue(null);
    setInputErrors((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
    setSaveError(null);
    setSaveSuccess(null);
    void persist(nextDraft, draft);
  };

  const recordShortcut = (
    event: KeyboardEvent<HTMLButtonElement>,
    actionId: ConfigurableShortcutActionId,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      cancelRecording(actionId);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      clearAction(actionId);
      return;
    }
    const normalized = normalizeShortcutInput(event);
    if (!normalized.ok) {
      setInputErrors((current) => ({ ...current, [actionId]: normalized.message }));
      return;
    }
    const nextDraft = { ...draft, [actionId]: normalized.value };
    const conflict = shortcutConflicts(nextDraft, actionId, normalized.value);
    setDraft(nextDraft);
    setRecordingActionId(conflict ? actionId : null);
    if (!conflict) setRecordingInitialValue(null);
    setInputErrors((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
    setSaveError(null);
    setSaveSuccess(null);
    if (!conflict) void persist(nextDraft, draft);
  };

  const persist = async (nextDraft: ShortcutSettings, previousDraft: ShortcutSettings) => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      if (await onSave(nextDraft)) setSaveSuccess("已自动保存。");
      else {
        setDraft(previousDraft);
        setSaveError("自动保存快捷键失败，请重试。");
      }
    } catch {
      setDraft(previousDraft);
      setSaveError("自动保存快捷键失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  const clearAll = async () => {
    if (!(await confirmAppAction("恢复默认快捷键？将清除自定义按键，不会删除同屏双显方案。")))
      return;
    const nextDraft = Object.fromEntries(
      Object.keys(draft).map((actionId) => [actionId, null]),
    ) as ShortcutSettings;
    const previousDraft = draft;
    setDraft(nextDraft);
    setRecordingActionId(null);
    setRecordingInitialValue(null);
    setInputErrors({});
    setSaveError(null);
    setSaveSuccess(null);
    void persist(nextDraft, previousDraft);
  };

  const containerAccessibility = embedded
    ? { role: "region" as const, "aria-label": "快捷键设置" }
    : { role: "dialog" as const, "aria-modal": true, "aria-label": "快捷键设置" };

  return (
    <div
      className={`shortcut-settings-dialog${embedded ? " shortcut-settings-dialog--embedded" : ""}`}
      {...containerAccessibility}
    >
      {!embedded ? (
        <button
          className="shortcut-settings-dialog__backdrop"
          type="button"
          aria-label="关闭快捷键设置"
          onClick={onClose}
        />
      ) : null}
      <section
        className={`shortcut-settings-dialog__surface${embedded ? "" : " dialog-with-standard-close"}`}
      >
        {!embedded ? (
          <button
            type="button"
            className="dialog-close-button dialog-close-button--corner dialog-close-control"
            aria-label="关闭快捷键设置"
            onClick={onClose}
          >
            <DialogCloseIcon />
          </button>
        ) : null}
        <header className="shortcut-settings-dialog__header">
          {!embedded ? (
            <div>
              <h2>快捷键设置</h2>
              <p>固定快捷键不可修改；可为常用专利功能设置快捷键。</p>
            </div>
          ) : null}
          <div className="shortcut-settings-dialog__tabs" role="tablist" aria-label="快捷键分类">
            <button
              type="button"
              role="tab"
              id="shortcut-settings-custom-tab"
              aria-selected={activeTab === "custom"}
              aria-controls="shortcut-settings-custom-panel"
              onClick={() => setActiveTab("custom")}
            >
              自定义快捷键
            </button>
            <button
              type="button"
              role="tab"
              id="shortcut-settings-fixed-tab"
              aria-selected={activeTab === "fixed"}
              aria-controls="shortcut-settings-fixed-panel"
              onClick={() => setActiveTab("fixed")}
            >
              固定快捷键
            </button>
          </div>
          <div className="shortcut-settings-dialog__toolbar">
            <div>
              {!embedded ? (
                <h3>{activeTab === "custom" ? "可自定义快捷键" : "固定快捷键"}</h3>
              ) : null}
              <SpatialPresence>
                {activeTab === "custom" ? (
                  <p className="shortcut-settings-dialog__guidance">
                    点击快捷键框后直接按键，按 Backspace 或 Delete 可清除。修改后立即保存。
                  </p>
                ) : null}
              </SpatialPresence>
              {
                <SpatialPresence>
                  {saving ? <p role="status">正在自动保存…</p> : null}
                </SpatialPresence>
              }
              {
                <SpatialPresence>
                  {!saving && saveSuccess ? <p role="status">{saveSuccess}</p> : null}
                </SpatialPresence>
              }
              {
                <SpatialPresence>
                  {saveError ? <p role="alert">{saveError}</p> : null}
                </SpatialPresence>
              }
            </div>
            {activeTab === "custom" ? (
              <button type="button" onClick={clearAll} disabled={saving}>
                恢复默认快捷键
              </button>
            ) : null}
          </div>
        </header>
        <div className="shortcut-settings-dialog__body">
          <SpatialView viewKey={String(activeTab === "custom")}>
            {activeTab === "custom" ? (
              <section
                id="shortcut-settings-custom-panel"
                role="tabpanel"
                aria-labelledby="shortcut-settings-custom-tab"
              >
                {CUSTOM_GROUPS.map((group) => (
                  <section
                    className="shortcut-settings-dialog__group"
                    key={group}
                    aria-label={`${group}快捷键`}
                  >
                    <div className="shortcut-settings-dialog__group-heading">
                      <h4>{group}</h4>
                      {group === "同屏双显" && onOpenCustomDualView ? (
                        <button
                          className="shortcut-settings-dialog__group-action"
                          type="button"
                          onClick={onOpenCustomDualView}
                        >
                          自定义同屏双显
                        </button>
                      ) : null}
                    </div>
                    <div className="shortcut-settings-dialog__group-list">
                      {actionsForGroup(group).map((action) => {
                        const recording = recordingActionId === action.id;
                        const error = errors[action.id];
                        return (
                          <div className="shortcut-settings-dialog__custom-row" key={action.id}>
                            <label htmlFor={`shortcut-${action.id}`}>{action.label}</label>
                            <button
                              id={`shortcut-${action.id}`}
                              type="button"
                              data-shortcut-input
                              aria-label={`设置${action.label}快捷键`}
                              aria-invalid={Boolean(error)}
                              className="shortcut-settings-dialog__shortcut-input"
                              disabled={saving}
                              onClick={() => beginRecording(action.id)}
                              onKeyDown={(event) => recordShortcut(event, action.id)}
                            >
                              {recording
                                ? "请按快捷键"
                                : platformShortcut(draft[action.id] ?? "未设置")}
                            </button>
                            {
                              <SpatialPresence>
                                {error ? <p role="alert">{error}</p> : null}
                              </SpatialPresence>
                            }
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </section>
            ) : (
              <section
                id="shortcut-settings-fixed-panel"
                role="tabpanel"
                aria-labelledby="shortcut-settings-fixed-tab"
              >
                <div className="shortcut-settings-dialog__fixed-list shortcut-settings-dialog__fixed-list--dense">
                  {FIXED_SHORTCUTS.map((shortcut) => (
                    <div className="shortcut-settings-dialog__fixed-row" key={shortcut.label}>
                      <span>
                        {shortcut.group} · {shortcut.label}
                      </span>
                      <kbd>
                        {Array.from(
                          new Set(shortcut.shortcuts.map((value) => platformEditorShortcut(value))),
                        ).join("、")}
                      </kbd>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </SpatialView>
        </div>
      </section>
    </div>
  );
}

import { platformEditorShortcut, platformShortcut } from "../../../shared/platform";
