import {
  isPatentDocumentTargetAvailable,
  type PatentDocumentTarget,
  patentDocumentTargetsEqual,
} from "../../../shared/patent/document-target";
import type { PatentBookKind } from "../../../shared/patent/model";
import {
  type CustomDualViewKind,
  type CustomDualViewPreset,
  isCustomDualViewPresetAvailable,
  isCustomDualViewToolKind,
} from "../../../shared/settings/custom-dual-view";

export type WorkspacePane = "left" | "right";

export type PatentBookTarget = Readonly<{
  patentId: string;
  bookKind: PatentBookKind;
}>;

export type PatentDocumentTargetInput = PatentDocumentTarget | PatentBookTarget;

export type DocumentPaneWorkspaceState = Readonly<{
  kind: "document";
  target: PatentDocumentTarget;
  dualZoomPercent: number;
  dualZoomManual?: boolean;
}>;

export type SelectionPaneWorkspaceState = Readonly<{
  kind: "selection";
  selectedPatentId: string | null;
}>;

export type PaneWorkspaceState = DocumentPaneWorkspaceState | SelectionPaneWorkspaceState;

export type PatentWorkspaceLayoutState = Readonly<{
  mode: "single" | "dual";
  activePane: WorkspacePane;
  singleTarget: PatentDocumentTarget | null;
  left: PaneWorkspaceState;
  right: PaneWorkspaceState;
}>;

export type PatentWorkspacePair = "claims-description" | "claims-drawings" | "drawings-description";

export type WorkspacePatentAvailability = Readonly<{
  patentId: string;
  availableBookKinds: readonly PatentBookKind[];
  auxiliaryDocumentIds?: readonly string[];
}>;

const DEFAULT_DUAL_ZOOM_PERCENT = 100;

const WORKSPACE_PAIRS: Readonly<
  Record<PatentWorkspacePair, readonly [PatentBookKind, PatentBookKind]>
> = {
  "claims-description": ["claims", "description"],
  "claims-drawings": ["claims", "description-drawings"],
  "drawings-description": ["description-drawings", "description"],
};

function documentPane(
  targetInput: PatentDocumentTargetInput,
  dualZoomPercent = DEFAULT_DUAL_ZOOM_PERCENT,
): DocumentPaneWorkspaceState {
  const target = normalizeTarget(targetInput);
  return { kind: "document", target, dualZoomPercent };
}

function normalizeTarget(target: PatentDocumentTargetInput): PatentDocumentTarget {
  return "kind" in target ? target : { ...target, kind: "book" };
}

function sameTarget(left: PatentDocumentTargetInput, right: PatentDocumentTargetInput): boolean {
  return patentDocumentTargetsEqual(normalizeTarget(left), normalizeTarget(right));
}

function selectionPane(selectedPatentId: string | null): SelectionPaneWorkspaceState {
  return { kind: "selection", selectedPatentId };
}

function otherPane(pane: WorkspacePane): WorkspacePane {
  return pane === "left" ? "right" : "left";
}

function paneTarget(pane: PaneWorkspaceState): PatentDocumentTarget | null {
  return pane.kind === "document" ? pane.target : null;
}

export function createSingleWorkspace(
  targetInput: PatentDocumentTargetInput | null,
): PatentWorkspaceLayoutState {
  const target = targetInput ? normalizeTarget(targetInput) : null;
  return {
    mode: "single",
    activePane: "left",
    singleTarget: target,
    left: target ? documentPane(target) : selectionPane(null),
    right: selectionPane(target?.patentId ?? null),
  };
}

export function enterDualWorkspace(state: PatentWorkspaceLayoutState): PatentWorkspaceLayoutState {
  if (state.mode === "dual") return state;

  const target = state.singleTarget ?? paneTarget(state.left);
  return {
    ...state,
    mode: "dual",
    activePane: "left",
    left: target ? documentPane(target) : selectionPane(null),
    right: selectionPane(target?.patentId ?? null),
  };
}

export function exitDualWorkspace(
  state: PatentWorkspaceLayoutState,
  preferredTargetInput: PatentDocumentTargetInput | null = null,
): PatentWorkspaceLayoutState {
  if (state.mode === "single" && preferredTargetInput === null) return state;

  const activeTarget = paneTarget(state[state.activePane]);
  const inactiveTarget = paneTarget(state[otherPane(state.activePane)]);
  const preferredTarget = preferredTargetInput ? normalizeTarget(preferredTargetInput) : null;
  return createSingleWorkspace(
    preferredTarget ?? activeTarget ?? inactiveTarget ?? state.singleTarget,
  );
}

