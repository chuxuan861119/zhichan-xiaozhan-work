import type { SnapshotPreviewFigure } from "../../../../shared/snapshot/model";
import type { SnapshotBookChange } from "./snapshot-book-diff";

// 说明书附图的实际内容不在书册文档里，而在快照版本的 figures 字段中。
// 这里把基线/当前附图列表的差异折算成与正文一致的变化条目，
// 供快照预览顶部的“说明书附图 N 项变化”标题与变化导航使用。
export function buildSnapshotFiguresDiff(input: {
  baselineFigures: readonly SnapshotPreviewFigure[];
  currentFigures: readonly SnapshotPreviewFigure[];
  bookKind?: "description-drawings" | "abstract-drawing";
}): readonly SnapshotBookChange[] {
  const changes: SnapshotBookChange[] = [];
  let serial = 0;
  const addChange = (
    kind: SnapshotBookChange["kind"],
    figure: SnapshotPreviewFigure,
    locationLabel: string,
    summary: string,
    details: readonly string[],
  ): void => {
    changes.push({
      id: `snapshot-figure-change-${input.bookKind ?? "description-drawings"}-${++serial}`,
      kind,
      bookKind: input.bookKind ?? "description-drawings",
      blockId: figure.figureId,
      locationLabel,
      summary,
      details,
      nodeType: null,
    });
  };
  const baselineById = new Map(input.baselineFigures.map((figure) => [figure.figureId, figure]));
  const currentById = new Map(input.currentFigures.map((figure) => [figure.figureId, figure]));
  const baselinePosition = new Map(
    input.baselineFigures.map((figure, index) => [figure.figureId, index]),
  );

  for (const [index, figure] of input.baselineFigures.entries()) {
    if (currentById.has(figure.figureId)) continue;
    addChange("delete", figure, `图${index + 1}`, "删除附图", [`删除附图：图${index + 1}`]);
  }
  for (const [index, figure] of input.currentFigures.entries()) {
    if (baselineById.has(figure.figureId)) continue;
    addChange("insert", figure, `图${index + 1}`, "新增附图", [`新增附图：图${index + 1}`]);
  }
  for (const [index, figure] of input.currentFigures.entries()) {
    const baseline = baselineById.get(figure.figureId);
    if (!baseline) continue;
    const details: string[] = [];
    if (baseline.widthMm !== figure.widthMm)
      details.push(`附图宽度：${baseline.widthMm} → ${figure.widthMm}`);
    if (baseline.assetId !== figure.assetId) details.push("附图图片：已替换");
    if ((baseline.rotationDeg ?? 0) !== (figure.rotationDeg ?? 0))
      details.push(`附图旋转：${baseline.rotationDeg ?? 0}° → ${figure.rotationDeg ?? 0}°`);
    if (details.length > 0) addChange("structure", figure, `图${index + 1}`, "附图调整", details);
  }

  // 只看共同附图之间的相对顺序；纯粹的增删不应被当作顺序调整。
  const commonBaselineOrder = input.baselineFigures
    .map((figure) => figure.figureId)
    .filter((figureId) => currentById.has(figureId));
  const commonCurrentOrder = input.currentFigures
    .map((figure) => figure.figureId)
    .filter((figureId) => baselineById.has(figureId));
  if (commonBaselineOrder.join(",") !== commonCurrentOrder.join(",")) {
    const moved = input.currentFigures
      .map((figure, index) => {
        const previous = baselinePosition.get(figure.figureId);
        if (previous === undefined || previous === index) return null;
        return `图${index + 1}：第${previous + 1}位 → 第${index + 1}位`;
      })
      .filter((detail): detail is string => detail !== null);
    const firstCommon = input.currentFigures.find((figure) => baselineById.has(figure.figureId));
    if (firstCommon) addChange("structure", firstCommon, "附图列表", "附图顺序调整", moved);
  }

  return changes;
}
