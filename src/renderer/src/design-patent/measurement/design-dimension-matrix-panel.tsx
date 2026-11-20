import { useState } from "react";
import type { DesignDimensionMatrix } from "../../../../shared/patent/design-dimension-matrix";
import type { DesignPatent } from "../../../../shared/patent/design-patent";

const STATE_LABEL = {
  missing: "缺少视图",
  unmeasured: "未测量",
  "automatic-unconfirmed": "自动识别，待人工确认",
  "manual-unconfirmed": "人工边界，待确认",
  confirmed: "人工边界已确认",
} as const;

const VIEW_LABEL = {
  front: "主视图",
  rear: "后视图",
  left: "左视图",
  right: "右视图",
  top: "俯视图",
  bottom: "仰视图",
} as const;

export function DesignDimensionMatrixPanel({
  matrix,
  views,
  referenceViewId,
  onReferenceChange,
  onManualBounds,
  onCorrect,
}: {
  matrix: DesignDimensionMatrix;
  views: readonly DesignPatent["views"][number][];
  referenceViewId: string | null;
  onReferenceChange(viewId: string | null): void;
  onManualBounds(
    viewId: string,
    bounds: NonNullable<DesignPatent["views"][number]["subjectBounds"]>,
  ): void;
  onCorrect(viewId: string): void;
}) {
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NonNullable<
    DesignPatent["views"][number]["subjectBounds"]
  > | null>(null);
  return (
    <section className="design-dimension-matrix" aria-labelledby="dimension-matrix-heading">
      <header>
        <div>
          <h2 id="dimension-matrix-heading" tabIndex={-1}>
            六视图长宽高对应
          </h2>
          <p>软件以 5% 为提示阈值；请人工确认产品主体边界后再判断比例。</p>
        </div>
        <label>
          尺寸比例参考视图
          <select
            aria-label="尺寸比例参考视图"
            value={referenceViewId ?? ""}
            onChange={(event) => onReferenceChange(event.currentTarget.value || null)}
          >
            <option value="">自动选择主视图或首个六视图</option>
            {views
              .filter((view) => view.kind in VIEW_LABEL)
              .map((view) => (
                <option key={view.viewId} value={view.viewId}>
                  {view.label}
                </option>
              ))}
          </select>
        </label>
      </header>
      {matrix.groups.map((group) => (
        <section key={group.axis} aria-label={`${group.label}对应`}>
          <h3>{group.label}对应</h3>
          <div className="design-dimension-matrix__cells">
            {group.cells.map((cell) => {
              const actualView = cell.viewId
                ? views.find((view) => view.viewId === cell.viewId)
                : null;
              const editing = cell.viewId === editingViewId && draft !== null;
              return (
                <article key={cell.kind}>
                  <strong>{VIEW_LABEL[cell.kind]}</strong>
                  <span>{cell.valuePx === null ? "—" : `${cell.valuePx} px`}</span>
                  <small>{STATE_LABEL[cell.state]}</small>
                  {cell.baseline ? <em>基准</em> : null}
                  {cell.difference !== null && cell.difference > 0 ? (
                    <p>
                      相对基准偏{cell.direction === "larger" ? "大" : "小"}{" "}
                      {Math.round(cell.difference * 100)}%
                    </p>
                  ) : null}
                  {cell.viewId && cell.state !== "confirmed" && cell.state !== "missing" ? (
                    editing ? (
                      <fieldset>
                        <legend>人工边界</legend>
                        {(["leftPx", "topPx", "widthPx", "heightPx"] as const).map((field) => (
                          <label key={field}>
                            {field}
                            <input
                              aria-label={`${VIEW_LABEL[cell.kind]}边界 ${field.replace("Px", "")}`}
                              type="number"
                              min="0"
                              value={draft[field]}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  [field]: Math.max(
                                    field === "widthPx" || field === "heightPx" ? 1 : 0,
                                    Number(event.target.value),
                                  ),
                                })
                              }
                            />
                          </label>
                        ))}
                        <button
                          type="button"
                          onClick={() => {
                            onManualBounds(cell.viewId!, draft);
                            setEditingViewId(null);
                            setDraft(null);
                          }}
                        >
                          保存{VIEW_LABEL[cell.kind]}人工边界
                        </button>
                      </fieldset>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          if (actualView?.subjectBounds) {
                            setEditingViewId(cell.viewId!);
                            setDraft(actualView.subjectBounds);
                          }
                        }}
                      >
                        编辑{VIEW_LABEL[cell.kind]}边界
                      </button>
                    )
                  ) : null}
                  {cell.viewId ? (
                    <button type="button" onClick={() => onCorrect(cell.viewId!)}>
                      校正{VIEW_LABEL[cell.kind]}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
          {group.softwarePrompt ? <p role="status">{group.softwarePrompt.message}</p> : null}
        </section>
      ))}
    </section>
  );
}
