import type { ParagraphNode } from "../document/model.js";
import { claimReferenceExpressions } from "../patent/claim-reference-expression.js";
import { createBlankPatent } from "../patent/defaults.js";
import { inspectPatent } from "../patent/validation.js";
import { buildPatentFactIndex } from "./facts.js";

function sample(reference: string) {
  const patent = createBlankPatent({ name: "装置", patentType: "invention" });
  const texts = [
    "1. 一种装置，其特征在于：壳体。",
    "2. 根据权利要求1所述的装置，其特征在于：盖体。",
    "3. 根据权利要求1所述的装置，其特征在于：底座。",
    `4. 根据${reference}所述的装置，其特征在于：连接件。`,
  ];
  return {
    ...patent,
    books: patent.books.map((book) =>
      book.kind !== "claims"
        ? book
        : {
            ...book,
            document: {
              ...book.document,
              content: texts.map(
                (text): ParagraphNode => ({
                  id: crypto.randomUUID(),
                  type: "paragraph",
                  attrs: {
                    alignment: "left",
                    paragraphIndentMm: 0,
                    lineSpacing: 1.5,
                    defaultFontFamily: "SimSun",
                    defaultFontSizePt: 14,
                  },
                  content: text
                    .split("\n")
                    .flatMap((part, i) => [
                      ...(i ? [{ type: "hard-break" as const }] : []),
                      { type: "text" as const, text: part, marks: [] },
                    ]),
                }),
              ),
            },
          },
    ),
  };
}

test.each(["1，或2", "1,或者2", "1、或2", "1–2任一项", "1－2任一项", "1～2任一项", "1或权利要求2"])(
  "inspection and insertion agree on complete alternatives: %s",
  (ref) => {
    const patent = sample(`权利要求${ref}`);
    const before = structuredClone(patent);
    const fact = buildPatentFactIndex(patent, "full").claims.at(-1);
    const parsed = claimReferenceExpressions(`权利要求${ref}所述的装置`);
    expect(fact?.referencedNumbers).toEqual([1, 2]);
    expect(fact?.referencedNumbers).toEqual(parsed?.flatMap((e) => e.numbers));
    expect(fact?.alternativeReference).toBe(true);
    expect(fact?.referenceError).toBeUndefined();
    expect(
      inspectPatent(patent).issues.filter((i) =>
        ["claim-reference-warning", "claim-multiple-reference-choice"].includes(i.legacyCode),
      ),
    ).toEqual([]);
    expect(patent).toEqual(before);
  },
);

test.each(["权\n利要求9", "权利\n要求9", "权利要\n求9", "权利要求1–9任一项"])(
  "does not silently lose references in %s",
  (ref) => {
    const patent = sample(ref);
    expect(buildPatentFactIndex(patent).claims.at(-1)?.referencedNumbers).toContain(9);
    expect(
      inspectPatent(patent).issues.some(
        (i) =>
          i.legacyCode === "claim-reference-warning" && i.summary.includes("不存在的权利要求9"),
      ),
    ).toBe(true);
  },
);

test.each(["1和2或3", "1及2或3", "1或2和3", "1，以及2或3", "1和2任一项"])(
  "never classifies conjunctions as unambiguous alternatives: %s",
  (ref) => {
    const patent = sample(`权利要求${ref}`);
    expect(buildPatentFactIndex(patent).claims.at(-1)?.alternativeReference).toBe(false);
    expect(
      inspectPatent(patent).issues.some(
        (i) =>
          i.legacyCode === "claim-multiple-reference-choice" ||
          i.legacyCode === "claim-reference-warning",
      ),
    ).toBe(true);
    expect(claimReferenceExpressions(`权利要求${ref}所述的装置`)).toBeNull();
  },
);

test.each(["1，或", "1–", "1–0", "1–100000000", "一", "1；或9"])(
  "unsupported and incomplete expressions cannot silently pass: %s",
  (ref) => {
    expect(
      inspectPatent(sample(`权利要求${ref}`)).issues.some(
        (i) => i.legacyCode === "claim-reference-warning",
      ),
    ).toBe(true);
    expect(claimReferenceExpressions(`权利要求${ref}所述的装置`)).toBeNull();
  },
);

test.each(["第9项", "９"])("preserves inspection-only recognition of %s", (ref) => {
  expect(buildPatentFactIndex(sample(`权利要求${ref}`)).claims.at(-1)?.referencedNumbers).toEqual([
    9,
  ]);
  expect(claimReferenceExpressions(`权利要求${ref}所述的装置`)).toBeNull();
});

test("reference facts refresh correctly after edits and undo-like restoration", () => {
  const patent = sample("权利要求1–9任一项");
  const previous = buildPatentFactIndex(patent, "full");
  const corrected = sample("权利要求1，或2");
  const next = buildPatentFactIndex(corrected, "full", {
    previous,
    changedDependencies: new Set(["claims"]),
  });
  expect(next.claims.at(-1)?.referencedNumbers).toEqual([1, 2]);
  expect(next.claims.at(-1)?.referenceError).toBeUndefined();
  const restored = buildPatentFactIndex(patent, "full", {
    previous: next,
    changedDependencies: new Set(["claims"]),
  });
  expect(restored.claims).toEqual(previous.claims);
});

test("mixed punctuation still participates in multiple-dependent base checking", () => {
  const patent = sample("权利要求1，或3");
  const claims = patent.books.find((book) => book.kind === "claims");
  const third = claims?.document.content[2];
  if (third?.type !== "paragraph") throw new Error("missing claim");
  third.content = [
    { type: "text", text: "3. 根据权利要求1，或2所述的装置，其特征在于：底座。", marks: [] },
  ];
  expect(
    inspectPatent(patent).issues.some(
      (issue) =>
        issue.legacyCode === "claim-multiple-reference-base" && issue.summary.includes("权利要求4"),
    ),
  ).toBe(true);
});

test("soft-break references participate in cycle and forward-reference checks", () => {
  const patent = sample("权利\n要求2");
  const second = patent.books.find((book) => book.kind === "claims")?.document.content[1];
  if (second?.type !== "paragraph") throw new Error("missing claim");
  second.content = [
    { type: "text", text: "2. 根据权利要求4所述的装置，其特征在于：盖体。", marks: [] },
  ];
  const report = inspectPatent(patent);
  expect(report.issues.some((issue) => issue.legacyCode === "claim-reference-cycle")).toBe(true);
  expect(report.issues.some((issue) => issue.summary.includes("引用了后续权利要求4"))).toBe(true);
});