export function closeDualWorkspacePane(
  state: PatentWorkspaceLayoutState,
  pane: WorkspacePane,
): PatentWorkspaceLayoutState {
  if (state.mode !== "dual") return state;

  return createSingleWorkspace(
    paneTarget(state[otherPane(pane)]) ?? paneTarget(state[pane]) ?? state.singleTarget,
  );
}

export function activateWorkspacePane(
  state: PatentWorkspaceLayoutState,
  pane: WorkspacePane,
): PatentWorkspaceLayoutState {
  return state.activePane === pane ? state : { ...state, activePane: pane };
}

/**
 * `singleCurrentTarget` 表示单屏实际显示的目标：内嵌 CAD标号/流程图 工作区独占单屏时，
 * `state.singleTarget` 仍是背后的书册，直接用它会把用户正看着的工作区挤出同屏。
 */
export function dropTargetIntoWorkspace(
  state: PatentWorkspaceLayoutState,
  pane: WorkspacePane,
  target: PatentDocumentTargetInput,
  singleCurrentTarget: PatentDocumentTargetInput | null = null,
): PatentWorkspaceLayoutState {
  const opposite = otherPane(pane);
  const paneDocument = paneTarget(state[pane]);
  const oppositeDocument = paneTarget(state[opposite]);

  if (state.mode === "single") {
    const current = singleCurrentTarget ?? state.singleTarget ?? paneDocument ?? oppositeDocument;
    if (current && sameTarget(current, target)) {
      return {
        ...state,
        mode: "dual",
        activePane: pane,
        [pane]: documentPane(target),
        [opposite]: selectionPane(target.patentId),
      };
    }
    return {
      ...state,
      mode: "dual",
      activePane: pane,
      [pane]: documentPane(target),
      [opposite]: current ? documentPane(current) : selectionPane(target.patentId),
    };
  }

  if (paneDocument && sameTarget(paneDocument, target)) {
    return activateWorkspacePane(state, pane);
  }
  if (oppositeDocument && sameTarget(oppositeDocument, target)) {
    return {
      ...state,
      activePane: pane,
      [pane]: state[opposite],
      [opposite]: state[pane],
    };
  }
  return {
    ...state,
    activePane: pane,
    [pane]: documentPane(
      target,
      state[pane].kind === "document" ? state[pane].dualZoomPercent : DEFAULT_DUAL_ZOOM_PERCENT,
    ),
  };
}

export function setWorkspacePaneZoom(
  state: PatentWorkspaceLayoutState,
  pane: WorkspacePane,
  dualZoomPercent: number,
  manual = false,
): PatentWorkspaceLayoutState {
  if (state.mode !== "dual" || state[pane].kind !== "document") return state;
  if (
    state[pane].dualZoomPercent === dualZoomPercent &&
    Boolean(state[pane].dualZoomManual) === manual
  )
    return state;
  return {
    ...state,
    [pane]: { ...state[pane], dualZoomPercent, dualZoomManual: manual },
  };
}

export function selectPaneTarget(
  state: PatentWorkspaceLayoutState,
  pane: WorkspacePane,
  targetInput: PatentDocumentTargetInput,
): Readonly<{
  state: PatentWorkspaceLayoutState;
  revealedPane: WorkspacePane | null;
}> {
  const oppositePane = otherPane(pane);
  const target = normalizeTarget(targetInput);
  const oppositeTarget = paneTarget(state[oppositePane]);
  if (oppositeTarget && patentDocumentTargetsEqual(oppositeTarget, target)) {
    return {
      state: activateWorkspacePane(state, oppositePane),
      revealedPane: oppositePane,
    };
  }

  return {
    state: {
      ...state,
      activePane: pane,
      [pane]: documentPane(target),
    },
    revealedPane: null,
  };
}

export function swapWorkspacePanes(state: PatentWorkspaceLayoutState): PatentWorkspaceLayoutState {
  if (state.mode !== "dual") return state;

  return {
    ...state,
    activePane: otherPane(state.activePane),
    left: state.right,
    right: state.left,
  };
}

