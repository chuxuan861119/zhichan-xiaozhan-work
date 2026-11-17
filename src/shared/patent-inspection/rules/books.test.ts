import { createBlankPatent } from "../../patent/defaults.js";
import { visibleBlockText } from "../../patent/text.js";
import { runPatentInspection } from "../engine.js";
import { descriptionChapterBodyRule, descriptionChapterStructureRule } from "./books.js";

describe("description chapter inspection", () => {
  test("does not require a separate beneficial-effects heading", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "章节口径" });
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const start = description.document.content.findIndex(
      (block) => visibleBlockText(block).trim() === "有益效果",
    );
    const end = description.document.content.findIndex(
      (block, index) => index > start && visibleBlockText(block).trim() === "附图说明",
    );
    description.document.content.splice(start, end - start);

    const issues = runPatentInspection(patent, [descriptionChapterBodyRule]).issues;
    expect(issues.some((issue) => issue.summary.includes("有益效果"))).toBe(false);
  });

  test("reports duplicate and out-of-order fixed headings", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "章节结构" });
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const technical = description.document.content.find(
      (block) => visibleBlockText(block).trim() === "技术领域",
    );
    const backgroundIndex = description.document.content.findIndex(
      (block) => visibleBlockText(block).trim() === "背景技术",
    );
    if (!technical || backgroundIndex < 0) throw new Error("fixture");
    description.document.content.splice(backgroundIndex, 0, structuredClone(technical));
    const inventionIndex = description.document.content.findIndex(
      (block) => visibleBlockText(block).trim() === "发明内容",
    );
    const background = description.document.content.splice(backgroundIndex + 1, 1)[0];
    if (!background || inventionIndex < 0) throw new Error("fixture");
    description.document.content.splice(inventionIndex + 1, 0, background);

    const issues = runPatentInspection(patent, [descriptionChapterStructureRule]).issues;
    expect(issues.some((issue) => issue.summary.includes("重复"))).toBe(true);
    expect(issues.some((issue) => issue.summary.includes("顺序"))).toBe(true);
    expect(issues.every((issue) => issue.severity === "suggestion")).toBe(true);
  });
});
