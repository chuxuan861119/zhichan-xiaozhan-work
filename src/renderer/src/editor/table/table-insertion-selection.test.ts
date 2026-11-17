import { Editor } from "@tiptap/core";
import { TableMap } from "@tiptap/pm/tables";
import { createPatentExtensions } from "../extensions";
import { runTableCommand } from "./table-commands";
import { inspectTableSelection } from "./table-selection";

for (const axis of ["row", "column"] as const) {
  for (const side of ["before", "after"] as const) {
    test.each([false, true])(
      `inserting ${axis} ${side} selects the new section (multiple=%s)`,
      (multiple) => {
        const editor = new Editor({
          extensions: createPatentExtensions(),
          content: `<p>前文</p><table>${Array.from({ length: 3 }, (_, row) => `<tr>${Array.from({ length: 3 }, (_, column) => `<td>${row}:${column}</td>`).join("")}</tr>`).join("")}</table><p>后文</p>`,
        });
        try {
          const initialized = editor.state.tr;
          editor.state.doc.descendants((node, position) => {
            if ("nodeId" in node.attrs && !node.attrs.nodeId)
              initialized.setNodeMarkup(position, undefined, {
                ...node.attrs,
                nodeId: crypto.randomUUID(),
              });
          });
          editor.view.dispatch(initialized.setMeta("addToHistory", false));
          let tableFrom = -1;
          editor.state.doc.descendants((node, position) => {
            if (node.type.spec.tableRole === "table") tableFrom = position;
          });
          const table = editor.state.doc.nodeAt(tableFrom)!;
          const map = TableMap.get(table);
          if (multiple) {
            editor.commands.setCellSelection({
              anchorCell: tableFrom + 1 + map.map[0]!,
              headCell: tableFrom + 1 + map.map[4]!,
            });
          } else {
            editor.commands.setTextSelection(tableFrom + 1 + map.map[4]! + 2);
          }
          const before = editor.getJSON();
          const target = side === "before" ? (multiple ? 0 : 1) : 2;
          const command = `add-${axis}-${side}` as const;
          const expectSelection = (index: number) => {
            expect(inspectTableSelection(editor)).toMatchObject({
              kind: axis,
              selectedCellCount: 3,
              ...(axis === "row"
                ? { selectedRowIndexes: [index], selectedColumnIndexes: [0, 1, 2] }
                : { selectedColumnIndexes: [index], selectedRowIndexes: [0, 1, 2] }),
            });
          };
          expect(runTableCommand(editor, command)).toBe(true);
          expectSelection(target);
          const first = editor.getJSON();
          expect(editor.commands.undo()).toBe(true);
          expect(editor.getJSON()).toEqual(before);
          expect(editor.commands.redo()).toBe(true);
          expectSelection(target);
          expect(runTableCommand(editor, command)).toBe(true);
          expectSelection(side === "before" ? target : target + 1);
          expect(editor.commands.undo()).toBe(true);
          expect(editor.getJSON()).toEqual(first);
        } finally {
          editor.destroy();
        }
      },
    );
  }
}
