import { memo, useMemo } from "react";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import type { PatentSession } from "../patents/patent-reducer";
import "./cad-reference-mark-panel.css";
import { AddReferenceMark, type AddReferenceMarkAction } from "../patents/reference-marks/add-reference-mark";

export function cadNumberSelection(projects: DrawingProject[], number: number) {
  return new Map(
    projects.map((project) => [
      project.projectId,
      project.annotations
        .filter((mark) => mark.text.trim() === String(number))
        .map((mark) => mark.id),
    ]),
  );
}

export const CadReferenceMarkPanel = memo(function CadReferenceMarkPanel({
  referenceMarks,
  projects,
  present: providedPresent,
  busy,
  onSelectNumber,
  onAddReferenceMark,
}: {
  referenceMarks: PatentSession["patent"]["referenceMarks"];
  projects?: DrawingProject[];
  present?: Set<string>;
  busy: boolean;
  onSelectNumber(number: number): void;
  onAddReferenceMark?: AddReferenceMarkAction;
}) {
  const present = useMemo(
    () =>
      providedPresent ??
      new Set(
        (projects ?? []).flatMap((project) => project.annotations.map((mark) => mark.text.trim())),
      ),
    [projects, providedPresent],
  );
  return (
    <section
      className="reference-mark-panel cad-reference-mark-panel"
      aria-label="附图标记"
      tabIndex={-1}
      data-selectable-tool-text
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest("button"))
          event.currentTarget.focus({ preventScroll: true });
      }}
    >
      <header className="reference-mark-panel__header">
        <h3>附图标记</h3>
        <AddReferenceMark entries={referenceMarks} disabled={busy}
          {...(onAddReferenceMark ? { onAdd: onAddReferenceMark } : {})} />
      </header>
      {referenceMarks.length ? (
        <>
          <div className="reference-mark-panel__columns" aria-hidden="true">
            <span>序号</span>
            <span>关键词</span>
            <span />
          </div>
          <div className="reference-mark-panel__rows">
            {referenceMarks.map((entry) => {
              const exists = present.has(String(entry.number));
              return (
                <button
                  key={entry.referenceMarkId}
                  type="button"
                  className="reference-mark-panel__row-summary cad-reference-mark-row"
                  aria-label={`选中标号${entry.number}`}
                  disabled={busy}
                  onClick={(event) => {
                    const selection = window.getSelection();
                    if (
                      event.detail > 0 &&
                      selection &&
                      !selection.isCollapsed &&
                      selection.anchorNode &&
                      event.currentTarget.contains(selection.anchorNode)
                    )
                      return;
                    onSelectNumber(entry.number);
                  }}
                >
                  <span className="reference-mark-panel__row-number">{entry.number}</span>
                  <span className="reference-mark-panel__row-keyword">{entry.keyword}</span>
                  <span
                    className="cad-reference-mark-status"
                    role="img"
                    data-status={exists ? "present" : "missing"}
                    aria-label={`标号${entry.number}：${exists ? "已存在" : "尚未标注"}`}
                    title={exists ? "全部图纸中已存在该标号" : "全部图纸中尚未标注该编号"}
                  />
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <p className="reference-mark-panel__empty">暂无附图标记</p>
      )}
    </section>
  );
});
