import { Table, TableCell, TableHeader, TableRow, TableView } from "@tiptap/extension-table";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { columnResizingPluginKey } from "@tiptap/pm/tables";
import { attachTableAnnotationEditors } from "../table/table-annotation-view";
import { createPatentTableCellNodeView } from "../table/table-cell-node-view";
import { beginTableColumnResize } from "../table/table-column-resize";
import { hasFirstRowHeader } from "../table/table-header-state";
import { createPatentTableRowNodeView } from "../table/table-row-node-view";

const annotationViews = new WeakMap<HTMLElement, ReturnType<typeof attachTableAnnotationEditors>>();
const annotationStates = new WeakMap<
  HTMLElement,
  {
    node: ProseMirrorNode;
    number: number;
    editable: boolean;
  }
>();

function syncTableAnnotations(view: import("@tiptap/pm/view").EditorView) {
  let number = 0;
  view.state.doc.descendants((node, position) => {
    if (node.type.name !== "table") return;
    if (node.attrs.tableNameEnabled && String(node.attrs.tableName ?? "").trim()) number++;
    const dom = view.nodeDOM(position);
    if (dom instanceof HTMLElement) {
      const previous = annotationStates.get(dom);
      if (
        previous?.node === node &&
        previous.number === number &&
        previous.editable === view.editable
      )
        return false;
      annotationViews.get(dom)?.sync(node.attrs, number);
      annotationStates.set(dom, { node, number, editable: view.editable });
    }
    return false;
  });
}

export const PATENT_TABLE_CELL_MIN_WIDTH_PX = 40;

function tableHeaderRowCount(element: HTMLElement): number {
  return element.getAttribute("data-header-row-count") === "1" ? 1 : 0;
}

function tableLayoutMode(element: HTMLElement): "fit-page" | "fixed" {
  return element.getAttribute("data-layout-mode") === "fixed" ? "fixed" : "fit-page";
}

function tableColumnWidths(element: HTMLElement): number[] | null {
  const value = element.getAttribute("data-column-widths-mm");
  if (!value) return null;
  const widths = value.split(",").map(Number);
  return widths.length > 0 &&
    widths.length <= 1000 &&
    widths.every((width) => Number.isFinite(width) && width > 0 && width <= 500)
    ? widths
    : null;
}

function tableRowHeight(element: HTMLElement): number | null {
  const value = Number(element.getAttribute("data-row-height-mm"));
  return Number.isFinite(value) && value >= 3 && value <= 300 ? value : null;
}

function tableRowHeightRule(element: HTMLElement): "at-least" | "exact" | null {
  const value = element.getAttribute("data-row-height-rule");
  return value === "at-least" || value === "exact" ? value : null;
}

function hasValidRowHeight(attributes: Record<string, unknown>): attributes is Record<
  string,
  unknown
> & {
  rowHeightMm: number;
  rowHeightRule: "at-least" | "exact";
} {
  return (
    typeof attributes.rowHeightMm === "number" &&
    Number.isFinite(attributes.rowHeightMm) &&
    attributes.rowHeightMm >= 3 &&
    attributes.rowHeightMm <= 300 &&
    (attributes.rowHeightRule === "at-least" || attributes.rowHeightRule === "exact")
  );
}

