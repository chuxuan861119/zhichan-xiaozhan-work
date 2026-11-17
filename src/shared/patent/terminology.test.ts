import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../document/defaults.js";
import { createBlankPatent } from "./defaults.js";
import {
  applyTerminologyReplacements,
  createPatentTerminologyBookEdits,
  scanPatentTerminology,
} from "./terminology.js";

describe("patent terminology preview", () => {
  test("finds safe invention-to-utility-model terminology candidates", () => {
    expect(
      scanPatentTerminology("本发明涉及设备。发明人张三。发明创造应被保护。", "utility-model"),
    ).toEqual([{ from: 0, to: 3, source: "本发明", replacement: "本实用新型" }]);
  });

  test("finds safe utility-model-to-invention terminology candidates", () => {
    expect(scanPatentTerminology("本实用新型涉及设备，属于实用新型专利。", "invention")).toEqual([
      { from: 0, to: 5, source: "本实用新型", replacement: "本发明" },
      { from: 12, to: 18, source: "实用新型专利", replacement: "发明专利" },
    ]);
  });

  test("applies accepted replacements in one reversible patch", () => {
    const source = "本发明涉及设备，该发明专利便于使用。";
    const preview = scanPatentTerminology(source, "utility-model");
    const result = applyTerminologyReplacements(source, preview);

    expect(result.text).toBe("本实用新型涉及设备，该实用新型专利便于使用。");
    expect(applyTerminologyReplacements(result.text, result.inverse).text).toBe(source);
    expect(Object.isFrozen(preview)).toBe(true);
  });

  test("creates cross-book edits for safe text nodes without changing formula source", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "术语替换" });
    const abstract = patent.books.find((book) => book.kind === "abstract");
    if (!abstract) throw new Error("fixture");
    abstract.document.content = [
      {
        id: "00000000-0000-4000-8000-000000000701",
        type: "paragraph",
        attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
        content: [{ type: "text", text: "本发明属于发明专利。", marks: [] }],
      },
      {
        id: "00000000-0000-4000-8000-000000000702",
        type: "block-formula",
        source: "本发明+x",
        formulaKind: "math",
      },
    ];

    const edits = createPatentTerminologyBookEdits(patent, "utility-model");

    expect(edits.map((edit) => edit.bookKind)).toContain("abstract");
    const changedAbstract = edits.find((edit) => edit.bookKind === "abstract")?.document;
    expect(JSON.stringify(changedAbstract?.content)).toContain("本实用新型属于实用新型专利");
    expect(changedAbstract?.content[1]).toMatchObject({
      type: "block-formula",
      source: "本发明+x",
    });
    expect(JSON.stringify(abstract.document.content)).toContain("本发明属于发明专利");
  });
});
