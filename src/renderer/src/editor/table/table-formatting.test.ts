import { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { createBlankBookDocument } from "../../../../shared/document/defaults";
import { createPatentExtensions } from "../extensions";
import { canonicalToTiptap, tiptapToPatentBookDocument } from "../model-adapter";
import { sanitizePastedHtmlWithFormulas } from "../paste-sanitizer";
import { insertPatentTable, setTableFormatting } from "./table-commands";

test("new tables have explicit compact defaults; old tables retain their defaults", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "<p></p>",
  });
  try {
    expect(
      insertPatentTable(editor, {
        rows: 2,
        columns: 2,
        headerRowCount: 0,
        layoutMode: "fit-page",
      }),
    ).toBe(true);
    const cell = editor.state.doc.firstChild?.firstChild?.firstChild;
    expect(cell?.attrs.paddingTopMm).toBe(1);
    expect(cell?.attrs.paddingLeftMm).toBe(2);
    expect(cell?.firstChild?.attrs.lineHeight).toBe(1);
    expect(cell?.firstChild?.attrs.paragraphIndentMm).toBe(0);
    editor.commands.setContent("<table><tr><td>旧表</td></tr></table>");
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs.paddingTopMm).toBeNull();
  } finally {
    editor.destroy();
  }
});

test("selected cells formatting persists and auto height clears the stored height", async () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table><tr data-row-height-mm="15" data-row-height-rule="exact"><td><p>甲</p><p>乙</p></td><td>丙</td></tr></table>',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, 2)));
    expect(
      setTableFormatting(editor, {
        lineSpacing: 1.15,
        padding: { top: 0, right: 3, bottom: 1, left: 2 },
        autoHeight: true,
      }),
    ).toBe(true);
    const cell = editor.state.doc.firstChild?.firstChild?.firstChild;
    expect(cell?.child(1).attrs.lineHeight).toBe(1.15);
    expect(cell?.attrs.paddingTopMm).toBe(0);
    expect(editor.state.doc.firstChild?.firstChild?.attrs.rowHeightMm).toBeNull();
    const saved = tiptapToPatentBookDocument(
      editor.getJSON(),
      createBlankBookDocument("表格"),
      new Set(),
    );
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    editor.commands.setContent(canonicalToTiptap(saved.value));
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs.paddingRightMm).toBe(3);
  } finally {
    editor.destroy();
  }
});

test("whole-table paste keeps column ratios, padding, paragraph spacing and row height", () => {
  const cleaned = sanitizePastedHtmlWithFormulas(
    '<table style="width:150mm"><colgroup><col style="width:50mm"><col style="width:100mm"></colgroup><tr style="height:12mm"><td style="padding:1mm 3mm;vertical-align:middle"><p style="line-height:1.15;margin-bottom:6pt">甲</p></td><td>乙</td></tr></table>',
    undefined,
    "source",
  );
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: cleaned.html,
  });
  try {
    const table = editor.state.doc.firstChild;
    expect(table?.attrs.columnWidthsMm).toEqual([50, 100]);
    expect(table?.firstChild?.attrs.rowHeightMm).toBe(12);
    expect(table?.firstChild?.firstChild?.attrs.paddingRightMm).toBe(3);
    expect(table?.firstChild?.firstChild?.firstChild?.attrs.lineHeight).toBe(1.15);
    expect(table?.firstChild?.firstChild?.firstChild?.attrs.spaceAfterPt).toBeCloseTo(6, 1);
  } finally {
    editor.destroy();
  }
});

test("line spacing targets only the current paragraph; compact formatting preserves manual height and text marks", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<table><tr data-row-height-mm="18" data-row-height-rule="at-least"><td><p><strong>甲</strong></p><p>乙</p></td><td><p>丙</p></td></tr></table>',
  });
  try {
    editor.commands.setTextSelection(4);
    expect(setTableFormatting(editor, { lineSpacing: 1.15 })).toBe(true);
    const cell = editor.state.doc.firstChild?.firstChild?.firstChild;
    expect(cell?.child(0).attrs.lineHeight).toBe(1.15);
    expect(cell?.child(1).attrs.lineHeight).not.toBe(1.15);
    expect(setTableFormatting(editor, { compact: true })).toBe(true);
    const row = editor.state.doc.firstChild?.firstChild;
    expect(row?.attrs.rowHeightMm).toBe(18);
    expect(row?.firstChild?.child(1).attrs.lineHeight).toBe(1);
    expect(row?.firstChild?.firstChild?.firstChild?.marks[0]?.type.name).toBe("bold");
    const cleaned = sanitizePastedHtmlWithFormulas(editor.getHTML(), undefined, "source");
    const copy = new Editor({ extensions: createPatentExtensions(), content: cleaned.html });
    try {
      expect(copy.state.doc.firstChild?.firstChild?.attrs.rowHeightMm).toBe(18);
      expect(copy.state.doc.firstChild?.firstChild?.firstChild?.attrs.paddingTopMm).toBe(1);
    } finally {
      copy.destroy();
    }
  } finally {
    editor.destroy();
  }
});

test("indented clipboard HTML does not create extra blank paragraphs in cells", () => {
  const cleaned = sanitizePastedHtmlWithFormulas(
    "<table><tr><td>\n  <p>正文</p>\n </td><td><span>甲</span> <span>乙</span></td></tr></table>",
    undefined,
    "source",
  );
  const editor = new Editor({ extensions: createPatentExtensions(), content: cleaned.html });
  try {
    const row = editor.state.doc.firstChild?.firstChild;
    expect(row?.firstChild?.childCount).toBe(1);
    expect(row?.child(1).textContent).toBe("甲 乙");
  } finally {
    editor.destroy();
  }
});
