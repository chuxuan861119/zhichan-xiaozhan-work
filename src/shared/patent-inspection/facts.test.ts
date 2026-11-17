import { describe, expect, test, vi } from "vitest";
import type { ParagraphNode } from "../document/model.js";
import { createBlankPatent } from "../patent/defaults.js";
import type { CanonicalPatent, PatentBookKind } from "../patent/model.js";
import * as claimGraphFacts from "./claim-graph.js";
import { runPatentInspection } from "./engine.js";
import { buildPatentFactIndex } from "./facts.js";
import * as formulaFacts from "./formula-facts.js";
import * as numericFacts from "./numeric-facts.js";
import { HEURISTIC_RULE } from "./rule-provenance.js";
import * as semanticCandidateFacts from "./semantic-candidate-facts.js";
import type { PatentInspectionRule } from "./types.js";

const paragraphAttrs = {
  alignment: "left",
  paragraphIndentMm: 7.4,
  lineSpacing: 1.5,
  defaultFontFamily: "宋体",
  defaultFontSizePt: 14,
} as const;

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    attrs: paragraphAttrs,
    content: [{ type: "text", text, marks: [] }],
  };
}

function replaceBookContent(
  patent: CanonicalPatent,
  kind: PatentBookKind,
  content: CanonicalPatent["books"][number]["document"]["content"],
): CanonicalPatent {
  return {
    ...patent,
    books: patent.books.map((book) =>
      book.kind === kind ? { ...book, document: { ...book.document, content } } : book,
    ),
  };
}

function createPatentWithFacts(): CanonicalPatent {
  let patent = createBlankPatent({ patentType: "invention", name: "事实索引测试" });
  patent = replaceBookContent(patent, "claims", [
    paragraph("00000000-0000-4000-8000-000000000101", "1. 一种装置，其特征在于："),
    paragraph("00000000-0000-4000-8000-000000000102", "2. 根据权利要求1所述的装置，其特征在于："),
  ]);
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("测试专利缺少说明书");
  patent = replaceBookContent(patent, "description", [
    ...description.document.content,
    paragraph("00000000-0000-4000-8000-000000000103", "该结构如图1所示。"),
  ]);
  return {
    ...patent,
    assets: [
      {
        assetId: "00000000-0000-4000-8000-000000000104",
        kind: "image",
        originalName: "图1.png",
        mediaType: "image/png",
        extension: "png",
        byteLength: 4,
        sha256: "A".repeat(64),
        widthPx: 100,
        heightPx: 100,
        previewByteLength: 4,
        previewSha256: "B".repeat(64),
      },
    ],
  };
}

