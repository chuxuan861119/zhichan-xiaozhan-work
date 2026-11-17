import { describe, expect, test } from "vitest";
import cases from "../../../tests/fixtures/ai-correction-prompt-cases.json" with { type: "json" };
import { buildCorrectionMessages } from "./prompt.js";

type PromptCase = (typeof cases)[number] & {
  bookKind: "claims" | "description" | "abstract";
  scopeKind: "selection" | "current-book";
};

describe("AI correction prompt regression corpus", () => {
  test.each(cases as PromptCase[])("keeps applicability boundaries for $id", (testCase) => {
    const prompt =
      buildCorrectionMessages(testCase.scopeKind, [
        {
          segmentId: "synthetic-segment",
          bookKind: testCase.bookKind,
          text: "合成测试文本。",
          requestContext: {
            chunkIndex: 1,
            chunkCount: 1,
            completeDocument: testCase.completeDocument,
          },
        },
      ])[0]?.content ?? "";
    for (const phrase of testCase.include) expect(prompt).toContain(phrase);
    for (const phrase of testCase.exclude) expect(prompt).not.toContain(phrase);
  });
});
