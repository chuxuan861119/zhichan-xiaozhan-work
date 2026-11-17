import { describe, expect, test } from "vitest";
import { calculateDocumentCoverage } from "./prompt-context.js";

describe("AI correction prompt coverage", () => {
  test("treats a full selection of every non-empty block as a complete document", () => {
    expect(
      calculateDocumentCoverage(
        [
          { id: "heading", text: "说明书" },
          { id: "first", text: "第一段。" },
          { id: "empty", text: "" },
          { id: "second", text: "第二段。" },
        ],
        [
          { blockId: "heading", startOffset: 0, endOffset: 3 },
          { blockId: "first", startOffset: 0, endOffset: 4 },
          { blockId: "empty", startOffset: 0, endOffset: 0 },
          { blockId: "second", startOffset: 0, endOffset: 4 },
        ],
      ),
    ).toEqual({ completeDocument: true });
  });

  test("does not grant full-document capability to a partial or truncated selection", () => {
    expect(
      calculateDocumentCoverage(
        [
          { id: "first", text: "第一段。" },
          { id: "second", text: "第二段。" },
        ],
        [{ blockId: "first", startOffset: 1, endOffset: 4 }],
      ),
    ).toEqual({ completeDocument: false });
  });
});
