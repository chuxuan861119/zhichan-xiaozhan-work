import { randomUUID } from "node:crypto";
import { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { describe, expect, test } from "vitest";
import type { TextPolishReplacementResult } from "../../../../shared/ai-correction/text-polish-contract";
import { AUTOMATIC_EDIT_RED } from "../../../../shared/patent/reference-marks";
import { createPatentExtensions } from "../../editor/extensions";
import { inspectMixedSelection, mixedEditorDocument } from "./mixed-selection";
import {
  applyTextPolish,
  inspectTextPolishSelection,
  resolveTextPolishAnchor,
} from "./text-polish-anchor";

function editorWith(blockId = randomUUID()) {
  return new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: blockId },
          content: [{ type: "text", text: "该装置能够进行工作。" }],
        },
        {
          type: "paragraph",
          attrs: { nodeId: randomUUID() },
          content: [{ type: "text", text: "第二段文字。" }],
        },
      ],
    },
  });
}

describe("text polish editor anchor", () => {
  test("requires explicit confirmation for paragraph restructuring and revalidates the source", () => {
    const editor = editorWith();
    editor.commands.selectAll();
    const selected = inspectTextPolishSelection(editor, "description");
    if (selected.status !== "ready") throw new Error("selection");
    const replacement = {
      anchor: { ...selected.scope, originalText: selected.text, originalTextHash: "a".repeat(64) },
      polishedText: "合并后的文字。",
    };
    const before = editor.getJSON();
    expect(applyTextPolish(editor, replacement)).toMatchObject({
      ok: false,
      requiresConfirmation: true,
    });
    expect(editor.getJSON()).toEqual(before);
    expect(applyTextPolish(editor, replacement, true)).toEqual({ ok: true });
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
    editor.commands.insertContentAt(1, "新增");
    expect(applyTextPolish(editor, replacement, true)).toMatchObject({ ok: false });
    editor.destroy();
  });
  test("accepts Ctrl+A as one continuous full-document selection", () => {
    const editor = editorWith();
    const firstBlockId = editor.getJSON().content?.[0]?.attrs?.nodeId as string;
    const secondBlockId = editor.getJSON().content?.[1]?.attrs?.nodeId as string;
    editor.commands.selectAll();

    expect(inspectTextPolishSelection(editor, "description")).toMatchObject({
      status: "ready",
      text: "该装置能够进行工作。\n第二段文字。",
      characterCount: 17,
      scope: {
        bookKind: "description",
        blocks: [
          { blockId: firstBlockId, blockType: "paragraph", startOffset: 0, endOffset: 10 },
          { blockId: secondBlockId, blockType: "paragraph", startOffset: 0, endOffset: 6 },
        ],
      },
    });
    editor.destroy();
  });

  test("accepts one continuous selection across multiple paragraphs", () => {
    const editor = editorWith();
    const firstBlockId = editor.getJSON().content?.[0]?.attrs?.nodeId as string;
    const secondBlockId = editor.getJSON().content?.[1]?.attrs?.nodeId as string;
    editor.commands.setTextSelection({ from: 4, to: 16 });
    expect(inspectTextPolishSelection(editor, "description")).toMatchObject({
      status: "ready",
      text: "能够进行工作。\n第二段",
      characterCount: 11,
      scope: {
        bookKind: "description",
        blocks: [
          { blockId: firstBlockId, blockType: "paragraph", startOffset: 3, endOffset: 10 },
          { blockId: secondBlockId, blockType: "paragraph", startOffset: 0, endOffset: 3 },
        ],
      },
    });
    editor.destroy();
  });

  test("keeps an empty paragraph inside one continuous selection", () => {
    const editor = editorWith();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: ids[0] },
          content: [{ type: "text", text: "第一" }],
        },
        { type: "paragraph", attrs: { nodeId: ids[1] } },
        {
          type: "paragraph",
          attrs: { nodeId: ids[2] },
          content: [{ type: "text", text: "第三" }],
        },
      ],
    });
    editor.commands.setTextSelection({ from: 1, to: 9 });

    expect(inspectTextPolishSelection(editor, "description")).toMatchObject({
      status: "ready",
      text: "第一\n\n第三",
      scope: {
        blocks: [
          { blockId: ids[0], blockType: "paragraph", startOffset: 0, endOffset: 2 },
          { blockId: ids[1], blockType: "paragraph", startOffset: 0, endOffset: 0 },
          { blockId: ids[2], blockType: "paragraph", startOffset: 0, endOffset: 2 },
        ],
      },
    });
    editor.destroy();
  });

  test("accepts plain text after an unselected inline object using node offsets", () => {
    const editor = editorWith();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: randomUUID() },
          content: [
            { type: "text", text: "前文" },
            { type: "hardBreak" },
            { type: "text", text: "需要润色" },
          ],
        },
      ],
    });
    editor.commands.setTextSelection({ from: 4, to: 8 });

    expect(inspectTextPolishSelection(editor, "description")).toMatchObject({
      status: "ready",
      text: "需要润色",
    });
    editor.destroy();
  });

  test("preserves mixed formatting, headings and paragraph attributes when polishing", () => {
    const editor = editorWith();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: randomUUID() },
          content: [
            { type: "text", text: "CO" },
            { type: "text", text: "2", marks: [{ type: "subscript" }] },
            { type: "text", text: "浓度比较高" },
          ],
        },
        {
          type: "heading",
          attrs: { nodeId: randomUUID(), level: 2 },
          content: [{ type: "text", text: "技术背景" }],
        },
        {
          type: "paragraph",
          attrs: { nodeId: randomUUID(), textAlign: "center" },
          content: [{ type: "text", text: "末段" }],
        },
      ],
    });
    const before = editor.getJSON();
    editor.commands.selectAll();
    const selection = inspectTextPolishSelection(editor, "description");
    if (selection.status !== "ready") throw new Error("selection");
    expect(
      applyTextPolish(editor, {
        anchor: {
          ...selection.scope,
          originalText: selection.text,
          originalTextHash: "a".repeat(64),
        },
        polishedText: selection.text.replace("比较高", "较高"),
      }),
    ).toEqual({ ok: true });
    const after = editor.getJSON();
    expect(after.content?.[0]?.content?.[1]?.marks).toEqual([{ type: "subscript" }]);
    expect(after.content?.[1]).toEqual(before.content?.[1]);
    expect(after.content?.[2]).toEqual(before.content?.[2]);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  test("replaces only an exact unchanged anchor and preserves undo", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    const result: TextPolishReplacementResult = {
      anchor: {
        bookKind: "description",
        blocks: [{ blockId, blockType: "paragraph", startOffset: 3, endOffset: 9 }],
        originalText: "能够进行工作",
        originalTextHash: "a".repeat(64),
      },
      polishedText: "可正常工作",
    };

    expect(resolveTextPolishAnchor(editor, result.anchor)).toMatchObject({ status: "ready" });
    expect(applyTextPolish(editor, result)).toEqual({ ok: true });
    expect(editor.getText()).toContain("该装置可正常工作。");
    editor.commands.undo();
    expect(editor.getText()).toContain("该装置能够进行工作。");

    editor.commands.insertContentAt({ from: 4, to: 5 }, "已");
    expect(applyTextPolish(editor, result)).toEqual({
      ok: false,
      message: "替换失败：原文已修改，请重新选择并润色。",
    });
    editor.destroy();
  });

  test("removes only the automatic red mark from replacement text", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: blockId },
          content: [
            { type: "text", text: "该装置" },
            {
              type: "text",
              text: "能够进行工作",
              marks: [
                { type: "bold" },
                { type: "textStyle", attrs: { color: AUTOMATIC_EDIT_RED } },
              ],
            },
            { type: "text", text: "。" },
          ],
        },
      ],
    });
    const result: TextPolishReplacementResult = {
      anchor: {
        bookKind: "description",
        blocks: [{ blockId, blockType: "paragraph", startOffset: 3, endOffset: 9 }],
        originalText: "能够进行工作",
        originalTextHash: "a".repeat(64),
      },
      polishedText: "可正常工作",
    };

    expect(applyTextPolish(editor, result)).toEqual({ ok: true });
    const replacement = editor
      .getJSON()
      .content?.[0]?.content?.find(
        (node) => node.type === "text" && (node as { text?: string }).text === "可正常工作",
      );
    expect(replacement?.marks).toContainEqual({ type: "bold" });
    expect(replacement?.marks ?? []).not.toContainEqual(
      expect.objectContaining({
        type: "textStyle",
        attrs: expect.objectContaining({ color: AUTOMATIC_EDIT_RED }),
      }),
    );
    editor.destroy();
  });

  test("replaces an unchanged multi-paragraph selection and preserves surrounding text", () => {
    const editor = editorWith();
    const firstBlockId = editor.getJSON().content?.[0]?.attrs?.nodeId as string;
    const secondBlockId = editor.getJSON().content?.[1]?.attrs?.nodeId as string;
    const result: TextPolishReplacementResult = {
      anchor: {
        bookKind: "description",
        blocks: [
          { blockId: firstBlockId, blockType: "paragraph", startOffset: 3, endOffset: 10 },
          { blockId: secondBlockId, blockType: "paragraph", startOffset: 0, endOffset: 3 },
        ],
        originalText: "能够进行工作。\n第二段",
        originalTextHash: "a".repeat(64),
      },
      polishedText: "能够稳定运行。\n第二部分",
    };

    expect(applyTextPolish(editor, result)).toEqual({ ok: true });
    expect(editor.getText({ blockSeparator: "\n" })).toBe("该装置能够稳定运行。\n第二部分文字。");
    editor.commands.undo();
    expect(editor.getText({ blockSeparator: "\n" })).toBe("该装置能够进行工作。\n第二段文字。");
    editor.destroy();
  });

  test("rejects a multi-paragraph result when a selected block changes structure", () => {
    const editor = editorWith();
    const firstBlockId = editor.getJSON().content?.[0]?.attrs?.nodeId as string;
    const secondBlockId = editor.getJSON().content?.[1]?.attrs?.nodeId as string;
    const anchor: TextPolishReplacementResult["anchor"] = {
      bookKind: "description",
      blocks: [
        {
          blockId: firstBlockId,
          blockType: "paragraph",
          startOffset: 3,
          endOffset: 10,
        },
        {
          blockId: secondBlockId,
          blockType: "paragraph",
          startOffset: 0,
          endOffset: 3,
        },
      ],
      originalText: "能够进行工作。\n第二段",
      originalTextHash: "a".repeat(64),
    };
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: firstBlockId },
          content: [{ type: "text", text: "该装置能够进行工作。" }],
        },
        {
          type: "heading",
          attrs: { nodeId: secondBlockId, level: 2 },
          content: [{ type: "text", text: "第二段文字。" }],
        },
      ],
    });

    expect(resolveTextPolishAnchor(editor, anchor)).toEqual({ status: "stale" });
    editor.destroy();
  });
});

