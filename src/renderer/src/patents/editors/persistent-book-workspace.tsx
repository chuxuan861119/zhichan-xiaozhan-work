import { type ReactElement, type ReactNode, useLayoutEffect, useRef } from "react";
import { isPatentBookAvailable, type PatentBookKind } from "../../../../shared/patent/model";
import { useSpatialViewMotion } from "../../shared/use-spatial-view-motion";
import { animateDocumentStructureRulerEntry } from "../document-structure-ruler-motion";
import type { PatentSession } from "../patent-reducer";
import type { PatentBookTarget, WorkspacePane } from "../patent-workspace-layout";

const TEXT_BOOK_KINDS = new Set<PatentBookKind>(["claims", "description", "abstract"]);

export type PatentBookPlacement = Readonly<{
  pane: WorkspacePane;
  target: PatentBookTarget;
  active: boolean;
}>;

type LegacyPersistentBookWorkspaceProps = Readonly<{
  session: PatentSession;
  active: boolean;
  renderBook(session: PatentSession): ReactNode;
}>;

type PlacementPersistentBookWorkspaceProps = Readonly<{
  sessions: readonly PatentSession[];
  placements: readonly PatentBookPlacement[];
  renderBook(session: PatentSession, placement: PatentBookPlacement | null): ReactNode;
}>;

type PersistentBookWorkspaceProps =
  | LegacyPersistentBookWorkspaceProps
  | PlacementPersistentBookWorkspaceProps;

function sessionForBook(session: PatentSession, activeBookKind: PatentBookKind): PatentSession {
  return {
    ...session,
    activeBookKind,
    patent: { ...session.patent, activeBookKind },
  };
}

function targetKey(target: PatentBookTarget): string {
  return `${target.patentId}:${target.bookKind}`;
}

function sessionContainsBook(session: PatentSession, kind: PatentBookKind): boolean {
  return (
    isPatentBookAvailable(session.patent, kind) &&
    session.patent.books.some((book) => book.kind === kind)
  );
}

function LegacyWorkspace({ session, active, renderBook }: LegacyPersistentBookWorkspaceProps) {
  const workspaceRef = useRef<HTMLElement>(null);
  const previousView = useRef({ active, bookKind: session.activeBookKind });
  const visitedTextBooks = useRef(new Set<PatentBookKind>());
  if (TEXT_BOOK_KINDS.has(session.activeBookKind)) {
    visitedTextBooks.current.add(session.activeBookKind);
  }

  useLayoutEffect(() => {
    const previous = previousView.current;
    previousView.current = { active, bookKind: session.activeBookKind };
    const shouldAnimate =
      active && (!previous.active || previous.bookKind !== session.activeBookKind);
    if (!shouldAnimate) return undefined;
    const ruler = workspaceRef.current?.querySelector<HTMLElement>(
      '.patent-book-transition-surface[data-active="true"] .document-structure-ruler',
    );
    const animation = animateDocumentStructureRulerEntry(ruler);
    if (!animation) return undefined;
    return () => animation.cancel();
  }, [active, session.activeBookKind]);

  return (
    <section
      ref={workspaceRef}
      className="persistent-book-workspace--legacy"
      hidden={!active}
      data-patent-workspace={session.patentId}
    >
      {[...visitedTextBooks.current].map((bookKind) => {
        const bookActive = bookKind === session.activeBookKind;
        return (
          <div
            key={bookKind}
            className="patent-book-transition-surface"
            data-active={bookActive}
            data-book-kind={bookKind}
            aria-hidden={bookActive ? undefined : true}
            inert={bookActive ? undefined : true}
          >
            <div data-book-transition-content>{renderBook(sessionForBook(session, bookKind))}</div>
          </div>
        );
      })}
      {!TEXT_BOOK_KINDS.has(session.activeBookKind) ? (
        <div
          key={session.activeBookKind}
          className="patent-book-transition-surface"
          data-active="true"
          data-book-kind={session.activeBookKind}
        >
          <div data-book-transition-content>{renderBook(session)}</div>
        </div>
      ) : null}
    </section>
  );
}

function PlacementWorkspace({
  sessions,
  placements,
  renderBook,
}: PlacementPersistentBookWorkspaceProps) {
  const stage = useRef<HTMLElement>(null);
  const placementViewKey = placements
    .map((placement) => `${targetKey(placement.target)}:${placement.pane}`)
    .join("|");
  const leftTarget = placements.find((placement) => placement.pane === "left")?.target;
  const rightTarget = placements.find((placement) => placement.pane === "right")?.target;
  const leftKey = leftTarget ? targetKey(leftTarget) : "";
  const rightKey = rightTarget ? targetKey(rightTarget) : "";
  const previousPaneTargets = useRef({ left: leftKey, right: rightKey });
  useSpatialViewMotion(stage, placementViewKey);
  useLayoutEffect(() => {
    const previous = previousPaneTargets.current;
    previousPaneTargets.current = { left: leftKey, right: rightKey };
    const animations: Animation[] = [];
    for (const key of [
      previous.left === leftKey ? "" : leftKey,
      previous.right === rightKey ? "" : rightKey,
    ]) {
      if (!key) continue;
      const target = [
        ...(stage.current?.querySelectorAll<HTMLElement>("[data-book-target]") ?? []),
      ].find((candidate) => candidate.dataset.bookTarget === key && !candidate.hidden);
      const animation = animateDocumentStructureRulerEntry(
        target?.querySelector<HTMLElement>(".document-structure-ruler"),
      );
      if (animation) animations.push(animation);
    }
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, [leftKey, rightKey]);
  const visitedTextTargets = useRef(new Map<string, PatentBookTarget>());
  const sessionByPatentId = new Map(sessions.map((session) => [session.patentId, session]));
  const visiblePlacements = new Map<string, PatentBookPlacement>();

  for (const placement of placements) {
    const key = targetKey(placement.target);
    if (visiblePlacements.has(key)) continue;
    const session = sessionByPatentId.get(placement.target.patentId);
    if (!session || !sessionContainsBook(session, placement.target.bookKind)) continue;
    visiblePlacements.set(key, placement);
    if (TEXT_BOOK_KINDS.has(placement.target.bookKind)) {
      visitedTextTargets.current.set(key, placement.target);
    }
  }

  const renderedTargets = new Map(visitedTextTargets.current);
  for (const [key, placement] of visiblePlacements) {
    if (!TEXT_BOOK_KINDS.has(placement.target.bookKind)) {
      renderedTargets.set(key, placement.target);
    }
  }

  return (
    <section
      ref={stage}
      className="persistent-book-workspace"
      data-persistent-book-workspace="true"
    >
      {[...renderedTargets].map(([key, target]) => {
        const session = sessionByPatentId.get(target.patentId);
        if (!session || !sessionContainsBook(session, target.bookKind)) {
          visitedTextTargets.current.delete(key);
          return null;
        }
        const placement = visiblePlacements.get(key) ?? null;
        return (
          <div
            key={key}
            hidden={!placement}
            data-book-target={key}
            data-workspace-pane={placement?.pane}
            data-active={placement?.active || undefined}
          >
            {renderBook(sessionForBook(session, target.bookKind), placement)}
          </div>
        );
      })}
    </section>
  );
}

export function PersistentBookWorkspace(props: LegacyPersistentBookWorkspaceProps): ReactElement;
export function PersistentBookWorkspace(props: PlacementPersistentBookWorkspaceProps): ReactElement;
export function PersistentBookWorkspace(props: PersistentBookWorkspaceProps) {
  if ("session" in props) return <LegacyWorkspace {...props} />;
  return <PlacementWorkspace {...props} />;
}
