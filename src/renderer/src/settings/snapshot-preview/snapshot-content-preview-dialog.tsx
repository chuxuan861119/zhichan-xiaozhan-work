import { useEffect, useMemo, useRef, useState } from "react";
import {
  PATENT_BOOK_LABELS,
  PATENT_BOOK_ORDER,
  type PatentBookKind,
} from "../../../../shared/patent/model";
import type { SnapshotContentPreview } from "../../../../shared/snapshot/model";
import { DialogCloseIcon } from "../../shared/dialog-close-icon";
import { StandardDialog } from "../../shared/standard-dialog";
import { useSpatialViewMotion } from "../../shared/use-spatial-view-motion";
import { SnapshotAuxiliaryPreview } from "./snapshot-auxiliary-preview";
import type { SnapshotBookChange, SnapshotBookDiff } from "./snapshot-book-diff";
import { SnapshotBookPreview } from "./snapshot-book-preview";
import { SnapshotFiguresPreview } from "./snapshot-figures-preview";
import { figuresForBook } from "./snapshot-preview-calculation";
import { useSnapshotPreviewCalculation } from "./use-snapshot-preview-calculation";

const EMPTY_DIFFS: SnapshotBookDiff[] = [];

type Props = Readonly<{
  preview: SnapshotContentPreview;
  documentId: string;
  resourceMissing?: boolean;
  onClose(): void;
  embedded?: boolean;
}>;

