import { Editor } from "@tiptap/core";
import { createBlankBookDocument } from "../../../shared/document/defaults";
import { createEditorJsonCache } from "./editor-json-cache";
import { createPatentExtensions } from "./extensions";
import {
  canonicalToTiptap,
  createIncrementalPatentBookAdapter,
  tiptapToPatentBookDocument,
} from "./model-adapter";

test("incremental conversion preserves normalization, formatting and undo while reusing unchanged output", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [1, 2, 3].map((number) => ({
        type: "paragraph",
        attrs: { nodeId: crypto.randomUUID() },
        content: [
          {
            type: "text",
            text: `测试${number}`,
            marks: [{ type: "textStyle", attrs: { color: "rgb(255, 0, 0)" } }],
          },
        ],
      })),
    },
  });
  const read = createEditorJsonCache();
  const base = createBlankBookDocument("测试");
  const adapter = createIncrementalPatentBookAdapter(
    () => [],
    () => new Set(),
  );
  const first = adapter.fromTiptap(read(editor.state.doc), base);
  if (!first.ok) throw new Error(first.error.message);
  const normalized = adapter.toTiptap(first.value);
  expect(normalized).toEqual(canonicalToTiptap(first.value));
  editor.commands.insertContentAt(1, "新增");
  const content = read(editor.state.doc);
  const changed = adapter.fromTiptap(content, first.value);
  const reference = tiptapToPatentBookDocument(content, first.value, new Set());
  if (!changed.ok || !reference.ok) throw new Error("转换失败");
  expect(changed.value.content).toEqual(reference.value.content);
  expect(adapter.toTiptap(changed.value)).toEqual(canonicalToTiptap(changed.value));
  expect(adapter.toTiptap(changed.value).content?.[1]).toBe(normalized.content?.[1]);
  expect(changed.value.content[1]).toBe(first.value.content[1]);
  expect(Object.isFrozen(changed.value.content[1])).toBe(true);
  editor.commands.undo();
  const restored = adapter.fromTiptap(read(editor.state.doc), changed.value);
  if (!restored.ok) throw new Error(restored.error.message);
  expect(restored.value.content).toEqual(first.value.content);
  editor.destroy();
});

test("cached block validation still rejects invalid edits and metadata without corrupting previous output", () => {
  const base = createBlankBookDocument("校验");
  const adapter = createIncrementalPatentBookAdapter(
    () => [],
    () => new Set(),
  );
  const node = {
    type: "paragraph",
    attrs: { nodeId: crypto.randomUUID() },
    content: [{ type: "text", text: "合法" }],
  };
  const first = adapter.fromTiptap({ type: "doc", content: [node] }, base);
  if (!first.ok) throw new Error(first.error.message);
  expect(() => {
    (first.value.content[0] as { id: string }).id = "corrupted";
  }).toThrow();
  expect(adapter.fromTiptap({ type: "doc", content: [node] }, { ...base, title: "" }).ok).toBe(
    false,
  );
  const invalid = { ...node, attrs: { nodeId: "not-a-uuid" } };
  expect(adapter.fromTiptap({ type: "doc", content: [invalid] }, base).ok).toBe(false);
  const again = adapter.fromTiptap({ type: "doc", content: [node] }, base);
  expect(again.ok).toBe(true);
  if (again.ok) expect(again.value.content[0]).toBe(first.value.content[0]);
});

test("unchanged block reuse cannot hide duplicate ids or resource removal", () => {
  const base = createBlankBookDocument("安全检查");
  const id = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  let ids = new Set([assetId]);
  const adapter = createIncrementalPatentBookAdapter(
    () => [],
    () => ids,
  );
  const node = { type: "figure", attrs: { nodeId: id, assetId, widthMm: 80, alignment: "center" } };
  const first = adapter.fromTiptap({ type: "doc", content: [node] }, base);
  expect(first.ok).toBe(true);
  expect(adapter.fromTiptap({ type: "doc", content: [node, { ...node }] }, base).ok).toBe(false);
  ids = new Set();
  expect(adapter.fromTiptap({ type: "doc", content: [node] }, base).ok).toBe(false);
});