function syncTableSizeAttributes(table: HTMLTableElement, node: ProseMirrorNode): void {
  const layoutMode = node.attrs.layoutMode === "fixed" ? "fixed" : "fit-page";
  table.setAttribute("data-layout-mode", layoutMode);
  const alignment = node.attrs.tableAlignment ?? "left";
  table.style.marginLeft = alignment === "left" ? "0" : "auto";
  table.style.marginRight = alignment === "right" ? "0" : "auto";
  table.style.maxWidth = "100%";
  if (layoutMode === "fit-page") table.style.width = "100%";
  const widths = node.attrs.columnWidthsMm;
  if (
    Array.isArray(widths) &&
    widths.length > 0 &&
    widths.every((width) => typeof width === "number" && Number.isFinite(width) && width > 0)
  ) {
    table.setAttribute("data-column-widths-mm", widths.join(","));
    table.style.minWidth = "";
    const allColumns = table.querySelectorAll<HTMLTableColElement>(":scope > colgroup > col");
    allColumns.forEach((column) => {
      column.style.minWidth = "0";
    });
    if (layoutMode === "fixed") {
      table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}mm`;
    }
    // Relative tracks share the table's available inner width, including collapsed
    // borders. Independent physical tracks can round up and force false overflow.
    {
      const total = widths.reduce((sum, width) => sum + width, 0);
      const columns = table.querySelectorAll<HTMLTableColElement>(":scope > colgroup > col");
      columns.forEach((column, index) => {
        const percentage = ((widths[index] ?? 0) / total) * 100;
        column.style.width = `${Number(percentage.toFixed(4))}%`;
      });
    }
  } else {
    table.removeAttribute("data-column-widths-mm");
  }
}

class PatentTableView extends TableView {
  constructor(...args: ConstructorParameters<typeof TableView>) {
    super(...args);
    syncTableSizeAttributes(this.table, args[0]);
    if (args[2]) {
      const annotations = attachTableAnnotationEditors(this.dom, this.table, args[2]);
      annotationViews.set(this.dom, annotations);
      annotations.sync(args[0].attrs, 0);
    }
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Element && !!event.target.closest(".table-annotation");
  }

  destroy() {
    annotationViews.get(this.dom)?.destroy();
  }

  override update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    // Upstream switches between width and min-width without clearing the other
    // property. Undoing a resize otherwise leaves the old pixel widths visible.
    for (const column of this.colgroup.children) {
      if (!(column instanceof HTMLElement)) continue;
      column.style.removeProperty("width");
      column.style.removeProperty("min-width");
    }
    const updated = super.update(node);
    if (updated) syncTableSizeAttributes(this.table, node);
    return updated;
  }
}

const cellAttributes = {
  ...Object.fromEntries(
    (["Top", "Right", "Bottom", "Left"] as const).map((side) => [
      `padding${side}Mm`,
      {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute(`data-padding-${side.toLowerCase()}-mm`);
          const value = raw === null ? NaN : Number(raw);
          return Number.isFinite(value) && value >= 0 && value <= 20 ? value : null;
        },
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs[`padding${side}Mm`] == null
            ? {}
            : {
                [`data-padding-${side.toLowerCase()}-mm`]: String(attrs[`padding${side}Mm`]),
                style: `padding-${side.toLowerCase()}: ${attrs[`padding${side}Mm`]}mm`,
              },
      },
    ]),
  ),
  horizontalAlignment: {
    default: "left",
    parseHTML: (element: HTMLElement) =>
      element.getAttribute("data-horizontal-alignment") ?? "left",
    renderHTML: (attributes: Record<string, unknown>) => ({
      "data-horizontal-alignment": attributes.horizontalAlignment,
    }),
  },
  verticalAlignment: {
    default: "top",
    parseHTML: (element: HTMLElement) => element.getAttribute("data-vertical-alignment") ?? "top",
    renderHTML: (attributes: Record<string, unknown>) => ({
      "data-vertical-alignment": attributes.verticalAlignment,
    }),
  },
  borderStyle: {
    default: "single",
    parseHTML: (element: HTMLElement) => element.getAttribute("data-border-style") ?? "single",
    renderHTML: (attributes: Record<string, unknown>) => ({
      "data-border-style": attributes.borderStyle,
    }),
  },
  borderTop: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-border-top"),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.borderTop === null ? {} : { "data-border-top": attributes.borderTop },
  },
  borderRight: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-border-right"),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.borderRight === null ? {} : { "data-border-right": attributes.borderRight },
  },
  borderBottom: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-border-bottom"),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.borderBottom === null ? {} : { "data-border-bottom": attributes.borderBottom },
  },
  borderLeft: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-border-left"),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.borderLeft === null ? {} : { "data-border-left": attributes.borderLeft },
  },
};

export const PatentTable = Table.extend({
  addProseMirrorPlugins() {
    const plugins = (this.parent?.() ?? []).map((plugin) => {
      if (plugin.spec.key !== columnResizingPluginKey) return plugin;
      const upstreamMouseMove = plugin.spec.props?.handleDOMEvents?.mousemove;
      return new Plugin({
        ...plugin.spec,
        props: {
          ...plugin.spec.props,
          handleDOMEvents: {
            ...plugin.spec.props?.handleDOMEvents,
            mousemove: (view, event) => {
              const resize = columnResizingPluginKey.getState(view.state);
              if (event.buttons !== 0 && !resize?.dragging) {
                if (resize && resize.activeHandle >= 0)
                  view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: -1 }));
                return false;
              }
              return upstreamMouseMove?.call(plugin, view, event) ?? false;
            },
            mousedown: (view, event) =>
              beginTableColumnResize(view, event, this.options.cellMinWidth, this.editor),
          },
        },
      });
    });
    return [
      ...plugins,
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const tr = state.tr;
          state.doc.descendants((table, position) => {
            if (table.type.spec.tableRole !== "table") return !table.isTextblock;
            const headerRowCount = hasFirstRowHeader(table) ? 1 : 0;
            if (table.attrs.headerRowCount !== headerRowCount)
              tr.setNodeMarkup(position, undefined, { ...table.attrs, headerRowCount });
            return false;
          });
          return tr.docChanged ? tr : null;
        },
      }),
      new Plugin({
        view: (view) => {
          syncTableAnnotations(view);
          let editable = view.editable;
          return {
            update: (next, previous) => {
              if (next.state.doc !== previous.doc || editable !== next.editable)
                syncTableAnnotations(next);
              editable = next.editable;
            },
          };
        },
      }),
    ];
  },
  addOptions() {
    return {
      HTMLAttributes: {},
      resizable: false,
      renderWrapper: false,
      handleWidth: 5,
      cellMinWidth: 25,
      lastColumnResizable: true,
      allowTableNodeSelection: false,
      ...this.parent?.(),
      View: PatentTableView,
    };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      ...Object.fromEntries(
        (["tableNameEnabled", "tableName", "tableNoteEnabled", "tableNote"] as const).map((key) => [
          key,
          {
            default: key.endsWith("Enabled") ? false : "",
            parseHTML: (element: HTMLElement) =>
              key.endsWith("Enabled")
                ? element.getAttribute(
                    `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
                  ) === "true"
                : (element.getAttribute(
                    `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
                  ) ?? ""),
            renderHTML: (attrs: Record<string, unknown>) => ({
              [`data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`]: String(
                attrs[key],
              ),
            }),
          },
        ]),
      ),
      headerRowCount: {
        default: 0,
        parseHTML: tableHeaderRowCount,
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-header-row-count": attributes.headerRowCount,
        }),
      },
      layoutMode: {
        default: "fit-page",
        parseHTML: tableLayoutMode,
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-layout-mode": attributes.layoutMode,
        }),
      },
      tableAlignment: {
        default: "left",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-table-alignment") ?? "left",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-table-alignment": attributes.tableAlignment,
        }),
      },
      columnWidthsMm: {
        default: null,
        parseHTML: tableColumnWidths,
        renderHTML: (attributes: Record<string, unknown>) =>
          Array.isArray(attributes.columnWidthsMm)
            ? { "data-column-widths-mm": attributes.columnWidthsMm.join(",") }
            : {},
      },
    };
  },
});

export const PatentTableRow = TableRow.extend({
  addNodeView() {
    return ({ node }) => createPatentTableRowNodeView(node);
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      rowHeightMm: {
        default: null,
        parseHTML: tableRowHeight,
        renderHTML: (attributes: Record<string, unknown>) =>
          hasValidRowHeight(attributes)
            ? {
                "data-row-height-mm": String(attributes.rowHeightMm),
                style: `--patent-row-height: ${attributes.rowHeightMm}mm`,
              }
            : {},
      },
      rowHeightRule: {
        default: null,
        parseHTML: tableRowHeightRule,
        renderHTML: (attributes: Record<string, unknown>) =>
          hasValidRowHeight(attributes) ? { "data-row-height-rule": attributes.rowHeightRule } : {},
      },
    };
  },
});

export const PatentTableCell = TableCell.extend({
  content: "paragraph+",
  addAttributes() {
    return { ...this.parent?.(), ...cellAttributes };
  },
  addNodeView() {
    return ({ node }) => createPatentTableCellNodeView(node, "td");
  },
});

export const PatentTableHeader = TableHeader.extend({
  content: "paragraph+",
  addAttributes() {
    return { ...this.parent?.(), ...cellAttributes };
  },
  addNodeView() {
    return ({ node }) => createPatentTableCellNodeView(node, "th");
  },
});
