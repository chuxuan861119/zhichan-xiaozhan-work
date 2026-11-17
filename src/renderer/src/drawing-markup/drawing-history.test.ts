import { expect, test } from "vitest";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { type AnnotationBatchHistory, DrawingHistory } from "./drawing-history";

function project(n: number): DrawingProject {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return { ...drawingProjectFixture(id), projectId: id, detailViews: [], baseFragments: [] };
}
function batch(a: DrawingProject, b: DrawingProject): AnnotationBatchHistory {
  return {
    ownerProjectId: a.projectId,
    annotationBatch: [a, b].map((p) => ({
      projectId: p.projectId,
      marks: [{ annotation: structuredClone(p.annotations[0]!), index: 0 }],
    })),
  };
}

test("batch undo and redo can start from either drawing and move once for all participants", () => {
  const a = project(1),
    b = project(2),
    history = new DrawingHistory();
  history.record(b);
  const deletion = batch(a, b);
  history.recordBatch(deletion);
  expect(history.peek(b.projectId, "undo")).toEqual({ entry: deletion, blockedProjectIds: [] });
  expect(history.move(b.projectId, "undo", b)).toBe(true);
  expect(history.forProject(a.projectId).undo).toEqual([]);
  expect(history.forProject(b.projectId).undo).toEqual([b]);
  expect(history.move(a.projectId, "redo", a)).toBe(true);
  expect(history.forProject(b.projectId).redo).toEqual([]);
  expect(history.peek(b.projectId, "undo").entry).toBe(deletion);
});

test("later local edits block batch undo until they are undone without losing history", () => {
  const a = project(1),
    b = project(2),
    history = new DrawingHistory();
  const deletion = batch(a, b);
  history.recordBatch(deletion);
  history.record(b);
  expect(history.peek(a.projectId, "undo").blockedProjectIds).toEqual([b.projectId]);
  expect(history.move(a.projectId, "undo", a)).toBe(false);
  expect(history.forProject(a.projectId).undo).toEqual([deletion]);
  expect(history.move(b.projectId, "undo", b)).toBe(true);
  expect(history.move(a.projectId, "undo", a)).toBe(true);
  expect(history.move(a.projectId, "redo", a)).toBe(true);
  expect(history.peek(b.projectId, "redo").entry).toBe(b);
});

test("edits in a participating drawing retire shared redo and its dependent snapshots", () => {
  const a = project(1),
    b = project(2),
    history = new DrawingHistory();
  const deletion = batch(a, b);
  history.recordBatch(deletion);
  history.record(b);
  history.move(b.projectId, "undo", b);
  history.move(a.projectId, "undo", a);
  history.record(a);
  expect(history.forProject(a.projectId).redo).toEqual([]);
  expect(history.forProject(b.projectId).redo).toEqual([]);
});

test("local undo after restoring a batch also invalidates the stale shared redo", () => {
  const a = project(1),
    b = project(2),
    history = new DrawingHistory();
  history.record(b);
  history.recordBatch(batch(a, b));
  history.move(a.projectId, "undo", a);
  history.move(b.projectId, "undo", b);
  expect(history.forProject(a.projectId).redo).toEqual([]);
  expect(history.forProject(b.projectId).redo).toEqual([b]);
});

test("unrelated drawing edits preserve a batch redo", () => {
  const a = project(1),
    b = project(2),
    c = project(3),
    history = new DrawingHistory();
  const deletion = batch(a, b);
  history.recordBatch(deletion);
  history.move(a.projectId, "undo", a);
  history.record(c);
  expect(history.peek(b.projectId, "redo").entry).toBe(deletion);
});

test("the initiating drawing can undo a batch even when it had no matching labels", () => {
  const a = project(1),
    b = project(2),
    c = project(3),
    history = new DrawingHistory();
  const deletion = { ...batch(a, b), ownerProjectId: c.projectId };
  history.recordBatch(deletion);
  expect(history.move(c.projectId, "undo", c)).toBe(true);
  expect(history.forProject(a.projectId).redo).toEqual([deletion]);
  expect(history.forProject(b.projectId).redo).toEqual([deletion]);
});

test("expiring a shared barrier retires older snapshots on other drawings", () => {
  const a = project(1),
    b = project(2),
    history = new DrawingHistory(2);
  history.record(a);
  history.recordBatch(batch(a, b));
  history.record(b);
  history.record(b);
  expect(history.forProject(a.projectId).undo).toEqual([]);
  expect(history.forProject(b.projectId).undo).toEqual([b, b]);
});

test("deleting a participant leaves remaining drawings' batch undo usable", () => {
  const a = project(1),
    b = project(2),
    history = new DrawingHistory();
  history.recordBatch(batch(a, b));
  history.deleteProject(a.projectId);
  const { entry, blockedProjectIds } = history.peek(b.projectId, "undo");
  expect(blockedProjectIds).toEqual([]);
  expect(
    entry && "annotationBatch" in entry && entry.annotationBatch.map((p) => p.projectId),
  ).toEqual([b.projectId]);
  expect(history.move(b.projectId, "undo", b)).toBe(true);
});

test("invalidating overlapping batch redos also retires their dependent participants", () => {
  const a = project(1),
    b = project(2),
    c = project(3),
    history = new DrawingHistory();
  history.recordBatch(batch(a, b));
  history.recordBatch(batch(b, c));
  history.move(c.projectId, "undo", c);
  history.move(a.projectId, "undo", a);
  history.record(a);
  for (const p of [a, b, c]) expect(history.forProject(p.projectId).redo).toEqual([]);
});

test("expiring an overlapping barrier retires earlier shared entries everywhere", () => {
  const a = project(1),
    b = project(2),
    c = project(3),
    history = new DrawingHistory(2);
  history.recordBatch(batch(b, c));
  history.recordBatch(batch(a, b));
  history.record(a);
  history.record(a);
  expect(history.forProject(b.projectId).undo).toEqual([]);
  expect(history.forProject(c.projectId).undo).toEqual([]);
  expect(history.forProject(a.projectId).undo).toEqual([a, a]);
});
