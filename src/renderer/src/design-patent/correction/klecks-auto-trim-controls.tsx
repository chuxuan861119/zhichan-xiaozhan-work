import { ChevronDown, Scan, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type AutoTrimOptions,
  AutoTrimOptionsSchema,
} from "../../../../shared/settings/design-auto-trim";

export function KlecksAutoTrimButton({
  compact = false,
  disabled,
  options,
  onRun,
  onSettings,
}: {
  compact?: boolean;
  disabled: boolean;
  options: AutoTrimOptions;
  onRun(): void;
  onSettings(): void;
}) {
  const mode = options.mode === "transparent" ? "透明边缘" : "纯色边缘（自动识别）";
  return (
    <span className={`klecks-auto-trim ${compact ? "klecks-auto-trim--compact" : ""}`}>
      <button
        type="button"
        disabled={disabled}
        aria-label="一键裁剪"
        title={`一键裁剪 · ${mode}（不改变缩放倍率）`}
        onClick={onRun}
      >
        <Scan size={compact ? 18 : 15} />
        {compact ? null : "一键裁剪"}
      </button>
      <button
        type="button"
        className="klecks-auto-trim__settings"
        disabled={disabled}
        aria-label="一键裁剪设置"
        title="设置透明或自动识别纯色边缘"
        onClick={onSettings}
      >
        <ChevronDown size={compact ? 9 : 13} />
      </button>
    </span>
  );
}

export function KlecksAutoTrimSettings({
  options,
  onSave,
  onClose,
}: {
  options: AutoTrimOptions;
  onSave(value: AutoTrimOptions): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(options);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  const valid = AutoTrimOptionsSchema.safeParse(draft).success;
  return createPortal(
    <dialog
      ref={dialog}
      className="klecks-size-dialog klecks-auto-trim-dialog"
      aria-label="一键裁剪设置"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="klecks-auto-trim-dialog__header">
        <h2>一键裁剪设置</h2>
        <button
          type="button"
          className="dialog-close-button"
          aria-label="关闭一键裁剪设置"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: The settings body only handles Escape bubbled from its form controls. */}
      <div
        className="klecks-auto-trim-settings"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <label>
          裁剪边缘
          <select
            aria-label="裁剪边缘"
            value={draft.mode}
            onChange={(e) =>
              setDraft({
                ...draft,
                mode: e.currentTarget.value as AutoTrimOptions["mode"],
              })
            }
          >
            <option value="transparent">透明（默认）</option>
            <option value="solid">纯色</option>
          </select>
        </label>
        <label>
          颜色容差
          <input
            type="number"
            aria-label="颜色容差"
            min={0}
            max={50}
            disabled={draft.mode === "transparent"}
            value={Number.isNaN(draft.tolerance) ? "" : draft.tolerance}
            onChange={(e) => setDraft({ ...draft, tolerance: e.currentTarget.valueAsNumber })}
          />
        </label>
        <p>
          自动识别白色或其他纯色边缘，无需选色。仅裁去四周边缘，不缩放图像。容差为 0
          时精确匹配颜色；提高容差可处理压缩产生的近似颜色。
        </p>
      </div>
      <footer>
        <button
          type="button"
          className="primary-button"
          disabled={!valid}
          onClick={() => onSave(draft)}
        >
          保存设置
        </button>
        <button type="button" onClick={onClose}>
          取消
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
