import { describe, expect, it } from "vitest";
import { createBlankPatent } from "../patent/defaults.js";
import {
  aiContentBlocks,
  mixedSelection,
  mixedTextForDisplay,
  mixedTextRuns,
} from "./mixed-content.js";

describe("mixed AI content", () => {
  it("keeps formula source and read-only boundaries separate from editable text", () => {
    const patent = createBlankPatent({ patentType: "invention", name: null });
    const paragraph = patent.books[0]!.document.content.find((b) => b.type === "paragraph")!;
    if (paragraph.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [
      { type: "text", text: "根据", marks: [] },
      { type: "inline-formula", source: "Q=\\frac{P}{R}", formulaKind: "math" },
      { type: "hard-break" },
      { type: "text", text: "计算", marks: [] },
    ];
    const blocks = aiContentBlocks([paragraph]);
    const spans = [
      { blockId: paragraph.id, blockType: "paragraph" as const, startOffset: 0, endOffset: 6 },
    ];
    const mixed = mixedSelection(blocks, spans);
    expect(mixed.text).toContain("frac");
    expect(mixed.text.split("\n")).toHaveLength(1);
    expect(mixedTextForDisplay(mixed.text)).toBe("根据Q=\\frac{P}{R}\n计算");
    const line = mixed.lines[0]!;
    expect(mixedTextRuns(line, line.text.replace("计算", "求得"))?.map((r) => r.text)).toEqual([
      "根据",
      "",
      "求得",
    ]);
    expect(mixedTextRuns(line, line.text.replace("frac", "sqrt"))).toBeNull();
    expect(() => mixedSelection(blocks, [...spans, ...spans])).toThrow();
  });
});
