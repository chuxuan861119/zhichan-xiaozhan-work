import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  type DesignBriefDetails,
  getDesignBriefDetails,
  getDesignProductName,
} from "../../../../shared/patent/design-brief-details";
import {
  type DesignPatent,
  inspectDesignPatent,
  isAssignedDesignView,
} from "../../../../shared/patent/design-patent";
import {
  OPPOSITE_DESIGN_VIEWS,
  ORTHOGRAPHIC_LABELS,
  type OrthographicKind,
  setViewOmission,
} from "../../../../shared/patent/design-view-omissions";
import { BriefDisclosure } from "./design-brief-disclosure";
import { BriefFieldLabel, BriefTextField } from "./design-brief-fields";
import { DesignBriefOptions } from "./design-brief-options";
import { DesignBriefPreview } from "./design-brief-preview";
import { DesignBriefGroups, DesignBriefGui } from "./design-brief-special-fields";
import "./design-brief-complete.css";

type RequiredSection = "partial" | "groups" | "gui";

function getRequiredTargets(design: DesignPatent, d: DesignBriefDetails) {
  const targets: Partial<Record<string, RequiredSection>> = {};
  if (design.subject === "partial-design" && d.partialRepresentation !== "lines")
    targets.partialDescription = "partial";
  if (d.gui.kind !== "none" && d.gui.scope === "interface-part") targets.partialUse = "partial";
  if (d.applicationType !== "single") targets.groups = "groups";
  if (d.applicationType === "similar") targets.basicDesign = "groups";
  if (d.applicationType === "component") targets.assembly = "groups";
  if (d.gui.kind !== "none") targets.gui = "gui";
  if (d.gui.kind === "dynamic") targets.frames = "gui";
  return targets;
}

