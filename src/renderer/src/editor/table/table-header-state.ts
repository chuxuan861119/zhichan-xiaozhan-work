import type { Node } from "@tiptap/pm/model";

export function hasFirstRowHeader(table: Node): boolean {
  const row = table.firstChild;
  if (!row?.childCount) return false;
  let header = true;
  row.forEach((cell) => {
    if (cell.type.spec.tableRole !== "header_cell") header = false;
  });
  return header;
}
