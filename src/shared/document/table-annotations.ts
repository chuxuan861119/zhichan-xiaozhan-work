import type { BlockNode, TableNode } from "./model.js";

/** Captions and notes use small-four (12pt), independently of cell text. */
export const TABLE_ANNOTATION_FONT_SIZE_PT = 12;

export type TableAnnotationUpdate = Partial<
  Pick<TableNode, "tableNameEnabled" | "tableName" | "tableNoteEnabled" | "tableNote">
>;

export function tableNameNumbers(content: readonly BlockNode[]): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  for (const block of content) {
    if (block.type === "table" && block.tableNameEnabled && block.tableName?.trim())
      numbers.set(block.id, numbers.size + 1);
  }
  return numbers;
}

export function visibleTableAnnotations(table: TableNode, number?: number) {
  return {
    name:
      table.tableNameEnabled && table.tableName?.trim()
        ? `${number ? `表${number} ` : ""}${table.tableName.trim()}`
        : "",
    note: table.tableNoteEnabled ? (table.tableNote?.trim() ?? "") : "",
  };
}
