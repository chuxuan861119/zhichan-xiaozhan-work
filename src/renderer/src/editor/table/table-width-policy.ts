import { Extension } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import { showAppAlert } from "../../shared/app-dialog";
import {
  TABLE_COLUMN_WIDTH_SYNC_META,
  TABLE_COMMAND_COLUMN_WIDTH_META,
} from "./table-column-width-sync";
import { editorContentWidthMm } from "./table-layout-width";
import { fitConstrainedWidths, tableWidthConstraints } from "./table-width-constraints";

const MM_PER_PX = 25.4 / 96;
export const TABLE_WIDTH_POLICY_META = "patentTableWidthPolicy";
export const TABLE_WIDTH_MESSAGE =
  "表格无法在正文宽度内完整显示，请减少列数或拆成多张表。原内容未改变。";
type Options = { paste?: boolean; before?: PMNode };
type Plan = { position: number; widths: number[] };
type BodyWidth = number | (() => number);
const signatures = new WeakMap<PMNode, string>();

function tables(doc: PMNode) {
  const result: { node: PMNode; position: number }[] = [];
  doc.descendants((node, position) => {
    if (node.type.spec.tableRole === "table") {
      result.push({ node, position });
      return false;
    }
  });
  return result;
}

function widthsPx(table: PMNode): number[] {
  const map = TableMap.get(table);
  const canonical = table.attrs.columnWidthsMm;
  if (
    Array.isArray(canonical) &&
    canonical.length === map.width &&
    canonical.every((w) => Number.isFinite(w) && w > 0)
  )
    return canonical.map((w) => w / MM_PER_PX);
  const widths = Array<number>(map.width).fill(113);
  for (const offset of new Set(map.map)) {
    const cell = table.nodeAt(offset),
      rect = map.findCell(offset);
    if (!Array.isArray(cell?.attrs.colwidth)) continue;
    cell.attrs.colwidth.forEach((value: unknown, index: number) => {
      if (typeof value === "number" && value > 0) widths[rect.left + index] = value;
    });
  }
  return widths;
}

function signature(table: PMNode): string {
  const cached = signatures.get(table);
  if (cached) return cached;
  // Row count/text edits must not cause a manual width to be recomputed.
  const constraints = [
    ...new Set(tableWidthConstraints(table).map((c) => `${c.left}:${c.right}:${c.minimum}`)),
  ].sort();
  const value = JSON.stringify([
    TableMap.get(table).width,
    table.attrs.layoutMode,
    widthsPx(table),
    constraints,
  ]);
  signatures.set(table, value);
  return value;
}

function plans(tr: Transaction, bodyMm: BodyWidth, options: Options): Plan[] | null {
  const previous = tables(options.before ?? tr.before);
  const result: Plan[] = [];
  let measuredBodyPx: number | undefined;
  for (const { node, position } of tables(tr.doc)) {
    const before =
      previous.find((item) => node.attrs.nodeId && item.node.attrs.nodeId === node.attrs.nodeId)
        ?.node ??
      previous.find((item) => item.position === position && !item.node.attrs.nodeId)?.node;
    if (before?.eq(node) || (before && signature(before) === signature(node))) continue;
    if (
      before &&
      !options.paste &&
      !node.attrs.columnWidthsMm &&
      [...new Set(TableMap.get(node).map)].some((offset) => {
        const value = node.nodeAt(offset)?.attrs.colwidth;
        return (
          Array.isArray(value) &&
          value.some((w) => typeof w !== "number" || !Number.isFinite(w) || w <= 0)
        );
      })
    )
      continue;
    // Reading clientWidth can force layout after an input. Ordinary text edits
    // leave table constraints unchanged and need no DOM measurements at all.
    measuredBodyPx ??= (typeof bodyMm === "function" ? bodyMm() : bodyMm) / MM_PER_PX;
    const bodyPx = measuredBodyPx;
    const widths = widthsPx(node),
      constraints = tableWidthConstraints(node);
    const total = widths.reduce((a, b) => a + b, 0);
    const target = node.attrs.layoutMode === "fixed" ? Math.min(total, bodyPx) : bodyPx;
    const fitted =
      fitConstrainedWidths(widths, target, constraints) ??
      fitConstrainedWidths(widths, bodyPx, constraints);
    if (!fitted) {
      // Legacy oversized documents are readable/editable; allow structural reductions,
      // but never add a column or increase the physical width of an invalid table.
      if (
        before &&
        !options.paste &&
        TableMap.get(node).width <= TableMap.get(before).width &&
        total <= widthsPx(before).reduce((a, b) => a + b, 0) + 0.01 &&
        requiredWidth(node) <= requiredWidth(before) + 0.01 &&
        !fitConstrainedWidths(widthsPx(before), bodyPx, tableWidthConstraints(before))
      )
        continue;
      return null;
    }
    const effective =
      node.attrs.layoutMode === "fixed" ? widths : widths.map((w) => (w * bodyPx) / total);
    const changed = fitted.some((w, i) => Math.abs(w - (effective[i] ?? 0)) > 0.01);
    if (
      changed ||
      !Array.isArray(node.attrs.columnWidthsMm) ||
      node.attrs.columnWidthsMm.length !== widths.length
    )
      result.push({ position, widths: fitted });
  }
  return result;
}

