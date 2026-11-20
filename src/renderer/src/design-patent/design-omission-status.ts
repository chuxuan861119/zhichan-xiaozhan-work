import type { DesignPatent, DesignPatentView } from "../../../shared/patent/design-patent";
import {
  ORTHOGRAPHIC_LABELS,
  type OrthographicKind,
  resolveOmissionSource,
} from "../../../shared/patent/design-view-omissions";

export function resolvedOrthographicOmissions(design: DesignPatent): Set<OrthographicKind> {
  const omitted = new Set<OrthographicKind>();
  if (design.imageMode === "multi-image") return omitted;
  for (const omission of design.brief.omissions) {
    const kind = omission.viewKind as OrthographicKind;
    if (
      !Object.hasOwn(ORTHOGRAPHIC_LABELS, kind) ||
      design.views.some((view) => view.kind === kind)
    )
      continue;
    switch (omission.reason) {
      case "same":
      case "symmetric":
        if (resolveOmissionSource(design, kind)) omitted.add(kind);
        break;
      case "not-visible-during-use":
        omitted.add(kind);
        break;
      case "other":
        if (omission.otherReason?.trim()) omitted.add(kind);
        break;
      case "rotationally-identical":
        if (
          omission.rotationDegrees &&
          design.views.some((view) => view.kind === omission.referenceKind)
        )
          omitted.add(kind);
        break;
    }
  }
  return omitted;
}

export function isHeldForOmittedView(
  view: DesignPatentView,
  omitted: ReadonlySet<OrthographicKind>,
) {
  // Returning an assigned picture to holding preserves the canonical slot label.
  return (
    view.kind === "unassigned" &&
    [...omitted].some((kind) => view.label === ORTHOGRAPHIC_LABELS[kind])
  );
}
