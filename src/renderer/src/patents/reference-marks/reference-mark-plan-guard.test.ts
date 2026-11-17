import { describe, expect, test } from "vitest";
import { createBlankPatent } from "../../../../shared/patent/defaults";
import { matchesReferenceMarkPlanBase } from "./reference-mark-plan-guard";

describe("reference mark plan guard", () => {
  test("ignores active book navigation but still rejects document changes", () => {
    const before = createBlankPatent({ patentType: "invention", name: "事务守卫" });
    const navigated = structuredClone(before);
    navigated.activeBookKind = "description";
    expect(matchesReferenceMarkPlanBase(navigated, before)).toBe(true);

    const edited = structuredClone(navigated);
    const claims = edited.books.find((book) => book.kind === "claims");
    const paragraph = claims?.document.content.find((block) => block.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [{ type: "text", text: "正文已变化", marks: [] }];
    expect(matchesReferenceMarkPlanBase(edited, before)).toBe(false);
  });
});
