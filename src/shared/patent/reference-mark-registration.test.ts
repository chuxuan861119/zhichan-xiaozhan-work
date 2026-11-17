import { expect, test } from "vitest";
import { createBlankPatent } from "./defaults.js";
import { planRegisterReferenceMark } from "./reference-mark-registration.js";
import { planSupplementClaimsReferenceNumbers } from "./reference-mark-operations.js";

test("registration preserves documents and drawing data and supports later number supplementation", () => {
  const patent = createBlankPatent({ patentType: "invention", name: "登记" });
  const claims = patent.books.find(book => book.kind === "claims")!;
  const paragraph = claims.document.content.find(block => block.type === "paragraph")!;
  if (paragraph.type !== "paragraph") throw new Error("fixture");
  paragraph.content = [{ type: "text", text: "一种包括底座的装置。", marks: [] }];
  const before = structuredClone(patent);
  const result = planRegisterReferenceMark(patent, { number: 7, keyword: " 底座 " });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(patent).toEqual(before);
  expect(result.plan.after.books).toBe(patent.books);
  expect(result.plan.after.drawingProjects).toBe(patent.drawingProjects);
  expect(result.plan.after.referenceMarks[0]).toMatchObject({ number: 7, keyword: "底座" });
  expect(result.plan.affectedBookKinds).toEqual([]);
  const supplemented = planSupplementClaimsReferenceNumbers(result.plan.after);
  expect(supplemented.ok && supplemented.plan.counts.claims).toBe(1);
});

test("invalid or duplicate registration never replaces an existing entry", () => {
  let patent = createBlankPatent({ patentType: "invention", name: "登记" });
  const initial = planRegisterReferenceMark(patent, { number: 1, keyword: "底座" });
  if (!initial.ok) throw new Error("fixture");
  patent = initial.plan.after;
  for (const entry of [
    { number: 1, keyword: "外壳" }, { number: 2, keyword: "底座" },
    { number: 0, keyword: "外壳" }, { number: 1.5, keyword: "外壳" },
    { number: 2, keyword: " " }, { number: 2, keyword: "外壳；箱体" },
    { number: 2, keyword: "字".repeat(501) },
  ]) expect(planRegisterReferenceMark(patent, entry).ok).toBe(false);
  patent.drawingBooksEnabled = false;
  expect(planRegisterReferenceMark(patent, { number: 2, keyword: "外壳" }).ok).toBe(false);
});
