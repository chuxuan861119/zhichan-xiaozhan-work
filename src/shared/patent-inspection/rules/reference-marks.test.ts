import { expect, test } from "vitest";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../../document/defaults.js";
import { createBlankPatent } from "../../patent/defaults.js";
import { runPatentInspection } from "../engine.js";
import { referenceMarkDescriptionPresenceRule } from "./reference-marks.js";

test("does not count a longer registered keyword as presence of the shorter keyword", () => {
  const patent = createBlankPatent({ patentType: "invention", name: "匹配口径" });
  const id = crypto.randomUUID();
  patent.referenceMarks = [
    { referenceMarkId: id, number: 1, keyword: "箱体" },
    { referenceMarkId: crypto.randomUUID(), number: 2, keyword: "箱体盖" },
  ];
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  description.document.content = [
    {
      id: crypto.randomUUID(),
      type: "paragraph",
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content: [{ type: "text", text: "箱体盖2", marks: [] }],
    },
  ];
  const report = runPatentInspection(patent, [referenceMarkDescriptionPresenceRule]);
  expect(report.issues).toHaveLength(1);
  expect(report.issues[0]?.summary).toContain("“箱体”（1）");
});
