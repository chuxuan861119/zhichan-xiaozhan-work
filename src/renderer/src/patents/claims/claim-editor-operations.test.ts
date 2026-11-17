import { Editor, type JSONContent } from "@tiptap/core";
import { PATENT_FIRST_LINE_INDENT_MM } from "../../../../shared/patent/formatting";
import { createPatentExtensions } from "../../editor/extensions";
import { clearExtraFormatting, insertDependentClaimAtSelection } from "./claim-editor-operations";

function claimEditor(paragraphs: readonly string[]) {
  return new Editor({
    extensions: createPatentExtensions("claim-operation-test", { patentParagraphRules: true }),
    content: {
      type: "doc",
      content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
    },
  });
}

function moveCaretToParagraph(editor: Editor, paragraphIndex: number) {
  let position = 1;
  editor.state.doc.forEach((node, offset, index) => {
    if (index === paragraphIndex) position = offset + Math.min(2, node.content.size);
  });
  editor.commands.setTextSelection(position);
}

function paragraphTexts(editor: Editor): string[] {
  const content = editor.getJSON().content ?? [];
  return content.map((node) =>
    (node.content ?? [])
      .map((inline) => {
        const text = inline as { type?: unknown; text?: unknown };
        return text.type === "text" && typeof text.text === "string" ? text.text : "";
      })
      .join(""),
  );
}

function cleanupEditor(content: JSONContent[]) {
  const editor = new Editor({
    extensions: createPatentExtensions("cleanup-regression", { patentParagraphRules: true }),
    content: { type: "doc", content },
  });
  const initialized = editor.state.tr.setMeta("addToHistory", false);
  editor.state.doc.descendants((node, pos) => {
    if ("nodeId" in node.attrs)
      initialized.setNodeMarkup(pos, undefined, { ...node.attrs, nodeId: crypto.randomUUID() });
  });
  editor.view.dispatch(initialized);
  return editor;
}

