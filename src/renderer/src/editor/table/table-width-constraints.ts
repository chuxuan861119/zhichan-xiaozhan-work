import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import { defaultDocumentFontSizePt } from "../../../../shared/document/font-policy";

import type { CellWidthConstraint } from "../../../../shared/document/table-width-solver";

export {
  type CellWidthConstraint,
  fitConstrainedWidths,
} from "../../../../shared/document/table-width-solver";
export function tableWidthConstraints(table: ProseMirrorNode, minimum = 40): CellWidthConstraint[] {
  const map = TableMap.get(table);
  return [...new Set(map.map)].flatMap((offset) => {
    const cell = table.nodeAt(offset);
    if (!cell) return [];
    const rect = map.findCell(offset);
    const paddingPx =
      (((cell.attrs.paddingLeftMm ?? 2) + (cell.attrs.paddingRightMm ?? 2)) * 96) / 25.4;
    let fontPt = cell.firstChild?.attrs.defaultFontSizePt ?? defaultDocumentFontSizePt();
    let objectPx = 0;
    cell.descendants((node) => {
      if (typeof node.attrs.defaultFontSizePt === "number")
        fontPt = Math.max(fontPt, node.attrs.defaultFontSizePt);
      for (const mark of node.marks) {
        if (typeof mark.attrs.fontSizePt === "number")
          fontPt = Math.max(fontPt, mark.attrs.fontSizePt);
      }
      if (node.type.name === "inlineFigure" && typeof node.attrs.widthMm === "number")
        objectPx = Math.max(objectPx, (node.attrs.widthMm * 96) / 25.4);
    });
    const fontPx = Math.max((fontPt * 96) / 72, objectPx);
    return [
      {
        left: rect.left,
        right: rect.right,
        minimum: Math.max(minimum, paddingPx + fontPx + 2),
      },
    ];
  });
}

export function resizeConstrainedWidths(
  widths: readonly number[],
  column: number,
  delta: number,
  maxTotal: number,
  constraints: readonly CellWidthConstraint[],
): number[] {
  const result = [...widths];
  if (column === widths.length - 1) {
    const total = widths.reduce((a, b) => a + b, 0);
    let minRatio = 0;
    for (const c of constraints)
      minRatio = Math.max(
        minRatio,
        c.minimum / widths.slice(c.left, c.right).reduce((a, b) => a + b, 0),
      );
    const lower = Math.min(total, total * minRatio);
    const target = Math.max(lower, Math.min(Math.max(lower, maxTotal), total + delta));
    return widths.map((width) => (width * target) / total);
  }
  let low = 0.1 - (widths[column] ?? 0);
  let high = (widths[column + 1] ?? 0) - 0.1;
  for (const c of constraints) {
    const coefficient =
      Number(column >= c.left && column < c.right) -
      Number(column + 1 >= c.left && column + 1 < c.right);
    const available = widths.slice(c.left, c.right).reduce((a, b) => a + b, 0) - c.minimum;
    if (coefficient === 1) low = Math.max(low, -Math.max(0, available));
    if (coefficient === -1) high = Math.min(high, Math.max(0, available));
  }
  const move = Math.max(low, Math.min(high, delta));
  result[column] = (widths[column] ?? 0) + move;
  result[column + 1] = (widths[column + 1] ?? 0) - move;
  return result;
}
