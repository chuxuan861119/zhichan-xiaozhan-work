import { type KeyboardEvent, useEffect, useState } from "react";
import { platformShortcut } from "../../../shared/platform";
import {
  CUSTOM_DUAL_VIEW_KINDS,
  type CustomDualViewKind,
  type CustomDualViewPreset,
  CustomDualViewPresetsSchema,
  compactCustomDualViewSlots,
  customDualViewFullLabel,
  customDualViewShortcutId,
} from "../../../shared/settings/custom-dual-view";
import {
  normalizeShortcutInput,
  type ShortcutSettings,
  shortcutConflicts,
} from "../../../shared/settings/shortcuts";
import { StandardDialog } from "../shared/standard-dialog";

type CustomDualViewDialogProps = Readonly<{
  open: boolean;
  presets: readonly CustomDualViewPreset[];
  shortcuts: ShortcutSettings;
  onClose(): void;
  onSave(presets: CustomDualViewPreset[], shortcuts: ShortcutSettings): Promise<boolean>;
}>;

const NEW_PRESET: CustomDualViewPreset = {
  leftBookKind: "description",
  rightBookKind: "claims",
};

function copyPresets(presets: readonly CustomDualViewPreset[]): CustomDualViewPreset[] {
  return presets.map((preset) => ({ ...preset }));
}

export function CustomDualViewDialog({
  open,
  presets,
  shortcuts,
  onClose,
  onSave,
}: CustomDualViewDialogProps) {
  const [draft, setDraft] = useState<CustomDualViewPreset[]>(() => copyPresets(presets));
  const [draftShortcuts, setDraftShortcuts] = useState<ShortcutSettings>(() => ({ ...shortcuts }));
  const [recordingIndex, setRecordingIndex] = useState<number | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(copyPresets(presets));
    setDraftShortcuts({ ...shortcuts });
    setRecordingIndex(null);
    setValidationError(null);
    setShortcutError(null);
    setSaving(false);
  }, [open, presets, shortcuts]);

  if (!open) return null;

  const updatePreset = (
    index: number,
    side: "leftBookKind" | "rightBookKind",
    bookKind: CustomDualViewKind,
  ) => {
    setDraft((current) =>
      current.map((preset, currentIndex) =>
        currentIndex === index ? { ...preset, [side]: bookKind } : preset,
      ),
    );
    setValidationError(null);
  };

  const recordShortcut = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    const actionId = customDualViewShortcutId(index);
    if (event.key === "Escape") {
      setRecordingIndex(null);
      setShortcutError(null);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      setDraftShortcuts((current) => ({ ...current, [actionId]: null }));
      setRecordingIndex(null);
      setShortcutError(null);
      return;
    }
    const normalized = normalizeShortcutInput(event);
    if (!normalized.ok) {
      setShortcutError(normalized.message);
      return;
    }
    const next = { ...draftShortcuts, [actionId]: normalized.value };
    const conflict = shortcutConflicts(next, actionId, normalized.value);
    if (conflict) {
      setShortcutError(`与${conflict.label}（${platformShortcut(conflict.shortcut)}）冲突`);
      return;
    }
    setDraftShortcuts(next);
    setRecordingIndex(null);
    setShortcutError(null);
  };

  const save = async () => {
    if (saving) return;
    const parsed = CustomDualViewPresetsSchema.safeParse(draft);
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "自定义双屏预设无效。");
      return;
    }
    setSaving(true);
    setValidationError(null);
    try {
      if (await onSave(parsed.data, draftShortcuts)) onClose();
      else setValidationError("保存自定义双屏设置失败，请重试。");
    } catch {
      setValidationError("保存自定义双屏设置失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <StandardDialog
      open={open}
      title="自定义同屏双显"
      subtitle="选择左右两侧要显示的文档或工具，并可为每组设置快捷键。"
      size="m"
      onCancel={onClose}
      closeDisabled={saving}
      bodyClassName="patent-dialog-body custom-dual-view-dialog"
      footer={
        <>
          <button type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={saving}
            onClick={() => void save()}
          >
            保存
          </button>
        </>
      }
    >
      <div className="custom-dual-view-dialog__presets">
        {draft.map((preset, index) => {
          const shortcutId = customDualViewShortcutId(index);
          return (
            <section className="custom-dual-view-dialog__preset" key={shortcutId}>
              <div className="custom-dual-view-dialog__preset-heading">
                <strong>第 {index + 1} 组</strong>
                <button
                  type="button"
                  disabled={saving}
                  aria-label={`删除第 ${index + 1} 组`}
                  onClick={() => {
                    const next = compactCustomDualViewSlots(draft, draftShortcuts, index);
                    setDraft(next.presets);
                    setDraftShortcuts(next.shortcuts);
                    setRecordingIndex(null);
                    setValidationError(null);
                    setShortcutError(null);
                  }}
                >
                  删除
                </button>
              </div>
              <div className="custom-dual-view-dialog__book-selects">
                <label>
                  左侧文档
                  <select
                    aria-label={`第 ${index + 1} 组左侧文档`}
                    value={preset.leftBookKind}
                    disabled={saving}
                    onChange={(event) =>
                      updatePreset(
                        index,
                        "leftBookKind",
                        event.currentTarget.value as CustomDualViewKind,
                      )
                    }
                  >
                    {CUSTOM_DUAL_VIEW_KINDS.map((bookKind) => (
                      <option value={bookKind} key={bookKind}>
                        {
                          customDualViewFullLabel({ ...preset, leftBookKind: bookKind }).split(
                            "｜",
                          )[0]
                        }
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  右侧文档
                  <select
                    aria-label={`第 ${index + 1} 组右侧文档`}
                    value={preset.rightBookKind}
                    disabled={saving}
                    onChange={(event) =>
                      updatePreset(
                        index,
                        "rightBookKind",
                        event.currentTarget.value as CustomDualViewKind,
                      )
                    }
                  >
                    {CUSTOM_DUAL_VIEW_KINDS.map((bookKind) => (
                      <option value={bookKind} key={bookKind}>
                        {
                          customDualViewFullLabel({ ...preset, rightBookKind: bookKind }).split(
                            "｜",
                          )[1]
                        }
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="custom-dual-view-dialog__shortcut">
                <span>快捷键</span>
                <button
                  type="button"
                  aria-label={`设置第 ${index + 1} 组快捷键`}
                  disabled={saving}
                  onClick={() => {
                    setRecordingIndex(index);
                    setShortcutError(null);
                  }}
                  onKeyDown={(event) => recordShortcut(event, index)}
                >
                  {recordingIndex === index
                    ? "请按快捷键"
                    : (draftShortcuts[shortcutId] ?? "未设置")}
                </button>
              </div>
            </section>
          );
        })}
      </div>
      <button
        type="button"
        className="custom-dual-view-dialog__add"
        disabled={saving}
        onClick={() => {
          setDraft((current) => [...current, { ...NEW_PRESET }]);
          setValidationError(null);
        }}
      >
        添加预设
      </button>
      {validationError || shortcutError ? (
        <p className="field-error" role="alert">
          {validationError ?? shortcutError}
        </p>
      ) : null}
    </StandardDialog>
  );
}
