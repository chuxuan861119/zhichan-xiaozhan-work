import {
  isPatentDocumentTargetAvailable,
  type PatentDocumentTarget,
  patentDocumentTargetKey,
  patentDocumentTargetsEqual,
} from "./document-target.js";

const patentId = "00000000-0000-4000-8000-000000000101";
const auxiliaryDocumentId = "00000000-0000-4000-8000-000000000401";

const official: PatentDocumentTarget = { patentId, kind: "book", bookKind: "description" };
const auxiliary: PatentDocumentTarget = {
  patentId,
  kind: "auxiliary",
  auxiliaryDocumentId,
};

describe("patent document targets", () => {
  test("keeps official and auxiliary identities distinct", () => {
    expect(patentDocumentTargetKey(official)).not.toBe(patentDocumentTargetKey(auxiliary));
    expect(patentDocumentTargetsEqual(official, auxiliary)).toBe(false);
    expect(patentDocumentTargetsEqual(auxiliary, { ...auxiliary })).toBe(true);
  });

  test("checks the availability of each target kind against its own collection", () => {
    const availability = {
      patentId,
      availableBookKinds: ["description"] as const,
      auxiliaryDocumentIds: [auxiliaryDocumentId],
    };

    expect(isPatentDocumentTargetAvailable(official, availability)).toBe(true);
    expect(isPatentDocumentTargetAvailable(auxiliary, availability)).toBe(true);
    expect(
      isPatentDocumentTargetAvailable(
        { ...auxiliary, auxiliaryDocumentId: "00000000-0000-4000-8000-000000000402" },
        availability,
      ),
    ).toBe(false);
  });
});
