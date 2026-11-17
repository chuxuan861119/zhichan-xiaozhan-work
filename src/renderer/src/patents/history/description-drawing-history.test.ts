import type { AssetDescriptor } from "../../../../shared/document/model";
import { createBlankPatent } from "../../../../shared/patent/defaults";
import type { CanonicalPatent, PatentFigure } from "../../../../shared/patent/model";
import {
  captureDescriptionDrawingState,
  type DescriptionDrawingEdit,
  DescriptionDrawingHistoryManager,
} from "./description-drawing-history";

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function figure(index: number, widthMm = 80): PatentFigure {
  return { figureId: uuid(index), assetId: uuid(index + 1000), widthMm };
}

function asset(index: number): AssetDescriptor {
  return {
    assetId: uuid(index + 1000),
    kind: "image",
    originalName: `图${index}.png`,
    mediaType: "image/png",
    extension: "png",
    byteLength: 100 + index,
    sha256: index.toString(16).padStart(64, "0").toUpperCase(),
    widthPx: 100,
    heightPx: 80,
    previewByteLength: 50 + index,
    previewSha256: (index + 100).toString(16).padStart(64, "0").toUpperCase(),
  };
}

function patent(index: number, figures: PatentFigure[] = []): CanonicalPatent {
  const value = createBlankPatent({ patentType: "utility-model", name: `历史 ${index}` });
  value.patentId = uuid(index);
  value.figures = structuredClone(figures);
  return value;
}

function applyEdit(patent: CanonicalPatent, edit: DescriptionDrawingEdit): CanonicalPatent {
  const next = structuredClone(patent);
  next.figures = structuredClone(edit.figures);
  next.assets = structuredClone(edit.assets);
  next.abstractDrawingFigureId = edit.abstractDrawingFigureId;
  return next;
}

