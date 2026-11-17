/** Copy supported clipboard geometry into bounded, inert editor attributes before styles are removed. */
export function preserveTablePasteFormatting(
  body: HTMLElement,
  options: {
    internal: boolean;
    sourceParagraphs: boolean;
    millimetres(value: string): number | null;
  },
): string[] {
  const issues = new Set<string>();
  const mm = options.millimetres;
  const sides = ["top", "right", "bottom", "left"] as const;
  const length = (value: string, base: number) => {
    if (/^\d+(?:\.\d+)?%$/u.test(value.trim())) return (Number.parseFloat(value) * base) / 100;
    return mm(value);
  };
  for (const table of body.querySelectorAll<HTMLTableElement>("table")) {
    if (!options.internal) {
      const rawWidth = table.style.width || table.getAttribute("width") || "";
      const tableWidth = length(/^\d+$/u.test(rawWidth) ? `${rawWidth}px` : rawWidth, 165);
      const cols = [
        ...table.querySelectorAll<HTMLTableColElement>(":scope > colgroup > col, :scope > col"),
      ];
      const widths: (number | null)[] = cols
        .flatMap((col) => {
          const raw = col.style.width || col.getAttribute("width") || "";
          return Array.from({ length: Math.min(1000, col.span || 1) }, () =>
            length(/^\d+$/u.test(raw) ? `${raw}px` : raw, tableWidth ?? 165),
          );
        })
        .slice(0, 1000);
      const spans: { left: number; right: number; width: number }[] = [];
      const cells: {
        cell: HTMLTableCellElement;
        left: number;
        right: number;
      }[] = [];
      const occupied: number[] = [];
      let count = widths.length;
      for (const [r, row] of [...table.rows].entries()) {
        if (row.closest("table") !== table) continue;
        let c = 0;
        for (const cell of [...row.cells]) {
          while ((occupied[c] ?? 0) > r && c < 1000) c++;
          const span = Math.max(1, Math.min(1000 - c, cell.colSpan));
          if (c >= 1000) break;
          cells.push({ cell, left: c, right: c + span });
          const raw = cell.style.width || cell.getAttribute("width") || "";
          const width = length(/^\d+$/u.test(raw) ? `${raw}px` : raw, tableWidth ?? 165);
          if (width && width > 0) spans.push({ left: c, right: c + span, width });
          for (let index = c; index < c + span; index++)
            occupied[index] = r + Math.max(1, Math.min(1000, cell.rowSpan));
          c += span;
        }
        count = Math.max(count, c);
      }
      while (widths.length < count) widths.push(null);
      for (const span of spans.sort((a, b) => a.right - a.left - (b.right - b.left))) {
        const missing = Array.from(
          { length: span.right - span.left },
          (_, i) => span.left + i,
        ).filter((i) => widths[i] == null);
        const known = widths
          .slice(span.left, span.right)
          .reduce<number>((sum, value) => sum + (value ?? 0), 0);
        for (const index of missing)
          widths[index] = Math.max(0.1, (span.width - known) / missing.length);
      }
      if (count) {
        const known = widths.reduce<number>((sum, value) => sum + (value ?? 0), 0);
        const missing = widths.filter((value) => value == null).length;
        const fallback = Math.max(
          0.1,
          ((tableWidth ?? Math.max(165, known)) - known) / Math.max(1, missing),
        );
        let resolved = widths.map((value) => value ?? fallback);
        const total = resolved.reduce((sum, value) => sum + value, 0);
        if (tableWidth && total > 0)
          resolved = resolved.map((value) => (value * tableWidth) / total);
        if (resolved.every((value) => value > 0 && value <= 500)) {
          table.dataset.columnWidthsMm = resolved
            .map((value) => Math.max(0.001, Math.round(value * 1000) / 1000))
            .join(",");
          cells.forEach(({ cell, left, right }) => {
            cell.setAttribute(
              "colwidth",
              resolved
                .slice(left, right)
                .map((value) => Math.max(1, Math.round((value * 96) / 25.4)))
                .join(","),
            );
          });
          table.dataset.layoutMode =
            rawWidth.endsWith("%") || (!tableWidth && !spans.length && !cols.length)
              ? "fit-page"
              : "fixed";
        } else issues.add("部分表格尺寸超出支持范围，请核对列宽");
      }
      if (table.rows[0]?.cells[0]?.tagName === "TH") table.dataset.headerRowCount = "1";
    }
    for (const row of [...table.rows]) {
      if (row.closest("table") !== table) continue;
      if (!options.internal) {
        const height = mm(row.style.height || `${row.getAttribute("height") ?? ""}px`);
        if (height !== null && height >= 3 && height <= 300) {
          row.dataset.rowHeightMm = String(height);
          row.dataset.rowHeightRule = /mso-height-rule\s*:\s*exactly/iu.test(
            row.getAttribute("style") ?? "",
          )
            ? "exact"
            : "at-least";
        }
      }
      for (const cell of [...row.cells]) {
        if (!options.internal) {
          for (const side of sides) {
            const value = mm(cell.style.getPropertyValue(`padding-${side}`));
            if (value !== null && value <= 20)
              cell.setAttribute(`data-padding-${side}-mm`, String(value));
            else if (value !== null) issues.add("部分单元格留白超出支持范围");
            else
              cell.setAttribute(
                `data-padding-${side}-mm`,
                side === "top" || side === "bottom" ? "1" : "2",
              );
          }
          const valign = cell.style.verticalAlign || cell.getAttribute("valign");
          if (valign && ["top", "middle", "bottom"].includes(valign))
            cell.dataset.verticalAlignment = valign;
          const align = cell.style.textAlign || cell.getAttribute("align");
          if (align && ["left", "center", "right"].includes(align))
            cell.dataset.horizontalAlignment = align;
          for (const side of sides) {
            const border = cell.style.getPropertyValue(`border-${side}-style`);
            if (border)
              cell.setAttribute(
                `data-border-${side}`,
                border === "none" ? "none" : border === "double" ? "double" : "single",
              );
          }
        }
        // Browsers also copy cells with text directly under td, without paragraph elements.
        let paragraph: HTMLParagraphElement | null = null;
        for (const child of [...cell.childNodes]) {
          // Pretty-printed clipboard markup has whitespace between block tags;
          // it is not a visible empty paragraph. Keep spaces within inline text.
          if (!paragraph && child.nodeType === 3 && !child.textContent?.trim()) {
            const next = child.nextSibling;
            const leadingInlineSpace =
              /^[ \t\u00a0\u3000]+$/u.test(child.textContent ?? "") &&
              next instanceof Element &&
              !next.matches("p,div,h1,h2,h3,ul,ol,table,br") &&
              Boolean(next.textContent?.trim());
            if (!leadingInlineSpace) continue;
          }
          if (child instanceof Element && child.matches("p,div,h1,h2,h3,ul,ol,table")) {
            paragraph = null;
            continue;
          }
          if (!paragraph) {
            paragraph = body.ownerDocument.createElement("p");
            cell.insertBefore(paragraph, child);
          }
          paragraph.append(child);
        }
        for (const p of cell.querySelectorAll<HTMLElement>("p,h1,h2,h3")) {
          if (options.internal) continue;
          if (!options.sourceParagraphs) {
            p.dataset.lineHeight = "1";
            p.dataset.spaceBeforePt = "0";
            p.dataset.spaceAfterPt = "0";
            continue;
          }
          const raw = p.style.lineHeight || cell.style.lineHeight;
          const ratio = raw.endsWith("%")
            ? Number.parseFloat(raw) / 100
            : /^\d+(?:\.\d+)?$/u.test(raw)
              ? Number(raw)
              : NaN;
          if (!raw || raw === "normal") p.dataset.lineHeight = "1";
          else if (ratio >= 1 && ratio <= 3) p.dataset.lineHeight = String(ratio);
          else issues.add("固定行距或不支持的行距已采用默认值");
          for (const [edge, name] of [
            ["top", "before"],
            ["bottom", "after"],
          ] as const) {
            const value = mm(p.style.getPropertyValue(`margin-${edge}`));
            if (value !== null && (value * 72) / 25.4 <= 200)
              p.setAttribute(
                `data-space-${name}-pt`,
                String(Math.round(((value * 72) / 25.4) * 100) / 100),
              );
          }
        }
      }
    }
  }
  return [...issues];
}
