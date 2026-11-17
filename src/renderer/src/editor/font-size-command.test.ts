import { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { createBlankDocument } from "../../../shared/document/defaults";
import { randomUuid } from "../../../shared/id";
import { EditorCommandBus } from "../app/command-bus";
import { createPatentExtensions } from "./extensions";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";

function setup(content: object[]) {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: { type: "doc", content },
  });
  const bus = new EditorCommandBus();
  bus.register("font-size", editor);
  return { editor, bus };
}

test.each(["inlineMath", "blockMath"])(
  "formula color survives %s save, reopen and undo",
  (type) => {
    const formula = { type, attrs: { nodeId: randomUuid(), latex: "x^2", fontSizePt: 10.5 } };
    const { editor, bus } = setup(
      type === "inlineMath" ? [{ ...paragraph(""), content: [formula] }] : [formula],
    );
    try {
      editor.commands.setNodeSelection(type === "inlineMath" ? 1 : 0);
      const before = editor.getJSON();
      expect(bus.setColor("font-size", "#123ABC")).toBe(true);
      expect(editor.view.dom.querySelector<HTMLElement>("[data-type$='-math']")?.style.color).toBe(
        "rgb(18, 58, 188)",
      );
      expect(bus.getFormatState("font-size").color).toBe("#123ABC");
      const saved = tiptapToCanonical(editor.getJSON(), createBlankDocument("颜色"));
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error(saved.error.message);
      expect(JSON.stringify(saved.value)).toContain('"color":"#123ABC"');
      const after = editor.getJSON();
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(after);
      editor.commands.setContent(canonicalToTiptap(saved.value));
      expect(editor.view.dom.querySelector<HTMLElement>("[data-type$='-math']")?.style.color).toBe(
        "rgb(18, 58, 188)",
      );
      expect(editor.state.doc.textContent).toBe("");
    } finally {
      editor.destroy();
    }
  },
);

test.each(["#FF0000", "rgb(255, 0, 0)"])(
  "legacy formula textStyle color %s is not dropped by canonical conversion",
  (color) => {
    const { editor } = setup([
      {
        ...paragraph(""),
        content: [
          { type: "text", text: "原文" },
          {
            type: "inlineMath",
            attrs: { latex: "x^2" },
            marks: [{ type: "textStyle", attrs: { color } }],
          },
        ],
      },
    ]);
    try {
      const saved = tiptapToCanonical(editor.getJSON(), createBlankDocument("旧格式"));
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error(saved.error.message);
      expect(JSON.stringify(saved.value)).toContain('"color":"#FF0000"');
      expect(editor.state.doc.textContent).toBe("原文");
    } finally {
      editor.destroy();
    }
  },
);
const paragraph = (text = "第一行第二行", size = 14) => ({
  type: "paragraph",
  attrs: {
    nodeId: randomUuid(),
    defaultFontSizePt: size,
    lineHeight: 1.5,
    spaceBeforePt: 3,
    spaceAfterPt: 5,
  },
  ...(text ? { content: [{ type: "text", text }] } : {}),
});

