import type { ReactNode } from "react";
import type { DesignBriefDetails } from "../../../../shared/patent/design-brief-details";
import type { DesignPatent } from "../../../../shared/patent/design-patent";
import { BriefFieldLabel, BriefTextField } from "./design-brief-fields";

export function DesignBriefOptions({
  design,
  details: d,
  partialDescriptionRequired,
  partialUseRequired,
  onChange,
  onSettingsChange,
  otherDescriptionRef,
  requiredNotice,
}: {
  design: DesignPatent;
  details: DesignBriefDetails;
  partialDescriptionRequired: boolean;
  partialUseRequired: boolean;
  onChange(design: DesignPatent): void;
  onSettingsChange(design: DesignPatent): void;
  otherDescriptionRef(element: HTMLInputElement | HTMLTextAreaElement | null): void;
  requiredNotice: ReactNode;
}) {
  const { brief } = design;
  const gui = d.gui;
  const update = (patch: Partial<DesignPatent["brief"]>) =>
    onChange({ ...design, brief: { ...brief, ...patch } });
  const detail = (patch: Partial<DesignBriefDetails>) => update({ details: { ...d, ...patch } });
  const setting = (patch: Partial<DesignBriefDetails>) =>
    onSettingsChange({ ...design, brief: { ...brief, details: { ...d, ...patch } } });
  const updateGuiSetting = (patch: Partial<DesignBriefDetails["gui"]>) =>
    setting({ gui: { ...gui, ...patch } });
  const updateGuiExtra = (patch: Partial<DesignBriefDetails["gui"]>) =>
    detail({ gui: { ...gui, ...patch } });
  return (
    <>
      <fieldset className="design-patent-workbench__form-section design-brief-option-section">
        <legend>申请设置</legend>
        <label>
          <BriefFieldLabel label="申请组织类型" />
          <select
            aria-label="申请组织类型"
            value={d.applicationType}
            onChange={(e) =>
              setting({
                applicationType: e.currentTarget.value as DesignBriefDetails["applicationType"],
              })
            }
          >
            <option value="single">单项设计</option>
            <option value="similar">同一产品的相似设计</option>
            <option value="set">成套产品</option>
            <option value="component">组件产品</option>
          </select>
        </label>
        <label>
          <BriefFieldLabel label="产品形态" />
          <select
            aria-label="产品形态"
            value={d.productForm}
            onChange={(e) =>
              setting({
                productForm: e.currentTarget.value as DesignBriefDetails["productForm"],
              })
            }
          >
            <option value="solid">立体产品</option>
            <option value="flat">平面产品</option>
          </select>
        </label>
        <label>
          <BriefFieldLabel label="设计范围" />
          <select
            aria-label="设计范围"
            value={design.subject}
            onChange={(e) =>
              onSettingsChange({
                ...design,
                subject: e.currentTarget.value as DesignPatent["subject"],
              })
            }
          >
            <option value="whole-product">整体产品设计</option>
            <option value="partial-design">产品的局部设计</option>
          </select>
        </label>
        <label>
          <BriefFieldLabel label="图形用户界面（GUI）" />
          <select
            aria-label="图形用户界面（GUI）"
            value={d.gui.kind}
            onChange={(e) =>
              setting({
                gui: {
                  ...d.gui,
                  kind: e.currentTarget.value as DesignBriefDetails["gui"]["kind"],
                },
              })
            }
          >
            <option value="none">不涉及 GUI</option>
            <option value="static">静态 GUI</option>
            <option value="dynamic">动态 GUI</option>
          </select>
        </label>
        <p className="design-brief-note">
          类型切换会保留草稿，不删除图片。成套产品应成套出售或使用；组件产品指由多个构件组成的同一产品。相似设计用于同一产品的多项相似设计，不等同于多个视角。
        </p>

        {design.subject === "partial-design" && (
          <label>
            <BriefFieldLabel label="局部保护部分的表示方式" />
            <select
              aria-label="局部保护部分的表示方式"
              value={d.partialRepresentation}
              onChange={(e) =>
                setting({
                  partialRepresentation: e.currentTarget
                    .value as DesignBriefDetails["partialRepresentation"],
                })
              }
            >
              <option value="unspecified">请选择表示方式</option>
              <option value="lines">实线为保护部分，虚线为其他部分</option>
              <option value="mask">颜色蒙版或其他遮蔽方式</option>
              <option value="other">其他表示方式</option>
            </select>
          </label>
        )}
        {gui.kind !== "none" && (
          <>
            <label>
              <BriefFieldLabel label="GUI 图片提交方式" />
              <select
                aria-label="GUI 图片提交方式"
                value={gui.submission}
                onChange={(e) =>
                  updateGuiSetting({ submission: e.currentTarget.value as typeof gui.submission })
                }
              >
                <option value="with-product">带有所应用产品的视图</option>
                <option value="gui-only">不带有所应用产品的界面视图</option>
              </select>
            </label>
            <label>
              <BriefFieldLabel label="GUI 设计要点范围" />
              <select
                aria-label="GUI 设计要点范围"
                value={gui.scope}
                onChange={(e) =>
                  updateGuiSetting({ scope: e.currentTarget.value as typeof gui.scope })
                }
              >
                <option value="interface-only">仅在于图形用户界面</option>
                <option value="interface-and-product">界面及其所应用产品</option>
                <option value="interface-part">仅在于界面中的局部</option>
              </select>
            </label>
            <p className="design-brief-note">
              局部外观设计的设计要点仅在于界面或界面中的局部；不带产品的界面视图应按局部外观设计方式提交。选择不会自动切换类型或修改图片，有不一致时仅提示核对。
            </p>
          </>
        )}
        {requiredNotice}
      </fieldset>
      <fieldset className="design-patent-workbench__form-section design-brief-option-section">
        <legend>设计与画法补充</legend>
        <BriefTextField
          label="设计要点具体描述（选填）"
          value={d.pointDescription}
          onChange={(pointDescription) => detail({ pointDescription })}
          help="填写后以此具体描述替代上方概括词；GUI 仍自动保留所选的设计要点范围。"
        />
        <label>
          <BriefFieldLabel label="单元图案连续方式（选填）" />
          <select
            aria-label="单元图案连续方式（选填）"
            value={brief.continuousSurface ?? ""}
            onChange={(e) =>
              update({
                continuousSurface: (e.currentTarget.value ||
                  null) as DesignPatent["brief"]["continuousSurface"],
              })
            }
          >
            <option value="">无</option>
            <option value="up-down">上下两方连续</option>
            <option value="left-right">左右两方连续</option>
            <option value="all-sides">四方连续</option>
          </select>
        </label>
        <p className="design-brief-note">
          连续方式仅用于无特定边界的重复单元图案，不表示动态界面变化。
        </p>
        <label className="design-brief-check">
          <input
            type="checkbox"
            checked={brief.elongatedObjectLengthOmitted}
            onChange={(e) => update({ elongatedObjectLengthOmitted: e.currentTarget.checked })}
          />
          细长物品省略长度
        </label>

        {design.subject === "partial-design" && (
          <>
            <label className="design-brief-check">
              <input
                type="checkbox"
                checked={d.partialBoundary}
                onChange={(e) => detail({ partialBoundary: e.currentTarget.checked })}
              />
              点划线仅表示保护部分的分界线，不请求保护该线
            </label>
            {!partialDescriptionRequired && (
              <BriefTextField
                label="局部设计保护部分及表示方式（选填）"
                value={brief.partialDesignDescription}
                onChange={(partialDesignDescription) => update({ partialDesignDescription })}
              />
            )}
            {!partialUseRequired && (
              <BriefTextField
                label="请求保护局部的用途（选填）"
                value={d.partialUse}
                onChange={(partialUse) => detail({ partialUse })}
                help="必要时说明局部本身的用途，不以此代替产品用途。"
              />
            )}
          </>
        )}
      </fieldset>
      <fieldset className="design-patent-workbench__form-section design-brief-option-section">
        <legend>补充内容</legend>
        <BriefTextField
          label="材料说明（选填）"
          value={brief.materialDescription}
          onChange={(materialDescription) => update({ materialDescription })}
          help="仅在材料导致透明、反光等特殊视觉效果、需要说明时填写，不写材料配方或技术性能。"
        />
        <BriefTextField
          label="不属于保护范围的内部结构说明（选填）"
          value={brief.excludedInteriorDescription}
          onChange={(excludedInteriorDescription) => update({ excludedInteriorDescription })}
          help="必要时说明不可见内部结构不属于保护内容，不描述工作原理或功能效果。"
        />

        {gui.kind !== "none" && (
          <>
            <BriefTextField
              label="GUI 在产品中的位置（选填）"
              value={gui.location}
              onChange={(location) => updateGuiExtra({ location })}
            />
            <BriefTextField
              label="人机交互方式（选填）"
              value={gui.interaction}
              max={4000}
              onChange={(interaction) => updateGuiExtra({ interaction })}
            />
          </>
        )}
        {d.applicationType === "component" && (
          <BriefTextField
            label="组件组合及使用关系（选填）"
            value={d.assemblyDescription}
            max={4000}
            onChange={(assemblyDescription) => detail({ assemblyDescription })}
            help="说明各构件之间的组合或使用关系，不描述技术性能。"
          />
        )}
        {d.gui.kind !== "none" && (
          <BriefTextField
            label="图形用户界面补充说明（选填）"
            value={brief.guiDescription}
            max={4000}
            onChange={(guiDescription) => update({ guiDescription })}
            help="用于补充结构化字段未覆盖的内容；历史说明原文会保留。"
          />
        )}
        {["set", "component"].includes(d.applicationType) && (
          <BriefTextField
            label="成套／组件产品补充说明（选填）"
            value={brief.setDescription}
            max={4000}
            onChange={(setDescription) => update({ setDescription })}
          />
        )}
        <BriefTextField
          label="其他需要说明的内容（选填）"
          inputRef={otherDescriptionRef}
          value={brief.otherDescription}
          max={4000}
          onChange={(otherDescription) => update({ otherDescription })}
          help="可补充图片名称、参考图／使用状态图说明等。请勿写商业宣传、技术性能或把说明书当作权利要求。"
        />
      </fieldset>
    </>
  );
}
