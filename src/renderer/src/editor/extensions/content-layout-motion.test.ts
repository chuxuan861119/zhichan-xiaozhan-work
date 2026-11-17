import { Editor, Node } from "@tiptap/core";
import TextAlign from "@tiptap/extension-text-align";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, expect, test, vi } from "vitest";
import { ContentLayoutMotion, shouldAnimateContentEdit } from "./content-layout-motion";

const editors: Editor[] = [];
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
const originalAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");
const originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  if (originalAnimations)
    Object.defineProperty(HTMLElement.prototype, "getAnimations", originalAnimations);
  else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  if (originalRangeRect)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeRect);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  document.documentElement.removeAttribute("data-reduced-motion");
});
function create() {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, TextAlign.configure({ types: ["paragraph"] }), ContentLayoutMotion],
    content: "<p>第一段内容</p><p>第二段内容</p>",
  });
  editors.push(editor);
  return editor;
}
function motion() {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => DOMRect.fromRect({ x: 20, y: 20, width: 20, height: 20 }),
  });
  const cancels: ReturnType<typeof vi.fn>[] = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 20, y: 20, width: 200, height: 40 }),
  );
  const animate = vi.fn(() => {
    const cancel = vi.fn();
    cancels.push(cancel);
    return { cancel, onfinish: null, id: "" } as unknown as Animation;
  });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  return { animate, cancels };
}
test("deleting a selection commits immediately, animates inert paint and remains undoable", async () => {
  const { animate, cancels } = motion();
  const editor = create();
  editor.commands.setTextSelection({ from: 1, to: 4 });
  editor.commands.deleteSelection();
  expect(editor.getText()).toBe("内容\n\n第二段内容");
  await Promise.resolve();
  expect(animate).toHaveBeenCalledWith(expect.any(Array), { duration: 400, easing: "ease-in-out" });
  const layer = document.querySelector<HTMLElement>(".editor-content-motion-paint");
  expect(layer?.inert).toBe(true);
  editor.view.dom.dispatchEvent(new Event("beforeinput"));
  expect(layer?.isConnected).toBe(false);
  expect(cancels.some((cancel) => cancel.mock.calls.length > 0)).toBe(true);
  editor.commands.undo();
  expect(editor.getText()).toBe("第一段内容\n\n第二段内容");
});
test("alignment and ordinary typing stay immediate", async () => {
  const { animate } = motion();
  const editor = create();
  editor.commands.setTextSelection(1);
  editor.commands.setTextAlign("right");
  await Promise.resolve();
  expect(animate).not.toHaveBeenCalled();
  expect(editor.getText()).toBe("第一段内容\n\n第二段内容");
  animate.mockClear();
  editor.commands.insertContent("甲");
  await Promise.resolve();
  expect(animate).not.toHaveBeenCalled();
});

test.each(["insertText", "insertReplacementText", "insertFromComposition"])(
  "%s replaces selected text immediately without losing undo or redo",
  async (inputType) => {
    const { animate } = motion();
    const editor = create();
    const original = editor.getText();
    editor.commands.setTextSelection({ from: 1, to: 4 });
    editor.view.dom.dispatchEvent(new InputEvent("beforeinput", { inputType, data: "新的文字" }));
    editor.view.dispatch(editor.state.tr.insertText("新的文字"));
    await Promise.resolve();
    expect(editor.getText()).toBe("新的文字内容\n\n第二段内容");
    expect(animate).not.toHaveBeenCalled();
    expect(document.querySelector(".editor-content-motion-paint")).toBeNull();
    editor.commands.undo();
    expect(editor.getText()).toBe(original);
    editor.commands.redo();
    expect(editor.getText()).toBe("新的文字内容\n\n第二段内容");
  },
);

test("text input without beforeinput stays immediate and leaves input rules in control", async () => {
  const { animate } = motion();
  const editor = create();
  editor.commands.setTextSelection({ from: 1, to: 4 });
  const handled = editor.view.someProp("handleTextInput", (handler) =>
    handler(editor.view, 1, 4, "中文输入", () => editor.state.tr.insertText("中文输入")),
  );
  expect(handled).not.toBe(true);
  editor.view.dispatch(editor.state.tr.insertText("中文输入"));
  await Promise.resolve();
  expect(editor.getText()).toBe("中文输入内容\n\n第二段内容");
  expect(animate).not.toHaveBeenCalled();
});

test("keyboard paragraph insertion stays immediate", async () => {
  const { animate } = motion();
  const editor = create();
  editor.commands.setTextSelection(3);
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await Promise.resolve();
  expect(editor.state.doc.childCount).toBe(3);
  expect(animate).not.toHaveBeenCalled();
});