test.each(["inlineMath", "blockMath"])(
  "font size changes selected %s and survives undo and canonical reopen",
  (type) => {
    const formula = {
      type,
      attrs: { nodeId: randomUuid(), latex: String.raw`\ce{H2O}`, formulaKind: "chemistry" },
    };
    const { editor, bus } = setup(
      type === "inlineMath"
        ? [
            {
              ...paragraph(""),
              content: [{ type: "text", text: "甲" }, formula, { type: "text", text: "乙" }],
            },
          ]
        : [formula],
    );
    try {
      editor.commands.setNodeSelection(type === "inlineMath" ? 2 : 0);
      const before = editor.getJSON();
      expect(bus.setFontSizePt("font-size", 10.5)).toBe(true);
      expect(editor.state.doc.nodeAt(editor.state.selection.from)?.attrs.fontSizePt).toBe(10.5);
      expect(bus.getFormatState("font-size").fontSizePt).toBe(10.5);
      const dom = editor.view.dom.querySelector<HTMLElement>(
        `[data-type="${type === "inlineMath" ? "inline-math" : "block-math"}"]`,
      );
      expect(dom?.style.fontSize).toBe("10.5pt");
      expect(dom?.querySelector<HTMLElement>(".katex")?.style.fontSize).toBe("1em");
      const saved = tiptapToCanonical(editor.getJSON(), createBlankDocument("字号"));
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error(saved.error.message);
      const after = editor.getJSON();
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(after);
      editor.commands.setContent(canonicalToTiptap(saved.value));
      expect(
        editor.view.dom.querySelector<HTMLElement>(
          `[data-type="${type === "inlineMath" ? "inline-math" : "block-math"}"]`,
        )?.style.fontSize,
      ).toBe("10.5pt");
      expect(JSON.stringify(saved.value)).toContain('"fontSizePt":10.5');
    } finally {
      editor.destroy();
    }
  },
);

test("mixed selection resizes formulas and text without altering formula source", () => {
  const { editor, bus } = setup([
    {
      ...paragraph(""),
      content: [
        { type: "text", text: "甲" },
        { type: "inlineMath", attrs: { latex: "x^2" } },
      ],
    },
    { type: "blockMath", attrs: { nodeId: randomUuid(), latex: "y^2" } },
  ]);
  try {
    editor.commands.selectAll();
    expect(bus.setFontSizePt("font-size", 12)).toBe(true);
    const formulas: unknown[] = [];
    editor.state.doc.descendants((n) => {
      if (["inlineMath", "blockMath"].includes(n.type.name))
        formulas.push([n.attrs.latex, n.attrs.fontSizePt]);
    });
    expect(formulas).toEqual([
      ["x^2", 12],
      ["y^2", 12],
    ]);
    expect(bus.getFormatState("font-size").fontSizePt).toBe(12);
  } finally {
    editor.destroy();
  }
});

test("an unsized inline formula reports the effective surrounding paragraph size", () => {
  const { editor, bus } = setup([
    {
      ...paragraph(""),
      content: [
        { type: "text", text: "甲", marks: [{ type: "textStyle", attrs: { fontSizePt: 10.5 } }] },
        { type: "inlineMath", attrs: { latex: "x^2" } },
      ],
    },
  ]);
  try {
    editor.commands.setNodeSelection(2);
    expect(bus.getFormatState("font-size").fontSizePt).toBe(10.5);
  } finally {
    editor.destroy();
  }
});

test.each(["inlineMath", "blockMath"])(
  "%s retains size through HTML clipboard roundtrip and source edits",
  (type) => {
    const formula = { type, attrs: { nodeId: randomUuid(), latex: "x^2", fontSizePt: 10.5 } };
    const { editor } = setup(
      type === "inlineMath" ? [{ ...paragraph(""), content: [formula] }] : [formula],
    );
    const pasted = new Editor({ extensions: createPatentExtensions(), content: editor.getHTML() });
    try {
      const position = type === "inlineMath" ? 1 : 0;
      expect(pasted.state.doc.nodeAt(position)?.attrs.fontSizePt).toBe(10.5);
      if (type === "inlineMath") pasted.commands.updateInlineMath({ pos: position, latex: "y^3" });
      else pasted.commands.updateBlockMath({ pos: position, latex: "y^3" });
      expect(pasted.state.doc.nodeAt(position)?.attrs).toMatchObject({
        fontSizePt: 10.5,
        latex: "y^3",
      });
    } finally {
      editor.destroy();
      pasted.destroy();
    }
  },
);