describe("buildPatentFactIndex", () => {
  test("indexes reusable book, chapter, claim, drawing and asset facts", () => {
    const patent = createPatentWithFacts();

    const facts = buildPatentFactIndex(patent);

    expect(facts.books.get("claims")?.visibleText).toContain("一种装置");
    expect(facts.books.get("description")?.chapters.get("technical-field")).toBeDefined();
    expect(facts.claims.map((claim) => claim.number)).toEqual([1, 2]);
    expect(facts.claims[1]?.referencedNumbers).toEqual([1]);
    expect(facts.drawingReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ figureNumber: 1, bookKind: "description" }),
      ]),
    );
    expect(facts.assetsById.size).toBe(patent.assets.length);
    expect(facts.assetsById.get(patent.assets[0]?.assetId ?? "")).toBe(patent.assets[0]);
  });

  test("indexes a multi-paragraph claim as one fact and preserves structural warnings", () => {
    const patent = replaceBookContent(createPatentWithFacts(), "claims", [
      paragraph("00000000-0000-4000-8000-000000000201", "权利要求书前言"),
      paragraph("00000000-0000-4000-8000-000000000202", "1． 一种装置，包括："),
      paragraph("00000000-0000-4000-8000-000000000203", "根据权利要求9设置的控制器。"),
      paragraph("00000000-0000-4000-8000-000000000204", "2、根据权利要求1所述的装置。"),
    ]);

    const facts = buildPatentFactIndex(patent);

    expect(facts.claims.map((claim) => claim.number)).toEqual([1, 2]);
    expect(facts.claims[0]).toMatchObject({
      paragraphId: "00000000-0000-4000-8000-000000000202",
      referencedNumbers: [9],
    });
    expect(facts.claims[0]?.text).toContain("根据权利要求9设置的控制器。");
    expect(facts.claimStructureWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "unnumbered-preface",
          targetId: "00000000-0000-4000-8000-000000000201",
        }),
      ]),
    );
  });

  test("indexes every branch of a compact multiple-claim reference", () => {
    const patent = replaceBookContent(createPatentWithFacts(), "claims", [
      paragraph("00000000-0000-4000-8000-000000000211", "1. 一种装置。"),
      paragraph("00000000-0000-4000-8000-000000000212", "2. 一种设备。"),
      paragraph(
        "00000000-0000-4000-8000-000000000213",
        "3. 根据权利要求1、2或权利要求4至5所述的系统。",
      ),
    ]);

    expect(buildPatentFactIndex(patent).claims[2]?.referencedNumbers).toEqual([1, 2, 4, 5]);
  });

  test("marks only explicit alternative multiple-claim references", () => {
    const patent = replaceBookContent(createPatentWithFacts(), "claims", [
      paragraph("00000000-0000-4000-8000-000000000221", "1. 一种装置。"),
      paragraph("00000000-0000-4000-8000-000000000222", "2. 根据权利要求1、2和3所述的装置。"),
      paragraph(
        "00000000-0000-4000-8000-000000000223",
        "3. 根据权利要求1、2中的任一项所述的装置。",
      ),
      paragraph("00000000-0000-4000-8000-000000000224", "4. 根据权利要求1或权利要求2所述的装置。"),
    ]);

    expect(buildPatentFactIndex(patent).claims.map((claim) => claim.alternativeReference)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  test("builds one fact index and shares it with every applicable rule", () => {
    const patent = createPatentWithFacts();
    const factFactory = vi.fn(buildPatentFactIndex);
    const receivedFacts: unknown[] = [];
    const rule = (id: string): PatentInspectionRule => ({
      id,
      version: 1,
      category: "formal",
      defaultSeverity: "warning",
      cost: "instant",
      dependencies: ["claims"],
      provenance: HEURISTIC_RULE,
      appliesTo: () => true,
      inspect: (_context, facts) => {
        receivedFacts.push(facts);
        return [];
      },
    });

    const firstRule = rule("test.first");
    const secondRule = rule("test.second");
    runPatentInspection(patent, [firstRule, secondRule], {
      buildFacts: factFactory,
    });

    expect(firstRule.cost).toBe("instant");
    expect(firstRule.dependencies).toEqual(["claims"]);
    expect(firstRule.provenance).toBe(HEURISTIC_RULE);
    expect(factFactory).toHaveBeenCalledTimes(1);
    expect(receivedFacts).toHaveLength(2);
    expect(receivedFacts[0]).toBe(receivedFacts[1]);
  });

  test("instant mode leaves the extension facts unbuilt", () => {
    const patent = createPatentWithFacts();

    const claimGraphSpy = vi.spyOn(claimGraphFacts, "buildClaimGraph");
    const numericSpy = vi.spyOn(numericFacts, "extractNumericFacts");
    const formulaSpy = vi.spyOn(formulaFacts, "extractFormulaFacts");
    const semanticSpy = vi.spyOn(semanticCandidateFacts, "extractSemanticCandidateFactsForBooks");

    try {
      const facts = buildPatentFactIndex(patent, "instant");

      expect(facts.full).toBeNull();
    } finally {
      claimGraphSpy.mockRestore();
      numericSpy.mockRestore();
      formulaSpy.mockRestore();
      semanticSpy.mockRestore();
    }

    expect(claimGraphSpy).not.toHaveBeenCalled();
    expect(numericSpy).not.toHaveBeenCalled();
    expect(formulaSpy).not.toHaveBeenCalled();
    expect(semanticSpy).not.toHaveBeenCalled();
  });

  test("reuses unchanged base facts when a specific book dependency is known", () => {
    const patent = createPatentWithFacts();
    const previous = buildPatentFactIndex(patent, "instant");
    const changed = {
      ...patent,
      revision: patent.revision + 1,
      books: patent.books.map((book) =>
        book.kind === "description" ? { ...book, localRevision: book.localRevision + 1 } : book,
      ),
    };
    const next = buildPatentFactIndex(changed, "instant", {
      previous,
      changedDependencies: new Set(["description"]),
    });

    expect(next.books.get("claims")).toBe(previous.books.get("claims"));
    expect(next.books.get("description")).not.toBe(previous.books.get("description"));
    expect(next.claims).toBe(previous.claims);
    expect(next.claimStructureWarnings).toBe(previous.claimStructureWarnings);
    expect(next.assetsById).toBe(previous.assetsById);
  });

  test("reuses unchanged full subfacts only when dependency information is explicit", () => {
    const patent = createPatentWithFacts();
    const previous = buildPatentFactIndex(patent, "full");

    const reused = buildPatentFactIndex(patent, "full", {
      previous,
      changedDependencies: new Set(),
    });
    expect(reused.full?.claimGraph).toBe(previous.full?.claimGraph);
    expect(reused.full?.numeric).toBe(previous.full?.numeric);
    expect(reused.full?.formulas).toBe(previous.full?.formulas);
    expect(reused.full?.semanticCandidates).toBe(previous.full?.semanticCandidates);

    const rebuilt = buildPatentFactIndex(patent, "full", { previous });
    expect(rebuilt.full?.claimGraph).not.toBe(previous.full?.claimGraph);
  });

  test("does not reuse full subfacts across patent identities, revisions, snapshots, or unknown dependencies", () => {
    const patent = createPatentWithFacts();
    const previous = buildPatentFactIndex(patent, "full");

    const differentPatent = {
      ...patent,
      patentId: "00000000-0000-4000-8000-000000000999",
    };
    expect(
      buildPatentFactIndex(differentPatent, "full", {
        previous,
        changedDependencies: new Set(),
      }).full?.claimGraph,
    ).not.toBe(previous.full?.claimGraph);

    const differentRevision = { ...patent, revision: patent.revision + 1 };
    expect(
      buildPatentFactIndex(differentRevision, "full", {
        previous,
        changedDependencies: new Set(),
      }).full?.claimGraph,
    ).not.toBe(previous.full?.claimGraph);

    const changedSnapshot = replaceBookContent(patent, "claims", [
      paragraph("00000000-0000-4000-8000-000000000301", "1. 一种不同装置。"),
    ]);
    expect(
      buildPatentFactIndex(changedSnapshot, "full", {
        previous,
        changedDependencies: new Set(),
      }).full?.claimGraph,
    ).not.toBe(previous.full?.claimGraph);

    const unknownDependencySet = new Set(["unknown-dependency"]) as unknown as ReadonlySet<
      import("./types.js").InspectionDependency
    >;
    expect(
      buildPatentFactIndex(patent, "full", {
        previous,
        changedDependencies: unknownDependencySet,
      }).full?.claimGraph,
    ).not.toBe(previous.full?.claimGraph);
  });

  test("reuses a previous index when equivalent canonical data has a different key insertion order", () => {
    const patent = createPatentWithFacts();
    const previous = buildPatentFactIndex(patent, "full");
    const reorderedPatent = Object.fromEntries(
      Object.entries(patent).reverse(),
    ) as unknown as CanonicalPatent;

    const reordered = buildPatentFactIndex(reorderedPatent, "full", {
      previous,
      changedDependencies: new Set(),
    });

    expect(reordered.full?.claimGraph).toBe(previous.full?.claimGraph);
    expect(reordered.source.snapshotFingerprint).toBe(previous.source.snapshotFingerprint);
  });
});
