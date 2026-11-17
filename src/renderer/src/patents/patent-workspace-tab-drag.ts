import type { FlowchartEditorMode } from "../../../shared/flowcharts/bridge";
import {
  type PatentDocumentTarget,
  patentDocumentTargetsEqual,
} from "../../../shared/patent/document-target";
import type {
  PatentDocumentTargetInput,
  PatentWorkspaceLayoutState,
  WorkspacePane,
} from "./patent-workspace-layout";

export const WORKSPACE_TAB_DRAG_THRESHOLD_PX = 6;

export type WorkspaceTabDragSource = Readonly<{
  key: string;
  label: string;
  target: PatentDocumentTargetInput;
  /** Toolbar entries can launch an unopened tool; tabs only move existing workspaces. */
  toolLaunch?: Readonly<{ editorMode?: FlowchartEditorMode }>;
}>;

export type WorkspaceTabDragStartRequest = Readonly<{
  source: WorkspaceTabDragSource;
  sourceElement: HTMLElement;
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
}>;

export type WorkspaceTabDragBindings = Readonly<{
  start(request: WorkspaceTabDragStartRequest): void;
  consumeClick(sourceKey: string): boolean;
}>;

export type WorkspacePoint = Readonly<{ x: number; y: number }>;

export type WorkspaceRect = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}>;

export type WorkspaceTabDropEffect =
  | "split-current"
  | "split-other"
  | "activate"
  | "replace"
  | "swap";

function normalizeTarget(target: PatentDocumentTargetInput): PatentDocumentTarget {
  return "kind" in target ? target : { ...target, kind: "book" };
}

function sameTarget(
  left: PatentDocumentTargetInput | null,
  right: PatentDocumentTargetInput,
): boolean {
  return left !== null && patentDocumentTargetsEqual(normalizeTarget(left), normalizeTarget(right));
}

function paneTarget(
  state: PatentWorkspaceLayoutState,
  pane: WorkspacePane,
): PatentDocumentTarget | null {
  const paneState = state[pane];
  return paneState.kind === "document" ? paneState.target : null;
}

export function passedWorkspaceTabDragThreshold(
  origin: WorkspacePoint,
  point: WorkspacePoint,
): boolean {
  return Math.hypot(point.x - origin.x, point.y - origin.y) >= WORKSPACE_TAB_DRAG_THRESHOLD_PX;
}

export function workspacePaneAtPoint(
  rect: WorkspaceRect,
  point: WorkspacePoint,
): WorkspacePane | null {
  if (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) {
    return null;
  }
  return point.x < rect.left + rect.width / 2 ? "left" : "right";
}

export function classifyWorkspaceTabDrop(
  state: PatentWorkspaceLayoutState,
  pane: WorkspacePane,
  target: PatentDocumentTargetInput,
  singleCurrentTarget: PatentDocumentTargetInput | null = null,
): WorkspaceTabDropEffect {
  if (state.mode === "single") {
    return sameTarget(singleCurrentTarget ?? state.singleTarget, target)
      ? "split-current"
      : "split-other";
  }
  if (sameTarget(paneTarget(state, pane), target)) return "activate";
  const opposite = pane === "left" ? "right" : "left";
  return sameTarget(paneTarget(state, opposite), target) ? "swap" : "replace";
}
