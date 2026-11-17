import { type Content, Editor } from "@tiptap/core";
import { expect, test } from "vitest";
import { createPatentExtensions } from "../extensions";
import {
  referenceMarkReviewMatchCount,
  setReferenceMarkReviewHighlights,
} from "./reference-mark-review-highlights";

function editorWith(content: Content) {
  return new Editor({ extensions: createPatentExtensions(), content });
}

test("excludes longer registered keywords and excluded legend nodes from review highlights", () => {
  const editor = editorWith({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { nodeId: "body", semanticRole: null },
        content: [{ type: "text", text: "自行车和自行车把手" }],
      },
      {
        type: "paragraph",
        attrs: { nodeId: "legend", semanticRole: null },
        content: [{ type: "text", text: "其中：1、自行车；2、自行车把手。" }],
      },
    ],
  });

  setReferenceMarkReviewHighlights(editor, "自行车", 0, {
    protectedSearches: ["自行车把手"],
    excludedNodeIds: ["legend"],
  });

  expect(referenceMarkReviewMatchCount(editor)).toBe(1);
  editor.destroy();
});
