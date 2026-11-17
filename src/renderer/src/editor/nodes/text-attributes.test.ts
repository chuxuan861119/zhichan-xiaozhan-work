import { Editor } from "@tiptap/core";
import { DOMParser, Slice } from "prosemirror-model";
import { createPatentExtensions } from "../extensions";

test.each([6, 96, 200])(
  "preserves supported %s pt text and paragraph defaults through HTML",
  (size) => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { defaultFontSizePt: size },
            content: [
              {
                type: "text",
                text: "字号",
                marks: [{ type: "textStyle", attrs: { fontSizePt: size } }],
              },
            ],
          },
        ],
      },
    });
    const html = editor.getHTML();
    expect(html).toContain(`data-font-size-pt="${size}"`);
    const reopened = new Editor({ extensions: createPatentExtensions(), content: html });
    expect(reopened.state.doc.firstChild?.attrs.defaultFontSizePt).toBe(size);
    expect(
      reopened.state.doc.firstChild?.firstChild?.marks.find(
        (mark) => mark.type.name === "textStyle",
      )?.attrs.fontSizePt,
    ).toBe(size);
    reopened.destroy();
    editor.destroy();
  },
);

test("parses allowed pasted font size and paragraph indentation from CSS", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: '<p style="text-indent: 16mm"><span style="font-size: 18pt">技术方案</span></p>',
  });
  const paragraph = editor.getJSON().content?.[0];

  expect(paragraph?.attrs).toMatchObject({ paragraphIndentMm: 16 });
  expect(paragraph?.content?.[0]?.marks?.[0]).toMatchObject({
    type: "textStyle",
    attrs: { fontSizePt: 18 },
  });
  editor.destroy();
});

test("round-trips drawing explanation semantic attributes through HTML", () => {
  const figureId = "00000000-0000-4000-8000-000000000401";
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: `<p data-semantic-role="description-drawing-explanation" data-figure-id="${figureId}">图1为整体结构示意图。</p>`,
  });
  const paragraph = editor.getJSON().content?.[0];

  expect(paragraph?.attrs).toMatchObject({
    semanticRole: "description-drawing-explanation",
    figureId,
  });
  expect(editor.getHTML()).toContain(`data-figure-id="${figureId}"`);
  editor.destroy();
});

test("renders 1.5 line spacing as a ratio shared with the print renderer", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: '<p data-line-height="1.5" data-default-font-size-pt="14">第一行<br>第二行</p>',
  });
  const html = editor.getHTML();

  expect(html).toContain('data-line-height="1.5"');
  expect(html).toContain("line-height: 2.025");
  editor.destroy();
});

test("does not change serialized line spacing at 150 percent display scaling", () => {
  const originalDevicePixelRatio = globalThis.devicePixelRatio;
  Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 1.5 });
  try {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: '<p data-line-height="1.5" data-default-font-size-pt="14">第一行<br>第二行</p>',
    });

    expect(editor.getHTML()).toContain("line-height: 2.025");
    editor.destroy();
  } finally {
    Object.defineProperty(globalThis, "devicePixelRatio", {
      configurable: true,
      value: originalDevicePixelRatio,
    });
  }
});

test("parses text-align from inline style", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: '<p style="text-align: center">居中段落</p><p>普通段落</p>',
  });
  const paragraphs = [...(editor.getJSON().content ?? [])];
  expect(paragraphs[0]?.attrs).toMatchObject({ textAlign: "center" });
  expect(paragraphs[1]?.attrs?.textAlign ?? "left").toBe("left");
  editor.destroy();
});

test("preserves centered alignment when pasting into blank document (simulating replaceSelection)", () => {
  // 模拟"清空文档后粘贴"：空文档 → parseSlice → replaceSelection
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: "",
  });

  const container = window.document.createElement("div");
  container.innerHTML =
    '<p style="text-align: center">发明名称</p><p style="text-align: justify">技术领域</p><p>正文段落</p>';
  const slice = DOMParser.fromSchema(editor.schema).parseSlice(container);

  // 应用与 paste handler 相同的修正：块级首尾子节点时 openStart/openEnd 应为 0
  const firstIsBlock = slice.content.firstChild?.isBlock ?? false;
  const lastIsBlock = slice.content.lastChild?.isBlock ?? false;
  const openStart = firstIsBlock ? 0 : slice.openStart;
  const openEnd = lastIsBlock ? 0 : slice.openEnd;

  const tr = editor.state.tr.replaceSelection(new Slice(slice.content, openStart, openEnd));
  editor.view.dispatch(tr);

  const paragraphs = [...(editor.getJSON().content ?? [])];
  expect(paragraphs).toHaveLength(3);
  expect(paragraphs[0]?.attrs).toMatchObject({ textAlign: "center" });
  expect(paragraphs[1]?.attrs).toMatchObject({ textAlign: "justify" });
  // 第三段无显式对齐样式，textAlign 为 null 或 "left"（默认值）
  expect(
    paragraphs[2]?.attrs?.textAlign === null || paragraphs[2]?.attrs?.textAlign === "left",
  ).toBe(true);

  editor.destroy();
});

test("uniform small runs render a small paragraph baseline without rewriting stored defaults", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<p data-default-font-size-pt="14"><span style="font-size:9pt" data-font-size-pt="9">第一行</span><br><span style="font-size:9pt" data-font-size-pt="9">第二行</span></p>',
  });
  const parsed = new window.DOMParser().parseFromString(editor.getHTML(), "text/html");
  expect(parsed.querySelector("p")?.style.fontSize).toBe("9pt");
  expect(editor.state.doc.firstChild?.attrs.defaultFontSizePt).toBe(14);
  editor.destroy();
});

test("mixed small runs reduce the baseline without resizing their text", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<p data-default-font-size-pt="14"><span style="font-size:9pt">小字</span><span style="font-size:12pt">稍大文字</span></p>',
  });
  const parsed = new window.DOMParser().parseFromString(editor.getHTML(), "text/html");
  expect(parsed.querySelector("p")?.style.fontSize).toBe("12pt");
  expect([...parsed.querySelectorAll("span")].map((span) => span.style.fontSize)).toEqual([
    "9pt",
    "12pt",
  ]);
  editor.destroy();
});

test("mixed sizes leave unmarked body text at the stored paragraph size", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content:
      '<p data-default-font-size-pt="14">正常正文<span style="font-size:9pt">小字</span><span style="font-size:28pt">大字</span></p>',
  });
  const parsed = new window.DOMParser().parseFromString(editor.getHTML(), "text/html");
  expect(parsed.querySelector("p")?.style.fontSize).toBe("14pt");
  editor.destroy();
});
