import {
  type DesignPatentPrimarySlot,
  type DesignPatentViewKind,
  inferDesignPatentViewKindFromFilename,
} from "../../../../shared/patent/design-patent";

export type AssignmentCandidate = { id: string; originalName: string };
export type AssignmentSuggestion =
  | { id: string; status: "suggested"; kind: DesignPatentPrimarySlot; evidence: string }
  | { id: string; status: "unassigned"; reason: "no-marker" | "ambiguous" }
  | {
      id: string;
      status: "conflict";
      kind: DesignPatentPrimarySlot;
      reason: "occupied" | "duplicate";
    };

export type AssignableView = {
  viewId: string;
  kind: DesignPatentViewKind;
  label: string;
  assignmentStatus?: "confirmed" | "pending-auto" | undefined;
  assignmentEvidence?: string | null | undefined;
};

const labels: Record<DesignPatentPrimarySlot, string> = {
  perspective: "立体图1",
  "perspective-2": "立体图2",
  "perspective-3": "立体图3",
  front: "主视图",
  rear: "后视图",
  left: "左视图",
  right: "右视图",
  top: "俯视图",
  bottom: "仰视图",
};

function hasViewMarker(filename: string): boolean {
  return /主视图|后视图|左视图|右视图|俯视图|顶视图|仰视图|底视图|立体图|透视图|\b(front|rear|left|right|top|bottom|perspective)\b/iu.test(
    filename,
  );
}

export function suggestDesignAssignments(
  candidates: readonly AssignmentCandidate[],
  occupied: ReadonlySet<DesignPatentPrimarySlot>,
): AssignmentSuggestion[] {
  const proposed = new Set<DesignPatentPrimarySlot>();
  return candidates.map((candidate) => {
    const kind = inferDesignPatentViewKindFromFilename(candidate.originalName);
    if (kind === null) {
      return hasViewMarker(candidate.originalName)
        ? { id: candidate.id, status: "unassigned", reason: "ambiguous" }
        : { id: candidate.id, status: "unassigned", reason: "no-marker" };
    }
    if (occupied.has(kind))
      return { id: candidate.id, status: "conflict", kind, reason: "occupied" };
    if (proposed.has(kind))
      return { id: candidate.id, status: "conflict", kind, reason: "duplicate" };
    proposed.add(kind);
    return { id: candidate.id, status: "suggested", kind, evidence: `文件名包含“${labels[kind]}”` };
  });
}

export function assignView(
  views: readonly AssignableView[],
  viewId: string,
  target: DesignPatentPrimarySlot | "unassigned",
): { views: AssignableView[]; changed: boolean } {
  const moved = views.find((view) => view.viewId === viewId);
  if (!moved) return { views: [...views], changed: false };
  if (moved.kind === target) {
    return moved.assignmentStatus === "pending-auto"
      ? {
          views: views.map((view) =>
            view.viewId === viewId
              ? { ...view, assignmentStatus: "confirmed", assignmentEvidence: null }
              : view,
          ),
          changed: true,
        }
      : { views: [...views], changed: false };
  }
  const displaced =
    target === "unassigned" ? undefined : views.find((view) => view.kind === target);
  const previous = moved.kind;
  return {
    views: views.map((view) => {
      if (view.viewId === moved.viewId)
        return {
          ...view,
          kind: target,
          label: target === "unassigned" ? view.label : labels[target],
          ...(view.assignmentStatus === "pending-auto"
            ? { assignmentStatus: "confirmed" as const, assignmentEvidence: null }
            : {}),
        };
      if (view.viewId === displaced?.viewId)
        return {
          ...view,
          kind: previous,
          label:
            previous === "unassigned"
              ? view.label
              : (labels[previous as DesignPatentPrimarySlot] ?? view.label),
        };
      return view;
    }),
    changed: true,
  };
}

export const DESIGN_ASSIGNMENT_LABELS = labels;
