import { getDesignBriefDetails } from "../../../../shared/patent/design-brief-details";
import type { DesignPatent } from "../../../../shared/patent/design-patent";

function changed<T extends object>(before: T, after: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(after).filter(([key, value]) => {
      const previous = before[key as keyof T];
      return previous !== value && JSON.stringify(previous) !== JSON.stringify(value);
    }),
  ) as Partial<T>;
}

/** Merge only this form's edits. Never replay stale image/assets or queued unrelated fields. */
export function mergeDesignBriefEdit(
  current: DesignPatent,
  rendered: DesignPatent,
  next: DesignPatent,
): DesignPatent {
  const patch = changed(rendered.brief, next.brief);
  if (patch.details) {
    const before = getDesignBriefDetails(rendered.brief),
      live = getDesignBriefDetails(current.brief);
    const detailsPatch = changed(before, patch.details);
    if (detailsPatch.gui)
      detailsPatch.gui = { ...live.gui, ...changed(before.gui, detailsPatch.gui) };
    patch.details = { ...live, ...detailsPatch };
  }
  return {
    ...current,
    brief: { ...current.brief, ...patch },
    ...(rendered.subject !== next.subject ? { subject: next.subject } : {}),
    ...(rendered.representativeViewId !== next.representativeViewId
      ? { representativeViewId: next.representativeViewId }
      : {}),
  };
}
