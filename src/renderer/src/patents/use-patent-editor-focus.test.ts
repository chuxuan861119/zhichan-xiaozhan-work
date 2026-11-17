import { describe, expect, test } from "vitest";
import {
  historyCommandFromKeyboardEvent,
  mayRestorePatentFocus,
  shouldRoutePatentHistoryShortcut,
  shouldRouteReferenceMarkUndo,
} from "./use-patent-editor-focus";

test.each(["hidden", "display"])(
  "ignores a closed dialog hidden via %s when restoring focus",
  (method) => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = '<section role="dialog"><input /></section>';
    document.body.append(wrapper);
    try {
      expect(mayRestorePatentFocus(document.body)).toBe(false);
      if (method === "hidden") wrapper.hidden = true;
      else wrapper.style.display = "none";
      expect(mayRestorePatentFocus(document.body)).toBe(true);
    } finally {
      wrapper.remove();
    }
  },
);

describe("reference mark undo routing", () => {
  test("routes undo from an active text patent editor", () => {
    const editor = document.createElement("div");
    editor.dataset.patentEditorId = "claims-editor";
    const paragraph = document.createElement("p");
    editor.append(paragraph);

    expect(
      shouldRouteReferenceMarkUndo({
        activeBookKind: "claims",
        canUndo: true,
        modalOpen: false,
        target: paragraph,
      }),
    ).toBe(true);
  });

  test("does not route undo from drawings, a modal, or a side-panel input", () => {
    const input = document.createElement("input");
    expect(
      shouldRouteReferenceMarkUndo({
        activeBookKind: "description-drawings",
        canUndo: true,
        modalOpen: false,
        target: document.body,
      }),
    ).toBe(false);
    expect(
      shouldRouteReferenceMarkUndo({
        activeBookKind: "claims",
        canUndo: true,
        modalOpen: true,
        target: document.body,
      }),
    ).toBe(false);
    expect(
      shouldRouteReferenceMarkUndo({
        activeBookKind: "claims",
        canUndo: true,
        modalOpen: false,
        target: input,
      }),
    ).toBe(false);
  });
});

describe("patent history shortcut routing", () => {
  test("recognizes undo and both redo shortcuts", () => {
    expect(
      historyCommandFromKeyboardEvent({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false }),
    ).toBe("undo");
    expect(
      historyCommandFromKeyboardEvent({ key: "y", ctrlKey: true, metaKey: false, shiftKey: false }),
    ).toBe("redo");
    expect(
      historyCommandFromKeyboardEvent({ key: "z", ctrlKey: true, metaKey: false, shiftKey: true }),
    ).toBe("redo");
    expect(
      historyCommandFromKeyboardEvent({
        key: "z",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
  });

  test("routes both drawing books but not local input history", () => {
    expect(
      shouldRoutePatentHistoryShortcut({
        activeBookKind: "description-drawings",
        modalOpen: false,
        target: document.body,
      }),
    ).toBe(true);
    expect(
      shouldRoutePatentHistoryShortcut({
        activeBookKind: "abstract-drawing",
        modalOpen: false,
        target: document.body,
      }),
    ).toBe(true);
    expect(
      shouldRoutePatentHistoryShortcut({
        activeBookKind: "description-drawings",
        modalOpen: false,
        target: document.createElement("input"),
      }),
    ).toBe(false);
    expect(
      shouldRoutePatentHistoryShortcut({
        activeBookKind: "description-drawings",
        modalOpen: true,
        target: document.body,
      }),
    ).toBe(false);
  });
});
