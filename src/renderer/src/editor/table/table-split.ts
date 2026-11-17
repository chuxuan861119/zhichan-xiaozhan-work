import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import { randomUuid } from "../../../../shared/id";

export type TableSplitRequest = { rows: number; columns: number };

// Keep existing grid boundaries so neighboring cells need only span the new tracks.
function refineAxis(existing: number[], start: number, end: number, count: number) {
  const normalize = (value: number) => Math.round(value * 1e6) / 1e6;
  const cuts = Array.from({ length: count + 1 }, (_, i) =>
    normalize(start + ((end - start) * i) / count),
  );
  const axis = [...new Set([...existing.map(normalize), ...cuts])].sort((a, b) => a - b);
  return { axis, index: (value: number) => axis.indexOf(normalize(value)), cuts };
}

export function buildSplitTable(
  table: ProseMirrorNode,
  offset: number,
  request: TableSplitRequest,
  widths: number[],
): ProseMirrorNode | null {
  const map = TableMap.get(table);
  if (map.problems || widths.length !== map.width) return null;
  const target = table.nodeAt(offset);
  if (!target) return null;
  const rect = map.findCell(offset);
  const xs = [0];
  for (const width of widths) xs.push((xs.at(-1) ?? 0) + width);
  const ys = Array.from({ length: map.height + 1 }, (_, i) => i);
  const x = refineAxis(xs, xs[rect.left]!, xs[rect.right]!, request.columns);
  const y = refineAxis(ys, rect.top, rect.bottom, request.rows);
  if (x.axis.length > 1001 || y.axis.length > 1001 || x.axis.length * y.axis.length > 100_000)
    return null;
  const newWidths = x.axis.slice(1).map((value, i) => value - x.axis[i]!);
  if (newWidths.some((width) => width <= 0)) return null;
  const rows: { left: number; node: ProseMirrorNode }[][] = Array.from(
    { length: y.axis.length - 1 },
    () => [],
  );
  function addCell(
    cell: ProseMirrorNode,
    left: number,
    right: number,
    top: number,
    bottom: number,
    fresh = false,
  ) {
    const l = x.index(left),
      r = x.index(right),
      t = y.index(top),
      b = y.index(bottom);
    const type =
      fresh && cell.type.spec.tableRole === "header_cell" && t > 0
        ? table.type.schema.nodes.tableCell!
        : cell.type;
    const attrs = {
      ...cell.attrs,
      nodeId: fresh ? randomUuid() : cell.attrs.nodeId,
      colspan: r - l,
      rowspan: b - t,
      colwidth: newWidths.slice(l, r).map((width) => Math.max(1, Math.round((width * 96) / 25.4))),
    };
    const content = fresh
      ? table.type.schema.nodes.paragraph!.create({
          ...cell.firstChild?.attrs,
          nodeId: randomUuid(),
        })
      : cell.content;
    rows[t]!.push({ left: l, node: type.create(attrs, content) });
  }
  for (const oldOffset of new Set(map.map)) {
    const cell = table.nodeAt(oldOffset)!;
    const box = map.findCell(oldOffset);
    if (oldOffset !== offset) {
      addCell(cell, xs[box.left]!, xs[box.right]!, box.top, box.bottom);
      continue;
    }
    for (let row = 0; row < request.rows; row += 1) {
      for (let col = 0; col < request.columns; col += 1) {
        addCell(
          cell,
          x.cuts[col]!,
          x.cuts[col + 1]!,
          y.cuts[row]!,
          y.cuts[row + 1]!,
          row !== 0 || col !== 0,
        );
      }
    }
  }
  const newRows = rows.map((cells, index) => {
    const top = y.axis[index]!;
    const oldIndex = Math.floor(top + 1e-7);
    const oldRow = table.child(oldIndex);
    const fraction = y.axis[index + 1]! - top;
    const attrs: Record<string, unknown> = {
      ...oldRow.attrs,
      nodeId: Number.isInteger(top) ? oldRow.attrs.nodeId : randomUuid(),
    };
    if (typeof attrs.rowHeightMm === "number" && fraction < 1) {
      attrs.rowHeightMm = Math.max(3, attrs.rowHeightMm * fraction);
      attrs.rowHeightRule = "at-least";
    }
    return oldRow.type.create(
      attrs,
      cells.sort((a, b) => a.left - b.left).map((cell) => cell.node),
    );
  });
  const result = table.type.create({ ...table.attrs, columnWidthsMm: newWidths }, newRows);
  return TableMap.get(result).problems ? null : result;
}
