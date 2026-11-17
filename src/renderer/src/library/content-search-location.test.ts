import { Schema } from "@tiptap/pm/model";
import { expect, test, vi } from "vitest";
import { resolveContentSearchMatch } from "./content-search-location";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: {
      content: "text*",
      group: "block",
      attrs: { nodeId: { default: null } },
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
  },
});

test("prefers the stable paragraph when its offset and global occurrence both change", () => {
  const passage = "a".repeat(120) + "关键词" + "z".repeat(120);
  const doc = schema.node(
    "doc",
    null,
    Array.from({ length: 41 }, (_, i) =>
      schema.node("paragraph", { nodeId: `p${i}` }, [
        schema.text((i === 40 ? "新增" : "") + passage),
      ]),
    ),
  );
  const match = resolveContentSearchMatch(
    doc,
    "关键词",
    "a".repeat(36) + "关键词" + "z".repeat(64),
    {
      nodeId: "p40",
      textOffset: 120,
      occurrence: 39,
      queryOffset: 36,
    },
  );
  expect(match).toBeDefined();
  expect(doc.resolve(match!.from).parent.attrs.nodeId).toBe("p40");
});

test("does not jump to an unrelated remaining occurrence after the clicked passage is deleted", () => {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", { nodeId: "other" }, [schema.text("完全不同的材料关键词说明")]),
  ]);
  expect(
    resolveContentSearchMatch(doc, "关键词", "原本独特的电机关键词结构", {
      nodeId: "deleted",
      textOffset: 8,
      occurrence: 0,
      queryOffset: 8,
    }),
  ).toBeUndefined();
});

test("rejects ambiguous identical replacements when the original paragraph no longer exists", () => {
  const doc = schema.node(
    "doc",
    null,
    ["a", "b"].map((nodeId) =>
      schema.node("paragraph", { nodeId }, [schema.text("独特关键词上下文")]),
    ),
  );
  expect(
    resolveContentSearchMatch(doc, "关键词", "独特关键词上下文", {
      nodeId: "deleted",
      textOffset: 2,
      occurrence: 0,
      queryOffset: 2,
    }),
  ).toBeUndefined();
});

test("rejects unrelated context even when another match occupies the old paragraph", () => {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", { nodeId: "old" }, [schema.text("完全不同的材料关键词说明")]),
  ]);
  expect(
    resolveContentSearchMatch(doc, "关键词", "原本独特的电机关键词结构", {
      nodeId: "old",
      textOffset: 8,
      occurrence: 0,
      queryOffset: 8,
    }),
  ).toBeUndefined();
});

test("does not use shared punctuation alone as evidence for a deleted passage", () => {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", { nodeId: "other" }, [schema.text("完全不同的材料关键词。")]),
  ]);
  expect(
    resolveContentSearchMatch(doc, "关键词", "原本独特的电机关键词。", {
      nodeId: "deleted",
      textOffset: 8,
      occurrence: 0,
      queryOffset: 8,
    }),
  ).toBeUndefined();
});

test("does not guess between equally plausible matches inside the same edited paragraph", () => {
  const passage = "a".repeat(120) + "关键词" + "z".repeat(120);
  const doc = schema.node("doc", null, [
    schema.node("paragraph", { nodeId: "old" }, [schema.text("新增" + passage + passage)]),
  ]);
  expect(
    resolveContentSearchMatch(doc, "关键词", "a".repeat(36) + "关键词" + "z".repeat(64), {
      nodeId: "old",
      textOffset: 120,
      occurrence: 0,
      queryOffset: 36,
    }),
  ).toBeUndefined();
});

test("finds the moved passage after its original paragraph is split", () => {
  const original = "前部关键词。独特目标关键词内容";
  const at = original.lastIndexOf("关键词");
  const doc = schema.node("doc", null, [
    schema.node("paragraph", { nodeId: "p1" }, [schema.text("前部关键词。")]),
    schema.node("paragraph", { nodeId: "p2" }, [schema.text("独特目标关键词内容")]),
  ]);
  const match = resolveContentSearchMatch(doc, "关键词", original, {
    nodeId: "p1",
    textOffset: at,
    queryOffset: at,
    occurrence: 1,
  });
  expect(doc.resolve(match!.from).parent.attrs.nodeId).toBe("p2");
});