describe("description drawing history", () => {
  test("undoes and redoes an abstract drawing selection without changing figures or assets", () => {
    const manager = new DescriptionDrawingHistoryManager();
    const before = patent(9, [figure(90), figure(91)]);
    before.assets = [asset(90), asset(91)];
    const after = structuredClone(before);
    after.abstractDrawingFigureId = required(after.figures[1], "缺少图2").figureId;
    manager.record({
      patentId: before.patentId,
      label: "选择摘要附图",
      before: captureDescriptionDrawingState(before),
      after: captureDescriptionDrawingState(after),
    });

    const undo = required(manager.takeUndo(before.patentId, after), "缺少摘要附图撤销事件");
    expect(undo.edit.abstractDrawingFigureId).toBeNull();
    expect(undo.edit.figures).toEqual(after.figures);
    expect(undo.edit.assets).toEqual(after.assets);
    expect(manager.commitUndo(before.patentId, undo)).toBe(true);
    const undone = applyEdit(after, undo.edit);
    const redo = required(manager.takeRedo(before.patentId, undone), "缺少摘要附图重做事件");
    expect(redo.edit.abstractDrawingFigureId).toBe(after.abstractDrawingFigureId);
    expect(redo.edit.figures).toEqual(after.figures);
    expect(redo.edit.assets).toEqual(after.assets);
  });

  test("undoes and redoes only fields owned by the recorded event", () => {
    const manager = new DescriptionDrawingHistoryManager();
    const before = patent(1, [figure(10, 80), figure(11, 80)]);
    const after = structuredClone(before);
    after.figures[0] = { ...required(after.figures[0], "缺少图1"), widthMm: 95 };
    manager.record({
      patentId: before.patentId,
      label: "调整附图尺寸",
      before: captureDescriptionDrawingState(before),
      after: captureDescriptionDrawingState(after),
    });

    const current = structuredClone(after);
    current.abstractDrawingFigureId = required(current.figures[1], "缺少图2").figureId;
    const undo = manager.takeUndo(before.patentId, current);
    expect(undo?.edit.figures[0]?.widthMm).toBe(80);
    expect(undo?.edit.abstractDrawingFigureId).toBe(current.abstractDrawingFigureId);
    const undoTransition = required(undo, "缺少撤销事件");
    manager.commitUndo(before.patentId, undoTransition);

    const undone = applyEdit(current, undoTransition.edit);
    const redo = manager.takeRedo(before.patentId, undone);
    expect(redo?.edit.figures[0]?.widthMm).toBe(95);
    expect(redo?.edit.abstractDrawingFigureId).toBe(current.abstractDrawingFigureId);
  });

  test("keeps patent owners isolated and rejects an owned-field mismatch", () => {
    const manager = new DescriptionDrawingHistoryManager();
    const firstBefore = patent(2, [figure(20, 80)]);
    const firstAfter = structuredClone(firstBefore);
    firstAfter.figures[0] = {
      ...required(firstAfter.figures[0], "缺少第一件专利附图"),
      widthMm: 90,
    };
    const secondBefore = patent(3, [figure(30, 80)]);
    const secondAfter = structuredClone(secondBefore);
    secondAfter.figures[0] = {
      ...required(secondAfter.figures[0], "缺少第二件专利附图"),
      widthMm: 100,
    };

    for (const [before, after] of [
      [firstBefore, firstAfter],
      [secondBefore, secondAfter],
    ] as const) {
      manager.record({
        patentId: before.patentId,
        label: "调整附图尺寸",
        before: captureDescriptionDrawingState(before),
        after: captureDescriptionDrawingState(after),
      });
    }

    expect(manager.takeUndo(firstBefore.patentId, firstAfter)?.edit.figures[0]?.widthMm).toBe(80);
    expect(manager.takeUndo(secondBefore.patentId, secondAfter)?.edit.figures[0]?.widthMm).toBe(80);
    const diverged = structuredClone(firstAfter);
    diverged.figures[0] = {
      ...required(diverged.figures[0], "缺少分歧附图"),
      widthMm: 120,
    };
    expect(manager.takeUndo(firstBefore.patentId, diverged)).toBeNull();
  });

  test("does not record description-only changes as drawing history", () => {
    const manager = new DescriptionDrawingHistoryManager();
    const before = patent(4, [figure(40)]);
    const description = required(
      before.books.find((book) => book.kind === "description"),
      "缺少说明书",
    );
    const after = structuredClone(before);
    const afterDescription = required(
      after.books.find((book) => book.kind === "description"),
      "缺少修改后的说明书",
    );
    afterDescription.document = {
      ...afterDescription.document,
      modifiedAt: "2026-08-09T00:00:00.000Z",
      content: description.document.content.slice(0, -1),
    };

    expect(
      manager.record({
        patentId: before.patentId,
        label: "修改说明书",
        before: captureDescriptionDrawingState(before),
        after: captureDescriptionDrawingState(after),
      }),
    ).toBe(false);
    expect(manager.canUndo(before.patentId)).toBe(false);
  });

  test("preserves assets added by unrelated later edits when undoing a figure import", () => {
    const manager = new DescriptionDrawingHistoryManager();
    const before = patent(7);
    before.assets = [asset(70)];
    const after = structuredClone(before);
    after.figures = [figure(71)];
    after.assets = [...before.assets, asset(71)];
    manager.record({
      patentId: before.patentId,
      label: "导入附图",
      before: captureDescriptionDrawingState(before),
      after: captureDescriptionDrawingState(after),
    });

    const current = structuredClone(after);
    current.assets.push(asset(72));
    const undo = manager.takeUndo(before.patentId, current);

    expect(undo?.edit.assets.map((item) => item.assetId)).toEqual([
      asset(70).assetId,
      asset(72).assetId,
    ]);
  });

  test("retains only the latest one hundred events per patent", () => {
    const manager = new DescriptionDrawingHistoryManager();
    let current = patent(5, [figure(50, 10)]);
    for (let index = 0; index < 101; index += 1) {
      const next = structuredClone(current);
      next.figures[0] = {
        ...required(next.figures[0], "缺少容量测试附图"),
        widthMm: 11 + index,
      };
      manager.record({
        patentId: current.patentId,
        label: `调整附图尺寸 ${index}`,
        before: captureDescriptionDrawingState(current),
        after: captureDescriptionDrawingState(next),
      });
      current = next;
    }

    for (let index = 0; index < 100; index += 1) {
      const undo = manager.takeUndo(current.patentId, current);
      const transition = required(undo, "缺少容量测试撤销事件");
      manager.commitUndo(current.patentId, transition);
      current = applyEdit(current, transition.edit);
    }
    expect(manager.takeUndo(current.patentId, current)).toBeNull();
  });
});
