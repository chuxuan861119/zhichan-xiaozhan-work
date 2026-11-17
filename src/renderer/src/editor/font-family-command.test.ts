import { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { createBlankDocument } from "../../../shared/document/defaults";
import { EditorCommandBus } from "../app/command-bus";
import { createPatentExtensions } from "./extensions";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";

function setup(content: string) {
  const editor = new Editor({ extensions: createPatentExtensions(), content });
  const bus = new EditorCommandBus();
  bus.register("font", editor);
  return { editor, bus };
}

test("empty paragraph font survives saving and reopening before any typing", () => {
  const { editor, bus } = setup("<p></p>");
  try {
    editor.commands.setContent(canonicalToTiptap(createBlankDocument("字体")));
    expect(bus.setFontFamily("font", "KaiTi")).toBe(true);
    const saved = tiptapToCanonical(editor.getJSON(), createBlankDocument("字体"));
    if (!saved.ok) throw new Error(saved.error.message);
    editor.commands.setContent(canonicalToTiptap(saved.value));
    expect(bus.getFormatState("font").fontFamily).toBe("KaiTi");
    editor.commands.insertContent("继续输入");
    expect(bus.getFormatState("font").fontFamily).toBe("KaiTi");
  } finally {
    editor.destroy();
  }
});

test("whole paragraph font updates its baseline and undoes without undoing prior typing", () => {
  const { editor, bus } = setup("<p>正文</p>");
  try {
    editor.commands.setTextSelection(3);
    editor.commands.insertContent("新增");
    const before = editor.getJSON();
    editor.commands.selectAll();
    expect(bus.setFontFamily("font", "FangSong")).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.defaultFontFamily).toBe("FangSong");
    const formatted = editor.getJSON();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(formatted);
  } finally {
    editor.destroy();
  }
});

test("partial font selection keeps the unselected paragraph baseline and text", () => {
  const { editor, bus } = setup("<p>甲乙丙丁</p>");
  try {
    editor.commands.setTextSelection({ from: 2, to: 4 });
    expect(bus.setFontFamily("font", "KaiTi")).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.defaultFontFamily).toBe("SimSun");
    expect(editor.state.doc.firstChild?.firstChild?.marks).toHaveLength(0);
    expect(editor.state.doc.firstChild?.lastChild?.marks).toHaveLength(0);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.to).toBe(4);
  } finally {
    editor.destroy();
  }
});

test("font applies to selected table cells including empty ones, not neighboring cells", () => {
  const { editor, bus } = setup(
    "<table><tr><td><p>甲</p></td><td><p>乙</p></td></tr><tr><td><p></p></td><td><p>丙</p></td></tr></table>",
  );
  try {
    const cells: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "tableCell") cells.push(pos);
    });
    const [first, , third] = cells;
    if (first === undefined || third === undefined) throw new Error("Missing test cells");
    editor.view.dispatch(
      editor.state.tr.setSelection(CellSelection.create(editor.state.doc, first, third)),
    );
    expect(bus.setFontFamily("font", "KaiTi")).toBe(true);
    const fonts: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "paragraph") fonts.push(node.attrs.defaultFontFamily);
    });
    expect(fonts).toEqual(["KaiTi", "SimSun", "KaiTi", "SimSun"]);
  } finally {
    editor.destroy();
  }
});

test.each(["family", "size"] as const)(
  "an empty cell %s change reports success and survives undoing subsequent typing",
  (kind) => {
    const { editor, bus } = setup("<table><tr><td><p></p></td></tr></table>");
    try {
      editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, 2)));
      const applied =
        kind === "family" ? bus.setFontFamily("font", "KaiTi") : bus.setFontSizePt("font", 10.5);
      expect(applied).toBe(true);
      const formatted = editor.getJSON();
      editor.commands.setTextSelection(4);
      editor.commands.insertContent("新文字");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(formatted);
    } finally {
      editor.destroy();
    }
  },
);
