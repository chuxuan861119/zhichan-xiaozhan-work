import { type Content, Editor } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { ReferenceMarkIssueLocation } from "../../../../shared/patent/reference-mark-issue-locator";
import { createPatentExtensions } from "../extensions";
import {
  referenceMarkIssueHighlightSnapshot,
  setReferenceMarkIssueHighlights,
} from "./reference-mark-issue-highlights";

const locations: ReferenceMarkIssueLocation[] = [
  {
    locationId: "claims:first:0:6:wrong-number",
    referenceMarkId: "mark-1",
    bookKind: "claims",
    nodeId: "first",
    from: 0,
    to: 6,
    text: "电池包(2)",
    reason: "wrong-number",
  },
  {
    locationId: "claims:second:0:3:missing-number",
    referenceMarkId: "mark-1",
    bookKind: "claims",
    nodeId: "second",
    from: 0,
    to: 3,
    text: "电池包",
    reason: "missing-number",
  },
];
const firstLocation = locations[0] as ReferenceMarkIssueLocation;

function editorWith(content: Content) {
  return new Editor({ extensions: createPatentExtensions(), content });
}

describe("reference mark issue highlights", () => {
  test("decorates every issue and marks only the current position active", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: "first", semanticRole: null },
          content: [{ type: "text", text: "电池包(2)。" }],
        },
        {
          type: "paragraph",
          attrs: { nodeId: "second", semanticRole: null },
          content: [{ type: "text", text: "电池包。" }],
        },
      ],
    });

    setReferenceMarkIssueHighlights(editor, locations, locations[1]?.locationId ?? null);

    expect(referenceMarkIssueHighlightSnapshot(editor)).toEqual([
      expect.objectContaining({ locationId: locations[0]?.locationId, active: false }),
      expect.objectContaining({ locationId: locations[1]?.locationId, active: true }),
    ]);
    expect(editor.view.dom.querySelectorAll(".reference-mark-issue-match")).toHaveLength(2);
    expect(
      editor.view.dom.querySelector("[data-reference-mark-issue-active='true']")?.textContent,
    ).toBe("电池包");
    editor.destroy();
  });

  test("drops a stale location after the problem text is corrected", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: "first", semanticRole: null },
          content: [{ type: "text", text: "电池包(2)。" }],
        },
      ],
    });
    setReferenceMarkIssueHighlights(editor, [firstLocation], firstLocation.locationId);

    editor.commands.setTextSelection({ from: 1, to: 7 });
    editor.commands.insertContent("电池包(1)");

    expect(referenceMarkIssueHighlightSnapshot(editor)).toEqual([]);
    editor.destroy();
  });

  test("clears all issue decorations", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: "first", semanticRole: null },
          content: [{ type: "text", text: "电池包(2)。" }],
        },
      ],
    });
    setReferenceMarkIssueHighlights(editor, [firstLocation], null);
    setReferenceMarkIssueHighlights(editor, [], null);

    expect(referenceMarkIssueHighlightSnapshot(editor)).toEqual([]);
    editor.destroy();
  });
});
