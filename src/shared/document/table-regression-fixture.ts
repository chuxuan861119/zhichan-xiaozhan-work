import { createBlankDocument } from "./defaults.js";
import type { ParagraphNode, TableCell, TableNode } from "./model.js";

/** Unequal columns, both merge directions, independent paragraph formatting and a header. */
export function tableRegressionDocument() {
  const document = createBlankDocument("表格格式回归");
  const base = document.content[0];
  if (base?.type !== "paragraph") throw new Error("Missing paragraph defaults");
  const paragraph = (
    text: string,
    alignment: ParagraphNode["attrs"]["alignment"],
  ): ParagraphNode => ({
    ...structuredClone(base),
    id: crypto.randomUUID(),
    attrs: {
      ...base.attrs,
      alignment,
      paragraphIndentMm: 0,
      lineSpacing: 1,
      spaceBeforePt: 3,
      spaceAfterPt: 4,
    },
    content: [
      { type: "text", text, marks: [{ type: "italic" }, { type: "font-size", valuePt: 12 }] },
    ],
  });
  const cell = (text: string, colSpan = 1, rowSpan = 1): TableCell => ({
    id: crypto.randomUUID(),
    colSpan,
    rowSpan,
    horizontalAlignment: "left",
    verticalAlignment: "middle",
    borderStyle: "single",
    content: [paragraph(text, "center"), paragraph(`${text}补充𠮷 αβ`, "right")],
  });
  const table: TableNode = {
    id: crypto.randomUUID(),
    type: "table",
    columnWidthsMm: [20, 40, 60],
    headerRowCount: 1,
    layoutMode: "fixed",
    tableAlignment: "center",
    tableNameEnabled: true,
    tableName: "原始数据",
    tableNoteEnabled: true,
    tableNote: "保持原文",
    rows: [
      { id: crypto.randomUUID(), cells: [cell("标题甲"), cell("标题乙"), cell("标题丙")] },
      { id: crypto.randomUUID(), cells: [cell("跨行", 1, 2), cell("跨列", 2)] },
      { id: crypto.randomUUID(), cells: [cell("末行乙"), cell("末行丙")] },
    ],
  };
  document.content = [table];
  return { document, table };
}