test("mixed selection preserves inline formulas and nested table text through apply and undo", () => {
  const editor = editorWith();
  editor.commands.setContent({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { nodeId: randomUUID() },
        content: [
          { type: "text", text: "根据" },
          { type: "inlineMath", attrs: { latex: "Q=P/R" } },
          { type: "text", text: "计算结果" },
        ],
      },
      {
        type: "table",
        attrs: { nodeId: randomUUID() },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [
                  {
                    type: "paragraph",
                    attrs: { nodeId: randomUUID() },
                    content: [{ type: "text", text: "比较高" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  editor.commands.selectAll();
  const selected = inspectTextPolishSelection(editor, "description");
  expect(selected.status).toBe("ready");
  if (selected.status !== "ready") throw new Error("selection");
  expect(selected.scope.formatVersion).toBe(2);
  expect(selected.text).toContain("Q=P/R");
  expect(selected.text).toContain("行1 列1");
  const before = editor.getJSON();
  const result = {
    anchor: { ...selected.scope, originalText: selected.text, originalTextHash: "a".repeat(64) },
    polishedText: selected.text.replace("比较高", "较高").replace("计算结果", "求得结果"),
  };
  expect(applyTextPolish(editor, result)).toEqual({ ok: true });
  expect(JSON.stringify(editor.getJSON())).toContain("Q=P/R");
  expect(JSON.stringify(editor.getJSON())).toContain("较高");
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(before);
  expect(
    applyTextPolish(
      editor,
      { ...result, polishedText: result.polishedText.replace("Q=P/R", "Q=P*R") },
      true,
    ).ok,
  ).toBe(false);
  expect(editor.getJSON()).toEqual(before);
  editor.destroy();
});

test("mixed selections become stale when formula content changes even if surrounding text is unchanged", () => {
  const editor = editorWith();
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "blockMath", attrs: { nodeId: randomUUID(), latex: "a=b" } }],
  });
  editor.commands.selectAll();
  const selected = inspectTextPolishSelection(editor, "description");
  expect(selected.status).toBe("ready");
  if (selected.status !== "ready") throw new Error("selection");
  const anchor = {
    ...selected.scope,
    originalText: selected.text,
    originalTextHash: "a".repeat(64),
  };
  expect(resolveTextPolishAnchor(editor, anchor).status).toBe("ready");
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(0, undefined, {
      ...editor.state.doc.firstChild!.attrs,
      latex: "a=c",
    }),
  );
  expect(resolveTextPolishAnchor(editor, anchor).status).toBe("stale");
  editor.destroy();
});

test("cell selections include only selected cells and preserve the rest on apply", () => {
  const editor = editorWith();
  editor.commands.setContent({
    type: "doc",
    content: [
      {
        type: "table",
        attrs: { layoutMode: "fixed", columnWidthsMm: [29.898, 29.898] },
        content: [0, 1].map((row) => ({
          type: "tableRow",
          content: [0, 1].map((col) => ({
            type: "tableCell",
            content: [
              {
                type: "paragraph",
                attrs: { nodeId: randomUUID() },
                content: [{ type: "text", text: col === 0 ? `比较高${row}` : `保密${row}` }],
              },
            ],
          })),
        })),
      },
    ],
  });
  const cells: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "tableCell") cells.push(pos);
  });
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[0]!, cells[2]!)),
  );
  const selected = inspectTextPolishSelection(editor, "description");
  expect(selected.status).toBe("ready");
  if (selected.status !== "ready") throw new Error("selection");
  expect(selected.text).not.toContain("保密");
  const before = editor.getJSON();
  expect(
    applyTextPolish(editor, {
      anchor: { ...selected.scope, originalText: selected.text, originalTextHash: "a".repeat(64) },
      polishedText: selected.text.replaceAll("比较高", "较高"),
    }),
  ).toEqual({ ok: true });
  expect(editor.getText()).toContain("保密0");
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(before);
  expect(inspectMixedSelection(editor).spans.length).toBe(2);
  expect(
    mixedEditorDocument(editor).blocks.filter((b) => b.structure.startsWith("表")).length,
  ).toBe(4);
  editor.destroy();
});
