import { createBlankPatent } from "../../../shared/patent/defaults";
import { inspectPatent } from "../../../shared/patent/validation";
import { applyInspectionPatch, inspectionPatch } from "./inspection-protocol";

test("inspection patches preserve complete results without resending unchanged long books", () => {
  const previous = createBlankPatent({ patentType: "invention", name: "增量检查" });
  const next = {
    ...previous,
    name: "修改名称",
    revision: 1,
    books: previous.books.map((book) =>
      book.kind === "claims"
        ? {
            ...book,
            localRevision: 1,
            document: { ...book.document, modifiedAt: new Date().toISOString() },
          }
        : book,
    ),
  };
  const patch = inspectionPatch(previous, next);
  expect(patch.books.map((book) => book.kind)).toEqual(["claims"]);
  const restored = applyInspectionPatch(structuredClone(previous), structuredClone(patch));
  expect(restored).toEqual(next);
  expect(inspectPatent(restored).issues).toEqual(inspectPatent(next).issues);
  expect(previous.name).toBe("增量检查");
});
