import type { DesignPatent, DesignPatentViewKind } from "./design-patent.js";

export const OPPOSITE_DESIGN_VIEWS = {
  front: "rear",
  rear: "front",
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
} as const;
export type OrthographicKind = keyof typeof OPPOSITE_DESIGN_VIEWS;
export const ORTHOGRAPHIC_LABELS = {
  front: "主视图",
  rear: "后视图",
  left: "左视图",
  right: "右视图",
  top: "俯视图",
  bottom: "仰视图",
} as const;
export type ViewOmission = DesignPatent["brief"]["omissions"][number];

/** References resolve only to a real assigned picture, never to another inferred face. */
export function resolveOmissionSource(design: DesignPatent, kind: DesignPatentViewKind) {
  const omission = design.brief.omissions.find((item) => item.viewKind === kind);
  if (
    !omission ||
    !["same", "symmetric"].includes(omission.reason) ||
    !omission.referenceKind ||
    OPPOSITE_DESIGN_VIEWS[kind as OrthographicKind] !== omission.referenceKind ||
    design.brief.omissions.some((item) => item.viewKind === omission.referenceKind)
  )
    return undefined;
  return design.views.find((view) => view.kind === omission.referenceKind);
}

export function setViewOmission(
  design: DesignPatent,
  kind: OrthographicKind,
  reason: ViewOmission["reason"] | null,
): DesignPatent {
  const remaining = design.brief.omissions.filter((item) => item.viewKind !== kind);
  return {
    ...design,
    brief: {
      ...design.brief,
      omissions:
        reason === null
          ? remaining
          : [
              ...remaining,
              {
                viewKind: kind,
                reason,
                otherReason: reason === "other" ? "" : null,
                ...(["same", "symmetric"].includes(reason)
                  ? { referenceKind: OPPOSITE_DESIGN_VIEWS[kind] }
                  : {}),
              },
            ],
    },
  };
}

export function omissionMirror(kind: OrthographicKind) {
  return kind === "top" || kind === "bottom" ? ("y" as const) : ("x" as const);
}
