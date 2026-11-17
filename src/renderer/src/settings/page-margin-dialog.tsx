import { useEffect, useState } from "react";
import {
  DEFAULT_PAGE_MARGINS,
  type PageMargins,
  validatePageMargins,
  WORD_MARGIN_PRESETS_CM,
  type WordMarginPresetKey,
} from "../../../shared/settings/page-margins";
import { confirmAppAction } from "../shared/app-dialog";
import { DialogCloseIcon } from "../shared/dialog-close-icon";
import { SpatialPresence } from "../shared/spatial-presence";
import {
  formatCmInput,
  mmToCm,
  PAGE_MARGIN_FIELD_LABELS,
  type PageMarginField,
  pageMarginsFromCmInput,
} from "./page-margin-utils";
import { useSettingsDraft } from "./settings-drafts";

const EDITABLE_PAGE_MARGIN_FIELDS: readonly PageMarginField[] = ["left", "right"];

type PageMarginDialogProps = {
  open: boolean;
  onClose: () => void;
  onSaved(margins: PageMargins): void;
  validateChange?: ((margins: PageMargins) => string | null) | undefined;
  embedded?: boolean;
  hasEditableDocument?: boolean;
  /** 组合校验所用的纸张宽（mm），通常取当前活动文档，无则传 A4 210。 */
  pageWidthMm: number;
  /** 组合校验所用的纸张高（mm），通常取当前活动文档，无则传 A4 297。 */
  pageHeightMm: number;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function fieldLabel(field: PageMarginField): string {
  return `${PAGE_MARGIN_FIELD_LABELS[field]}边距 (cm)`;
}

export function PageMarginDialog({
  open,
  onClose,
  onSaved,
  validateChange,
  pageWidthMm,
  pageHeightMm,
  embedded = false,
  hasEditableDocument = true,
}: PageMarginDialogProps) {
  const [values, setValues] = useState<Record<PageMarginField, string>>({
    top: formatCmInput(mmToCm(DEFAULT_PAGE_MARGINS.marginTopMm)),
    right: formatCmInput(mmToCm(DEFAULT_PAGE_MARGINS.marginRightMm)),
    bottom: formatCmInput(mmToCm(DEFAULT_PAGE_MARGINS.marginBottomMm)),
    left: formatCmInput(mmToCm(DEFAULT_PAGE_MARGINS.marginLeftMm)),
  });
  const [fieldErrors, setFieldErrors] = useState<Record<PageMarginField, string | null>>({
    top: null,
    right: null,
    bottom: null,
    left: null,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [preset, setPreset] = useState<WordMarginPresetKey | "">("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [baseline, setBaseline] = useState(values);
  const [loaded, setLoaded] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  useEffect(() => {
    if (!savedFeedback) return;
    const timer = window.setTimeout(() => setSavedFeedback(false), 3000);
    return () => window.clearTimeout(timer);
  }, [savedFeedback]);
  const dirty = loaded && JSON.stringify(values) !== JSON.stringify(baseline);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setFieldErrors({ top: null, right: null, bottom: null, left: null });
    setPreset("");
    setLoading(true);
    setLoaded(false);
    window.patentApi.settings
      .read()
      .then((result) => {
        if (!result.ok) throw new Error(result.error.message);
        const margins = result.value.pageMargins;
        const saved = {
          top: formatCmInput(mmToCm(margins.marginTopMm)),
          right: formatCmInput(mmToCm(margins.marginRightMm)),
          bottom: formatCmInput(mmToCm(margins.marginBottomMm)),
          left: formatCmInput(mmToCm(margins.marginLeftMm)),
        };
        setValues(saved);
        setBaseline(saved);
        setLoaded(true);
      })
      .catch(() => setFormError("无法读取页边距设置，请关闭后重试。"))
      .finally(() => setLoading(false));
  }, [open]);

  const updateField = (field: PageMarginField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: null }));
    setFormError(null);
  };

  const fillMargins = (margins: PageMargins) => {
    setValues((current) => ({
      ...current,
      right: formatCmInput(mmToCm(margins.marginRightMm)),
      left: formatCmInput(mmToCm(margins.marginLeftMm)),
    }));
    setFieldErrors({ top: null, right: null, bottom: null, left: null });
    setFormError(null);
    setPreset("");
  };

  const applyPreset = (key: WordMarginPresetKey) => {
    const presetValue = WORD_MARGIN_PRESETS_CM[key];
    setValues((current) => ({
      ...current,
      right: formatCmInput(presetValue.right),
      left: formatCmInput(presetValue.left),
    }));
    setFieldErrors({ top: null, right: null, bottom: null, left: null });
    setFormError(null);
  };

  const preview = pageMarginsFromCmInput(values);
  const previewMm =
    preview.margins === null
      ? null
      : {
          width: round2(pageWidthMm - preview.margins.marginLeftMm - preview.margins.marginRightMm),
          height: round2(
            pageHeightMm - preview.margins.marginTopMm - preview.margins.marginBottomMm,
          ),
        };
  const paperContentInsets =
    preview.margins === null
      ? undefined
      : {
          top: `${(preview.margins.marginTopMm / pageHeightMm) * 100}%`,
          right: `${(preview.margins.marginRightMm / pageWidthMm) * 100}%`,
          bottom: `${(preview.margins.marginBottomMm / pageHeightMm) * 100}%`,
          left: `${(preview.margins.marginLeftMm / pageWidthMm) * 100}%`,
        };

  const handleSave = async () => {
    if (!loaded || saving) return false;
    const parsed = pageMarginsFromCmInput(values);
    setFieldErrors(parsed.fieldErrors);
    setFormError(null);
    if (parsed.margins === null) return false;
    const validationError = validatePageMargins(parsed.margins, pageWidthMm, pageHeightMm);
    if (validationError !== null) {
      setFormError(validationError);
      return false;
    }
    const tableError = validateChange?.(parsed.margins);
    if (tableError) {
      setFormError(tableError);
      return false;
    }
    setSaving(true);
    try {
      const result = await window.patentApi.settings.update({ pageMargins: parsed.margins });
      if (!result.ok) {
        setFormError(result.error.message);
        return false;
      }
      onSaved(parsed.margins);
      setBaseline(values);
      setSavedFeedback(true);
      if (!embedded) onClose();
      return true;
    } catch {
      setFormError("保存设置失败，请重试。");
      return false;
    } finally {
      setSaving(false);
    }
  };
  const revert = () => {
    setValues(baseline);
    setPreset("");
    setFormError(null);
    setFieldErrors({ top: null, right: null, bottom: null, left: null });
  };
  useSettingsDraft({ label: "页边距", dirty, save: handleSave, discard: revert });
  const requestClose = async () => {
    if (saving) return;
    if (dirty && !(await confirmAppAction("放弃尚未保存的页边距修改？"))) return;
    onClose();
  };
  if (!open) return null;

  const actions = (
    <div
      className={embedded ? "page-margin-dialog__actions" : undefined}
      style={{
        marginTop: embedded ? 0 : 16,
        textAlign: "right",
        display: "flex",
        gap: 8,
        justifyContent: "flex-end",
      }}
    >
      <button
        type="button"
        hidden={embedded && !dirty}
        onClick={embedded ? revert : () => void requestClose()}
        disabled={saving}
        style={{
          padding: "6px 16px",
          border: "1px solid #ccc",
          borderRadius: 4,
          backgroundColor: "#fff",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        {embedded ? "还原未保存修改" : "取消"}
      </button>
      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving || !loaded}
        style={{
          padding: "6px 16px",
          border: "none",
          borderRadius: 4,
          backgroundColor: saving || !loaded ? "#cbd5e1" : "#2563eb",
          color: "#fff",
          cursor: saving || !loaded ? "not-allowed" : "pointer",
          fontSize: 13,
        }}
      >
        {saving ? "保存中..." : "保存"}
      </button>
    </div>
  );

  const content = (
    <div
      className={
        embedded
          ? "page-margin-dialog page-margin-dialog--embedded settings-page"
          : "page-margin-dialog dialog-with-standard-close"
      }
      {...(embedded
        ? { role: "region", "aria-label": "页面设置" }
        : { role: "dialog", "aria-modal": true, "aria-label": "页边距设置" })}
      style={{
        ...(embedded
          ? {}
          : {
              position: "fixed",
              inset: 0,
              zIndex: 1000,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }),
      }}
    >
      {!embedded ? (
        <button
          type="button"
          aria-label="关闭页边距设置"
          style={{
            position: "absolute",
            inset: 0,
            padding: 0,
            background: "rgba(0,0,0,0.3)",
            border: 0,
            cursor: "default",
          }}
          onClick={() => void requestClose()}
        />
      ) : null}
      <div
        className={
          embedded
            ? "page-margin-dialog__card"
            : "page-margin-dialog__card dialog-with-standard-close"
        }
        style={{
          ...(embedded
            ? {}
            : {
                position: "relative",
                backgroundColor: "#fff",
                border: "1px solid #cbd5e1",
                borderRadius: 12,
                boxShadow: "0 12px 36px rgb(15 23 42 / 16%)",
                width: "min(520px, calc(100vw - 48px))",
                fontSize: 14,
                lineHeight: 1.6,
                maxHeight: "80vh",
                overflow: "auto",
                padding: 20,
              }),
        }}
      >
        {!embedded ? (
          <button
            type="button"
            className="dialog-close-button dialog-close-button--corner dialog-close-control"
            aria-label="关闭页边距设置"
            onClick={() => void requestClose()}
          >
            <DialogCloseIcon />
          </button>
        ) : null}
        {!embedded ? (
          <>
            <h2 style={{ margin: "0 28px 6px 0", fontSize: 16, fontWeight: 600 }}>页边距设置</h2>
            <p style={{ margin: "0 0 18px", color: "#666", fontSize: 13 }}>
              默认左右页边距为 3.17cm
            </p>
          </>
        ) : null}

        {
          <SpatialPresence>
            {loading ? (
              <p style={{ color: "#666" }}>加载中...</p>
            ) : (
              <>
                <p className="settings-save-status" role="status">
                  {dirty ? "有未保存修改。" : savedFeedback ? "已保存。" : ""}
                  保存后应用于全部文档。
                </p>
                <div className={embedded ? "page-margin-dialog__layout" : undefined}>
                  <div className={embedded ? "page-margin-dialog__form" : undefined}>
                    {embedded ? (
                      <h4 className="page-margin-dialog__group-title">左右边距</h4>
                    ) : null}
                    <div
                      className={embedded ? "page-margin-dialog__fields" : undefined}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: "14px 20px",
                        marginBottom: 16,
                      }}
                    >
                      {EDITABLE_PAGE_MARGIN_FIELDS.map((field) => {
                        const error = fieldErrors[field];
                        return (
                          <label key={field} style={{ display: "grid", gap: 6, fontSize: 13 }}>
                            <span style={{ color: "#30343b", fontWeight: 600 }}>
                              {PAGE_MARGIN_FIELD_LABELS[field]}边距
                            </span>
                            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={values[field]}
                                disabled={saving}
                                onChange={(event) => updateField(field, event.target.value)}
                                aria-label={fieldLabel(field)}
                                aria-invalid={error !== null}
                                style={{
                                  boxSizing: "border-box",
                                  width: 110,
                                  height: 34,
                                  padding: "0 8px",
                                  border: `1px solid ${error !== null ? "#dc2626" : "#c8cdd5"}`,
                                  borderRadius: 4,
                                  fontSize: 14,
                                  color: "#20242a",
                                  outline:
                                    error !== null ? "2px solid rgb(220 38 38 / 18%)" : "none",
                                }}
                              />
                              <span style={{ color: "#64748b", fontSize: 12 }}>cm</span>
                            </span>
                            {
                              <SpatialPresence>
                                {error !== null ? (
                                  <span role="alert" style={{ color: "#b91c1c", fontSize: 12 }}>
                                    {error}
                                  </span>
                                ) : null}
                              </SpatialPresence>
                            }
                          </label>
                        );
                      })}
                    </div>

                    <div
                      className={embedded ? "page-margin-dialog__preset" : undefined}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        marginBottom: 14,
                        ...(embedded
                          ? {}
                          : {
                              padding: "10px 12px",
                              background: "#f8fafc",
                              border: "1px solid #dbe2ea",
                              borderRadius: 6,
                            }),
                      }}
                    >
                      <label
                        htmlFor="page-margin-preset"
                        style={{ fontSize: 13, color: "#30343b" }}
                      >
                        页边距预设：
                      </label>
                      <div className="page-margin-dialog__preset-controls">
                        <select
                          id="page-margin-preset"
                          value={preset}
                          disabled={saving}
                          onChange={(event) => {
                            const key = event.target.value as WordMarginPresetKey | "";
                            setPreset(key);
                            if (key !== "") applyPreset(key);
                          }}
                          style={{
                            height: 30,
                            padding: "0 6px",
                            border: "1px solid #c8cdd5",
                            borderRadius: 4,
                            fontSize: 13,
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          <option value="">请选择...</option>
                          {(Object.keys(WORD_MARGIN_PRESETS_CM) as WordMarginPresetKey[]).map(
                            (key) => (
                              <option key={key} value={key}>
                                {WORD_MARGIN_PRESETS_CM[key].label}（左{" "}
                                {WORD_MARGIN_PRESETS_CM[key].left}
                                cm / 右 {WORD_MARGIN_PRESETS_CM[key].right}cm）
                              </option>
                            ),
                          )}
                        </select>
                        <button
                          type="button"
                          onClick={() => fillMargins(DEFAULT_PAGE_MARGINS)}
                          disabled={saving}
                          style={{
                            height: 30,
                            padding: "0 12px",
                            border: "1px solid #c8cdd5",
                            borderRadius: 4,
                            backgroundColor: "#fff",
                            fontSize: 13,
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          恢复默认
                        </button>
                      </div>
                    </div>

                    {!embedded && previewMm !== null ? (
                      <p style={{ margin: "0 0 12px", color: "#52606d", fontSize: 12 }}>
                        当前页面内容区：{previewMm.width}mm × {previewMm.height}mm
                      </p>
                    ) : null}

                    {
                      <SpatialPresence>
                        {formError !== null ? (
                          <p
                            role="alert"
                            style={{ margin: "0 0 12px", color: "#b91c1c", fontSize: 13 }}
                          >
                            {formError}
                          </p>
                        ) : null}
                      </SpatialPresence>
                    }
                    {!hasEditableDocument ? (
                      <p role="note" style={{ margin: "0 0 12px", color: "#b45309", fontSize: 13 }}>
                        当前没有打开文档，仍可保存全局页边距。
                      </p>
                    ) : null}

                    {!embedded ? actions : null}
                  </div>
                  {embedded ? (
                    <aside
                      className="page-margin-dialog__preview"
                      aria-label="页面预览"
                      {...(previewMm === null
                        ? {}
                        : {
                            "data-content-width-mm": String(previewMm.width),
                            "data-content-height-mm": String(previewMm.height),
                          })}
                    >
                      <div className="page-margin-dialog__preview-heading">
                        <span>页面预览</span>
                        <span className="page-margin-dialog__preview-badge">比例示意</span>
                      </div>
                      <div className="page-margin-dialog__paper">
                        <div
                          className="page-margin-dialog__paper-content"
                          style={paperContentInsets}
                          role="document"
                          aria-label="页面预览内容"
                        >
                          <p>本发明涉及专利文档编辑技术领域，尤其涉及一种页面内容排版方法。</p>
                          <p>通过调整页面边距，可以直观预览正文的行宽、段落间距及可用内容区域。</p>
                        </div>
                      </div>
                      <div className="page-margin-dialog__preview-caption">
                        <span>虚线范围为正文区域</span>
                        {previewMm !== null ? (
                          <span className="page-margin-dialog__preview-size">
                            {previewMm.width} × {previewMm.height} mm
                          </span>
                        ) : null}
                      </div>
                    </aside>
                  ) : null}
                </div>
                {embedded ? actions : null}
              </>
            )}
          </SpatialPresence>
        }
      </div>
    </div>
  );

  return content;
}
