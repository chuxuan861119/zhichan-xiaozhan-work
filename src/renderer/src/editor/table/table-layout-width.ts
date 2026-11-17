import type { Editor } from "@tiptap/core";

const MILLIMETRES_PER_PIXEL = 25.4 / 96;

/** Use layout pixels, not transformed screen coordinates, so zoom does not affect dimensions. */
export function renderedTableWidthMm(editor: Editor, tableFrom: number): number | null {
  const dom = editor.view.nodeDOM(tableFrom);
  if (!(dom instanceof HTMLElement)) return null;
  const table = dom instanceof HTMLTableElement ? dom : dom.querySelector("table");
  const width = table?.offsetWidth ?? 0;
  return width > 0 ? width * MILLIMETRES_PER_PIXEL : null;
}

export function editorContentWidthMm(editor: Pick<Editor, "view">): number | null {
  const dom = editor.view.dom;
  const styles = getComputedStyle(dom);
  const padding =
    (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0);
  const width = dom.clientWidth - padding;
  return width > 0 ? width * MILLIMETRES_PER_PIXEL : null;
}

export function scaleColumnWidths(widths: readonly number[], totalMm: number | null): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  return widths.map(
    (width) =>
      Math.round((totalMm && total > 0 ? (width / total) * totalMm : width) * 1_000) / 1_000,
  );
}
