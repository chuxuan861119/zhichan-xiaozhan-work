import { useEffect, useState } from "react";
import type { AssetDescriptor } from "../../../../shared/document/model";
import type {
  DesignPatent,
  DesignPatentPrimarySlot,
} from "../../../../shared/patent/design-patent";
import { DESIGN_ASSIGNMENT_LABELS, suggestDesignAssignments } from "./design-assignment";
import { DesignAssignmentInspector } from "./design-assignment-inspector";

type PendingSuggestion = Record<string, { kind: DesignPatentPrimarySlot; evidence: string }>;

export function DesignAssetList({
  design,
  assets,
  autoSuggested = {},
  selectedViewId,
  previewUrls = {},
  onAssign,
  onRemove,
}: {
  design: DesignPatent;
  assets: readonly AssetDescriptor[];
  autoSuggested?: PendingSuggestion;
  selectedViewId: string | null;
  previewUrls?: Record<string, string>;
  onAssign(viewId: string, target: DesignPatentPrimarySlot | "unassigned"): void;
  onRemove?(viewId: string): void;
}) {
  const [selectedTarget, setSelectedTarget] = useState<DesignPatentPrimarySlot | "unassigned">(
    (design.views.find((view) => view.viewId === selectedViewId)?.kind as
      | DesignPatentPrimarySlot
      | "unassigned") ?? "unassigned",
  );

  const originalName = (view: DesignPatent["views"][number]) =>
    assets.find((asset) => asset.assetId === view.assetId)?.originalName ?? view.label;
  const held = design.views.filter((view) => view.kind === "unassigned");
  const occupied = new Set(
    design.views
      .filter((view) => view.kind !== "unassigned")
      .map((view) => view.kind as DesignPatentPrimarySlot),
  );
  const heldSuggestions = new Map(
    suggestDesignAssignments(
      held.map((view) => ({ id: view.viewId, originalName: originalName(view) })),
      occupied,
    ).map((suggestion) => [suggestion.id, suggestion]),
  );
  const selected = design.views.find((view) => view.viewId === selectedViewId) ?? null;
  const selectedKind = selected?.kind;
  useEffect(() => {
    if (selectedKind) setSelectedTarget(selectedKind as DesignPatentPrimarySlot | "unassigned");
  }, [selectedKind]);
  const pending = selected ? autoSuggested[selected.viewId] : undefined;
  const suggestion =
    selected?.kind === "unassigned" ? heldSuggestions.get(selected.viewId) : undefined;

  return (
    <section className="design-import-step__assets" aria-label="当前图片">
      <h2>当前图片</h2>
      <p>{design.views.length === 0 ? "尚未导入图片" : `已导入 ${design.views.length} 张图片`}</p>
      {selected ? (
        <section aria-label="已选图片检查器" className="design-import-step__inspector">
          {previewUrls[selected.viewId] ? (
            <img src={previewUrls[selected.viewId]} alt={`${selected.label}检查预览`} />
          ) : null}
          <h3>{selected.label}</h3>
          <p className="design-import-step__filename">{originalName(selected)}</p>
          <p>
            {selected.expression === "line-drawing"
              ? "线稿"
              : selected.expression === "photo"
                ? "实物照片"
                : "CAD 渲染图"}
          </p>
          {pending ? (
            <p>自动匹配待确认：{pending.evidence}</p>
          ) : (
            <DesignAssignmentInspector suggestion={suggestion} />
          )}
          <label>
            分配到
            <select
              aria-label="已选图片分配位置"
              value={selectedTarget}
              onChange={(event) =>
                setSelectedTarget(
                  event.currentTarget.value as DesignPatentPrimarySlot | "unassigned",
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onAssign(selected.viewId, selectedTarget);
                }
              }}
            >
              <option value="unassigned">暂存区</option>
              {Object.entries(DESIGN_ASSIGNMENT_LABELS).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => onAssign(selected.viewId, selectedTarget)}>
            确认分配
          </button>
          {onRemove ? (
            <button
              className="design-import-step__remove"
              type="button"
              onClick={() => onRemove(selected.viewId)}
            >
              移除当前图片
            </button>
          ) : null}
          <small>选择目标后按 Enter 或空格也可确认。</small>
        </section>
      ) : design.views.length > 0 ? (
        <p>从视图板或暂存区选择一张图片。</p>
      ) : null}
    </section>
  );
}
