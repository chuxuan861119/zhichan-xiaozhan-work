import { describe, expect, test } from "vitest";
import { createBlankPatent } from "./defaults.js";
import { CanonicalPatentSchema } from "./model.js";
import {
  inspectReferenceMarkDescriptionState,
  planFillReferenceMarksIntoDescription,
  planReorderReferenceMarks,
} from "./reference-mark-operations.js";
import { formatReferenceMarkText } from "./reference-marks.js";

describe("reference mark order", () => {
  const fixture = () => {
    const patent = createBlankPatent({ patentType: "invention", name: "排序" });
    patent.referenceMarks = [
      { referenceMarkId: crypto.randomUUID(), number: 8, keyword: "底座" },
      { referenceMarkId: crypto.randomUUID(), number: 3, keyword: "丝杆" },
    ];
    return patent;
  };
  test("persists order with unchanged body and numbering, and uses it in generated text", () => {
    const patent = fixture();
    const before = JSON.stringify(patent);
    const ids = patent.referenceMarks.map((mark) => mark.referenceMarkId).reverse();
    const result = planReorderReferenceMarks(patent, ids);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const restored = CanonicalPatentSchema.parse(JSON.parse(JSON.stringify(result.plan.after)));
    expect(restored.referenceMarks).toEqual([...patent.referenceMarks].reverse());
    expect(restored.books).toEqual(patent.books);
    expect(JSON.stringify(patent)).toBe(before);
    expect(formatReferenceMarkText(restored.referenceMarks)).toContain("3、丝杆");
    const state = inspectReferenceMarkDescriptionState(restored);
    expect(state.status).not.toBe("invalid");
    if (state.status !== "invalid")
      expect(state.targetText).toBe(formatReferenceMarkText(restored.referenceMarks));
    expect(result.plan.affectedBookKinds).toEqual([]);
    const filled = planFillReferenceMarksIntoDescription(restored);
    expect(filled.ok).toBe(true);
    if (filled.ok)
      expect(inspectReferenceMarkDescriptionState(filled.plan.after).status).toBe("aligned");
  });
  test("rejects missing, duplicate and stale ids without modifying the patent", () => {
    const patent = fixture();
    const id = patent.referenceMarks[0]?.referenceMarkId ?? "";
    for (const ids of [[id], [id, id], [id, crypto.randomUUID()]]) {
      expect(planReorderReferenceMarks(patent, ids).ok).toBe(false);
    }
  });
});
