import { supportsDualColumns } from "./dual-column-eligibility";

test.each(["claims", "description"] as const)("allows %s in dual columns", (kind) => {
  expect(supportsDualColumns(kind)).toBe(true);
});

test.each(["abstract", "description-drawings", "abstract-drawing"] as const)(
  "does not allow %s in dual columns",
  (kind) => {
    expect(supportsDualColumns(kind)).toBe(false);
  },
);