test("typing intent cannot leak into a later paste or programmatic edit", async () => {
  const { animate } = motion();
  const editor = create();
  editor.commands.setTextSelection({ from: 1, to: 4 });
  editor.view.dom.dispatchEvent(
    new InputEvent("beforeinput", { inputType: "insertText", data: "甲" }),
  );
  editor.view.dom.dispatchEvent(new Event("paste"));
  editor.view.dispatch(editor.state.tr.insertText("粘贴文字").setMeta("uiEvent", "paste"));
  await Promise.resolve();
  expect(animate).toHaveBeenCalled();
  editor.view.dom.dispatchEvent(
    new InputEvent("beforeinput", { inputType: "insertText", data: "乙" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  animate.mockClear();
  editor.commands.insertContent("批量新增");
  await Promise.resolve();
  expect(animate).toHaveBeenCalled();
});

test.each([
  ["win32", 650],
  ["darwin", 400],
  ["openharmony", 400],
])("content edit timing is isolated for %s", async (platform, duration) => {
  vi.stubGlobal("documentFontPlatform", platform);
  const { animate } = motion();
  const editor = create();
  editor.commands.setTextSelection({ from: 1, to: 4 });
  editor.commands.deleteSelection();
  await Promise.resolve();
  expect(animate).toHaveBeenCalledWith(expect.any(Array), { duration, easing: "ease-in-out" });
  expect(editor.getText()).toBe("内容\n\n第二段内容");
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
  expect(document.querySelector(".editor-content-motion-paint")).toBeNull();
});

test("automatic ancestor and unrelated panel scroll do not cancel paint; user wheel does", async () => {
  const { cancels } = motion();
  const editor = create();
  editor.commands.setTextSelection({ from: 1, to: 4 });
  editor.commands.deleteSelection();
  await Promise.resolve();
  const layer = document.querySelector(".editor-content-motion-paint");
  const ancestor = editor.view.dom.parentElement;
  if (!ancestor) throw new Error("missing editor ancestor");
  ancestor.dispatchEvent(new Event("scroll"));
  expect(layer?.isConnected).toBe(true);
  const unrelated = document.createElement("div");
  document.body.append(unrelated);
  unrelated.dispatchEvent(new Event("scroll"));
  expect(cancels.every((cancel) => cancel.mock.calls.length === 0)).toBe(true);
  ancestor.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
  expect(layer?.isConnected).toBe(false);
  expect(cancels.every((cancel) => cancel.mock.calls.length > 0)).toBe(true);
  unrelated.remove();
});
test("reduced motion and composing changes do not create retained layers", async () => {
  const { animate } = motion();
  const editor = create();
  document.documentElement.dataset.reducedMotion = "true";
  editor.commands.setTextSelection({ from: 1, to: 4 });
  editor.commands.deleteSelection();
  await Promise.resolve();
  expect(animate).not.toHaveBeenCalled();
  document.documentElement.removeAttribute("data-reduced-motion");
  editor.view.dispatch(editor.state.tr.insertText("乙").setMeta("composition", 1));
  await Promise.resolve();
  expect(animate).not.toHaveBeenCalled();
});

test("direct manipulation suppresses animation until the pointer is released", async () => {
  const { animate } = motion();
  const editor = create();
  window.dispatchEvent(new Event("pointerdown"));
  editor.commands.insertContent("新增内容");
  await Promise.resolve();
  expect(animate).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("pointerup"));
  editor.commands.insertContent("更多内容");
  await Promise.resolve();
  expect(animate).toHaveBeenCalled();
});

test("existing table motion keeps ownership of the same document transition", async () => {
  const { animate } = motion();
  const editor = create();
  Object.defineProperty(editor.view.dom, "getAnimations", {
    configurable: true,
    value: () => [{ id: "table-layout-motion" }],
  });
  editor.commands.insertContent("新增内容");
  await Promise.resolve();
  expect(animate).not.toHaveBeenCalled();
  expect(document.querySelector(".editor-content-motion-paint")).toBeNull();
});

test("bulk text insertion animates while retaining the single undo operation", async () => {
  const { animate } = motion();
  const editor = create();
  editor.commands.setTextSelection(1);
  editor.commands.insertContent("粘贴内容");
  expect(editor.getText().startsWith("粘贴内容第一段")).toBe(true);
  await Promise.resolve();
  expect(animate).toHaveBeenCalled();
  editor.commands.undo();
  expect(editor.getText()).toBe("第一段内容\n\n第二段内容");
});

test("appended paragraph normalization retains the original deletion positions", async () => {
  motion();
  const editor = create();
  editor.registerPlugin(
    new Plugin({
      appendTransaction(transactions, _before, after) {
        if (
          !transactions.some((transaction) => transaction.docChanged) ||
          after.doc.firstChild?.attrs.textAlign === "left"
        )
          return null;
        return after.tr.setNodeMarkup(0, undefined, {
          ...after.doc.firstChild?.attrs,
          textAlign: "left",
        });
      },
    }),
  );
  editor.commands.setTextSelection({ from: 1, to: 4 });
  editor.commands.deleteSelection();
  await Promise.resolve();
  expect(document.querySelector(".editor-content-motion-paint")?.textContent).toBe("内容");
  editor.destroy();
  editors.splice(editors.indexOf(editor), 1);
  expect(document.querySelector(".editor-content-motion-paint")).toBeNull();
});

test("formatting part of a text run, clearing it and undo/redo never creates paint", async () => {
  const { animate } = motion();
  const editor = create();
  editor.commands.setTextSelection({ from: 2, to: 4 });
  for (const command of [
    "toggleBold",
    "toggleUnderline",
    "toggleItalic",
    "unsetAllMarks",
    "undo",
    "redo",
  ] as const) {
    editor.commands[command]();
    await Promise.resolve();
    expect(animate, command).not.toHaveBeenCalled();
    expect(document.querySelector(".editor-content-motion-paint")).toBeNull();
  }
});

test("very long offscreen text has a bounded measurement cost and stays editable", async () => {
  const { animate } = motion();
  const editor = create();
  editor.commands.setContent(`<p>${"长".repeat(10_000)}</p>`);
  await Promise.resolve();
  const measure = vi
    .spyOn(Range.prototype, "getBoundingClientRect")
    .mockReturnValue(DOMRect.fromRect({ x: 20, y: -100, width: 20, height: 20 }));
  animate.mockClear();
  editor.commands.setTextSelection({ from: 1, to: 4 });
  editor.commands.deleteSelection();
  await Promise.resolve();
  expect(measure.mock.calls.length).toBeLessThanOrEqual(2400);
  expect(editor.getText()).toHaveLength(9997);
  expect(document.querySelector(".editor-content-motion-paint")).toBeNull();
  expect(animate).not.toHaveBeenCalled();
});

test("content changes combined with formatting and same-length replacements still animate", () => {
  const editor = create();
  const before = editor.state;
  const bold = before.schema.marks.bold;
  if (!bold) throw new Error("missing bold mark");
  const transaction = before.tr.insertText("替换", 1, 3).addMark(1, 3, bold.create());
  expect(shouldAnimateContentEdit(transaction, before)).toBe(true);
});

test("inline atom attribute changes remain content edits", () => {
  const atom = Node.create({
    name: "formulaFixture",
    inline: true,
    group: "inline",
    atom: true,
    addAttributes: () => ({ expression: { default: "x" } }),
    renderHTML: ({ node }) => ["span", {}, node.attrs.expression],
  });
  const editor = new Editor({
    extensions: [StarterKit, atom],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "formulaFixture" }] }],
    },
  });
  editors.push(editor);
  const before = editor.state;
  expect(
    shouldAnimateContentEdit(before.tr.setNodeMarkup(1, undefined, { expression: "y" }), before),
  ).toBe(true);
});

