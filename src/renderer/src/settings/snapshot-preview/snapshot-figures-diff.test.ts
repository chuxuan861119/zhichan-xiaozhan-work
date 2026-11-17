import { describe, expect, test } from "vitest";
import type { SnapshotPreviewFigure } from "../../../../shared/snapshot/model";
import { buildSnapshotFiguresDiff } from "./snapshot-figures-diff";

function figure(
  index: number,
  overrides: Partial<SnapshotPreviewFigure> = {},
): SnapshotPreviewFigure {
  return {
    figureId: `00000000-0000-4000-8002-${index.toString(16).padStart(12, "0")}`,
    assetId: `00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`,
    widthMm: 80,
    ...overrides,
  };
}

describe("buildSnapshotFiguresDiff", () => {
  test("uses distinct navigable identifiers for drawings and abstract drawings", () => {
    const input = { baselineFigures: [], currentFigures: [figure(1)] };
    const drawing = buildSnapshotFiguresDiff(input)[0];
    const abstract = buildSnapshotFiguresDiff({ ...input, bookKind: "abstract-drawing" })[0];
    expect(drawing?.id).toMatch(/^snapshot-figure-change-/);
    expect(abstract?.id).toMatch(/^snapshot-figure-change-/);
    expect(drawing?.id).not.toBe(abstract?.id);
    expect(abstract?.bookKind).toBe("abstract-drawing");
  });
  test("detects rotation and treats a missing legacy rotation as zero", () => {
    expect(
      buildSnapshotFiguresDiff({
        baselineFigures: [figure(1)],
        currentFigures: [figure(1, { rotationDeg: 90 })],
      }),
    ).toMatchObject([{ kind: "structure", details: ["附图旋转：0° → 90°"] }]);
    expect(
      buildSnapshotFiguresDiff({
        baselineFigures: [figure(1)],
        currentFigures: [figure(1, { rotationDeg: 0 })],
      }),
    ).toEqual([]);
  });
  test("counts an appended figure as one insert change with its current 图号", () => {
    const changes = buildSnapshotFiguresDiff({
      baselineFigures: [figure(1)],
      currentFigures: [figure(1), figure(2)],
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "insert",
      bookKind: "description-drawings",
      blockId: figure(2).figureId,
      locationLabel: "图2",
      summary: "新增附图",
      nodeType: null,
    });
    expect(changes[0]?.details).toContain("新增附图：图2");
  });

  test("counts a removed figure as one delete change with its baseline 图号", () => {
    const changes = buildSnapshotFiguresDiff({
      baselineFigures: [figure(1), figure(2)],
      currentFigures: [figure(2)],
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "delete",
      bookKind: "description-drawings",
      blockId: figure(1).figureId,
      locationLabel: "图1",
      summary: "删除附图",
      nodeType: null,
    });
    expect(changes[0]?.details).toContain("删除附图：图1");
  });

  test("reports width and image replacement as one structure change per figure", () => {
    const changes = buildSnapshotFiguresDiff({
      baselineFigures: [figure(1)],
      currentFigures: [
        figure(1, {
          widthMm: 120,
          assetId: "00000000-0000-4000-8001-0000000000ab",
        }),
      ],
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "structure",
      blockId: figure(1).figureId,
      locationLabel: "图1",
      summary: "附图调整",
    });
    expect(changes[0]?.details).toEqual(["附图宽度：80 → 120", "附图图片：已替换"]);
  });

  test("reports a reorder as one structure change without fake inserts or deletes", () => {
    const changes = buildSnapshotFiguresDiff({
      baselineFigures: [figure(1), figure(2), figure(3)],
      currentFigures: [figure(3), figure(1), figure(2)],
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "structure",
      bookKind: "description-drawings",
      summary: "附图顺序调整",
    });
    expect(changes[0]?.details).toEqual([
      "图1：第3位 → 第1位",
      "图2：第1位 → 第2位",
      "图3：第2位 → 第3位",
    ]);
  });

  test("returns no changes for identical figure sets and identical order", () => {
    expect(
      buildSnapshotFiguresDiff({
        baselineFigures: [figure(1), figure(2)],
        currentFigures: [figure(1), figure(2)],
      }),
    ).toEqual([]);
    expect(buildSnapshotFiguresDiff({ baselineFigures: [], currentFigures: [] })).toEqual([]);
  });

  test("treats an empty baseline as a fully added list so old snapshots without figure stats stay comparable", () => {
    const changes = buildSnapshotFiguresDiff({
      baselineFigures: [],
      currentFigures: [figure(1)],
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "insert", locationLabel: "图1", summary: "新增附图" });
  });

  test("combines additions, deletions and resizes into one stable change list", () => {
    const changes = buildSnapshotFiguresDiff({
      baselineFigures: [figure(1), figure(2, { widthMm: 90 }), figure(3)],
      currentFigures: [figure(1), figure(3, { widthMm: 100 }), figure(4)],
    });

    expect(changes.map((change) => change.kind)).toEqual(["delete", "insert", "structure"]);
    expect(changes.map((change) => change.locationLabel)).toEqual(["图2", "图3", "图2"]);
    expect(new Set(changes.map((change) => change.id)).size).toBe(changes.length);
  });
});