function requiredWidth(table: PMNode): number {
  const bounds = [0],
    constraints = tableWidthConstraints(table);
  for (let right = 1; right <= TableMap.get(table).width; right++) {
    let width = (bounds[right - 1] ?? 0) + 0.1;
    for (const c of constraints)
      if (c.right === right) width = Math.max(width, (bounds[c.left] ?? 0) + c.minimum);
    bounds.push(width);
  }
  return bounds.at(-1) ?? 0;
}

/** Preflight the entire operation before altering any table. Call before dispatch. */
export function normalizeTableTransaction(
  tr: Transaction,
  bodyMm: BodyWidth,
  options: Options = {},
): boolean {
  const pending = plans(tr, bodyMm, options);
  if (!pending) return false;
  for (const { position, widths } of pending) {
    const table = tr.doc.nodeAt(position);
    if (!table) throw new Error("表格位置已失效");
    const map = TableMap.get(table);
    // Keep fractional physical widths; independent rounding can make a full-width table overflow.
    tr.setNodeMarkup(position, undefined, {
      ...table.attrs,
      columnWidthsMm: widths.map((w) => w * MM_PER_PX),
    });
    for (const offset of new Set(map.map)) {
      const cell = tr.doc.nodeAt(position + 1 + offset);
      if (!cell) throw new Error("表格单元格位置已失效");
      const rect = map.findCell(offset);
      tr.setNodeMarkup(position + 1 + offset, undefined, {
        ...cell.attrs,
        colwidth: widths.slice(rect.left, rect.right).map((w) => Math.max(1, Math.round(w))),
      });
    }
  }
  if (pending.length) tr.setMeta(TABLE_COMMAND_COLUMN_WIDTH_META, true);
  return true;
}

export const TableWidthPolicy = Extension.create({
  name: "tableWidthPolicy",
  priority: 80,
  addProseMirrorPlugins() {
    const editor = this.editor;
    let noticePending = false;
    const exempt = (tr: Transaction) =>
      !tr.docChanged ||
      isHistoryTransaction(tr) ||
      tr.getMeta("preventUpdate") !== undefined ||
      tr.getMeta(TABLE_WIDTH_POLICY_META);
    return [
      new Plugin({
        filterTransaction(tr) {
          if (exempt(tr)) return true;
          const ok =
            plans(tr, () => editorContentWidthMm(editor) ?? 165, {
              paste: tr.getMeta("uiEvent") === "paste",
            }) !== null;
          if (!ok && !noticePending) {
            noticePending = true;
            queueMicrotask(() => {
              noticePending = false;
              if (!editor.isDestroyed) showAppAlert(TABLE_WIDTH_MESSAGE);
            });
          }
          return ok;
        },
        appendTransaction(transactions, oldState, newState) {
          if (
            transactions.every(exempt) ||
            transactions.some(
              (tr) =>
                isHistoryTransaction(tr) ||
                tr.getMeta("preventUpdate") !== undefined ||
                tr.getMeta(TABLE_WIDTH_POLICY_META),
            )
          )
            return null;
          // Let width synchronization finish before evaluating canonical widths.
          const tr = newState.tr;
          if (
            !normalizeTableTransaction(tr, () => editorContentWidthMm(editor) ?? 165, {
              before: oldState.doc,
              paste: transactions.some((t) => t.getMeta("uiEvent") === "paste"),
            })
          )
            return null;
          return tr.docChanged
            ? tr.setMeta(TABLE_WIDTH_POLICY_META, true).setMeta(TABLE_COLUMN_WIDTH_SYNC_META, true)
            : null;
        },
      }),
    ];
  },
});
