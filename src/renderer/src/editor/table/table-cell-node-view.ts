import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

type CellTagName = "td" | "th";

function setAttribute(element: HTMLElement, name: string, value: unknown): void {
  if (value === null || value === undefined || value === "") {
    element.removeAttribute(name);
    return;
  }
  element.setAttribute(name, String(value));
}

function synchronizeBorderEdge(
  element: HTMLTableCellElement,
  edge: "top" | "right" | "bottom" | "left",
  value: unknown,
): void {
  const style = value === "none" || value === "double" ? value : "solid";
  element.style.setProperty(`border-${edge}-style`, style);
  if (style === "double") element.style.setProperty(`border-${edge}-width`, "3px");
  else element.style.removeProperty(`border-${edge}-width`);
}

function synchronizeCellAttributes(element: HTMLTableCellElement, node: ProseMirrorNode): void {
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    const value = node.attrs[`padding${side}Mm`];
    setAttribute(element, `data-padding-${side.toLowerCase()}-mm`, value);
    if (typeof value === "number")
      element.style.setProperty(`padding-${side.toLowerCase()}`, `${value}mm`);
    else element.style.removeProperty(`padding-${side.toLowerCase()}`);
  }
  element.style.setProperty(
    "--patent-cell-vertical-padding",
    `${(node.attrs.paddingTopMm ?? 2) + (node.attrs.paddingBottomMm ?? 2)}mm`,
  );
  element.colSpan = Math.max(1, Number(node.attrs.colspan) || 1);
  element.rowSpan = Math.max(1, Number(node.attrs.rowspan) || 1);
  setAttribute(element, "data-horizontal-alignment", node.attrs.horizontalAlignment ?? "left");
  setAttribute(element, "data-vertical-alignment", node.attrs.verticalAlignment ?? "top");
  setAttribute(element, "data-border-style", node.attrs.borderStyle ?? "single");
  setAttribute(element, "data-border-top", node.attrs.borderTop);
  setAttribute(element, "data-border-right", node.attrs.borderRight);
  setAttribute(element, "data-border-bottom", node.attrs.borderBottom);
  setAttribute(element, "data-border-left", node.attrs.borderLeft);
  const fallbackBorder = node.attrs.borderStyle ?? "single";
  synchronizeBorderEdge(element, "top", node.attrs.borderTop ?? fallbackBorder);
  synchronizeBorderEdge(element, "right", node.attrs.borderRight ?? fallbackBorder);
  synchronizeBorderEdge(element, "bottom", node.attrs.borderBottom ?? fallbackBorder);
  synchronizeBorderEdge(element, "left", node.attrs.borderLeft ?? fallbackBorder);
}

function synchronizeOverflow(element: HTMLTableCellElement, contentDOM: HTMLElement): void {
  if (element.parentElement?.getAttribute("data-row-height-rule") !== "exact") {
    delete element.dataset.contentOverflow;
    return;
  }
  if (contentDOM.scrollHeight > contentDOM.clientHeight + 1)
    element.dataset.contentOverflow = "true";
  else delete element.dataset.contentOverflow;
}

/**
 * 在单帧内批量收集所有需要检测溢出的单元格，减少多次 ResizeObserver
 * 回调引起的同步布局读取（scrollHeight/clientHeight）导致的布局抖动。
 */
const pendingOverflowCells = new Set<[HTMLTableCellElement, HTMLElement]>();
let overflowBatchScheduled = false;
function scheduleOverflowBatch(): void {
  if (overflowBatchScheduled) return;
  overflowBatchScheduled = true;
  requestAnimationFrame(() => {
    overflowBatchScheduled = false;
    for (const [element, contentDOM] of pendingOverflowCells) {
      synchronizeOverflow(element, contentDOM);
    }
    pendingOverflowCells.clear();
  });
}

export function createPatentTableCellNodeView(
  node: ProseMirrorNode,
  tagName: CellTagName,
): NodeView {
  let currentNode = node;
  const dom = document.createElement(tagName);
  const contentDOM = document.createElement("div");
  contentDOM.className = "patent-table-cell-content";
  dom.append(contentDOM);
  synchronizeCellAttributes(dom, currentNode);

  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          pendingOverflowCells.add([dom, contentDOM]);
          scheduleOverflowBatch();
        });
  observer?.observe(contentDOM);
  synchronizeOverflow(dom, contentDOM);

  return {
    dom,
    contentDOM,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) return false;
      if (!nextNode.sameMarkup(currentNode)) synchronizeCellAttributes(dom, nextNode);
      currentNode = nextNode;
      synchronizeOverflow(dom, contentDOM);
      return true;
    },
    destroy() {
      observer?.disconnect();
    },
    ignoreMutation(mutation) {
      return mutation.type === "attributes" && mutation.target === dom;
    },
  };
}
