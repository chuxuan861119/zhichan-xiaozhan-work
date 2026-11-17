import { ChevronDown } from "lucide-react";
import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { isNetworkAiAvailable } from "../../../shared/platform";
import {
  availableEditorColors,
  colorLuminance,
  DEFAULT_EDITOR_COLORS,
  EDITOR_COLOR_PRESETS,
  type EditorColorField,
  type EditorColorOption,
  type EditorColors,
  EditorColorsSchema,
  editorColorTokens,
} from "../../../shared/settings/editor-colors";
import { SpatialPresence } from "../shared/spatial-presence";
import "./editor-color-settings.css";
import { useModalDialog } from "../shared/use-modal-dialog";
import { EditorColorGamut } from "./editor-color-gamut";
import { useSettingsDraft } from "./settings-drafts";

function ColorPalette({
  label,
  color,
  options,
  disabled,
  onChange,
  field,
  contrastColor,
}: {
  label: string;
  color: string;
  options: EditorColorOption[];
  disabled: boolean;
  onChange(color: string): void;
  field: EditorColorField;
  contrastColor: string;
}) {
  const [open, setOpen] = useState(false);
  const [gamutRevision, setGamutRevision] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const palette = useRef<HTMLFieldSetElement>(null);
  const id = useId();
  const colorName = options.find((option) => option.color === color.toLowerCase())?.name;
  const displayName =
    !colorName || colorName === "当前颜色" || colorName === "已保存颜色" ? "自定义" : colorName;
  const retained = options.filter(
    (option) => option.name === "当前颜色" || option.name === "已保存颜色",
  );
  const visibleOptions = [
    ...options.filter((option) => !retained.includes(option)).slice(0, 24 - retained.length),
    ...retained,
  ];
  useModalDialog({
    open: open && !disabled,
    containerRef: root,
    initialFocusRef: trigger,
    onClose: () => setOpen(false),
  });
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const position = () => {
      const element = palette.current;
      const anchor = root.current;
      if (!element || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      let top = 8;
      let bottom = window.innerHeight - 8;
      for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/u.test(getComputedStyle(parent).overflowY)) {
          const bounds = parent.getBoundingClientRect();
          top = Math.max(top, bounds.top + 8);
          bottom = Math.min(bottom, bounds.bottom - 8);
        }
      }
      const availableHeight = Math.max(0, bottom - top);
      element.style.maxHeight = `${availableHeight}px`;
      const borderHeight = element.offsetHeight - element.clientHeight;
      const height = Math.min(element.scrollHeight + borderHeight, availableHeight);
      // Prefer below the trigger, but slide over it instead of shrinking the picker.
      const popupTop = Math.max(top, Math.min(rect.bottom + 6, bottom - height));
      element.style.top = `${popupTop - rect.top}px`;
      element.style.bottom = "auto";
    };
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open, disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);
  return (
    <div className="editor-color-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="editor-color-picker__trigger"
        aria-label={label}
        aria-expanded={open && !disabled}
        aria-controls={open && !disabled ? id : undefined}
        data-color={color}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span
          className="editor-color-picker__chip"
          style={{ background: color }}
          aria-hidden="true"
        />
        <span>{displayName}</span>
        <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
      </button>
      <SpatialPresence>
        {open && !disabled && (
          <fieldset
            ref={palette}
            className="editor-color-picker__palette"
            id={id}
            aria-label={`${label}可用颜色`}
          >
            <header className="editor-color-picker__heading">
              <strong>{label}</strong>
              <span>{displayName}</span>
            </header>
            <EditorColorGamut
              key={gamutRevision}
              color={color}
              field={field}
              contrastColor={contrastColor}
              onChange={onChange}
            />
            <span className="editor-color-picker__hint">精选颜色</span>
            <div className="editor-color-picker__grid">
              {visibleOptions.map((option) => (
                <button
                  key={option.color}
                  type="button"
                  aria-label={option.name}
                  title={`${option.name} ${option.color}`}
                  aria-pressed={color.toLowerCase() === option.color}
                  style={{
                    background: option.color,
                    color: colorLuminance(option.color) < 0.4 ? "#fff" : "#111",
                  }}
                  onClick={() => {
                    onChange(option.color);
                    setGamutRevision((revision) => revision + 1);
                  }}
                >
                  <span aria-hidden="true">{color.toLowerCase() === option.color ? "✓" : ""}</span>
                </button>
              ))}
            </div>
            <label className="editor-color-picker__value">
              <span
                className="editor-color-picker__chip"
                style={{ background: color }}
                aria-hidden="true"
              />
              <input
                aria-label="当前色值"
                value={color.toUpperCase()}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
          </fieldset>
        )}
      </SpatialPresence>
    </div>
  );
}

