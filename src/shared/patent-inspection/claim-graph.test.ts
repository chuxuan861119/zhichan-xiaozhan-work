import { describe, expect, test } from "vitest";
import { buildClaimGraph, type ClaimFact } from "./claim-graph.js";

function claim(
  number: number,
  text: string,
  referencedNumbers: readonly number[],
  alternativeReference = false,
  paragraphIds = [`claim-${number}`],
): ClaimFact {
  return {
    number,
    paragraphId: paragraphIds[0] ?? `claim-${number}`,
    paragraphIds,
    paragraphs: paragraphIds.map((paragraphId) => ({ paragraphId, text })),
    text,
    kind: referencedNumbers.length === 0 ? "independent" : "dependent",
    subjectName: "装置",
    referencedNumbers,
    multipleDependent: referencedNumbers.length > 1,
    alternativeReference,
  };
}

describe("buildClaimGraph", () => {
  test("tracks multi-paragraph claims, ancestor order, multiple dependencies, and cycles", () => {
    const claims = [
      claim(1, "1. 一种装置，包括：\n组件。", [], false, ["claim1a", "claim1b"]),
      claim(2, "2. 根据权利要求3和权利要求1所述的装置。", [3, 1]),
      claim(3, "3. 根据权利要求2或权利要求1所述的装置。", [2, 1], true),
      claim(4, "4. 根据权利要求3所述的装置。", [3]),
    ];

    const graph = buildClaimGraph(claims);

    expect(graph.byNumber.get(1)).toMatchObject({
      number: 1,
      kind: "independent",
      paragraphIds: ["claim1a", "claim1b"],
      subjectName: "装置",
    });
    expect(graph.ancestorsByNumber.get(4)).toEqual([3, 2, 1]);
    expect(graph.multipleDependentNumbers).toContain(3);
    expect(graph.cycles).toEqual([[2, 3]]);
  });

  test("only marks explicit alternative language as alternative references", () => {
    const graph = buildClaimGraph([
      claim(1, "1. 一种装置。", []),
      claim(2, "2. 根据权利要求1、2和3所述的装置。", [1, 2, 3], false),
      claim(3, "3. 根据权利要求1、2或3所述的装置。", [1, 2, 3], true),
    ]);

    expect(graph.byNumber.get(2)?.alternativeReference).toBe(false);
    expect(graph.byNumber.get(3)?.alternativeReference).toBe(true);
  });

  test("recognizes 任一项 as an explicit alternative reference", () => {
    const graph = buildClaimGraph([
      claim(1, "1. 一种装置。", []),
      claim(2, "2. 根据权利要求1、2中的任一项所述的装置。", [1, 2], true),
    ]);

    expect(graph.byNumber.get(2)?.alternativeReference).toBe(true);
  });

  test("excludes missing and later claim references from the ancestor chain", () => {
    const graph = buildClaimGraph([
      claim(1, "1. 一种装置。", []),
      claim(2, "2. 根据权利要求3和99所述的装置。", [3, 99]),
      claim(3, "3. 根据权利要求1所述的装置。", [1]),
    ]);

    expect(graph.ancestorsByNumber.get(2)).toEqual([]);
    expect(graph.ancestorsByNumber.get(3)).toEqual([1]);
  });

  test("orders branch ancestors by distance before traversing deeper levels", () => {
    const graph = buildClaimGraph([
      claim(1, "1. 一种装置。", []),
      claim(2, "2. 根据权利要求1所述的装置。", [1]),
      claim(3, "3. 根据权利要求1所述的装置。", [1]),
      claim(4, "4. 根据权利要求3和2所述的装置。", [3, 2]),
    ]);

    expect(graph.ancestorsByNumber.get(4)).toEqual([3, 2, 1]);
  });

  test("rejects duplicate claim numbers instead of silently overwriting a graph node", () => {
    expect(() =>
      buildClaimGraph([claim(1, "1. 一种装置。", []), claim(1, "1. 一种设备。", [])]),
    ).toThrow(/duplicate claim number|重复权利要求编号/iu);
  });
});
