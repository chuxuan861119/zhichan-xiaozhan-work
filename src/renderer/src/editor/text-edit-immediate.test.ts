import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { afterEach, expect, test, vi } from "vitest";
import { createPatentExtensions } from "./extensions";

const editors: Editor[] = [];
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
const originalAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");
const originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [target, key, descriptor] of [
    [HTMLElement.prototype, "animate", originalAnimate],
    [HTMLElement.prototype, "getAnimations", originalAnimations],
    [Range.prototype, "getBoundingClientRect", originalRangeRect],
  ] as const) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
});

for (const platform of ["win32", "darwin", "openharmony"]) {
  test.each(["delete", "cross-paragraph-delete", "paste", "rich-paste"])(
    `${platform}: %s is immediate and remains undoable without content paint`,
    async (operation) => {
      vi.stubGlobal("documentFontPlatform", platform);
      const rect = () => DOMRect.fromRect({ x: 20, y: 20, width: 200, height: 40 });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(rect);
      Object.defineProperty(Range.prototype, "getBoundingClientRect", {
        configurable: true,
        value: rect,
      });
      const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null, id: "" }));
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        value: animate,
      });
      Object.defineProperty(HTMLElement.prototype, "getAnimations", {
        configurable: true,
        value: () => [],
      });
      const editor = new Editor({
        element: document.createElement("div"),
        extensions: createPatentExtensions(),
        content: "<p>第一段内容</p><p>第二段内容</p>",
      });
      editors.push(editor);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const before = editor.getJSON();
      editor.commands.setTextSelection({
        from: 1,
        to: operation === "cross-paragraph-delete" ? 11 : 4,
      });
      editor.view.dispatch(closeHistory(editor.state.tr));
      if (operation.includes("delete")) editor.commands.deleteSelection();
      else {
        const clipboard = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(clipboard, "clipboardData", {
          value: {
            getData: (type: string) =>
              type === "text/plain"
                ? "粘贴文字"
                : type === "text/html" && operation === "rich-paste"
                  ? "<p><strong>粘贴文字</strong></p>"
                  : "",
          },
        });
        editor.view.dom.dispatchEvent(clipboard);
      }
      const after = editor.getJSON();
      expect(after).not.toEqual(before);
      if (operation.includes("paste")) expect(editor.getText()).toContain("粘贴文字");
      await Promise.resolve();
      expect(animate).not.toHaveBeenCalled();
      expect(
        editor.extensionManager.extensions.some(
          (extension) => extension.name === "contentLayoutMotion",
        ),
      ).toBe(false);
      expect(
        editor.view.dom.parentElement?.querySelector(
          ".editor-content-motion-paint, .editor-content-motion-measure",
        ),
      ).toBeNull();
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(after);
    },
  );
}
