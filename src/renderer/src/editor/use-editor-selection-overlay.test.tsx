import { randomUUID } from "node:crypto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import { createPatentExtensions } from "./extensions";
import { useEditorSelectionOverlay } from "./use-editor-selection-overlay";

function createEditor() {
  return new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: randomUUID() },
          content: [{ type: "text", text: "该装置能够进行工作。" }],
        },
      ],
    },
  });
}

describe("useEditorSelectionOverlay", () => {
  test.each([0.5, 0.8, 1.5, 2])("scales retained line backgrounds at zoom %s", async (scale) => {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 2, to: 8 });
    const host = editor.view.dom.parentElement;
    if (!host) throw new Error("missing editor host");
    document.body.append(host);
    const paragraph = editor.view.dom.querySelector("p");
    if (!paragraph) throw new Error("missing paragraph");
    paragraph.style.lineHeight = "40px";
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 100, y: 200, width: 600 * scale, height: 900 * scale }),
    );
    Object.defineProperty(host, "offsetWidth", { configurable: true, value: 600 });
    const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    const originalHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => paragraph,
    });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [
        DOMRect.fromRect({
          x: 100 + 20 * scale,
          y: 200 + 40 * scale,
          width: 100 * scale,
          height: 20 * scale,
        }),
      ],
    });
    const { unmount } = renderHook(() =>
      useEditorSelectionOverlay({ editor, enabled: true, tone: "background" }),
    );
    try {
      await waitFor(() => {
        const rect = host.querySelector<HTMLElement>(".editor-selection-overlay__rect");
        expect(rect).not.toBeNull();
        expect(Number.parseFloat(rect?.style.height ?? "0")).toBeCloseTo(40);
        expect(Number.parseFloat(rect?.style.top ?? "0")).toBeCloseTo(30);
      });
    } finally {
      unmount();
      host.remove();
      editor.destroy();
      if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects);
      else Reflect.deleteProperty(Range.prototype, "getClientRects");
      if (originalHitTest) Object.defineProperty(document, "elementFromPoint", originalHitTest);
      else Reflect.deleteProperty(document, "elementFromPoint");
    }
  });

  test("renders a background selection while the editor is inactive and cleans it up", async () => {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 2, to: 8 });
    const host = editor.view.dom.parentElement;
    if (!host) throw new Error("missing editor host");
    document.body.append(host);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 100, y: 200, width: 600, height: 900 }),
    );
    Object.defineProperty(host, "offsetWidth", { configurable: true, value: 600 });
    const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [DOMRect.fromRect({ x: 120, y: 240, width: 100, height: 20 })],
    });
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    const { rerender, unmount } = renderHook(
      ({ enabled, tone }) => useEditorSelectionOverlay({ editor, enabled, tone }),
      { initialProps: { enabled: true, tone: "background" as const } },
    );

    const layer = await waitFor(() => {
      const current = host.querySelector<HTMLElement>(".editor-selection-overlay");
      expect(current).not.toBeNull();
      expect(current?.dataset.tone).toBe("background");
      return current as HTMLElement;
    });
    const rectangle = await waitFor(() => {
      const current = layer.querySelector<HTMLElement>(".editor-selection-overlay__rect");
      expect(current).not.toBeNull();
      return current as HTMLElement;
    });
    expect(rectangle?.style).toMatchObject({
      left: "20px",
      top: "40px",
      width: "100px",
      height: "20px",
    });
    expect(layer.hidden).toBe(false);

    act(() => editor.commands.focus());
    await waitFor(() => expect(layer.hidden).toBe(true));

    outside.focus();
    await waitFor(() => expect(layer.hidden).toBe(false));
    rerender({ enabled: false, tone: "background" });
    await waitFor(() => expect(host.querySelector(".editor-selection-overlay")).toBeNull());
    expect(host.classList.contains("editor-selection-overlay-host")).toBe(false);

    unmount();
    outside.remove();
    host.remove();
    if (originalRangeRects) {
      Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
    } else {
      Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
    editor.destroy();
  });
});
