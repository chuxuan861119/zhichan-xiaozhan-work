import { Editor } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { createPatentExtensions } from "../extensions";
import { convertBlockFigureToInline, convertInlineFigureToBlock } from "./figure-commands";

const attrs = {
  nodeId: "00000000-0000-4000-8000-000000000101",
  assetId: "00000000-0000-4000-8000-000000000102",
  widthMm: 80,
  alignment: "center",
  rotationDeg: 90,
  sourceAspectRatio: 1.5,
};

function imagePosition(editor: Editor, type: "figure" | "inlineFigure"): number {
  let found = -1;
  editor.state.doc.descendants((node, position) => {
    if (found < 0 && node.type.name === type) found = position;
  });
  return found;
}

describe("figure layout conversion", () => {
  test.each(["tableCell", "listItem"])(
    "does not move an inline image out of its %s",
    (container) => {
      const paragraph = {
        type: "paragraph",
        content: [
          { type: "text", text: "前" },
          { type: "inlineFigure", attrs },
          { type: "text", text: "后" },
        ],
      };
      const content =
        container === "tableCell"
          ? {
              type: "table",
              content: [
                { type: "tableRow", content: [{ type: "tableCell", content: [paragraph] }] },
              ],
            }
          : { type: "bulletList", content: [{ type: "listItem", content: [paragraph] }] };
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content: { type: "doc", content: [content] },
      });
      editor.commands.setNodeSelection(imagePosition(editor, "inlineFigure"));
      const original = editor.getJSON();
      expect(convertInlineFigureToBlock(editor)).toBe(false);
      expect(editor.getJSON()).toEqual(original);
      editor.state.doc.check();
      editor.destroy();
    },
  );

  test("turns a block figure into an inline image paragraph", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: { type: "doc", content: [{ type: "figure", attrs }] },
    });
    editor.commands.setNodeSelection(imagePosition(editor, "figure"));
    expect(convertBlockFigureToInline(editor)).toBe(true);
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "paragraph",
      content: [
        {
          type: "inlineFigure",
          attrs: { assetId: attrs.assetId, rotationDeg: 90, sourceAspectRatio: 1.5 },
        },
      ],
    });
    editor.destroy();
  });

  test("splits text around an inline image when converting to a block", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { nodeId: "00000000-0000-4000-8000-000000000103" },
            content: [
              { type: "text", text: "前" },
              { type: "inlineFigure", attrs },
              { type: "text", text: "后" },
            ],
          },
        ],
      },
    });
    editor.commands.setNodeSelection(imagePosition(editor, "inlineFigure"));
    expect(convertInlineFigureToBlock(editor)).toBe(true);
    expect(editor.getJSON().content?.map((node) => node.type)).toEqual([
      "paragraph",
      "figure",
      "paragraph",
    ]);
    expect(editor.getJSON().content?.[0]).toMatchObject({ content: [{ text: "前" }] });
    expect(editor.getJSON().content?.[2]).toMatchObject({ content: [{ text: "后" }] });
    expect(editor.getJSON().content?.[1]?.attrs?.sourceAspectRatio).toBe(1.5);
    editor.destroy();
  });

  test("splits a heading around an inline image when converting to a block", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { nodeId: crypto.randomUUID(), level: 1 },
            content: [
              { type: "text", text: "前" },
              { type: "inlineFigure", attrs },
              { type: "text", text: "后" },
            ],
          },
        ],
      },
    });
    editor.commands.setNodeSelection(imagePosition(editor, "inlineFigure"));

    expect(convertInlineFigureToBlock(editor)).toBe(true);
    expect(
      editor
        .getJSON()
        .content?.map((node) => node.type)
        .slice(0, 3),
    ).toEqual(["heading", "figure", "heading"]);
    editor.destroy();
  });
});
