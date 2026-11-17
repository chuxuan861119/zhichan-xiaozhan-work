import { useEffect, useRef, useState } from "react";
import type { SnapshotContentPreview } from "../../../../shared/snapshot/model";
import { useSpatialViewMotion } from "../../shared/use-spatial-view-motion";
import type { SnapshotBookDiff } from "./snapshot-book-diff";
import { SnapshotBookPreview } from "./snapshot-book-preview";

export function SnapshotAuxiliaryPreview({
  preview,
  documentId,
  auxiliaryDocumentId,
  diff,
}: {
  preview: SnapshotContentPreview;
  documentId: string;
  auxiliaryDocumentId: string;
  diff: SnapshotBookDiff | null;
}) {
  const current = preview.current.auxiliaryDocuments?.find(
    (item) => item.auxiliaryDocumentId === auxiliaryDocumentId,
  );
  const baseline = preview.baseline?.auxiliaryDocuments?.find(
    (item) => item.auxiliaryDocumentId === auxiliaryDocumentId,
  );
  const item = current ?? baseline;
  const workspaceRef = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState<{ id: string } | null>(null);
  const selectedId = selection?.id;
  const detailRef = useRef<HTMLElement>(null);
  useSpatialViewMotion(detailRef, selectedId ?? "");
  const selectChange = (id: string) => setSelection({ id });
  useEffect(() => {
    if (!selection) return;
    const target = workspaceRef.current?.querySelector<HTMLElement>(
      `[data-snapshot-change-id="${CSS.escape(selection.id)}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.classList.add("is-snapshot-change-target");
    const timeout = window.setTimeout(
      () => target.classList.remove("is-snapshot-change-target"),
      900,
    );
    return () => {
      window.clearTimeout(timeout);
      target.classList.remove("is-snapshot-change-target");
    };
  }, [selection]);
  if (!item || !diff) return null;
  const selected = diff.changes.find((change) => change.id === selectedId);
  return (
    <div className="snapshot-content-preview__body spatial-view">
      <aside className="snapshot-content-preview__rail" aria-label="其他文档变化">
        <strong>{item.title}</strong>
        {!current ? (
          <p>此文档已删除，以下保留删除前的内容供核对。</p>
        ) : !baseline && preview.baseline ? (
          <p>新增文档</p>
        ) : null}
        {current && baseline && current.title !== baseline.title ? (
          <p>
            重命名：{baseline.title} → {current.title}
          </p>
        ) : null}
        {diff.changes.length === 0 ? (
          <p>{preview.baseline ? "正文没有变化。" : "初始内容。"}</p>
        ) : (
          diff.changes.map((change) => (
            <button
              type="button"
              key={change.id}
              onClick={() => selectChange(change.id)}
              className={selectedId === change.id ? "is-selected" : ""}
            >
              <strong>{change.locationLabel}</strong>
              <small>{change.summary}</small>
            </button>
          ))
        )}
      </aside>
      <main ref={workspaceRef} className="snapshot-content-preview__workspace">
        <SnapshotBookPreview
          key={auxiliaryDocumentId}
          displayTitle={item.title}
          diff={diff}
          documentId={documentId}
          currentRevision={preview.current.revision}
          onChangeSelected={selectChange}
        />
      </main>
      <section
        ref={detailRef}
        className="snapshot-content-preview__detail"
        aria-label="其他文档变化详情"
      >
        <p>{item.title}</p>
        {selected ? (
          selected.details.map((detail) => <p key={detail}>{detail}</p>)
        ) : (
          <p>点击变化位置查看详情。恢复会创建专利副本，不覆盖当前专利。</p>
        )}
      </section>
    </div>
  );
}
