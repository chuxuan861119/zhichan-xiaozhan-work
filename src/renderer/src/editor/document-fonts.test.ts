import { Editor } from "@tiptap/core";
import { displayDocumentFont, documentFontOptions } from "../../../shared/document/font-policy";
import { createPatentExtensions } from "./extensions";
import { menuFormatValue } from "./ui/editor-menu-state";

test.each([
  ["darwin", "PingFang SC"],
  ["openharmony", "HarmonyOS Sans SC"],
  ["win32", "SimSun"],
])(
  "%s renders imported Songti and foreign system fonts using its own default",
  (platform, expected) => {
    vi.stubGlobal("documentFontPlatform", platform);
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { defaultFontFamily: "SimSun" },
            content: [
              {
                type: "text",
                text: "正文 ABC 𠮷",
                marks: [
                  { type: "textStyle", attrs: { fontFamily: "HarmonyOS Sans SC" } },
                  { type: "bold" },
                ],
              },
            ],
          },
        ],
      },
    });
    try {
      const before = editor.getJSON();
      expect(editor.view.dom.querySelector("p")?.style.fontFamily.replaceAll('"', "")).toContain(
        expected,
      );
      expect(editor.view.dom.querySelector("span")?.style.fontFamily.replaceAll('"', "")).toBe(
        expected,
      );
      expect(menuFormatValue(editor, "fontFamily", "SimSun")).toBe(expected);
      expect(editor.getText()).toBe("正文 ABC 𠮷");
      expect(editor.getJSON()).toEqual(before);
      expect(before.content?.[0]?.attrs?.defaultFontFamily).toBe("SimSun");
      editor.commands.setContent(editor.getHTML());
      expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "textStyle",
            attrs: expect.objectContaining({ fontFamily: "HarmonyOS Sans SC" }),
          }),
          expect.objectContaining({ type: "bold" }),
        ]),
      );
      expect(editor.getText()).toBe("正文 ABC 𠮷");
    } finally {
      editor.destroy();
      vi.unstubAllGlobals();
    }
  },
);

test("switching every supported font and undoing preserves all document text", () => {
  const text = "一种冷却机构，ABC 123 αβ，𠮷。";
  const editor = new Editor({ extensions: createPatentExtensions(), content: `<p>${text}</p>` });
  try {
    editor.commands.selectAll();
    for (const platform of ["win32", "darwin", "openharmony"]) {
      for (const font of documentFontOptions(platform)) {
        expect(editor.commands.setFontFamily(font.value)).toBe(true);
        expect(editor.getText()).toBe(text);
        expect(menuFormatValue(editor, "fontFamily", "SimSun")).toBe(
          displayDocumentFont(font.value),
        );
      }
    }
    editor.commands.undo();
    expect(editor.getText()).toBe(text);
    const saved = editor.getJSON();
    editor.commands.setContent(saved);
    expect(editor.getText()).toBe(text);
  } finally {
    editor.destroy();
  }
});

test("inherited paragraph font is reported in both cursor and selection menus", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: '<p data-default-font-family="Source Han Serif CN">正文</p>',
  });
  try {
    expect(menuFormatValue(editor, "fontFamily", "SimSun")).toBe("Source Han Serif CN");
    editor.commands.selectAll();
    expect(menuFormatValue(editor, "fontFamily", "SimSun")).toBe("Source Han Serif CN");
  } finally {
    editor.destroy();
  }
});

test.each([
  ["darwin", 14],
  ["openharmony", 14],
  ["win32", 14],
])("%s gives a blank editor its body size and preserves explicit sizes", (platform, expected) => {
  vi.stubGlobal("documentFontPlatform", platform);
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: '<p>新正文</p><p data-default-font-size-pt="16">原正文</p>',
  });
  try {
    expect(editor.getJSON().content?.[0]?.attrs?.defaultFontSizePt).toBe(expected);
    expect(editor.view.dom.querySelector("p")?.style.fontSize).toBe(expected + "pt");
    expect(editor.getJSON().content?.[1]?.attrs?.defaultFontSizePt).toBe(16);
  } finally {
    editor.destroy();
    vi.unstubAllGlobals();
  }
});