export function EditorColorSettings({
  value,
  disabled,
  onApply,
}: {
  value: EditorColors;
  disabled: boolean;
  onApply: (value: EditorColors) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const saved = useRef(value);
  useEffect(() => {
    const previous = saved.current;
    if (
      previous.page !== value.page ||
      previous.canvas !== value.canvas ||
      previous.panel !== value.panel ||
      previous.panelFollowsPage !== value.panelFollowsPage
    ) {
      setDraft(value);
    }
    saved.current = value;
  }, [value]);
  const parsed = EditorColorsSchema.safeParse(draft);
  const preview = parsed.success ? parsed.data : value;
  const changed = JSON.stringify(draft) !== JSON.stringify(value);
  useSettingsDraft({
    label: "编辑区配色",
    dirty: changed,
    save: async () => (!disabled && parsed.success ? onApply(parsed.data) : false),
    discard: () => setDraft(value),
  });
  const update = (patch: Partial<EditorColors>) =>
    setDraft((previous) => ({ ...previous, ...patch }));
  return (
    <div className="preference-group editor-color-settings">
      <h4>
        编辑区配色{" "}
        <small role="status" aria-label="当前配色方案">
          {EDITOR_COLOR_PRESETS.find(
            ({ colors }) => JSON.stringify(colors) === JSON.stringify(draft),
          )?.name ?? "自定义"}
        </small>
      </h4>
      <div className="editor-color-presets">
        {EDITOR_COLOR_PRESETS.map(({ name, colors }) => (
          <button
            type="button"
            key={name}
            disabled={disabled}
            aria-label={name}
            aria-pressed={JSON.stringify(draft) === JSON.stringify(colors)}
            onClick={() => setDraft({ ...colors })}
          >
            <span
              className="editor-color-swatch"
              aria-hidden="true"
              style={{ background: colors.canvas }}
            >
              <span style={{ background: colors.page }} />
              <span style={{ background: colors.panel }} />
            </span>
            <span className="editor-color-preset-name">
              {name}
              {name === "经典白" && <small>默认</small>}
            </span>
          </button>
        ))}
      </div>
      <div className="editor-color-workspace">
        <div
          className="editor-color-preview"
          role="img"
          aria-label="配色预览"
          style={editorColorTokens(preview) as CSSProperties}
        >
          <div className="editor-color-preview__page">
            <strong>权利要求书</strong>
            <p>1. 一种装置，包括底座和支撑杆。</p>
            <p>
              <span style={{ color: "#2563eb" }}>关键词</span> ·{" "}
              <span style={{ color: "#b91c1c" }}>修订内容</span> ·{" "}
              <span style={{ color: "#7c3aed" }}>增补编号</span>
            </p>
          </div>
          <div className="editor-color-preview__panel">
            <strong>文档工具</strong>
            <p>快速检查</p>
            {isNetworkAiAvailable() ? (
              <>
                <p>AI 纠错</p>
                <p>小栈AI助手</p>
              </>
            ) : (
              <p>附图排序</p>
            )}
          </div>
        </div>
        <div className="editor-color-controls">
          <label className="preference-row">
            <span className="preference-copy">
              功能栏跟随页面颜色
              <small>
                {isNetworkAiAvailable()
                  ? "AI 纠错与小栈AI助手跟随功能栏"
                  : "文档工具区域跟随页面配色"}
              </small>
            </span>
            <input
              type="checkbox"
              aria-label="功能栏跟随页面颜色"
              disabled={disabled}
              checked={draft.panelFollowsPage}
              onChange={(event) => update({ panelFollowsPage: event.target.checked })}
            />
          </label>
          {(
            [
              ["page", "页面颜色"],
              ["canvas", "空背景颜色"],
              ["panel", "功能栏颜色"],
            ] as const
          ).map(([key, label]) => {
            if (key === "panel" && draft.panelFollowsPage) return null;
            return (
              <div className="preference-row" key={key}>
                <span>{label}</span>
                <ColorPalette
                  field={key}
                  contrastColor={key === "page" ? draft.canvas : draft.page}
                  label={label}
                  color={draft[key]}
                  disabled={disabled}
                  options={availableEditorColors(draft, key, value[key])}
                  onChange={(color) => update({ [key]: color })}
                />
              </div>
            );
          })}
        </div>
      </div>
      {
        <SpatialPresence>
          {!parsed.success && (
            <p className="editor-color-error" role="alert">
              {parsed.error.issues[0]?.message}
            </p>
          )}
        </SpatialPresence>
      }
      <p className="editor-color-note">仅改变编辑显示，不影响正文、导出和打印。</p>
      <div className="preference-footer editor-color-actions">
        <button
          className="editor-color-reset"
          type="button"
          disabled={disabled}
          onClick={() => setDraft({ ...DEFAULT_EDITOR_COLORS })}
        >
          恢复默认配色
        </button>
        <button type="button" disabled={disabled || !changed} onClick={() => setDraft(value)}>
          取消调整
        </button>
        <button
          className="editor-color-apply"
          type="button"
          disabled={disabled || !parsed.success || !changed}
          onClick={() => {
            if (parsed.success) void onApply(parsed.data);
          }}
        >
          应用配色
        </button>
      </div>
    </div>
  );
}
