import { createBlankPatent } from "../../../../shared/patent/defaults";
import type { CanonicalPatent } from "../../../../shared/patent/model";
import {
  planUpdateReferenceMark,
  planAssignDescriptionReferenceNumber,
} from "../../../../shared/patent/reference-mark-operations";
import { classifyDescriptionChapterBlock } from "../../../../shared/patent/description";
import { type ReferenceHistoryEdit, ReferenceMarkUndoManager } from "./reference-mark-undo-manager";

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function applyEdit(patent: CanonicalPatent, edit: ReferenceHistoryEdit): CanonicalPatent {
  const next = structuredClone(patent);
  next.referenceMarks = structuredClone(edit.referenceMarks);
  next.referenceMarkSettings = structuredClone(edit.referenceMarkSettings);
  for (const bookEdit of edit.bookEdits) {
    const book = next.books.find((candidate) => candidate.kind === bookEdit.bookKind);
    if (!book) throw new Error(`缺少书册 ${bookEdit.bookKind}`);
    book.document = structuredClone(bookEdit.document);
    book.editorState = structuredClone(bookEdit.editorState);
  }
  return next;
}

function withReference(patent: CanonicalPatent, index: number): CanonicalPatent {
  const next = structuredClone(patent);
  next.referenceMarks.push({
    referenceMarkId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    number: index,
    keyword: `部件 ${index}`,
  });
  return next;
}

