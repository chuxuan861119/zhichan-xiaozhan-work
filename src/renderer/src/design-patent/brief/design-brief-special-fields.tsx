import { useState } from "react";
import {
  type DesignBriefDetails,
  getDesignGuiSequences,
} from "../../../../shared/patent/design-brief-details";
import type { DesignPatent } from "../../../../shared/patent/design-patent";
import { BriefFieldLabel, BriefTextField } from "./design-brief-fields";

type Props = {
  details: DesignBriefDetails;
  views: DesignPatent["views"];
  onChange(patch: Partial<DesignBriefDetails>): void;
  sectionId?: string;
};
export function DesignBriefGroups({ details: d, views, onChange, sectionId }: Props) {
  const title = { single: "设计", similar: "设计", set: "套件", component: "构件" }[
    d.applicationType
  ];
  const [removeId, setRemoveId] = useState<string | null>(null);
  const update = (id: string, patch: Partial<DesignBriefDetails["groups"][number]>) =>
    onChange({ groups: d.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) });
  const limit = d.applicationType === "similar" ? 10 : 100;
  return (
    <fieldset
      id={sectionId}
      tabIndex={sectionId ? -1 : undefined}
      className="design-patent-workbench__form-section design-brief-special"
    >
      <legend>
        {d.applicationType === "similar"
          ? "相似设计"
          : d.applicationType === "set"
            ? "成套产品"
            : "组件产品"}
      </legend>
      <p className="design-brief-note">
        {d.applicationType === "similar"
          ? "同一产品的相似设计最多 10 项，须指定一项基本设计。"
          : d.applicationType === "set"
            ? "分别列出各套件的产品名称，并关联对应图片；局部外观设计不能作为成套产品合案。"
            : "分别列出构件名称、组装关系及对应图片。"}{" "}
        建议在第一步使用多图模式，按设计／套件／构件命名图片；此处不会更改或删除图片。
      </p>
      {d.applicationType === "similar" && (
        <label>
          <BriefFieldLabel label="基本设计（条件必填）" />
          <select
            aria-label="基本设计（条件必填）"
            value={d.basicDesignId ?? ""}
            onChange={(e) => onChange({ basicDesignId: e.currentTarget.value || null })}
          >
            <option value="">请选择基本设计</option>
            {d.groups.map((g, i) => (
              <option key={g.id} value={g.id}>
                {g.name || `设计${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {d.applicationType === "component" && (
        <>
          <label>
            <BriefFieldLabel label="组装关系（条件必填）" />
            <select
              aria-label="组装关系（条件必填）"
              value={d.assembly}
              onChange={(e) =>
                onChange({ assembly: e.currentTarget.value as DesignBriefDetails["assembly"] })
              }
            >
              <option value="unspecified">请选择组装关系</option>
              <option value="unique">组装关系唯一</option>
              <option value="variable">组装关系不唯一</option>
              <option value="none">各构件之间无组装关系</option>
            </select>
          </label>
        </>
      )}
      <div className="design-brief-groups">
        {d.groups.map((g, i) => (
          <fieldset key={g.id} className="design-brief-group">
            <legend>
              {title} {i + 1}
            </legend>
            <div className="design-brief-group__heading">
              <BriefTextField
                label={`${title} ${i + 1} 名称（条件必填）`}
                singleLine
                max={100}
                value={g.name}
                onChange={(name) => update(g.id, { name })}
              />
              <button type="button" onClick={() => setRemoveId(g.id)}>
                移除分组
              </button>
            </div>
            {removeId === g.id && (
              <div className="design-brief-note">
                仅移除此分组及其关联，不删除图片。
                <button
                  type="button"
                  onClick={() => {
                    onChange({
                      groups: d.groups.filter((item) => item.id !== g.id),
                      ...(d.basicDesignId === g.id ? { basicDesignId: null } : {}),
                    });
                    setRemoveId(null);
                  }}
                >
                  确认移除分组
                </button>
                <button type="button" onClick={() => setRemoveId(null)}>
                  保留分组
                </button>
              </div>
            )}
            <fieldset
              className="design-brief-image-choices"
              aria-label={`${title} ${i + 1} 关联图片`}
            >
              <legend>
                <BriefFieldLabel label="关联图片（条件必填）" />
              </legend>
              {views.map((v) => (
                <label key={v.viewId}>
                  <input
                    type="checkbox"
                    checked={g.viewIds.includes(v.viewId)}
                    disabled={g.viewIds.length >= 1000 && !g.viewIds.includes(v.viewId)}
                    onChange={(e) =>
                      update(g.id, {
                        viewIds: e.currentTarget.checked
                          ? [...g.viewIds, v.viewId]
                          : g.viewIds.filter((id) => id !== v.viewId),
                      })
                    }
                  />
                  {v.label}
                </label>
              ))}
              {!views.length && <p>尚无可关联图片，请先在第一步导入并分配。</p>}
              {g.viewIds.length >= 1000 && (
                <p>每项最多关联 1000 张图片，可先取消部分关联再调整，不会删除图片。</p>
              )}
              {g.viewIds
                .filter((id) => !views.some((v) => v.viewId === id))
                .map((id) => (
                  <p key={id} className="design-brief-stale">
                    关联图片已删除或未分配。
                    <button
                      type="button"
                      onClick={() =>
                        update(g.id, { viewIds: g.viewIds.filter((item) => item !== id) })
                      }
                    >
                      移除失效关联
                    </button>
                  </p>
                ))}
            </fieldset>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={d.groups.length >= limit}
          onClick={() =>
            onChange({
              groups: [
                ...d.groups,
                { id: crypto.randomUUID(), name: `${title}${d.groups.length + 1}`, viewIds: [] },
              ],
            })
          }
        >
          添加{title}
        </button>
        {d.groups.length >= limit && <small>已达到{limit}项；已有草稿不会自动删除。</small>}
      </div>
    </fieldset>
  );
}
export function DesignBriefGui({ details: d, views, onChange, sectionId }: Props) {
  const gui = d.gui,
    update = (patch: Partial<DesignBriefDetails["gui"]>) => onChange({ gui: { ...gui, ...patch } });
  const move = (i: number, delta: number) => {
    const frames = [...gui.frames];
    [frames[i], frames[i + delta]] = [frames[i + delta]!, frames[i]!];
    update({ frames });
  };
  return (
    <fieldset
      id={sectionId}
      tabIndex={sectionId ? -1 : undefined}
      className="design-patent-workbench__form-section design-brief-special"
    >
      <legend>图形用户界面（GUI）说明</legend>
      <BriefTextField
        label="GUI 用途（条件必填）"
        value={gui.use}
        onChange={(use) => update({ use })}
      />
      <BriefTextField
        label="所应用的产品（条件必填）"
        value={gui.product}
        max={1000}
        onChange={(product) => update({ product })}
        help="与产品名称及图片提交方式一致。不带产品提交时仍应说明所应用产品。"
      />
      {gui.kind === "dynamic" && (
        <>
          <BriefTextField
            label="动态变化过程（条件必填）"
            value={gui.changeProcess}
            max={4000}
            onChange={(changeProcess) => update({ changeProcess })}
            help="按图片顺序说明触发操作和状态变化；图片应能确定完整变化过程。"
          />
          <div className="design-brief-frames">
            <label>
              <BriefFieldLabel label="添加变化状态图片（条件必填）" />
              <select
                aria-label="添加变化状态图片"
                value=""
                onChange={(e) => {
                  if (e.currentTarget.value)
                    update({ frames: [...gui.frames, e.currentTarget.value] });
                }}
                disabled={gui.frames.length >= 200}
              >
                <option value="">选择图片加入序列</option>
                {views
                  .filter((v) => !gui.frames.includes(v.viewId))
                  .map((v) => (
                    <option key={v.viewId} value={v.viewId}>
                      {v.label}
                    </option>
                  ))}
              </select>
            </label>
            <p className="design-brief-note">
              动态 GUI
              的申报产品名称应包含“动态”字样。起始状态图片命名为“主视图”，后续按顺序命名为“变化状态图1、变化状态图2……”；多项设计可加设计／套件／构件前缀，各组分别编号。可返回第一步修改图片名称，不会改变图片内容。
            </p>
            <p className="design-brief-note">
              {d.applicationType === "single"
                ? "第一张为起始状态，后续按变化顺序排列。"
                : "系统按上方图片分组分别生成状态顺序；每组在列表中的首张为该组起始状态，请在变化过程中分别说明各项设计。"}
              此处只记录引用，不重排第一步中的图片。
            </p>
            <ol>
              {gui.frames.map((id, i) => (
                <li key={id}>
                  <span>
                    {views.find((v) => v.viewId === id)?.label ?? "图片已删除或未分配"}
                    {getDesignGuiSequences(d)
                      .filter((s) => s.frames[0] === id)
                      .map((s) => `（${s.name}起始状态）`)
                      .join("")}
                  </span>
                  <div>
                    <button
                      type="button"
                      aria-label={`上移状态 ${i + 1}`}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      aria-label={`下移状态 ${i + 1}`}
                      disabled={i === gui.frames.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      下移
                    </button>
                    <button
                      type="button"
                      aria-label={`移除状态 ${i + 1}`}
                      onClick={() =>
                        update({ frames: gui.frames.filter((_, index) => index !== i) })
                      }
                    >
                      移除
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </fieldset>
  );
}
