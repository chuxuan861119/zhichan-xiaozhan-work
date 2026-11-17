import { expect, test } from "vitest";
import { contentSearchText } from "./content-search-text.js";

test("literal matching preserves original offsets, escapes syntax, and rejects empty or structural queries", () => {
  expect([...contentSearchText.matches("İX µ μ [x] a.b 😀", "X")]).toEqual([
    { from: 1, to: 2 },
    { from: 8, to: 9 },
  ]);
  expect([...contentSearchText.matches("µ μ", "μ")]).toEqual([
    { from: 0, to: 1 },
    { from: 2, to: 3 },
  ]);
  expect([...contentSearchText.matches("a.b axb", "a.b")]).toEqual([{ from: 0, to: 3 }]);
  expect([...contentSearchText.matches("x", "")]).toEqual([]);
  expect([...contentSearchText.matches("x\u0000y", "x\u0000y")]).toEqual([]);
});

test("canonical and editor nodes share text, block ids, offsets, and atom boundaries", () => {
  const canonical = contentSearchText.collect({
    content: [
      {
        type: "paragraph",
        id: "p1",
        content: [
          { type: "text", text: "前😀" },
          { type: "inline-figure" },
          { type: "text", text: "后关键词" },
        ],
      },
      {
        type: "table",
        id: "t1",
        tableNameEnabled: true,
        tableName: " 表名 ",
        tableNoteEnabled: true,
        tableNote: "补充说明",
        rows: [
          {
            cells: [
              {
                content: [
                  { type: "paragraph", id: "cell-p", content: [{ type: "text", text: "单元格" }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const editor = contentSearchText.collect({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { nodeId: "p1" },
        content: [
          { type: "text", text: "前😀" },
          { type: "inlineFigure" },
          { type: "text", text: "后关键词" },
        ],
      },
      {
        type: "table",
        attrs: {
          nodeId: "t1",
          tableNameEnabled: true,
          tableName: " 表名 ",
          tableNoteEnabled: true,
          tableNote: "补充说明",
        },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [
                  {
                    type: "paragraph",
                    attrs: { nodeId: "cell-p" },
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
  expect(editor).toEqual(canonical);
  expect(canonical.spans[1]).toMatchObject({ nodeId: "p1", textOffset: 4 });
  expect([...contentSearchText.matches(canonical.text, "😀后")]).toEqual([]);
});
