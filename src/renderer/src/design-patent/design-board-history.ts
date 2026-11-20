import type { DesignPatent, DesignPatentView } from "../../../shared/patent/design-patent";

const fields = (v: DesignPatentView) => ({
  viewId: v.viewId,
  kind: v.kind,
  label: v.label,
  assignmentStatus: v.assignmentStatus,
  assignmentEvidence: v.assignmentEvidence,
});
export const boardSignature = (d: DesignPatent) =>
  JSON.stringify({
    mode: d.imageMode ?? "six-view",
    views: d.views.map(fields),
    representative: d.representativeViewId,
    reference: d.dimensionReferenceViewId,
    omissions: d.brief.omissions,
  });
type Entry = { before: DesignPatent; after: DesignPatent; resizeIds?: string[] };
const imageVersion = (v: DesignPatentView) => [
  v.assetId,
  v.operations,
  v.editor,
  v.subjectBounds,
  v.subjectBoundsSource,
  v.subjectBoundsConfirmed,
];
/** Board metadata only. Pixel projects stay in their independent native history. */
export class DesignBoardHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
  record(before: DesignPatent, after: DesignPatent) {
    if ((before.imageMode ?? "six-view") !== (after.imageMode ?? "six-view")) {
      this.clear();
      return;
    }
    if (boardSignature(before) === boardSignature(after)) return;
    this.past.push({ before: structuredClone(before), after: structuredClone(after) });
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }
  recordResize(before: DesignPatent, after: DesignPatent, ids: readonly string[]) {
    if (!ids.length) return;
    this.past.push({
      before: structuredClone(before),
      after: structuredClone(after),
      resizeIds: [...ids],
    });
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }
  resizeTargets(redo: boolean) {
    return (redo ? this.future : this.past).at(-1)?.resizeIds ?? null;
  }
  prepareResizeStep(current: DesignPatent, redo: boolean) {
    const from = redo ? this.future : this.past,
      to = redo ? this.past : this.future,
      entry = from.at(-1);
    if (!entry?.resizeIds) return null;
    const ids = new Set(entry.resizeIds),
      expected = redo ? entry.before : entry.after,
      target = redo ? entry.after : entry.before;
    if (boardSignature(current) !== boardSignature(expected)) return null;
    for (const id of ids) {
      const view = current.views.find((v) => v.viewId === id),
        prior = expected.views.find((v) => v.viewId === id);
      if (
        !view ||
        !prior ||
        JSON.stringify(imageVersion(view)) !== JSON.stringify(imageVersion(prior))
      )
        return null;
    }
    const design = {
      ...current,
      views: current.views.map((view) => {
        if (!ids.has(view.viewId)) return view;
        const copy = structuredClone(target.views.find((v) => v.viewId === view.viewId)!);
        const { editor: _editor, ...rest } = view;
        return {
          ...rest,
          ...(copy.editor ? { editor: copy.editor } : {}),
          subjectBounds: copy.subjectBounds,
          subjectBoundsSource: copy.subjectBoundsSource,
          subjectBoundsConfirmed: copy.subjectBoundsConfirmed,
        };
      }),
    };
    return {
      design,
      finish: () => {
        if (from.at(-1) === entry) {
          from.pop();
          to.push(entry);
        }
      },
    };
  }
  undo(current: DesignPatent) {
    return this.step(current, false);
  }
  redo(current: DesignPatent) {
    return this.step(current, true);
  }
  private step(current: DesignPatent, redo: boolean): DesignPatent | null {
    const from = redo ? this.future : this.past,
      to = redo ? this.past : this.future,
      entry = from.at(-1);
    if (!entry || entry.resizeIds) return null;
    const expected = redo ? entry.before : entry.after,
      target = redo ? entry.after : entry.before;
    if (boardSignature(current) !== boardSignature(expected)) {
      this.clear();
      return null;
    }
    // Refresh snapshots when removing imported/assigned views so redo keeps later image edits.
    if (redo) entry.before = structuredClone(current);
    else entry.after = structuredClone(current);
    const byId = new Map(current.views.map((v) => [v.viewId, v]));
    const next = {
      ...current,
      views: target.views.map((v) => ({
        ...structuredClone(byId.get(v.viewId) ?? v),
        ...fields(v),
      })),
      representativeViewId: target.representativeViewId,
      dimensionReferenceViewId: target.dimensionReferenceViewId,
      brief: { ...current.brief, omissions: structuredClone(target.brief.omissions) },
    };
    from.pop();
    to.push(entry);
    return next;
  }
}