describe("reference mark undo manager", () => {
  test("undoes description numbering and registration together without touching claims", () => {
    const before = createBlankPatent({ patentType: "invention", name: "说明书撤销" });
    const document = before.books.find((book) => book.kind === "description")!.document;
    const index =
      document.content.findIndex(
        (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
      ) + 1;
    const body = document.content[index]!;
    if (body.type !== "paragraph") throw new Error("fixture");
    body.content = [{ type: "text", text: "支架与支架连接。", marks: [] }];
    const result = planAssignDescriptionReferenceNumber(before, "支架", index, {
      now: () => new Date(),
      createId: () => crypto.randomUUID(),
    });
    if (!result.ok) throw new Error(result.message);
    const after = result.plan.after;
    const manager = new ReferenceMarkUndoManager();
    manager.record({ patentId: before.patentId, ownerBookKind: "description", before, after });
    expect(manager.canUndo(before.patentId, "claims", after)).toBe(false);
    const undo = required(manager.takeUndo(before.patentId, "description", after), "缺少撤销");
    expect(undo.edit.bookEdits.map((edit) => edit.bookKind)).toEqual(["description"]);
    const undone = applyEdit(after, undo.edit);
    expect(undone.books).toEqual(before.books);
    expect(undone.referenceMarks).toEqual(before.referenceMarks);
    expect(manager.commitUndo(undo)).toBe(true);
    const redo = required(manager.takeRedo(before.patentId, "description", undone), "缺少重做");
    const redone = applyEdit(undone, redo.edit);
    expect(redone.books).toEqual(after.books);
    expect(redone.referenceMarks).toEqual(after.referenceMarks);
    expect(manager.commitRedo(redo)).toBe(true);
  });
  test("discards old redo on a new edit even if native undo later returns to the same text", () => {
    const manager = new ReferenceMarkUndoManager();
    const before = createBlankPatent({ patentType: "invention", name: "分支" });
    const after = withReference(before, 1);
    manager.record({ patentId: before.patentId, ownerBookKind: "claims", before, after });
    manager.commitUndo(required(manager.takeUndo(before.patentId, "claims", after), "undo"));
    manager.discardRedoForEdit(before.patentId, "claims");
    expect(manager.canRedo(before.patentId, "claims", before)).toBe(false);
  });
  test("undoes and redoes a real panel edit across all three text books as one operation", () => {
    const before = createBlankPatent({ patentType: "invention", name: "三书同步撤销" });
    const referenceMarkId = crypto.randomUUID();
    before.referenceMarks = [{ referenceMarkId, number: 5, keyword: "防护壳" }];
    for (const book of before.books) {
      if (!["claims", "description", "abstract"].includes(book.kind)) continue;
      const paragraph = book.document.content.find((block) => block.type === "paragraph");
      if (paragraph?.type !== "paragraph") throw new Error("fixture");
      paragraph.content = [
        { type: "text", marks: [], text: book.kind === "claims" ? "防护壳(5)" : "防护壳和防护壳5" },
      ];
      book.document.content = [paragraph];
    }
    const result = planUpdateReferenceMark(before, { referenceMarkId, number: 8, keyword: "外壳" });
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.affectedBookKinds).toEqual(["claims", "description", "abstract"]);
    const after = result.plan.after;
    const manager = new ReferenceMarkUndoManager();
    manager.record({ patentId: before.patentId, ownerBookKind: "description", before, after });
    const undo = required(manager.takeUndo(before.patentId, "description", after), "缺少撤销");
    expect(undo.edit.bookEdits).toHaveLength(3);
    const undone = applyEdit(after, undo.edit);
    expect(undone.books).toEqual(before.books);
    expect(undone.referenceMarks).toEqual(before.referenceMarks);
    expect(manager.commitUndo(undo)).toBe(true);
    const redo = required(manager.takeRedo(before.patentId, "description", undone), "缺少重做");
    const redone = applyEdit(undone, redo.edit);
    expect(redone.books).toEqual(after.books);
    expect(redone.referenceMarks).toEqual(after.referenceMarks);
    expect(manager.commitRedo(redo)).toBe(true);
  });

  test("keeps undo points isolated by their initiating book", () => {
    const manager = new ReferenceMarkUndoManager();
    const before = createBlankPatent({ patentType: "invention", name: "撤销测试" });
    const after = structuredClone(before);
    after.referenceMarkSettings.synchronizedEditingEnabled = true;
    manager.record({
      patentId: before.patentId,
      ownerBookKind: "claims",
      before,
      after,
    });

    expect(manager.canUndo(before.patentId, "description", after)).toBe(false);
    expect(manager.takeUndo(before.patentId, "description", after)).toBeNull();
    expect(manager.takeUndo(before.patentId, "claims", after)?.edit).toBeDefined();
  });

  test("moves an undone point to redo and back to undo", () => {
    const manager = new ReferenceMarkUndoManager();
    const before = createBlankPatent({ patentType: "invention", name: "撤销测试" });
    const after = withReference(before, 1);
    manager.record({
      patentId: before.patentId,
      ownerBookKind: "description",
      before,
      after,
    });

    const undo = manager.takeUndo(before.patentId, "description", after);
    const undoTransition = required(undo, "缺少标号撤销事件");
    const undone = applyEdit(after, undoTransition.edit);
    expect(manager.commitUndo(undoTransition)).toBe(true);
    expect(manager.canRedo(before.patentId, "description", undone)).toBe(true);

    const redo = manager.takeRedo(before.patentId, "description", undone);
    const redoTransition = required(redo, "缺少标号重做事件");
    const redone = applyEdit(undone, redoTransition.edit);
    expect(manager.commitRedo(redoTransition)).toBe(true);
    expect(manager.canUndo(before.patentId, "description", redone)).toBe(true);
  });

  test("keeps earlier reference operations undoable after undoing the latest operation", () => {
    const manager = new ReferenceMarkUndoManager();
    const original = createBlankPatent({ patentType: "invention", name: "连续撤销测试" });
    const afterFirst = withReference(original, 1);
    const afterSecond = withReference(afterFirst, 2);
    manager.record({
      patentId: original.patentId,
      ownerBookKind: "claims",
      before: original,
      after: afterFirst,
    });
    manager.record({
      patentId: original.patentId,
      ownerBookKind: "claims",
      before: afterFirst,
      after: afterSecond,
    });

    const latest = required(
      manager.takeUndo(original.patentId, "claims", afterSecond),
      "缺少最新标号撤销事件",
    );
    const afterLatestUndo = applyEdit(afterSecond, latest.edit);
    manager.commitUndo(latest);
    const earlier = manager.takeUndo(original.patentId, "claims", afterLatestUndo);
    expect(earlier?.edit.referenceMarks).toEqual([]);
  });

  test("waits for later owner-book text to be undone before the composite event", () => {
    const manager = new ReferenceMarkUndoManager();
    const before = createBlankPatent({ patentType: "invention", name: "顺序测试" });
    const after = structuredClone(before);
    after.referenceMarkSettings.synchronizedEditingEnabled = true;
    manager.record({
      patentId: before.patentId,
      ownerBookKind: "claims",
      before,
      after,
    });
    const laterText = structuredClone(after);
    const claims = required(
      laterText.books.find((book) => book.kind === "claims"),
      "缺少权利要求书",
    );
    claims.document.content = [];
    claims.document.modifiedAt = "2026-08-09T01:00:00.000Z";

    expect(manager.canUndo(before.patentId, "claims", laterText)).toBe(false);
    const textUndone = structuredClone(after);
    required(
      textUndone.books.find((book) => book.kind === "claims"),
      "缺少撤销后的权利要求书",
    ).document.modifiedAt = "2026-08-09T02:00:00.000Z";
    expect(manager.canUndo(before.patentId, "claims", textUndone)).toBe(true);
  });

  test("keeps at most one hundred undo points per patent book", () => {
    const manager = new ReferenceMarkUndoManager();
    let current = createBlankPatent({ patentType: "invention", name: "容量测试" });
    for (let index = 1; index <= 101; index += 1) {
      const next = withReference(current, index);
      manager.record({
        patentId: current.patentId,
        ownerBookKind: "claims",
        before: current,
        after: next,
      });
      current = next;
    }

    let count = 0;
    while (true) {
      const transition = manager.takeUndo(current.patentId, "claims", current);
      if (!transition) break;
      current = applyEdit(current, transition.edit);
      manager.commitUndo(transition);
      count += 1;
    }
    expect(count).toBe(100);
    expect(current.referenceMarks).toHaveLength(1);
  });

  test("invalidates every book bucket for a closed patent", () => {
    const manager = new ReferenceMarkUndoManager();
    const before = createBlankPatent({ patentType: "invention", name: "失效测试" });
    const after = withReference(before, 1);
    manager.record({ patentId: before.patentId, ownerBookKind: "claims", before, after });
    manager.record({ patentId: before.patentId, ownerBookKind: "description", before, after });

    manager.invalidate(before.patentId);
    expect(manager.canUndo(before.patentId, "claims", after)).toBe(false);
    expect(manager.canUndo(before.patentId, "description", after)).toBe(false);
  });
});
