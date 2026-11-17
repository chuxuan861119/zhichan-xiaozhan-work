import { useEffect, useState } from "react";
import {
  PATENT_WORKSPACE_TOOL_LABELS,
  type PatentDocumentTarget,
  patentDocumentTargetKey,
  patentDocumentTargetsEqual,
} from "../../../shared/patent/document-target";
import {
  availablePatentBookKinds,
  PATENT_BOOK_LABELS,
  type PatentBookKind,
} from "../../../shared/patent/model";
import type { PatentSession } from "./patent-reducer";
import type { PatentBookTarget } from "./patent-workspace-layout";

type PatentBookPickerProps = Readonly<{
  sessions: readonly PatentSession[];
  selectedPatentId: string | null;
  excludedTarget: PatentDocumentTarget | PatentBookTarget | null;
  excludedTargets?: readonly (PatentDocumentTarget | PatentBookTarget)[];
  onSelectPatent(patentId: string): void;
  onSelectTarget(target: PatentDocumentTarget | PatentBookTarget): void;
  onRevealExistingPane?(): void;
  onOpenOtherPatent(): void;
}>;

export type PatentBookSwitcherProps = Readonly<{
  sessions: readonly PatentSession[];
  currentTarget: PatentDocumentTarget | PatentBookTarget;
  excludedTarget: PatentDocumentTarget | PatentBookTarget | null;
  excludedTargets?: readonly (PatentDocumentTarget | PatentBookTarget)[];
  requestedPatentId?: string | null;
  onRequestedPatentApplied?(): void;
  onSelectTarget(target: PatentDocumentTarget | PatentBookTarget): void;
  onRevealExistingPane?(): void;
  onOpenOtherPatent(): void;
}>;

function patentName(session: PatentSession): string {
  return session.patent.name?.trim() || "未命名专利";
}

function availableKinds(session: PatentSession): PatentBookKind[] {
  const existingKinds = new Set(session.patent.books.map((book) => book.kind));
  return availablePatentBookKinds(session.patent).filter((kind) => existingKinds.has(kind));
}

function normalizeTarget(target: PatentDocumentTarget | PatentBookTarget): PatentDocumentTarget {
  return "kind" in target ? target : { ...target, kind: "book" };
}

function targetLabel(
  sessions: readonly PatentSession[],
  target: PatentDocumentTarget | PatentBookTarget,
): string {
  const normalized = normalizeTarget(target);
  if (normalized.kind === "tool") return PATENT_WORKSPACE_TOOL_LABELS[normalized.tool];
  if (normalized.kind === "book") return PATENT_BOOK_LABELS[normalized.bookKind];
  return (
    sessions
      .find((session) => session.patentId === normalized.patentId)
      ?.patent.auxiliaryDocuments.find(
        (document) => document.auxiliaryDocumentId === normalized.auxiliaryDocumentId,
      )?.title ?? "其他文档"
  );
}

export function PatentBookPicker({
  sessions,
  selectedPatentId,
  excludedTarget,
  excludedTargets = [],
  onSelectPatent,
  onSelectTarget,
  onRevealExistingPane,
  onOpenOtherPatent,
}: PatentBookPickerProps) {
  const selectedSession =
    sessions.find((session) => session.patentId === selectedPatentId) ?? sessions[0] ?? null;
  const unavailableTargets = excludedTarget
    ? [excludedTarget, ...excludedTargets]
    : excludedTargets;
  const choices = selectedSession
    ? [
        ...availableKinds(selectedSession).map((bookKind) => ({
          target: { patentId: selectedSession.patentId, bookKind } satisfies PatentBookTarget,
          label: PATENT_BOOK_LABELS[bookKind],
        })),
        ...(["flowchart", "drawing-markup"] as const).map((tool) => ({
          target: {
            patentId: selectedSession.patentId,
            kind: "tool",
            tool,
          } satisfies PatentDocumentTarget,
          label: PATENT_WORKSPACE_TOOL_LABELS[tool],
        })),
      ].filter(({ target }) =>
        unavailableTargets.every(
          (unavailable) =>
            !patentDocumentTargetsEqual(normalizeTarget(target), normalizeTarget(unavailable)),
        ),
      )
    : [];

  return (
    <section className="patent-book-picker" aria-label="选择同屏文档">
      <div className="patent-book-picker__column">
        <h2>已打开的专利</h2>
        <ul aria-label="已打开的专利">
          {sessions.map((session) => (
            <li key={session.patentId}>
              <button
                type="button"
                aria-pressed={selectedSession?.patentId === session.patentId}
                onClick={() => onSelectPatent(session.patentId)}
              >
                {patentName(session)}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="patent-book-picker__open-other"
          onClick={onOpenOtherPatent}
        >
          打开其他专利……
        </button>
      </div>

      <div className="patent-book-picker__column patent-book-picker__column--books">
        <h2>文档</h2>
        {selectedSession && choices.length > 0 ? (
          <ul aria-label={`${patentName(selectedSession)}的文档`}>
            {choices.map(({ target, label }) => (
              <li key={patentDocumentTargetKey(normalizeTarget(target))}>
                <button type="button" onClick={() => onSelectTarget(target)}>
                  {label}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="patent-book-picker__empty">请选择文档</p>
        )}
        {selectedSession &&
        excludedTarget?.patentId === selectedSession.patentId &&
        onRevealExistingPane ? (
          <button
            type="button"
            className="patent-book-picker__reveal-existing"
            onClick={onRevealExistingPane}
          >
            切换到另一侧的{targetLabel(sessions, excludedTarget)}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function PatentBookSwitcher({
  sessions,
  currentTarget,
  excludedTarget,
  excludedTargets = [],
  requestedPatentId = null,
  onRequestedPatentApplied,
  onSelectTarget,
  onRevealExistingPane,
  onOpenOtherPatent,
}: PatentBookSwitcherProps) {
  const [selectedPatentId, setSelectedPatentId] = useState(currentTarget.patentId);

  useEffect(() => {
    setSelectedPatentId(currentTarget.patentId);
  }, [currentTarget.patentId]);

  useEffect(() => {
    if (!requestedPatentId) return;
    setSelectedPatentId(requestedPatentId);
    onRequestedPatentApplied?.();
  }, [onRequestedPatentApplied, requestedPatentId]);

  return (
    <PatentBookPicker
      sessions={sessions}
      selectedPatentId={selectedPatentId}
      excludedTarget={excludedTarget}
      excludedTargets={excludedTargets}
      onSelectPatent={setSelectedPatentId}
      onSelectTarget={onSelectTarget}
      onOpenOtherPatent={onOpenOtherPatent}
      {...(onRevealExistingPane ? { onRevealExistingPane } : {})}
    />
  );
}