test("finds the clicked occurrence instead of the first match when a snippet spans paragraphs", () => {
  const paragraph = (text: string) => schema.node("paragraph", null, [schema.text(text)]);
  const doc = schema.node("doc", null, [
    paragraph("第一处螺旋输送机构。"),
    paragraph("其他描述。"),
    paragraph("第二处螺旋输送机构。"),
  ]);
  const first = resolveContentSearchMatch(doc, "螺旋输送");
  const second = resolveContentSearchMatch(doc, "螺旋输送", "其他描述。\n第二处螺旋输送机构。");
  expect(first).toBeDefined();
  expect(second?.from).toBeGreaterThan(first?.from ?? 0);
});
test("distinguishes identical passages and uses context after earlier text changes", () => {
  const text = "重复关键词段落";
  const paragraph = (value: string) => schema.node("paragraph", null, [schema.text(value)]);
  const doc = schema.node("doc", null, [paragraph(text), paragraph(text)]);
  expect(
    resolveContentSearchMatch(doc, "关键词", text, { occurrence: 1, queryOffset: 2 })?.from,
  ).toBeGreaterThan(resolveContentSearchMatch(doc, "关键词", text)?.from ?? 0);
  const changed = schema.node("doc", null, [
    paragraph("新增关键词"),
    paragraph("独特关键词上下文"),
  ]);
  expect(
    resolveContentSearchMatch(changed, "关键词", "独特关键词上下文", {
      occurrence: 0,
      queryOffset: 2,
    })?.from,
  ).toBeGreaterThan(6);
});

test("locates caret codes literally instead of selecting unrelated whitespace", () => {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("前文 空格 后文^w文字")]),
  ]);
  const match = resolveContentSearchMatch(doc, "^w");
  expect(match).toBeDefined();
  expect(doc.textBetween(match!.from, match!.to)).toBe("^w");
});

test("keeps the last clicked occurrence in forty identical paragraphs", () => {
  const doc = schema.node(
    "doc",
    null,
    Array.from({ length: 40 }, () => schema.node("paragraph", null, [schema.text("关键词")])),
  );
  const snippet = `${"关键词\n".repeat(9)}关键词\n`;
  expect(
    resolveContentSearchMatch(doc, "关键词", snippet, {
      occurrence: 39,
      queryOffset: 36,
    })?.from,
  ).toBe(196);
});

test("uses a stable paragraph id after earlier identical matches are inserted", () => {
  const doc = schema.node(
    "doc",
    null,
    Array.from({ length: 41 }, (_, index) =>
      schema.node("paragraph", { nodeId: `p-${index}` }, [schema.text("重复关键词段落")]),
    ),
  );
  const match = resolveContentSearchMatch(doc, "关键词", "重复关键词段落", {
    occurrence: 39,
    queryOffset: 2,
    nodeId: "p-40",
    textOffset: 2,
  });
  expect(doc.resolve(match!.from).parent.attrs.nodeId).toBe("p-40");
});

test("rechecks context when edits put a different match at the saved block offset", () => {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", { nodeId: "p-1" }, [schema.text("新增关键词 独特关键词上下文")]),
  ]);
  expect(
    resolveContentSearchMatch(doc, "关键词", "独特关键词上下文", {
      occurrence: 0,
      queryOffset: 2,
      nodeId: "p-1",
      textOffset: 2,
    })?.from,
  ).toBe(9);
});

test("does not rescan a ten-thousand-paragraph tree for every context candidate", () => {
  const doc = schema.node(
    "doc",
    null,
    Array.from({ length: 10000 }, () => schema.node("paragraph", null, [schema.text("关键词")])),
  );
  const scan = vi.spyOn(doc, "textBetween");
  const match = resolveContentSearchMatch(doc, "关键词", `${"关键词\n".repeat(9)}关键词\n`, {
    occurrence: 9999,
    queryOffset: 36,
  });
  expect(match?.from).toBe(49996);
  expect(scan).not.toHaveBeenCalled();
  scan.mockRestore();
});
