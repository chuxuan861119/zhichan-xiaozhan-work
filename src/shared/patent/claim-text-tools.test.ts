import {
  createDependentClaimTemplate,
  parseClaimParagraphs,
  renumberClaimParagraphs,
} from "./claim-text-tools.js";

describe("free-text claim tools", () => {
  test("creates an ordinary dependent claim template", () => {
    expect(createDependentClaimTemplate(2, 1, "环保回收装置")).toBe(
      "2. 根据权利要求1所述的环保回收装置，其特征在于：",
    );
  });

  test("renumbers visible claim paragraphs without changing their body text", () => {
    expect(renumberClaimParagraphs(["7. 第一段", "继续并结束。", "9、第二项。"])).toEqual([
      "1. 第一段",
      "继续并结束。",
      "2. 第二项。",
    ]);
  });
});
test("does not interpret numerically unsafe pasted prefixes as claim numbers", () => {
  const parsed = parseClaimParagraphs([`${"9".repeat(310)}. 原文保留。`, "1. 一种装置。"]);
  expect(parsed.claims.map((claim) => claim.number)).toEqual([1]);
  expect(parsed.unnumberedPrefaceParagraphIndexes).toEqual([0]);
});