test("whole-run cleanup retains equal text rather than trusting a coarse replace map", async () => {
  motion();
  const editor = create();
  editor.commands.setContent("<p>箱体 安装在支架上，箱体 保持稳定。</p>");
  await Promise.resolve();
  editor.view.dom.dispatchEvent(new Event("beforeinput"));
  const text = "箱体安装在支架上，箱体保持稳定。";
  editor.view.dispatch(editor.state.tr.insertText(text, 1, editor.state.doc.content.size - 1));
  await Promise.resolve();
  expect(document.querySelector(".editor-content-motion-paint")?.textContent).toBe(text);
  expect(editor.getText()).toBe(text);
});

test("animation failure restores native paint without changing the committed content", async () => {
  const { animate, cancels } = motion();
  const editor = create();
  animate.mockImplementationOnce(() => {
    throw new Error("animation unavailable");
  });
  editor.commands.setTextSelection({ from: 1, to: 4 });
  editor.commands.deleteSelection();
  await Promise.resolve();
  expect(editor.getText()).toBe("内容\n\n第二段内容");
  expect(document.querySelector(".editor-content-motion-paint")).toBeNull();
  expect(document.querySelector(".editor-content-motion-measure")).toBeNull();
  expect(cancels.every((cancel) => cancel.mock.calls.length > 0)).toBe(true);
});

test("geometry failure never aborts selection deletion or undo", async () => {
  motion();
  const editor = create();
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(() => {
    throw new DOMException("Native DOM already changed", "IndexSizeError");
  });
  expect(() => editor.commands.setTextSelection({ from: 1, to: 4 })).not.toThrow();
  expect(() => editor.commands.deleteSelection()).not.toThrow();
  await Promise.resolve();
  expect(editor.getText()).toBe("内容\n\n第二段内容");
  expect(document.querySelector(".editor-content-motion-paint")).toBeNull();
  expect(() => editor.commands.undo()).not.toThrow();
  expect(editor.getText()).toBe("第一段内容\n\n第二段内容");
});

test("ordinary typing does not premeasure glyphs on every input event", async () => {
  motion();
  const editor = create();
  editor.commands.setTextSelection(1);
  const measure = vi.spyOn(Range.prototype, "getBoundingClientRect");
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
  editor.view.dom.dispatchEvent(
    new InputEvent("beforeinput", { inputType: "insertText", data: "a" }),
  );
  editor.commands.insertContent("a");
  await Promise.resolve();
  expect(measure).not.toHaveBeenCalled();
  expect(editor.getText().startsWith("a第一段")).toBe(true);
});
