import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_INVENTION_CONTENT_PREFIX,
  INVENTION_CONTENT_PREFIXES,
  InventionContentPrefixSchema,
  normalizeInventionContentPrefix,
} from "../../../shared/settings/invention-content";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { SpatialPresence } from "../shared/spatial-presence";
import { StandardDialog } from "../shared/standard-dialog";
import "./invention-content-settings-dialog.css";

export function InventionContentSettingsDialog({
  value,
  onSave,
  onClose,
}: {
  value: string;
  onSave(value: string): Promise<boolean>;
  onClose(): void;
}) {
  const isPreset = INVENTION_CONTENT_PREFIXES.some((prefix) => prefix === value);
  const [choice, setChoice] = useState(isPreset ? value : "custom");
  const [custom, setCustom] = useState(isPreset ? "" : value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const prefix = normalizeInventionContentPrefix(choice === "custom" ? custom : choice);
  const valid = InventionContentPrefixSchema.safeParse(prefix).success;
  const save = async () => {
    if (saving.current || !valid) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      if (await onSave(prefix)) onClose();
      else setError("保存失败，原设置未改变，请重试。");
    } catch {
      setError("保存失败，请重试。");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return createPortal(
    <StandardDialog
      open
      title="发明内容设置"
      size="s"
      onCancel={() => {
        if (!saving.current) onClose();
      }}
      closeDisabled={busy}
      footer={
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setChoice(DEFAULT_INVENTION_CONTENT_PREFIX);
              setCustom("");
              setError("");
            }}
          >
            恢复默认
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !valid}
            onClick={() => void save()}
          >
            {busy ? "正在保存…" : "保存"}
          </button>
        </>
      }
    >
      <div
        className="invention-content-settings"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <p>选择从属权利要求转换后的段落开头。</p>
        <fieldset disabled={busy}>
          <legend>段落开头</legend>
          <div className="invention-content-settings__choices">
            {[...INVENTION_CONTENT_PREFIXES, "custom"].map((item) => (
              <label key={item}>
                <input
                  type="radio"
                  name="invention-prefix"
                  value={item}
                  checked={choice === item}
                  onChange={() => setChoice(item)}
                />
                {item === "custom" ? "自定义" : item}
              </label>
            ))}
          </div>
          {
            <SpatialCollapse open={Boolean(choice === "custom")}>
              {choice === "custom" ? (
                <label className="invention-content-settings__custom">
                  自定义开头
                  <input
                    autoComplete="off"
                    maxLength={60}
                    value={custom}
                    placeholder="例如：在一种实施方式中，"
                    onChange={(event) => setCustom(event.target.value)}
                  />
                </label>
              ) : null}
            </SpatialCollapse>
          }
        </fieldset>
        <div className="invention-content-settings__preview">
          <span>生成预览</span>
          <p>{prefix}所述装置包括连接件。</p>
        </div>
        <p className="invention-content-settings__hint">
          未填写末尾标点时自动补逗号。仅用于今后的“发明内容”转换，所有专利共用；不会改动已有正文。请按技术方案关系选择合适措辞。
        </p>
        {<SpatialPresence>{error ? <p role="alert">{error}</p> : null}</SpatialPresence>}
      </div>
    </StandardDialog>,
    document.body,
  );
}
