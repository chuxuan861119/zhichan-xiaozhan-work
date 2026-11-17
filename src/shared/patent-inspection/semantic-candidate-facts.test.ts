import { describe, expect, test } from "vitest";
import {
  extractSemanticCandidateFacts,
  extractSemanticCandidateFactsForBooks,
} from "./semantic-candidate-facts.js";

const location = {
  kind: "book" as const,
  bookKind: "description" as const,
  targetId: "paragraph-1",
};

describe("extractSemanticCandidateFacts", () => {
  test("records ambiguous, functional, abbreviation and complete object-name candidates", () => {
    const facts = extractSemanticCandidateFacts(
      "该装置具有约5毫米的较大范围，适当调整后优选用于实现稳定输出，以下简称控制器。控制器使得系统运行。",
      location,
    );

    expect(facts.map((fact) => fact.kind)).toEqual(
      expect.arrayContaining(["ambiguous-expression", "functional-expression", "abbreviation"]),
    );
    expect(facts.every((fact) => fact.raw.length > 0 && fact.nearbyText.length > 0)).toBe(true);
  });

  test("keeps object names from claims, description and abstract as separate candidates", () => {
    const facts = extractSemanticCandidateFactsForBooks([
      { bookKind: "claims", targetId: "claims-1", text: "一种多功能装置，其特征在于：" },
      { bookKind: "description", targetId: "description-1", text: "一种多功能装置包括控制器。" },
      { bookKind: "abstract", targetId: "abstract-1", text: "一种装置。" },
    ]);

    const objectNames = facts.filter((fact) => fact.kind === "object-name");
    expect(objectNames.map((fact) => fact.raw)).toEqual(
      expect.arrayContaining(["多功能装置", "装置"]),
    );
    expect(objectNames.every((fact) => fact.location.kind === "book")).toBe(true);
  });

  test("does not treat a word-internal 约 as an ambiguous expression", () => {
    const facts = extractSemanticCandidateFacts("该参数abc约5毫米，约5毫米可接受。", location);

    expect(
      facts.filter((fact) => fact.kind === "ambiguous-expression").map((fact) => fact.raw),
    ).toEqual(["约"]);
  });

  test("recognizes 约 expressions after Chinese text, including 约为 forms", () => {
    const facts = extractSemanticCandidateFacts(
      "参数约5毫米，装置约为5毫米，长度约为20mm。",
      location,
    );

    expect(
      facts.filter((fact) => fact.kind === "ambiguous-expression").map((fact) => fact.raw),
    ).toEqual(["约", "约", "约"]);
  });

  test("does not treat 约 inside an ASCII or numeric token as an ambiguous expression", () => {
    const facts = extractSemanticCandidateFacts("abc约5毫米，A约为5毫米，123约5毫米。", location);

    expect(facts.filter((fact) => fact.kind === "ambiguous-expression")).toEqual([]);
  });

  test("tracks an abbreviation definition and later occurrences across books", () => {
    const facts = extractSemanticCandidateFactsForBooks([
      { bookKind: "claims", targetId: "claims-1", text: "一种控制器，以下简称控制器A。" },
      { bookKind: "description", targetId: "description-1", text: "控制器A用于调节。" },
    ]);

    expect(
      facts
        .filter((fact) => fact.kind === "abbreviation")
        .map((fact) => [fact.raw, fact.location.bookKind]),
    ).toEqual([
      ["控制器A", "claims"],
      ["控制器A", "description"],
    ]);
  });

  test("only records abbreviation occurrences after the definition and respects boundaries", () => {
    const facts = extractSemanticCandidateFacts(
      "控制器A在定义前。以下简称控制器A。控制器A用于调节，控制器AB不应命中。",
      location,
    );

    expect(
      facts.filter((fact) => fact.kind === "abbreviation").map((fact) => fact.location.startOffset),
    ).toEqual([13, 18]);
  });

  test("tracks a same-book definition across paragraph-sized text chunks", () => {
    const facts = extractSemanticCandidateFactsForBooks([
      { bookKind: "description", targetId: "description-1", text: "以下简称控制器A。" },
      { bookKind: "description", targetId: "description-2", text: "控制器A用于调节。" },
    ]);

    expect(facts.filter((fact) => fact.kind === "abbreviation")).toHaveLength(2);
  });

  test("does not match a defined abbreviation inside a longer token in a later book", () => {
    const facts = extractSemanticCandidateFactsForBooks([
      { bookKind: "claims", targetId: "claims-1", text: "以下简称控制器A。" },
      { bookKind: "description", targetId: "description-1", text: "控制器AB用于调节。" },
    ]);

    expect(facts.filter((fact) => fact.kind === "abbreviation")).toHaveLength(1);
  });

  test("preserves modifiers, ordinals and sets in object-name candidates", () => {
    const facts = extractSemanticCandidateFacts(
      "一种包括第一模块和第二模块的控制系统，其特征在于：",
      location,
    );

    expect(facts.filter((fact) => fact.kind === "object-name").map((fact) => fact.raw)).toContain(
      "第一模块和第二模块的控制系统",
    );
  });
});