export function SnapshotContentPreviewDialog({
  preview,
  documentId,
  resourceMissing = false,
  onClose,
  embedded = false,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const scrollTopByBook = useRef(new Map<PatentBookKind, number>());
  const selectedChangeByBook = useRef(new Map<PatentBookKind, string>());
  const resetIdentityRef = useRef("");
  const resetPreviewRef = useRef<SnapshotContentPreview | null>(null);
  const previewIdentity = `${documentId}:${preview.current.revision}`;
  const calculation = useSnapshotPreviewCalculation(preview);
  const diffs = calculation.value?.books ?? EMPTY_DIFFS;
  const allChanges = useMemo(() => diffs.flatMap((diff) => diff.changes), [diffs]);
  const firstChangedBookKind =
    diffs.find((diff) => diff.changes.length > 0)?.bookKind ?? PATENT_BOOK_ORDER[0];
  const firstChangeId = allChanges[0]?.id ?? null;
  const [activeBookKind, setActiveBookKind] = useState<PatentBookKind>(firstChangedBookKind);
  const [activeAuxiliaryId, setActiveAuxiliaryId] = useState("");
  const auxiliaryDocuments = [
    ...new Map(
      [
        ...(preview.baseline?.auxiliaryDocuments ?? []),
        ...(preview.current.auxiliaryDocuments ?? []),
      ].map((item) => [item.auxiliaryDocumentId, item]),
    ).values(),
  ];
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(firstChangeId);
  const [locateRequest, setLocateRequest] = useState({ id: firstChangeId });
  const selectedChange = allChanges.find((change) => change.id === selectedChangeId) ?? null;
  const detailRef = useRef<HTMLElement>(null);
  useSpatialViewMotion(workspaceRef, `${activeBookKind}:${activeAuxiliaryId}`);
  useSpatialViewMotion(detailRef, `${activeBookKind}:${selectedChangeId ?? ""}`);
  const selectedIndex = selectedChange ? allChanges.indexOf(selectedChange) : -1;
  const bookBoundaryIndices = useMemo(() => {
    const activeOrderIndex = PATENT_BOOK_ORDER.indexOf(activeBookKind);
    let previous = -1;
    let current = -1;
    let next = -1;
    for (const [index, change] of allChanges.entries()) {
      const changeOrderIndex = PATENT_BOOK_ORDER.indexOf(change.bookKind);
      if (changeOrderIndex < activeOrderIndex) previous = index;
      else if (changeOrderIndex === activeOrderIndex && current < 0) current = index;
      else if (changeOrderIndex > activeOrderIndex && next < 0) next = index;
    }
    return { previous, current, next };
  }, [activeBookKind, allChanges]);
  const previousIndex = selectedIndex >= 0 ? selectedIndex - 1 : bookBoundaryIndices.previous;
  const nextIndex =
    selectedIndex >= 0
      ? selectedIndex + 1
      : bookBoundaryIndices.current >= 0
        ? bookBoundaryIndices.current
        : bookBoundaryIndices.next;
  const activeDiff = diffs.find((diff) => diff.bookKind === activeBookKind) as SnapshotBookDiff;

  useEffect(() => {
    if (workspaceRef.current)
      workspaceRef.current.scrollTop = scrollTopByBook.current.get(activeBookKind) ?? 0;
  }, [activeBookKind]);

  useEffect(() => {
    if (!calculation.value) return;
    if (resetIdentityRef.current === previewIdentity && resetPreviewRef.current === preview) return;
    resetIdentityRef.current = previewIdentity;
    resetPreviewRef.current = preview;
    scrollTopByBook.current.clear();
    selectedChangeByBook.current.clear();
    if (firstChangeId) selectedChangeByBook.current.set(firstChangedBookKind, firstChangeId);
    setActiveBookKind(firstChangedBookKind);
    setActiveAuxiliaryId("");
    setSelectedChangeId(firstChangeId);
    setLocateRequest({ id: firstChangeId });
    if (workspaceRef.current) workspaceRef.current.scrollTop = 0;
  }, [calculation.value, firstChangeId, firstChangedBookKind, preview, previewIdentity]);

  useEffect(() => {
    if (
      !selectedChange ||
      selectedChange.id !== locateRequest.id ||
      selectedChange.bookKind !== activeBookKind
    )
      return;
    const target = dialogRef.current?.querySelector<HTMLElement>(
      selectedChange.id.startsWith("snapshot-figure-change-")
        ? `[data-snapshot-figure-id="${CSS.escape(selectedChange.blockId)}"]`
        : `[data-snapshot-change-id="${CSS.escape(selectedChange.id)}"]`,
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
  }, [activeBookKind, locateRequest, selectedChange]);

  const switchBook = (bookKind: PatentBookKind) => {
    setActiveAuxiliaryId("");
    if (workspaceRef.current)
      scrollTopByBook.current.set(activeBookKind, workspaceRef.current.scrollTop);
    setActiveBookKind(bookKind);
    setSelectedChangeId(selectedChangeByBook.current.get(bookKind) ?? null);
    setLocateRequest({ id: null });
  };
  const selectChange = (change: SnapshotBookChange) => {
    if (workspaceRef.current)
      scrollTopByBook.current.set(activeBookKind, workspaceRef.current.scrollTop);
    setActiveBookKind(change.bookKind);
    setSelectedChangeId(change.id);
    selectedChangeByBook.current.set(change.bookKind, change.id);
    setLocateRequest({ id: change.id });
  };
  const navigate = (offset: -1 | 1) => {
    const next = allChanges[offset === -1 ? previousIndex : nextIndex];
    if (next) selectChange(next);
  };
  const previewBody = !calculation.value ? (
    <div className="snapshot-content-preview__workspace">
      {calculation.failed ? (
        <>
          <p role="alert">差异预览计算失败，请重试。快照内容未受影响。</p>
          <button type="button" onClick={calculation.retry}>
            重新计算
          </button>
        </>
      ) : (
        <p role="status">正在计算内容差异…</p>
      )}
    </div>
  ) : (
    <>
      {resourceMissing ? (
        <p className="snapshot-content-preview__resource-warning" role="alert">
          该快照有资源缺失，正文仍可预览；缺失资源可能无法显示。
        </p>
      ) : null}
      {preview.skippedRevisions.length > 0 && preview.baseline ? (
        <p className="snapshot-content-preview__warning" role="alert">
          v{preview.skippedRevisions.join("、v")} 无法读取，当前 v{preview.current.revision} 改为与
          v{preview.baseline.revision} 比较。差异可能包含被跳过版本期间的累计修改。
        </p>
      ) : null}
      <div className="snapshot-content-preview__tabs" role="tablist" aria-label="五书内容">
        {diffs.map((diff) => (
          <button
            key={diff.bookKind}
            type="button"
            role="tab"
            aria-selected={!activeAuxiliaryId && activeBookKind === diff.bookKind}
            aria-label={`${PATENT_BOOK_LABELS[diff.bookKind]} ${diff.changes.length} 项变化`}
            onClick={() => switchBook(diff.bookKind)}
          >
            {PATENT_BOOK_LABELS[diff.bookKind]} <span>{diff.changes.length}</span>
          </button>
        ))}
        {auxiliaryDocuments.length > 0 ? (
          <label>
            其他文档{" "}
            <select
              aria-label="其他文档快照"
              value={activeAuxiliaryId}
              onChange={(event) => setActiveAuxiliaryId(event.currentTarget.value)}
            >
              <option value="">选择文档</option>
              {auxiliaryDocuments.map((item) => (
                <option key={item.auxiliaryDocumentId} value={item.auxiliaryDocumentId}>
                  {item.title}
                  {preview.current.auxiliaryDocuments?.some(
                    (current) => current.auxiliaryDocumentId === item.auxiliaryDocumentId,
                  )
                    ? ""
                    : "（已删除）"}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {activeAuxiliaryId ? (
        <SnapshotAuxiliaryPreview
          key={activeAuxiliaryId}
          preview={preview}
          documentId={documentId}
          auxiliaryDocumentId={activeAuxiliaryId}
          diff={calculation.value.auxiliary[activeAuxiliaryId] ?? null}
        />
      ) : (
        <div className="snapshot-content-preview__body spatial-view">
          <aside className="snapshot-content-preview__rail" aria-label="变化位置">
            {activeDiff.changes.length === 0 ? (
              <p>该文档没有可标记的内容变化。</p>
            ) : (
              activeDiff.changes.map((change) => (
                <button
                  key={change.id}
                  type="button"
                  className={change.id === selectedChangeId ? "is-selected" : ""}
                  aria-label={`${change.locationLabel}：${change.summary}`}
                  onClick={() => selectChange(change)}
                >
                  <strong>{kindLabel(change.kind)}</strong>
                  <span>
                    {PATENT_BOOK_LABELS[change.bookKind]} · {change.locationLabel}
                  </span>
                </button>
              ))
            )}
          </aside>
          <main ref={workspaceRef} className="snapshot-content-preview__workspace">
            {activeBookKind === "description-drawings" || activeBookKind === "abstract-drawing" ? (
              <SnapshotFiguresPreview
                title={PATENT_BOOK_LABELS[activeBookKind]}
                figures={figuresForBook(preview.current, activeBookKind)}
                baselineFigures={figuresForBook(preview.baseline, activeBookKind)}
                documentId={documentId}
                currentRevision={preview.current.revision}
                baselineRevision={preview.baseline?.revision ?? null}
              />
            ) : null}
            <SnapshotBookPreview
              diff={activeDiff}
              documentId={documentId}
              currentRevision={preview.current.revision}
              onChangeSelected={(id) => {
                const change = allChanges.find((item) => item.id === id);
                if (change) selectChange(change);
              }}
            />
          </main>
          <section
            ref={detailRef}
            className="snapshot-content-preview__detail"
            aria-label="变化详情"
            aria-live="polite"
          >
            <div className="snapshot-content-preview__navigation">
              <button type="button" onClick={() => navigate(-1)} disabled={previousIndex < 0}>
                上一个变化
              </button>
              <button
                type="button"
                onClick={() => navigate(1)}
                disabled={nextIndex < 0 || nextIndex >= allChanges.length}
              >
                下一个变化
              </button>
            </div>
            {selectedChange ? (
              <>
                <strong>
                  {kindLabel(selectedChange.kind)} · {selectedChange.locationLabel}
                </strong>
                {selectedChange.details.map((detail) => (
                  <p key={detail}>{detail}</p>
                ))}
              </>
            ) : (
              <p>请选择左侧变化位置查看详情。</p>
            )}
          </section>
        </div>
      )}
    </>
  );

  if (!embedded) {
    return (
      <StandardDialog
        open
        title={`v${preview.current.revision} 内容预览`}
        subtitle={comparisonText(preview)}
        size="xl"
        onCancel={onClose}
        movable
        resizable
        topInset={38}
        closeLabel="关闭内容预览"
        dialogRef={dialogRef}
        className="snapshot-content-preview__surface"
        bodyClassName="snapshot-content-preview__standard-body"
      >
        {previewBody}
      </StandardDialog>
    );
  }

  return (
    <div className="snapshot-content-preview snapshot-content-preview--embedded">
      {/* biome-ignore lint/a11y/useSemanticElements: this shared ref must also target the non-embedded dialog div. */}
      <div
        ref={dialogRef}
        className="snapshot-content-preview__surface"
        role="region"
        aria-label={`v${preview.current.revision} 内容预览`}
        tabIndex={-1}
      >
        <header className="snapshot-content-preview__header">
          <div>
            <p>{comparisonText(preview)}</p>
          </div>
          <button
            ref={closeRef}
            className="snapshot-content-preview__close dialog-close-button dialog-close-control"
            type="button"
            onClick={onClose}
            aria-label="关闭内容预览"
          >
            <DialogCloseIcon />
          </button>
        </header>
        {previewBody}
      </div>
    </div>
  );
}

function comparisonText(preview: SnapshotContentPreview): string {
  if (preview.comparison === "initial") return "初始基线，无更早快照可比较。";
  if (preview.comparison === "no-readable-baseline")
    return "没有可用的历史版本，无法生成差异标记。";
  if (!preview.baseline) throw new Error("比较快照缺少基线");
  return `与 v${preview.baseline.revision}（${formatTime(preview.baseline.createdAt)}）相比`;
}

function formatTime(value: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function kindLabel(kind: SnapshotBookChange["kind"]): string {
  if (kind === "insert") return "新增";
  if (kind === "delete") return "删除";
  if (kind === "format") return "格式变化";
  return "结构变化";
}