test("whole paragraph size changes update its baseline and undo together", () => {
  const { editor, bus } = setup([paragraph()]);
  editor.commands.selectAll();
  const before = editor.getJSON();
  expect(bus.setFontSizePt("font-size", 9)).toBe(true);
  expect(editor.state.doc.firstChild?.attrs).toMatchObject({
    defaultFontSizePt: 9,
    lineHeight: 1.5,
    spaceBeforePt: 3,
    spaceAfterPt: 5,
  });
  expect(editor.getHTML()).toContain("font-size: 9pt");
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getJSON()).toEqual(before);
  expect(editor.commands.redo()).toBe(true);
  const reopened = new Editor({ extensions: createPatentExtensions(), content: editor.getJSON() });
  expect(reopened.state.doc.firstChild?.attrs.defaultFontSizePt).toBe(9);
  reopened.destroy();
  editor.destroy();
});

test("partial text size does not change the baseline or unselected runs", () => {
  const { editor, bus } = setup([paragraph()]);
  editor.commands.setTextSelection({ from: 2, to: 4 });
  bus.setFontSizePt("font-size", 9);
  expect(editor.state.doc.firstChild?.attrs.defaultFontSizePt).toBe(14);
  expect(editor.state.doc.firstChild?.firstChild?.marks).toHaveLength(0);
  expect(editor.state.selection.from).toBe(2);
  expect(editor.state.selection.to).toBe(4);
  editor.destroy();
});

test("empty paragraph changes baseline and retains size for subsequent typing", () => {
  const { editor, bus } = setup([paragraph("")]);
  expect(bus.setFontSizePt("font-size", 9)).toBe(true);
  expect(editor.state.doc.firstChild?.attrs.defaultFontSizePt).toBe(9);
  editor.commands.insertContent("正文");
  expect(bus.getFormatState("font-size").fontSizePt).toBe(9);
  editor.destroy();
});

test("cross-paragraph selection changes only completely selected paragraphs", () => {
  const { editor, bus } = setup([paragraph("甲乙"), paragraph("丙丁"), paragraph("戊己")]);
  editor.commands.setTextSelection({ from: 2, to: 10 });
  bus.setFontSizePt("font-size", 9);
  expect([...editor.state.doc.content.content].map((p) => p.attrs.defaultFontSizePt)).toEqual([
    14, 9, 14,
  ]);
  editor.destroy();
});

test("cell selection updates only selected cells including empty paragraphs", () => {
  const cell = (text: string) => ({ type: "tableCell", content: [paragraph(text)] });
  const { editor, bus } = setup([
    {
      type: "table",
      content: [
        { type: "tableRow", content: [cell("甲"), cell("")] },
        { type: "tableRow", content: [cell("乙"), cell("丙")] },
      ],
    },
  ]);
  const cells: number[] = [];
  editor.state.doc.descendants((n, p) => {
    if (n.type.name === "tableCell") cells.push(p);
  });
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[0]!, cells[1]!)),
  );
  bus.setFontSizePt("font-size", 9);
  const sizes: number[] = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === "paragraph") sizes.push(n.attrs.defaultFontSizePt);
  });
  expect(sizes).toEqual([9, 9, 14, 14]);
  editor.destroy();
});

test.each([NaN, Infinity, -Infinity, 7, 73])(
  "rejects invalid size %s without changing the document",
  (size) => {
    const { editor, bus } = setup([paragraph()]);
    editor.commands.selectAll();
    const before = editor.getJSON();
    expect(bus.setFontSizePt("font-size", size)).toBe(false);
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  },
);

test("undoing a size change does not undo the immediately preceding text edit", () => {
  const { editor, bus } = setup([paragraph("原文")]);
  editor.commands.setTextSelection(3);
  editor.commands.insertContent("新增文字");
  const before = editor.getJSON();
  editor.commands.selectAll();
  bus.setFontSizePt("font-size", 9);
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(before);
  editor.destroy();
});

test("undoing subsequent typing retains the applied paragraph size", () => {
  const { editor, bus } = setup([paragraph("原文")]);
  editor.commands.selectAll();
  bus.setFontSizePt("font-size", 9);
  const formatted = editor.getJSON();
  editor.commands.setTextSelection(3);
  editor.commands.insertContent("后续输入");
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(formatted);
  editor.destroy();
});