export function DesignBriefForm({
  design,
  productName,
  previewUrls,
  zoomPercent = 100,
  onChange,
  onPreviewImage,
  onReview,
}: {
  design: DesignPatent;
  productName: string | null;
  previewUrls: Record<string, string>;
  zoomPercent?: number;
  onChange(design: DesignPatent): void;
  onPreviewImage(viewId: string): void;
  onReview(): void;
}) {
  const [mode, setMode] = useState<"fill" | "preview">("fill");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [omissionJump, setOmissionJump] = useState(0);
  const [newRequiredSection, setNewRequiredSection] = useState<RequiredSection | null>(null);
  const fieldId = useId();
  const omissionInput = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const preview = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (mode !== "preview") return;
    preview.current?.focus({ preventScroll: true });
    preview.current?.scrollIntoView?.({ block: "start" });
  }, [mode]);
  useLayoutEffect(() => {
    if (!omissionJump) return;
    const input = omissionInput.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const scroll = () => {
      if (document.activeElement === input && !input.closest("[inert]"))
        input.scrollIntoView?.({ block: "nearest" });
    };
    const animations = input.closest(".design-brief-disclosure__body")?.getAnimations?.() ?? [];
    if (animations.length) {
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(scroll);
    } else scroll();
  }, [omissionJump]);
  const brief = design.brief,
    d = getDesignBriefDetails(brief),
    views = design.views.filter(isAssignedDesignView);
  const selected = views.find((v) => v.viewId === design.representativeViewId);
  const representativeUrl = selected ? previewUrls[selected.viewId] : undefined;
  const colorInPoints = brief.designPoints.includes("color");
  const colorMismatch = colorInPoints !== brief.colorProtectionRequested;
  const update = (patch: Partial<DesignPatent["brief"]>) =>
    onChange({ ...design, brief: { ...brief, ...patch } });
  const detail = (patch: Partial<DesignBriefDetails>) => update({ details: { ...d, ...patch } });
  const requiredTargets = getRequiredTargets(design, d);
  const partialDescriptionRequired = requiredTargets.partialDescription === "partial";
  const partialUseRequired = requiredTargets.partialUse === "partial";
  const changeSettings = (next: DesignPatent) => {
    const nextTargets = getRequiredTargets(next, getDesignBriefDetails(next.brief));
    const added = Object.keys(nextTargets).find((key) => !requiredTargets[key]);
    setNewRequiredSection((previous) => {
      if (added) return nextTargets[added] ?? null;
      return previous && Object.values(nextTargets).includes(previous) ? previous : null;
    });
    onChange(next);
  };
  const optionalCount = [
    d.pointDescription.trim(),
    brief.continuousSurface,
    brief.elongatedObjectLengthOmitted,
    brief.materialDescription.trim(),
    brief.excludedInteriorDescription.trim(),
    brief.otherDescription.trim(),
    design.subject === "partial-design" && d.partialBoundary,
    design.subject === "partial-design" &&
      !partialDescriptionRequired &&
      brief.partialDesignDescription.trim(),
    design.subject === "partial-design" && !partialUseRequired && d.partialUse.trim(),
    d.applicationType === "component" && d.assemblyDescription.trim(),
    (d.applicationType === "set" || d.applicationType === "component") &&
      brief.setDescription.trim(),
    d.gui.kind !== "none" && d.gui.location.trim(),
    d.gui.kind !== "none" && d.gui.interaction.trim(),
    d.gui.kind !== "none" && brief.guiDescription.trim(),
  ].filter(Boolean).length;
  const optionalSummary =
    [
      { single: null, similar: "相似设计", set: "成套产品", component: "组件产品" }[
        d.applicationType
      ],
      design.subject === "partial-design" && "局部设计",
      d.productForm === "flat" && "平面产品",
      d.gui.kind !== "none" && (d.gui.kind === "dynamic" ? "动态 GUI" : "静态 GUI"),
      optionalCount > 0 && `已填写 ${optionalCount} 项`,
    ]
      .filter(Boolean)
      .join(" · ") || "默认设置 · 未填写";
  const warnings = inspectDesignPatent(design, productName).filter((i) =>
    [
      "missing-product-use",
      "missing-design-point",
      "missing-representative-view",
      "missing-partial-design-description",
      "invalid-design-color",
      "invalid-design-brief-text",
      "invalid-design-group",
      "incomplete-gui-brief",
      "invalid-brief-combination",
      "invalid-view-omission",
      "missing-omission-reason",
    ].includes(i.code),
  );
  const omissionKinds = (Object.keys(ORTHOGRAPHIC_LABELS) as OrthographicKind[]).filter(
    (kind) =>
      !design.views.some((v) => v.kind === kind) ||
      brief.omissions.some((o) => o.viewKind === kind),
  );
  return (
    <section className="design-patent-workbench__brief design-brief-complete">
      <div className="design-patent-workbench__brief-layout" style={{ zoom: `${zoomPercent}%` }}>
        <article
          className="design-patent-workbench__brief-sheet"
          aria-label={mode === "fill" ? "外观设计简要说明填写页" : "外观设计简要说明预览页"}
        >
          <header className="design-patent-workbench__brief-sheet-header">
            <p>外观设计申请文件</p>
            <h2>外观设计简要说明</h2>
          </header>
          <nav className="design-patent-workbench__brief-toc" aria-label="简要说明目录">
            <button type="button" aria-pressed={mode === "fill"} onClick={() => setMode("fill")}>
              填写内容
            </button>
            <button
              type="button"
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
            >
              正文预览
            </button>
          </nav>
          {mode === "fill" ? (
            <div className="design-patent-workbench__brief-form">
              <fieldset
                id="brief-basic-information"
                className="design-patent-workbench__form-section"
              >
                <legend>基本信息</legend>
                <BriefTextField
                  label="产品名称（必填）"
                  singleLine
                  max={200}
                  value={getDesignProductName(productName, brief)}
                  onChange={(productName) => detail({ productName })}
                  showCount={false}
                />
                <BriefTextField
                  label="产品用途（必填）"
                  value={brief.productUse}
                  onChange={(productUse) => update({ productUse })}
                  help="简洁说明产品的实际用途，不写技术原理、性能或宣传用语。"
                  placeholder="本外观设计产品用于…"
                  autoGrow
                />
                <fieldset className="design-brief-points">
                  <legend>
                    <BriefFieldLabel label="设计要点（必填）" />
                  </legend>
                  {(["shape", "pattern"] as const).map((point) => (
                    <label key={point}>
                      <input
                        type="checkbox"
                        checked={brief.designPoints.includes(point)}
                        onChange={(e) =>
                          update({
                            designPoints: e.currentTarget.checked
                              ? [...brief.designPoints, point]
                              : brief.designPoints.filter((p) => p !== point),
                          })
                        }
                      />
                      {{ shape: "形状", pattern: "图案" }[point]}
                    </label>
                  ))}
                  <label>
                    <input
                      type="checkbox"
                      aria-describedby={`${fieldId}-color-protection`}
                      checked={brief.colorProtectionRequested}
                      ref={(input) => {
                        if (input) input.indeterminate = colorMismatch;
                      }}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        update({
                          colorProtectionRequested: checked,
                          designPoints: checked
                            ? colorInPoints
                              ? brief.designPoints
                              : [...brief.designPoints, "color"]
                            : brief.designPoints.filter((point) => point !== "color"),
                        });
                      }}
                    />
                    色彩
                  </label>
                  <p id={`${fieldId}-color-protection`} className="design-brief-color-note">
                    {colorMismatch
                      ? brief.colorProtectionRequested
                        ? "旧稿已声明保护色彩，但未勾选色彩要点。当前正文保持原样。"
                        : "旧稿已勾选色彩要点，但未声明保护色彩。当前正文保持原样。"
                      : "勾选色彩会在简要说明中声明请求保护色彩；取消勾选会移除该声明。"}
                  </p>
                </fieldset>
                <div className="design-patent-workbench__representative-preview">
                  <label className="design-brief-representative__controls">
                    <BriefFieldLabel label="最能表明设计要点的图片或照片（必填）" />
                    <select
                      aria-label="最能表明设计要点的图片或照片（必填）"
                      value={selected?.viewId ?? ""}
                      onChange={(e) =>
                        onChange({ ...design, representativeViewId: e.currentTarget.value || null })
                      }
                    >
                      <option value="">请选择代表图</option>
                      {views.map((v) => (
                        <option key={v.viewId} value={v.viewId}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selected && representativeUrl ? (
                    <button
                      type="button"
                      className="design-brief-representative__thumb"
                      aria-label={`放大代表图：${selected.label}`}
                      aria-haspopup="dialog"
                      title="点击查看大图"
                      onClick={() => onPreviewImage(selected.viewId)}
                    >
                      <img src={representativeUrl} alt="代表图缩略图" />
                    </button>
                  ) : (
                    <span className="design-brief-representative__empty">
                      {selected ? "暂无预览" : "未选图"}
                    </span>
                  )}
                  <p className="design-brief-note">
                    代表图须清楚显示设计要点。局部设计应显示请求保护的部分；相似设计请选基本设计的图片。
                  </p>
                </div>
              </fieldset>

              <fieldset className="design-patent-workbench__form-section">
                <legend>视图省略说明</legend>
                {design.imageMode === "multi-image" ? (
                  <div className="design-brief-inline-action">
                    <span>按各项设计、套件或构件说明省略的视图、原因和对应图片。</span>
                    <button
                      type="button"
                      onClick={() => {
                        setOptionsOpen(true);
                        setOmissionJump((request) => request + 1);
                      }}
                    >
                      填写多图省略说明
                    </button>
                  </div>
                ) : (
                  <div className="design-brief-omissions">
                    <p className="design-brief-note">
                      按实际情况勾选并填写原因；未上传图片不会自动声明省略。
                    </p>
                    {!omissionKinds.length && (
                      <p className="design-brief-note">六视图均已导入，无需填写视图省略说明。</p>
                    )}
                    {omissionKinds.map((kind) => {
                      const o = brief.omissions.find((item) => item.viewKind === kind);
                      return (
                        <div key={kind}>
                          <label className="design-brief-check">
                            <input
                              type="checkbox"
                              checked={!!o}
                              onChange={(e) =>
                                onChange(
                                  setViewOmission(
                                    design,
                                    kind,
                                    e.currentTarget.checked ? "not-visible-during-use" : null,
                                  ),
                                )
                              }
                            />
                            省略{ORTHOGRAPHIC_LABELS[kind]}
                          </label>
                          {o && (
                            <>
                              <select
                                aria-label={`${ORTHOGRAPHIC_LABELS[kind]}省略原因`}
                                value={o.reason}
                                onChange={(e) =>
                                  onChange(
                                    setViewOmission(
                                      design,
                                      kind,
                                      e.currentTarget.value as typeof o.reason,
                                    ),
                                  )
                                }
                              >
                                <option value="same">
                                  与{ORTHOGRAPHIC_LABELS[OPPOSITE_DESIGN_VIEWS[kind]]}相同
                                </option>
                                <option value="symmetric">
                                  与{ORTHOGRAPHIC_LABELS[OPPOSITE_DESIGN_VIEWS[kind]]}对称
                                </option>
                                <option value="rotationally-identical">旋转后与其他视图相同</option>
                                <option value="not-visible-during-use">使用时不容易看到</option>
                                <option value="other">其他原因</option>
                                {["same-or-symmetric", "flat-or-thin"].includes(o.reason) && (
                                  <option value={o.reason}>历史省略设置（请核对）</option>
                                )}
                              </select>
                              {o.reason === "rotationally-identical" && (
                                <>
                                  <label>
                                    <BriefFieldLabel label="旋转后对应的视图" />
                                    <select
                                      aria-label="旋转后对应的视图"
                                      value={o.referenceKind ?? ""}
                                      onChange={(e) =>
                                        update({
                                          omissions: brief.omissions.map((item) =>
                                            item.viewKind === kind
                                              ? {
                                                  ...item,
                                                  referenceKind: (e.currentTarget.value ||
                                                    undefined) as typeof o.referenceKind,
                                                }
                                              : item,
                                          ),
                                        })
                                      }
                                    >
                                      <option value="">请选择已上传视图</option>
                                      {(Object.keys(ORTHOGRAPHIC_LABELS) as OrthographicKind[])
                                        .filter((k) => design.views.some((v) => v.kind === k))
                                        .map((k) => (
                                          <option key={k} value={k}>
                                            {ORTHOGRAPHIC_LABELS[k]}
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                  <label>
                                    <BriefFieldLabel label="顺时针旋转角度" />
                                    <select
                                      aria-label="顺时针旋转角度"
                                      value={o.rotationDegrees ?? ""}
                                      onChange={(e) =>
                                        update({
                                          omissions: brief.omissions.map((item) =>
                                            item.viewKind === kind
                                              ? {
                                                  ...item,
                                                  rotationDegrees: (Number(e.currentTarget.value) ||
                                                    undefined) as typeof o.rotationDegrees,
                                                }
                                              : item,
                                          ),
                                        })
                                      }
                                    >
                                      <option value="">请选择角度</option>
                                      <option value="90">90°</option>
                                      <option value="180">180°</option>
                                      <option value="270">270°</option>
                                    </select>
                                  </label>
                                </>
                              )}
                              {o.reason === "other" && (
                                <BriefTextField
                                  label={`${ORTHOGRAPHIC_LABELS[kind]}其他省略原因（条件必填）`}
                                  singleLine
                                  max={500}
                                  value={o.otherReason ?? ""}
                                  onChange={(otherReason) =>
                                    update({
                                      omissions: brief.omissions.map((item) =>
                                        item.viewKind === kind ? { ...item, otherReason } : item,
                                      ),
                                    })
                                  }
                                />
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </fieldset>
              {(partialDescriptionRequired || partialUseRequired) && (
                <fieldset
                  id={`${fieldId}-partial`}
                  tabIndex={-1}
                  className="design-patent-workbench__form-section"
                >
                  <legend>局部外观设计</legend>
                  {partialDescriptionRequired && (
                    <BriefTextField
                      label="局部设计保护部分及表示方式（条件必填）"
                      value={brief.partialDesignDescription}
                      onChange={(partialDesignDescription) => update({ partialDesignDescription })}
                      help="说明请求保护的部分及表示方式。已用实线和虚线明确表示时，可在下方申请设置中选择对应方式。"
                    />
                  )}
                  {partialUseRequired && (
                    <BriefTextField
                      label="请求保护局部的用途（条件必填）"
                      value={d.partialUse}
                      onChange={(partialUse) => detail({ partialUse })}
                      help="请说明请求保护的 GUI 局部的具体用途，不以整个界面或产品的用途代替。"
                    />
                  )}
                </fieldset>
              )}
              {d.applicationType !== "single" && (
                <DesignBriefGroups
                  details={d}
                  views={views}
                  onChange={detail}
                  sectionId={`${fieldId}-groups`}
                />
              )}
              {d.gui.kind !== "none" && (
                <DesignBriefGui
                  details={d}
                  views={views}
                  onChange={detail}
                  sectionId={`${fieldId}-gui`}
                />
              )}

              {!!warnings.length && (
                <aside className="design-brief-warnings" aria-label="简要说明填写提示">
                  <strong>待核对 {warnings.length} 项</strong>
                  <ul>
                    {warnings.map((w) => (
                      <li key={`${w.code}-${w.message}`}>{w.message}</li>
                    ))}
                  </ul>
                  <span>提示不会清除内容；可在导出页确认风险后继续。</span>
                </aside>
              )}
              <BriefDisclosure
                title="其他补充说明"
                summary={optionalSummary}
                expanded={optionsOpen}
                onToggle={() => setOptionsOpen(!optionsOpen)}
              >
                <DesignBriefOptions
                  design={design}
                  details={d}
                  partialDescriptionRequired={partialDescriptionRequired}
                  partialUseRequired={partialUseRequired}
                  onChange={onChange}
                  onSettingsChange={changeSettings}
                  otherDescriptionRef={(input) => {
                    omissionInput.current = input;
                  }}
                  requiredNotice={
                    newRequiredSection && (
                      <div className="design-brief-inline-action">
                        <span role="status">上方已显示当前类型新增的必填项。</span>
                        <button
                          type="button"
                          onClick={() => {
                            const section = document.getElementById(
                              `${fieldId}-${newRequiredSection}`,
                            );
                            section?.focus({ preventScroll: true });
                            section?.scrollIntoView?.({ block: "start" });
                            setNewRequiredSection(null);
                          }}
                        >
                          定位必填项
                        </button>
                      </div>
                    )
                  }
                />
              </BriefDisclosure>
            </div>
          ) : (
            <DesignBriefPreview productName={productName} design={design} ref={preview} />
          )}
          <footer className="design-patent-workbench__brief-actions">
            <span>填写内容会自动保存，可随时返回继续完善。</span>
            <button
              type="button"
              className="primary-button"
              onClick={mode === "fill" ? () => setMode("preview") : onReview}
            >
              {mode === "fill" ? "简要说明预览" : "前往导出"}
            </button>
          </footer>
        </article>
      </div>
    </section>
  );
}
