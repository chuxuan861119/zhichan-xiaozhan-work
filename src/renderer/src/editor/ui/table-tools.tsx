import type { Editor } from "@tiptap/core";
import { insertPatentTable as insertTable } from "../table/table-commands";

export { runTableCommand } from "../table/table-commands";

export function insertPatentTable(editor: Editor, rows: number, columns: number): boolean {
  return insertTable(editor, { rows, columns, headerRowCount: 0, layoutMode: "fit-page" });
}