describe("claim editor operations", () => {
  test.each([true, false])(
    "preserves all table formatting except text colors (colors: %s)",
    (colored) => {
      const editor = new Editor({
        extensions: createPatentExtensions("table-cleanup", { patentParagraphRules: true }),
        content: {
          type: "doc",
          content: [
            {
              type: "table",
              attrs: { layoutMode: "fixed", columnWidthsMm: [30, 40, 60] },
              content: [
                {
                  type: "tableRow",
                  attrs: { rowHeightMm: 18, rowHeightRule: "at-least" },
                  content: [
                    {
                      type: "tableHeader",
                      attrs: {
                        colspan: 2,
                        paddingTopMm: 1,
                        paddingBottomMm: 3,
                        paddingLeftMm: 2,
                        paddingRightMm: 4,
                        horizontalAlignment: "center",
                        verticalAlignment: "middle",
                        borderStyle: "double",
                      },
                      content: [
                        {
                          type: "paragraph",
                          attrs: {
                            lineHeight: 1.15,
                            paragraphIndentMm: 0,
                            spaceBeforePt: 6,
                            spaceAfterPt: 12,
                            textAlign: "right",
                            defaultFontSizePt: 18,
                          },
                          content: [
                            {
                              type: "text",
                              text: "　　保留  空格____",
                              marks: [
                                { type: "bold" },
                                { type: "italic" },
                                { type: "underline" },
                                {
                                  type: "textStyle",
                                  attrs: {
                                    fontSizePt: 18,
                                    ...(colored
                                      ? { color: "#112233", backgroundColor: "#FFFF00" }
                                      : {}),
                                  },
                                },
                                ...(colored ? [{ type: "claimReferenceReview" }] : []),
                              ],
                            },
                            { type: "hardBreak" },
                            { type: "inlineMath", attrs: { latex: "x^2" } },
                          ],
                        },
                        { type: "paragraph" },
                        { type: "paragraph", content: [{ type: "text", text: "    " }] },
                      ],
                    },
                    { type: "tableCell", content: [{ type: "paragraph" }] },
                  ],
                },
              ],
            },
            { type: "paragraph", content: [{ type: "text", text: "正文" }] },
          ],
        },
      });
      try {
        const initialized = editor.state.tr.setMeta("addToHistory", false);
        editor.state.doc.descendants((node, pos) => {
          if ("nodeId" in node.attrs)
            initialized.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              nodeId: crypto.randomUUID(),
            });
        });
        editor.view.dispatch(initialized);
        const before = editor.getJSON();
        const expected = structuredClone(before);
        const removeColors = (node: JSONContent) => {
          if (node.marks)
            node.marks = node.marks
              .filter((mark) => mark.type !== "claimReferenceReview")
              .map((mark) =>
                mark.type === "textStyle"
                  ? { ...mark, attrs: { ...mark.attrs, color: null, backgroundColor: null } }
                  : mark,
              );
          node.content?.forEach(removeColors);
        };
        removeColors(expected);
        const result = clearExtraFormatting(editor);
        expect(result.ok).toBe(true);
        expect(editor.getJSON()).toEqual(expected);
        if (colored) {
          expect(editor.commands.undo()).toBe(true);
          expect(editor.getJSON()).toEqual(before);
          expect(editor.commands.redo()).toBe(true);
          expect(editor.getJSON()).toEqual(expected);
        } else {
          expect(result.message).toBe("未发现需要清理的多余格式或空格。");
          expect(editor.commands.undo()).toBe(false);
        }
      } finally {
        editor.destroy();
      }
    },
  );

  test.each([
    ["alpha ", "beta", " gamma", "alpha beta gamma"],
    ["alpha  ", "  ", " beta", "alpha beta"],
    ["材料 ", " layers ", "结构", "材料layers结构"],
  ])(
    "cleans spaces across formatting boundaries without joining English words: %s",
    (first, middle, last, expected) => {
      const editor = new Editor({
        extensions: createPatentExtensions("cleanup-run-boundary", { patentParagraphRules: true }),
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { nodeId: crypto.randomUUID() },
              content: [
                { type: "text", text: first, marks: [{ type: "bold" }] },
                { type: "text", text: middle, marks: [{ type: "italic" }] },
                { type: "text", text: last },
              ],
            },
          ],
        },
      });
      try {
        const before = editor.getJSON();
        expect(clearExtraFormatting(editor).ok).toBe(true);
        expect(editor.state.doc.textContent).toBe(expected);
        expect(editor.commands.undo()).toBe(true);
        expect(editor.getJSON()).toEqual(before);
        expect(editor.commands.redo()).toBe(true);
        expect(editor.state.doc.textContent).toBe(expected);
      } finally {
        editor.destroy();
      }
    },
  );
  test("inserts a dependent claim at the current caret", () => {
    const editor = claimEditor([
      "1. 一种电池回收装置，其特征在于：",
      "2. 根据权利要求1所述的一种电池回收装置，其特征在于：",
      "3. 根据权利要求 2 所述的一种电池回收装置，其特征在于：",
      "4. 根据权利要求3所述的一种电池回收装置，其特征在于：",
    ]);
    moveCaretToParagraph(editor, 1);

    const result = insertDependentClaimAtSelection(editor);

    expect(result).toEqual({
      ok: true,
      message: "已在第 2 项后插入第 3 项从属权利要求，默认引用权利要求 2。",
    });
    expect(paragraphTexts(editor)).toEqual([
      "1. 一种电池回收装置，其特征在于：",
      "2. 根据权利要求1所述的一种电池回收装置，其特征在于：",
      "3. 根据权利要求 2 所述的一种电池回收装置，其特征在于：",
      "4. 根据权利要求 2 所述的一种电池回收装置，其特征在于：",
      "5. 根据权利要求 4 所述的一种电池回收装置，其特征在于：",
    ]);
    expect(JSON.stringify(editor.getJSON())).toContain('"type":"claimReferenceReview"');
    expect(editor.state.selection.$head.parent.textContent).toBe(
      "3. 根据权利要求 2 所述的一种电池回收装置，其特征在于：",
    );

    // 新插入段整段红字；引用的权利要求数字红字 + 黄色高亮 + 下划线。
    const insertedNode = editor.getJSON().content?.[2] as {
      content?: { type?: string; text?: string; marks?: unknown[] }[];
    };
    const insertedTexts = insertedNode.content ?? [];
    for (const inline of insertedTexts) {
      if (inline.type === "text") {
        expect(
          (inline.marks ?? []).some(
            (mark) => (mark as { type?: string }).type === "claimReferenceReview",
          ),
        ).toBe(true);
      }
    }
    const serialized = JSON.stringify(editor.getJSON());
    expect(serialized).toContain('"backgroundColor":"#FDE047"');
    // 引用数字带下划线。
    expect(serialized).toContain('"type":"underline"');
    // 编号与点标黄、编号后空格不标黄：被重编号段落的编号点号节点含黄底，空格节点不含。
    const renumbered = editor.getJSON().content?.[3] as {
      content?: { type?: string; text?: string; marks?: unknown[] }[];
    };
    const renumberedTexts = renumbered?.content ?? [];
    const dotNode = renumberedTexts.find(
      (inline) => inline.type === "text" && /[.．、]/u.test(inline.text ?? ""),
    );
    const spaceNode = renumberedTexts.find(
      (inline) => inline.type === "text" && inline.text?.startsWith(" "),
    );
    // 编号（含点）标黄；编号后空格不标黄。
    expect(dotNode?.text).toMatch(/[.．、]/u);
    expect(dotNode?.marks ?? []).toContainEqual(expect.objectContaining({ type: "textStyle" }));
    expect(spaceNode?.text?.[0]).toBe(" ");
    expect(spaceNode?.marks ?? []).not.toContainEqual(
      expect.objectContaining({ type: "textStyle" }),
    );

    editor.destroy();
  });

  test("keeps the dunhao number separator for inserted and renumbered claims", () => {
    const editor = claimEditor([
      "1、一种电池回收装置，其特征在于：",
      "2、根据权利要求1所述的一种电池回收装置，其特征在于：",
      "3、根据权利要求 2 所述的一种电池回收装置，其特征在于：",
    ]);
    moveCaretToParagraph(editor, 1);

    const result = insertDependentClaimAtSelection(editor);
    expect(result).toEqual({
      ok: true,
      message: "已在第 2 项后插入第 3 项从属权利要求，默认引用权利要求 2。",
    });
    // 插入段与受影响段的标号分隔符均保持顿号。
    expect(paragraphTexts(editor)).toEqual([
      "1、一种电池回收装置，其特征在于：",
      "2、根据权利要求1所述的一种电池回收装置，其特征在于：",
      "3、根据权利要求 2 所述的一种电池回收装置，其特征在于：",
      "4、根据权利要求 2 所述的一种电池回收装置，其特征在于：",
    ]);
    editor.destroy();
  });

  test("does not alter the editor when the caret is in unnumbered preface text", () => {
    const editor = claimEditor(["普通文字", "1. 一种装置，其特征在于："]);
    moveCaretToParagraph(editor, 0);
    const before = editor.getJSON();

    expect(insertDependentClaimAtSelection(editor)).toEqual({
      ok: false,
      message: "未能确定光标所在的权利要求，请将光标放入目标权利要求后重试。",
    });
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  test("inserts at the caret when a non-claim block precedes the claims", () => {
    const editor = new Editor({
      extensions: createPatentExtensions("claim-operation-heading-test", {
        patentParagraphRules: true,
      }),
      content: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "撰写提示" }] },
          {
            type: "paragraph",
            content: [{ type: "text", text: "1. 一种电池回收装置，其特征在于：" }],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "2. 根据权利要求1所述的一种电池回收装置，其特征在于：" },
            ],
          },
        ],
      },
    });
    moveCaretToParagraph(editor, 2);

    expect(insertDependentClaimAtSelection(editor)).toEqual({
      ok: true,
      message: "已在第 2 项后插入第 3 项从属权利要求，默认引用权利要求 2。",
    });
    expect(paragraphTexts(editor)).toEqual([
      "撰写提示",
      "1. 一种电池回收装置，其特征在于：",
      "2. 根据权利要求1所述的一种电池回收装置，其特征在于：",
      "3. 根据权利要求 2 所述的一种电池回收装置，其特征在于：",
    ]);
    editor.destroy();
  });

  test("clears review formatting and extra Chinese spaces without collapsing English words", () => {
    const editor = new Editor({
      extensions: createPatentExtensions("format-cleanup-test", { patentParagraphRules: true }),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "一种　电池 回收装置，",
                marks: [
                  { type: "textStyle", attrs: { color: "#112233" } },
                  { type: "underline" },
                  { type: "claimReferenceReview" },
                ],
              },
              {
                type: "text",
                text: "battery    recycling device",
                marks: [{ type: "bold" }, { type: "textStyle", attrs: { fontSizePt: 14 } }],
              },
              { type: "inlineMath", attrs: { latex: "x + y" } },
            ],
          },
          { type: "paragraph" },
        ],
      },
    });
    moveCaretToParagraph(editor, 0);

    expect(clearExtraFormatting(editor)).toEqual({
      ok: true,
      message: "已清除 3 处格式，删除 1 处空行，并整理 3 处多余空格。",
    });
    expect(paragraphTexts(editor)[0]).toBe("一种电池回收装置，battery recycling device");
    expect(JSON.stringify(editor.getJSON())).not.toContain("claimReferenceReview");
    expect(JSON.stringify(editor.getJSON())).not.toContain('"underline"');
    expect(JSON.stringify(editor.getJSON())).not.toContain('"color":"#112233"');
    expect(JSON.stringify(editor.getJSON())).toContain('"bold"');
    expect(JSON.stringify(editor.getJSON())).toContain('"fontSizePt":14');
    expect(editor.getJSON().content).toHaveLength(1);

    expect(editor.commands.undo()).toBe(true);
    expect(paragraphTexts(editor)[0]).toBe("一种　电池 回收装置，battery    recycling device");
    editor.destroy();
  });

  test("clears underlined template spaces while keeping typed underlined content in one undo step", () => {
    const editor = new Editor({
      extensions: createPatentExtensions("format-cleanup-template-blank-test", {
        patentParagraphRules: true,
      }),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "本发明涉及" },
              { type: "text", text: "电池冷却      ", marks: [{ type: "underline" }] },
              { type: "text", text: "技术领域。" },
            ],
          },
        ],
      },
    });

    expect(clearExtraFormatting(editor).ok).toBe(true);
    expect(paragraphTexts(editor)).toEqual(["本发明涉及电池冷却技术领域。"]);
    expect(JSON.stringify(editor.getJSON())).not.toContain('"underline"');

    expect(editor.commands.undo()).toBe(true);
    expect(paragraphTexts(editor)).toEqual([`本发明涉及电池冷却${" ".repeat(6)}技术领域。`]);
    expect(JSON.stringify(editor.getJSON())).toContain('"underline"');
    editor.destroy();
  });

  test("converts full-width and four-or-more half-width spaces into structural indents", () => {
    const editor = new Editor({
      extensions: createPatentExtensions("format-cleanup-drawing-indent-test", {
        patentParagraphRules: true,
      }),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { paragraphIndentMm: 0 },
            content: [{ type: "text", text: "　　图1为本发明的结构示意图。" }],
          },
          {
            type: "paragraph",
            attrs: { paragraphIndentMm: 0 },
            content: [{ type: "text", text: "    图2为本发明的流程示意图。" }],
          },
          {
            type: "paragraph",
            attrs: { paragraphIndentMm: 0 },
            content: [{ type: "text", text: "      图3为本发明的连接示意图。" }],
          },
        ],
      },
    });

    expect(clearExtraFormatting(editor).ok).toBe(true);
    expect(paragraphTexts(editor)).toEqual([
      "图1为本发明的结构示意图。",
      "图2为本发明的流程示意图。",
      "图3为本发明的连接示意图。",
    ]);
    expect(editor.getJSON().content?.map((node) => node.attrs?.paragraphIndentMm)).toEqual([
      PATENT_FIRST_LINE_INDENT_MM,
      PATENT_FIRST_LINE_INDENT_MM,
      PATENT_FIRST_LINE_INDENT_MM,
    ]);

    expect(editor.commands.undo()).toBe(true);
    expect(paragraphTexts(editor)).toEqual([
      "　　图1为本发明的结构示意图。",
      "    图2为本发明的流程示意图。",
      "      图3为本发明的连接示意图。",
    ]);
    expect(editor.getJSON().content?.map((node) => node.attrs?.paragraphIndentMm)).toEqual([
      0, 0, 0,
    ]);
    editor.destroy();
  });

  test("does not dispatch a cleanup when the active document is already clean", () => {
    const editor = claimEditor(["一种电池回收装置，battery recycling device"]);
    const before = editor.getJSON();

    expect(clearExtraFormatting(editor)).toEqual({
      ok: true,
      message: "未发现需要清理的多余格式或空格。",
    });
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  test("clears text highlight and color while keeping other text styles", () => {
    const editor = new Editor({
      extensions: createPatentExtensions("format-cleanup-highlight-test", {
        patentParagraphRules: true,
      }),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "高亮文字",
                marks: [
                  { type: "textStyle", attrs: { color: "#112233", backgroundColor: "#FFFF00" } },
                ],
              },
              {
                type: "text",
                text: "保留字号",
                marks: [{ type: "textStyle", attrs: { fontSizePt: 14 } }],
              },
            ],
          },
        ],
      },
    });
    moveCaretToParagraph(editor, 0);

    expect(clearExtraFormatting(editor)).toEqual({
      ok: true,
      message: "已清除 1 处格式并整理 0 处多余空格。",
    });
    expect(paragraphTexts(editor)[0]).toBe("高亮文字保留字号");
    const first = editor.getJSON().content?.[0]?.content?.[0] as {
      text?: string;
      marks?: unknown;
    };
    expect(first.text).toBe("高亮文字");
    expect(first.marks).toBeUndefined();
    const second = editor.getJSON().content?.[0]?.content?.[1] as {
      text?: string;
      marks?: Array<{
        attrs?: { fontSizePt?: number; color?: unknown; backgroundColor?: unknown };
      }>;
    };
    expect(second.text).toBe("保留字号");
    expect(second.marks?.[0]?.attrs?.fontSizePt).toBe(14);
    expect(second.marks?.[0]?.attrs?.color).toBeNull();
    expect(second.marks?.[0]?.attrs?.backgroundColor).toBeNull();
    editor.destroy();
  });

  test("removes empty underlines left by the default templates", () => {
    const editor = new Editor({
      extensions: createPatentExtensions("format-cleanup-underline-test", {
        patentParagraphRules: true,
      }),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "本发明涉及______技术领域。" },
              { type: "text", text: "采用的技术方案是＿＿＿＿＿＿。" },
            ],
          },
        ],
      },
    });
    moveCaretToParagraph(editor, 0);

    expect(clearExtraFormatting(editor)).toEqual({
      ok: true,
      message: "已清除 0 处格式，删除 2 处空下划线，并整理 0 处多余空格。",
    });
    expect(paragraphTexts(editor)[0]).toBe("本发明涉及技术领域。采用的技术方案是。");
    editor.destroy();
  });

  test("clears italic marks", () => {
    const editor = new Editor({
      extensions: createPatentExtensions("format-cleanup-italic-test", {
        patentParagraphRules: true,
      }),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "斜体内容", marks: [{ type: "italic" }] },
              { type: "text", text: "普通内容" },
            ],
          },
        ],
      },
    });
    moveCaretToParagraph(editor, 0);

    expect(clearExtraFormatting(editor)).toEqual({
      ok: true,
      message: "已清除 1 处格式并整理 0 处多余空格。",
    });
    expect(paragraphTexts(editor)[0]).toBe("斜体内容普通内容");
    expect(JSON.stringify(editor.getJSON())).not.toContain('"italic"');
    editor.destroy();
  });

  test("removes empty paragraphs and whitespace-only paragraphs", () => {
    const editor = new Editor({
      extensions: createPatentExtensions("format-cleanup-empty-lines-test", {
        patentParagraphRules: true,
      }),
      content: {
        type: "doc",
        content: [
          { type: "paragraph" },
          { type: "paragraph", content: [{ type: "text", text: "第一段正文" }] },
          { type: "paragraph", content: [{ type: "text", text: "   " }] },
          { type: "paragraph", content: [{ type: "text", text: "第二段正文" }] },
        ],
      },
    });
    moveCaretToParagraph(editor, 0);

    expect(clearExtraFormatting(editor)).toEqual({
      ok: true,
      message: "已清除 0 处格式，删除 2 处空行，并整理 0 处多余空格。",
    });
    expect(paragraphTexts(editor)).toEqual(["第一段正文", "第二段正文"]);
    editor.destroy();
  });

  test("keeps one paragraph when the whole document is empty", () => {
    const editor = new Editor({
      extensions: createPatentExtensions("format-cleanup-all-empty-test", {
        patentParagraphRules: true,
      }),
      content: { type: "doc", content: [{ type: "paragraph" }, { type: "paragraph" }] },
    });
    moveCaretToParagraph(editor, 0);

    expect(clearExtraFormatting(editor)).toEqual({
      ok: true,
      message: "已清除 0 处格式，删除 1 处空行，并整理 0 处多余空格。",
    });
    expect(paragraphTexts(editor)).toEqual([""]);
    editor.destroy();
  });

  test.each(["______", "＿＿＿＿＿＿", "_ _ _ _", "＿　＿　＿"])(
    "removes a placeholder across formatting boundaries in one idempotent undoable cleanup: %s",
    (placeholder) => {
      const editor = cleanupEditor([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "本发明涉及" },
            ...Array.from(placeholder).map((text, index) => ({
              type: "text",
              text,
              marks: [{ type: "textStyle", attrs: { color: index % 2 ? "#112233" : "#223344" } }],
            })),
            { type: "text", text: "技术领域。" },
          ],
        },
      ]);
      try {
        const before = editor.getJSON();
        expect(clearExtraFormatting(editor).ok).toBe(true);
        expect(editor.state.doc.textContent).toBe("本发明涉及技术领域。");
        const cleaned = editor.getJSON();
        expect(clearExtraFormatting(editor).message).toBe("未发现需要清理的多余格式或空格。");
        expect(editor.getJSON()).toEqual(cleaned);
        expect(editor.commands.undo()).toBe(true);
        expect(editor.getJSON()).toEqual(before);
        expect(editor.commands.redo()).toBe(true);
        expect(editor.getJSON()).toEqual(cleaned);
      } finally {
        editor.destroy();
      }
    },
  );

  test.each(["__init__", "data__cache", "A___B", "α__β", "编号__1"])(
    "preserves underscores in technical identifiers: %s",
    (identifier) => {
      const editor = cleanupEditor([
        { type: "paragraph", content: [{ type: "text", text: `采用${identifier}进行处理。` }] },
      ]);
      try {
        const before = editor.getJSON();
        expect(clearExtraFormatting(editor).message).toBe("未发现需要清理的多余格式或空格。");
        expect(editor.getJSON()).toEqual(before);
        expect(editor.commands.undo()).toBe(false);
      } finally {
        editor.destroy();
      }
    },
  );

  test("removes a placeholder-only paragraph in the same undo step without touching paragraph layout", () => {
    const editor = cleanupEditor([
      {
        type: "paragraph",
        attrs: { textAlign: "center", paragraphIndentMm: 0 },
        content: [{ type: "text", text: "第一段" }],
      },
      { type: "paragraph", content: [{ type: "text", text: "______" }] },
      { type: "paragraph", content: [{ type: "text", text: "第二段" }] },
    ]);
    try {
      const before = editor.getJSON();
      expect(clearExtraFormatting(editor).ok).toBe(true);
      expect(paragraphTexts(editor)).toEqual(["第一段", "第二段"]);
      expect(editor.getJSON().content?.[0]).toEqual(before.content?.[0]);
      const cleaned = editor.getJSON();
      expect(clearExtraFormatting(editor).message).toBe("未发现需要清理的多余格式或空格。");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(cleaned);
    } finally {
      editor.destroy();
    }
  });

  test("clears extra soft line breaks while preserving one meaningful break and inline formulas", () => {
    const editor = cleanupEditor([
      {
        type: "paragraph",
        content: [
          { type: "hardBreak" },
          { type: "text", text: "第一行" },
          { type: "hardBreak" },
          { type: "text", text: "  " },
          { type: "hardBreak" },
          { type: "inlineMath", attrs: { latex: "x^2" } },
          { type: "text", text: "第二行" },
          { type: "hardBreak" },
          { type: "hardBreak" },
        ],
      },
      { type: "paragraph", content: [{ type: "hardBreak" }] },
      { type: "paragraph", content: [{ type: "text", text: "最后一段" }] },
    ]);
    try {
      const before = editor.getJSON();
      expect(clearExtraFormatting(editor).ok).toBe(true);
      expect(editor.getJSON().content).toHaveLength(2);
      expect(editor.getJSON().content?.[0]?.content?.map((node) => node.type)).toEqual([
        "text",
        "hardBreak",
        "inlineMath",
        "text",
      ]);
      expect(editor.state.doc.firstChild?.child(2).attrs.latex).toBe("x^2");
      const cleaned = editor.getJSON();
      expect(clearExtraFormatting(editor).message).toBe("未发现需要清理的多余格式或空格。");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(cleaned);
    } finally {
      editor.destroy();
    }
  });

  test("does not join a placeholder across an inline object or a meaningful soft break", () => {
    const editor = cleanupEditor([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "_" },
          { type: "inlineMath", attrs: { latex: "x" } },
          { type: "text", text: "_" },
          { type: "hardBreak" },
          { type: "text", text: "_" },
        ],
      },
    ]);
    try {
      const before = editor.getJSON();
      expect(clearExtraFormatting(editor).message).toBe("未发现需要清理的多余格式或空格。");
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  test("retains schema-required empty list paragraphs after clearing their placeholders", () => {
    const editor = cleanupEditor([
      {
        type: "orderedList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "______" }] }],
          },
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "第二项" }] }],
          },
        ],
      },
    ]);
    try {
      const before = editor.getJSON();
      expect(clearExtraFormatting(editor).ok).toBe(true);
      expect(editor.getJSON().content?.[0]?.content).toHaveLength(2);
      expect(editor.state.doc.firstChild?.firstChild?.firstChild?.type.name).toBe("paragraph");
      editor.state.doc.check();
      const cleaned = editor.getJSON();
      expect(clearExtraFormatting(editor).message).toBe("未发现需要清理的多余格式或空格。");
      expect(editor.getJSON()).toEqual(cleaned);
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  test("cleans an independent placeholder beside a split identifier without corrupting the identifier", () => {
    const editor = cleanupEditor([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "__", marks: [{ type: "bold" }] },
          {
            type: "text",
            text: "init",
            marks: [{ type: "textStyle", attrs: { color: "#ff0000" } }],
          },
          { type: "text", text: "__ ______" },
        ],
      },
    ]);
    try {
      const before = editor.getJSON();
      expect(clearExtraFormatting(editor).ok).toBe(true);
      expect(editor.state.doc.textContent).toBe("__init__");
      expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual([{ type: "bold" }]);
      expect(clearExtraFormatting(editor).message).toBe("未发现需要清理的多余格式或空格。");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  test("removes duplicate empty paragraphs after a list but keeps its required caret paragraph", () => {
    const editor = cleanupEditor([
      {
        type: "orderedList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "列表正文" }] }],
          },
        ],
      },
      { type: "paragraph" },
      { type: "paragraph" },
      { type: "paragraph" },
    ]);
    try {
      const before = editor.getJSON();
      expect(clearExtraFormatting(editor).message).toContain("删除 2 处空行");
      expect(editor.getJSON().content?.map((node) => node.type)).toEqual([
        "orderedList",
        "paragraph",
      ]);
      expect(clearExtraFormatting(editor).message).toBe("未发现需要清理的多余格式或空格。");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  test("keeps cleanup in a separate undo step from immediately preceding typing", () => {
    const editor = cleanupEditor([
      { type: "paragraph", content: [{ type: "text", text: "正文" }] },
    ]);
    try {
      const original = editor.getJSON();
      editor.view.dispatch(editor.state.tr.insertText("______", 3));
      const beforeCleanup = editor.getJSON();
      expect(clearExtraFormatting(editor).ok).toBe(true);
      expect(editor.state.doc.textContent).toBe("正文");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(beforeCleanup);
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(original);
    } finally {
      editor.destroy();
    }
  });

  test("keeps immediate typing after cleanup in its own undo step", () => {
    const editor = cleanupEditor([
      { type: "paragraph", content: [{ type: "text", text: "正文______" }] },
    ]);
    try {
      const beforeCleanup = editor.getJSON();
      expect(clearExtraFormatting(editor).ok).toBe(true);
      const cleaned = editor.getJSON();
      editor.view.dispatch(editor.state.tr.insertText("新", 1));
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(cleaned);
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(beforeCleanup);
    } finally {
      editor.destroy();
    }
  });
});
