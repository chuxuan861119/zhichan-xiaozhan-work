import { Editor } from "@tiptap/core";
import { PATENT_FIRST_LINE_INDENT_MM } from "../../../../shared/patent/formatting";
import { createPatentExtensions } from "../extensions";

function createEditor(content: object): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: createPatentExtensions("", { patentParagraphRules: true }),
    content,
  });
}

function pressBackspace(editor: Editor): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Backspace",
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function pressEnter(editor: Editor): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

test("removes a body paragraph first-line indent when Backspace is pressed at its start", () => {
  const editor = createEditor({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM },
        content: [{ type: "text", text: "小标题" }],
      },
    ],
  });
  editor.commands.setTextSelection(1);

  const event = pressBackspace(editor);

  expect(event.defaultPrevented).toBe(true);
  expect(editor.getJSON().content?.[0]?.attrs?.paragraphIndentMm).toBe(0);
  expect(editor.getText()).toBe("小标题");
  expect(editor.state.selection.from).toBe(1);

  expect(editor.commands.undo()).toBe(true);
  expect(editor.getJSON().content?.[0]?.attrs?.paragraphIndentMm).toBe(PATENT_FIRST_LINE_INDENT_MM);
  editor.destroy();
});

test("leaves native Backspace behavior unchanged away from an indented paragraph start", () => {
  const editor = createEditor({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM },
        content: [{ type: "text", text: "正文" }],
      },
    ],
  });
  editor.commands.setTextSelection(2);

  const event = pressBackspace(editor);

  expect(event.defaultPrevented).toBe(false);
  expect(editor.getText()).toBe("正文");
  expect(editor.getJSON().content?.[0]?.attrs?.paragraphIndentMm).toBe(PATENT_FIRST_LINE_INDENT_MM);
  editor.destroy();
});

test("does not consume Backspace at the start of an unindented paragraph", () => {
  const editor = createEditor({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { paragraphIndentMm: 0 },
        content: [{ type: "text", text: "标题" }],
      },
    ],
  });
  editor.commands.setTextSelection(1);

  const event = pressBackspace(editor);

  expect(event.defaultPrevented).toBe(false);
  expect(editor.getJSON().content?.[0]?.attrs?.paragraphIndentMm).toBe(0);
  editor.destroy();
});

test("starts patent body formatting after the centered first-line title", () => {
  const editor = createEditor({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { textAlign: "center", paragraphIndentMm: 0 },
        content: [{ type: "text", text: "专利题目" }],
      },
    ],
  });
  editor.commands.setTextSelection(editor.state.doc.content.size);

  const event = pressEnter(editor);

  expect(event.defaultPrevented).toBe(true);
  expect(editor.getJSON().content).toHaveLength(2);
  expect(editor.getJSON().content?.[1]?.attrs).toMatchObject({
    textAlign: "justify",
    paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM,
  });
  editor.destroy();
});

test("title font marks do not override the resumed body font after Enter", () => {
  const editor = createEditor({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { textAlign: "center", paragraphIndentMm: 0, defaultFontSizePt: 24 },
        content: [
          {
            type: "text",
            text: "专利题目",
            marks: [{ type: "textStyle", attrs: { fontFamily: "KaiTi", fontSizePt: 24 } }],
          },
        ],
      },
    ],
  });
  try {
    editor.commands.setTextSelection(5);
    pressEnter(editor);
    editor.commands.insertContent("正文");
    const body = editor.state.doc.child(1);
    const style = body.firstChild?.marks.find((mark) => mark.type.name === "textStyle")?.attrs;
    expect(style?.fontSizePt ?? body.attrs.defaultFontSizePt).toBe(14);
    expect(style?.fontFamily ?? body.attrs.defaultFontFamily).toBe("SimSun");
    expect(editor.state.doc.child(0).firstChild?.marks[0]?.attrs.fontSizePt).toBe(24);
  } finally {
    editor.destroy();
  }
});

test("inserting a blank line before the title does not turn the title into body text", () => {
  const editor = createEditor({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { textAlign: "center", paragraphIndentMm: 0 },
        content: [{ type: "text", text: "专利题目" }],
      },
    ],
  });
  editor.commands.setTextSelection(1);
  pressEnter(editor);
  expect(editor.getJSON().content).toHaveLength(2);
  expect(editor.getJSON().content?.[1]?.attrs).toMatchObject({
    textAlign: "center",
    paragraphIndentMm: 0,
  });
  expect(editor.state.doc.child(1).textContent).toBe("专利题目");
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getJSON().content).toHaveLength(1);
  expect(editor.getJSON().content?.[0]?.attrs?.textAlign).toBe("center");
  editor.destroy();
});