export function applyWorkspacePair(
  state: PatentWorkspaceLayoutState,
  patentId: string,
  pair: PatentWorkspacePair,
  availableBookKinds: readonly PatentBookKind[],
): PatentWorkspaceLayoutState {
  const [leftKind, rightKind] = WORKSPACE_PAIRS[pair];
  return applyWorkspaceBookPair(state, patentId, leftKind, rightKind, availableBookKinds);
}

export function applyWorkspaceBookPair(
  state: PatentWorkspaceLayoutState,
  patentId: string,
  leftKind: PatentBookKind,
  rightKind: PatentBookKind,
  availableBookKinds: readonly PatentBookKind[],
): PatentWorkspaceLayoutState {
  if (leftKind === rightKind) return state;
  if (!availableBookKinds.includes(leftKind) || !availableBookKinds.includes(rightKind)) {
    return state;
  }

  return {
    ...state,
    mode: "dual",
    activePane: "left",
    left: documentPane({ patentId, kind: "book", bookKind: leftKind }),
    right: documentPane({ patentId, kind: "book", bookKind: rightKind }),
  };
}

export function applyWorkspaceCustomDualViewPreset(
  state: PatentWorkspaceLayoutState,
  patentId: string,
  preset: CustomDualViewPreset,
  availableBookKinds: readonly PatentBookKind[],
): PatentWorkspaceLayoutState {
  if (
    preset.leftBookKind === preset.rightBookKind ||
    !isCustomDualViewPresetAvailable(preset, availableBookKinds)
  )
    return state;
  const target = (kind: CustomDualViewKind): PatentDocumentTarget =>
    isCustomDualViewToolKind(kind)
      ? { patentId, kind: "tool", tool: kind }
      : { patentId, kind: "book", bookKind: kind };
  return {
    ...state,
    mode: "dual",
    activePane: "left",
    left: documentPane(target(preset.leftBookKind)),
    right: documentPane(target(preset.rightBookKind)),
  };
}

function availabilityFor(
  target: PatentDocumentTarget,
  availabilities: readonly WorkspacePatentAvailability[],
): WorkspacePatentAvailability | null {
  return availabilities.find((availability) => availability.patentId === target.patentId) ?? null;
}

function isTargetAvailable(
  target: PatentDocumentTarget,
  availabilities: readonly WorkspacePatentAvailability[],
): boolean {
  const availability = availabilityFor(target, availabilities);
  return isPatentDocumentTargetAvailable(
    target,
    availability
      ? { ...availability, auxiliaryDocumentIds: availability.auxiliaryDocumentIds ?? [] }
      : null,
  );
}

function fallbackDescriptionTarget(
  targets: readonly PatentDocumentTarget[],
  availabilities: readonly WorkspacePatentAvailability[],
): PatentDocumentTarget | null {
  for (const target of targets) {
    const availability = availabilityFor(target, availabilities);
    if (availability?.availableBookKinds.includes("description")) {
      return { patentId: target.patentId, kind: "book", bookKind: "description" };
    }
  }
  return null;
}

export function reconcileWorkspaceTargets(
  state: PatentWorkspaceLayoutState,
  availabilities: readonly WorkspacePatentAvailability[],
): PatentWorkspaceLayoutState {
  if (state.mode === "single") {
    if (!state.singleTarget || isTargetAvailable(state.singleTarget, availabilities)) {
      return state;
    }
    return createSingleWorkspace(fallbackDescriptionTarget([state.singleTarget], availabilities));
  }

  const leftTarget = paneTarget(state.left);
  const rightTarget = paneTarget(state.right);
  const leftValid = leftTarget ? isTargetAvailable(leftTarget, availabilities) : false;
  const rightValid = rightTarget ? isTargetAvailable(rightTarget, availabilities) : false;

  if ((leftTarget === null || leftValid) && (rightTarget === null || rightValid)) return state;

  if (!leftValid && !rightValid) {
    return createSingleWorkspace(
      fallbackDescriptionTarget(
        [leftTarget, rightTarget].filter(
          (target): target is PatentDocumentTarget => target !== null,
        ),
        availabilities,
      ),
    );
  }

  if (!leftValid && leftTarget) {
    return {
      ...state,
      activePane: "right",
      left: selectionPane(rightTarget?.patentId ?? availabilities[0]?.patentId ?? null),
    };
  }

  if (!rightValid && rightTarget) {
    return {
      ...state,
      activePane: "left",
      right: selectionPane(leftTarget?.patentId ?? availabilities[0]?.patentId ?? null),
    };
  }

  return state;
}
