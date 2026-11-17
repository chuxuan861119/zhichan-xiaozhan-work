import { Editor, type JSONContent } from "@tiptap/core";
import { createBlankDocument } from "../../../shared/document/defaults";
import type { TableNode } from "../../../shared/document/model";
import { createPatentExtensions } from "./extensions";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";
import { insertPatentTable, runTableCommand } from "./ui/table-tools";

function tableJson(editor: Editor): JSONContent {
  const table = editor.getJSON().content?.find((node) => node.type === "table");
  if (!table) throw new Error("测试表格不存在");
  return table;
}

function cellPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "tableCell") positions.push(position);
  });
  return positions;
}

describe("table tools", () => {
  test("inserts explicit rows and columns and supports row/column commands", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    expect(insertPatentTable(editor, 2, 3)).toBe(true);
    expect(tableJson(editor).content).toHaveLength(2);
    expect(tableJson(editor).content?.[0]?.content).toHaveLength(3);

    const firstCell = cellPositions(editor)[0];
    expect(firstCell).toBeDefined();
    if (firstCell === undefined) return;
    editor.commands.setTextSelection(firstCell + 2);
    expect(runTableCommand(editor, "add-row-after")).toBe(true);
    expect(tableJson(editor).content).toHaveLength(3);
    expect(runTableCommand(editor, "delete-row")).toBe(true);
    expect(tableJson(editor).content).toHaveLength(2);
    expect(runTableCommand(editor, "add-column-after")).toBe(true);
    expect(tableJson(editor).content?.[0]?.content).toHaveLength(4);
    expect(runTableCommand(editor, "delete-column")).toBe(true);
    expect(tableJson(editor).content?.[0]?.content).toHaveLength(3);
    editor.destroy();
  });

  test("merges and splits selected cells", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    insertPatentTable(editor, 2, 2);
    const positions = cellPositions(editor);
    const first = positions[0];
    const second = positions[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    editor.commands.setCellSelection({ anchorCell: first, headCell: second });
    expect(runTableCommand(editor, "merge-cells")).toBe(true);
    expect(tableJson(editor).content?.[0]?.content?.[0]?.attrs?.colspan).toBe(2);
    expect(runTableCommand(editor, "split-cell")).toBe(true);
    expect(tableJson(editor).content?.[0]?.content).toHaveLength(2);
    editor.destroy();
  });

  test("round-trips widths, alignments, borders, and cell spans", () => {
    const base = createBlankDocument("表格测试");
    const paragraph = base.content[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;
    const table: TableNode = {
      id: "00000000-0000-4000-8000-000000000101",
      type: "table",
      columnWidthsMm: [25.4, 50.8],
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000102",
          cells: [
            {
              id: "00000000-0000-4000-8000-000000000103",
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "center",
              verticalAlignment: "middle",
              borderStyle: "double",
              content: [{ ...paragraph, id: "00000000-0000-4000-8000-000000000104" }],
            },
            {
              id: "00000000-0000-4000-8000-000000000105",
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "right",
              verticalAlignment: "bottom",
              borderStyle: "none",
              content: [{ ...paragraph, id: "00000000-0000-4000-8000-000000000106" }],
            },
          ],
        },
      ],
    };
    const document = { ...base, content: [table] };
    const result = tiptapToCanonical(canonicalToTiptap(document), document);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toEqual([table]);
  });

  test("rejects nested tables instead of persisting them", () => {
    const base = createBlankDocument("嵌套表格");
    const nested: JSONContent = {
      type: "doc",
      content: [
        {
          type: "table",
          attrs: { nodeId: "00000000-0000-4000-8000-000000000111" },
          content: [
            {
              type: "tableRow",
              attrs: { nodeId: "00000000-0000-4000-8000-000000000112" },
              content: [
                {
                  type: "tableCell",
                  attrs: {
                    nodeId: "00000000-0000-4000-8000-000000000113",
                    colspan: 1,
                    rowspan: 1,
                  },
                  content: [{ type: "table", content: [] }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(tiptapToCanonical(nested, base).ok).toBe(false);
  });
});