test("inherits custom paragraph formatting when Enter is pressed outside the first-line title", () => {
  const editor = createEditor({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "前文" }] },
      {
        type: "paragraph",
        attrs: {
          textAlign: "right",
          paragraphIndentMm: 3,
          lineHeight: 2,
          defaultFontFamily: "KaiTi",
          defaultFontSizePt: 16,
        },
        content: [{ type: "text", text: "自定义段落" }],
      },
    ],
  });
  editor.commands.setTextSelection(editor.state.doc.content.size);

  pressEnter(editor);

  expect(editor.getJSON().content).toHaveLength(3);
  expect(editor.getJSON().content?.[2]?.attrs).toMatchObject({
    textAlign: "right",
    paragraphIndentMm: 3,
    lineHeight: 2,
    defaultFontFamily: "KaiTi",
    defaultFontSizePt: 16,
  });
  editor.destroy();
});

test.each(["正文", ""])(
  "restores new-paragraph indentation after removing indent from %j",
  (text) => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM },
          ...(text ? { content: [{ type: "text", text }] } : {}),
        },
      ],
    });
    editor.commands.setTextSelection(1);
    pressBackspace(editor);
    editor.commands.setTextSelection(1 + text.length);
    pressEnter(editor);
    expect(editor.getJSON().content?.[0]?.attrs?.paragraphIndentMm).toBe(0);
    expect(editor.getJSON().content?.[1]?.attrs?.paragraphIndentMm).toBe(
      PATENT_FIRST_LINE_INDENT_MM,
    );
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON().content).toHaveLength(1);
    editor.destroy();
  },
);

test("repeated Enter keeps empty body paragraphs indented", () => {
  const editor = createEditor({
    type: "doc",
    content: [{ type: "paragraph", attrs: { paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM } }],
  });
  editor.commands.setTextSelection(1);
  pressEnter(editor);
  pressEnter(editor);
  expect(editor.getJSON().content).toHaveLength(3);
  for (const paragraph of editor.getJSON().content ?? []) {
    expect(paragraph.attrs?.paragraphIndentMm).toBe(PATENT_FIRST_LINE_INDENT_MM);
  }
  editor.destroy();
});

test("does not reformat existing unindented text when splitting in its middle", () => {
  const editor = createEditor({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { paragraphIndentMm: 0 },
        content: [{ type: "text", text: "原有文字" }],
      },
    ],
  });
  editor.commands.setTextSelection(3);
  pressEnter(editor);
  expect(editor.state.doc.child(1).textContent).toBe("文字");
  expect(editor.getJSON().content?.[1]?.attrs?.paragraphIndentMm).toBe(0);
  editor.destroy();
});

test("does not indent new paragraphs inside a table cell", () => {
  const editor = createEditor({
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [
                  {
                    type: "paragraph",
                    attrs: { paragraphIndentMm: 0 },
                    content: [{ type: "text", text: "单元格" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  editor.commands.setTextSelection(7);
  pressEnter(editor);
  const cell = editor.state.doc.child(0).child(0).child(0);
  expect(cell.childCount).toBe(2);
  expect(cell.child(1).attrs.paragraphIndentMm).toBe(0);
  editor.destroy();
});

test("restores body indentation after deleting an indented paragraph and joining the previous one", () => {
  const editor = createEditor({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { paragraphIndentMm: 0 },
        content: [{ type: "text", text: "前文" }],
      },
      { type: "paragraph", attrs: { paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM } },
    ],
  });
  editor.commands.setTextSelection(5);
  pressBackspace(editor);
  pressBackspace(editor);
  expect(editor.state.doc.childCount).toBe(1);
  pressEnter(editor);
  expect(editor.state.doc.childCount).toBe(2);
  expect(editor.state.doc.child(0).attrs.paragraphIndentMm).toBe(0);
  expect(editor.state.doc.child(1).attrs.paragraphIndentMm).toBe(PATENT_FIRST_LINE_INDENT_MM);
  editor.destroy();
});

test("restoring indent preserves font, alignment and line spacing", () => {
  const editor = createEditor({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: {
          paragraphIndentMm: 0,
          textAlign: "right",
          lineHeight: 2,
          defaultFontFamily: "KaiTi",
          defaultFontSizePt: 16,
        },
        content: [{ type: "text", text: "正文" }],
      },
    ],
  });
  editor.commands.setTextSelection(3);
  pressEnter(editor);
  expect(editor.state.doc.child(1).attrs).toMatchObject({
    paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM,
    textAlign: "right",
    lineHeight: 2,
    defaultFontFamily: "KaiTi",
    defaultFontSizePt: 16,
  });
  editor.destroy();
});
