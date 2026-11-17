import type { DrawingAnnotation, DrawingProject } from "../../../shared/drawing-markup/model";

export type AnnotationBatchHistory = {
  ownerProjectId: string;
  annotationBatch: {
    projectId: string;
    marks: { annotation: DrawingAnnotation; index: number }[];
  }[];
};
export type DrawingHistoryEntry = DrawingProject | AnnotationBatchHistory;
type Direction = "undo" | "redo";
type ProjectHistory = { undo: DrawingHistoryEntry[]; redo: DrawingHistoryEntry[] };

/** Local edits keep their own history; a cross-drawing deletion is one shared transaction. */
export class DrawingHistory {
  private projects = new Map<string, ProjectHistory>();

  constructor(private limit = 100) {}

  forProject(id: string): ProjectHistory {
    let history = this.projects.get(id);
    if (!history) {
      history = { undo: [], redo: [] };
      this.projects.set(id, history);
    }
    return history;
  }

  private participants(entry: AnnotationBatchHistory) {
    return [...new Set([entry.ownerProjectId, ...entry.annotationBatch.map((b) => b.projectId)])];
  }

  private retireShared(entries: AnnotationBatchHistory[], direction: Direction) {
    const pending = [...entries];
    const retired = new Set<AnnotationBatchHistory>();
    while (pending.length) {
      const entry = pending.pop();
      if (!entry || retired.has(entry)) continue;
      retired.add(entry);
      for (const participant of this.participants(entry)) {
        const stack = this.forProject(participant)[direction];
        const index = stack.indexOf(entry);
        if (index < 0) continue;
        // Prefix snapshots depend on this barrier. Retire overlapping batches everywhere too.
        for (const removed of stack.splice(0, index + 1)) {
          if ("annotationBatch" in removed && !retired.has(removed)) pending.push(removed);
        }
      }
    }
  }

  private invalidateBatchRedo(id: string) {
    this.retireShared(
      this.forProject(id).redo.filter(
        (entry): entry is AnnotationBatchHistory => "annotationBatch" in entry,
      ),
      "redo",
    );
  }

  private trim(id: string) {
    const history = this.forProject(id);
    while (history.undo.length > this.limit) {
      const oldest = history.undo[0]!;
      if (!("annotationBatch" in oldest)) history.undo.shift();
      else {
        // Expiring a shared barrier also retires older snapshots on every participant.
        this.retireShared([oldest], "undo");
      }
    }
  }

  record(project: DrawingProject) {
    this.invalidateBatchRedo(project.projectId);
    const history = this.forProject(project.projectId);
    history.redo.length = 0;
    history.undo.push(project);
    this.trim(project.projectId);
  }

  recordBatch(entry: AnnotationBatchHistory) {
    const participants = this.participants(entry);
    for (const id of participants) this.invalidateBatchRedo(id);
    for (const id of participants) {
      const history = this.forProject(id);
      history.redo.length = 0;
      history.undo.push(entry);
    }
    for (const id of participants) this.trim(id);
  }

  peek(id: string, direction: Direction) {
    const entry = this.forProject(id)[direction].at(-1);
    const blockedProjectIds =
      entry && "annotationBatch" in entry
        ? this.participants(entry).filter(
            (participant) => this.forProject(participant)[direction].at(-1) !== entry,
          )
        : [];
    return { entry, blockedProjectIds };
  }

  move(id: string, direction: Direction, current: DrawingProject): boolean {
    const { entry, blockedProjectIds } = this.peek(id, direction);
    if (!entry || blockedProjectIds.length) return false;
    const opposite = direction === "undo" ? "redo" : "undo";
    if ("annotationBatch" in entry) {
      for (const participant of this.participants(entry)) {
        const history = this.forProject(participant);
        history[direction].pop();
        history[opposite].push(entry);
      }
      if (direction === "redo")
        for (const participant of this.participants(entry)) this.trim(participant);
    } else {
      // Traversing local snapshots can change a restored mark too, so retire batch redo.
      this.invalidateBatchRedo(id);
      const history = this.forProject(id);
      history[direction].pop();
      history[opposite].push(current);
      if (direction === "redo") this.trim(id);
    }
    return true;
  }

  deleteProject(id: string) {
    const history = this.projects.get(id);
    if (!history) return;
    const entries = new Set([...history.undo, ...history.redo]);
    for (const entry of entries) {
      if (!("annotationBatch" in entry)) continue;
      entry.annotationBatch = entry.annotationBatch.filter((batch) => batch.projectId !== id);
      if (entry.ownerProjectId === id)
        entry.ownerProjectId = entry.annotationBatch[0]?.projectId ?? "";
    }
    this.projects.delete(id);
  }
}
