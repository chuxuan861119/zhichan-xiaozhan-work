import { createBlankPatent } from "./defaults.js";
import { tableRegressionDocument } from "../document/table-regression-fixture.js";
import type { CanonicalPatent } from "./model.js";
import { documentText } from "./reference-mark-text.js";
import {
  planAssignDescriptionReferenceNumber,
  planAssignReferenceNumber,
  planSupplementDescriptionReferenceNumbers,
} from "./reference-mark-operations.js";

const deps = {
  now: () => new Date("2026-10-26T00:00:00Z"),
  createId: () => "00000000-0000-4000-8000-000000000099",
};
function fixture(text = "支架设置在底座上，支架用于支撑。") {
  const patent = createBlankPatent({ patentType: "invention", name: "说明书编号" });
  const description = patent.books.find((book) => book.kind === "description")!.document;
  const template = description.content.find((block) => block.type === "paragraph")!;
  description.content = [
    "技术领域",
    "支架用于相关技术。",
    "具体实施方式",
    text,
    "附图说明",
    "支架为示意结构。",
  ].map((text, index) => ({
    ...structuredClone(template),
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    content: [{ type: "text" as const, text, marks: [] }],
  }));
  const claims = patent.books.find((book) => book.kind === "claims")!.document;
  claims.content = [];
  return patent;
}
const assign = (patent: CanonicalPatent, number?: number, index = 3, keyword = "支架") =>
  planAssignDescriptionReferenceNumber(patent, keyword, index, deps, number);
function after(result: ReturnType<typeof assign>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.plan;
}
const descriptionText = (patent: CanonicalPatent) =>
  documentText(patent.books.find((book) => book.kind === "description")!.document);

test("numbers only the embodiment and records a description-owned transaction", () => {
  const patent = fixture();
  const before = structuredClone(patent);
  const plan = after(assign(patent));
  expect(descriptionText(plan.after)).toBe(
    "技术领域\n支架用于相关技术。\n具体实施方式\n支架1设置在底座上，支架1用于支撑。\n附图说明\n支架为示意结构。",
  );
  expect(plan.after.referenceMarks).toEqual([
    { referenceMarkId: deps.createId(), keyword: "支架", number: 1 },
  ]);
  expect(plan.affectedBookKinds).toEqual(["description"]);
  expect(plan.historyBookKind).toBe("description");
  expect(plan.after.books.filter((book) => book.kind !== "description")).toEqual(
    before.books.filter((book) => book.kind !== "description"),
  );
  expect(patent).toEqual(before);
});
test.each([1, 2, 4, 5, -1, 99])("rejects selections outside embodiment body: %s", (index) => {
  expect(assign(fixture(), undefined, index).ok).toBe(false);
});
test.each(["missing", "duplicate"])("rejects an unclear embodiment boundary: %s", (kind) => {
  const patent = fixture();
  const doc = patent.books.find((book) => book.kind === "description")!.document;
  if (kind === "missing") doc.content.splice(2, 1);
  else
    doc.content.push({
      ...structuredClone(doc.content[2]!),
      id: "00000000-0000-4000-8000-000000000098",
    });
  expect(assign(patent).ok).toBe(false);
});
test("reuses handwritten numbers and normalizes parenthesized forms without touching other chapters", () => {
  const plan = after(assign(fixture("支架7、支架（７）、支架(7)和支架。")));
  expect(descriptionText(plan.after)).toContain("支架7、支架7、支架7和支架7。");
  expect(plan.after.referenceMarks[0]?.number).toBe(7);
});
test("reuses the registered number without duplicating it and is idempotent", () => {
  const first = after(assign(fixture(), 12));
  const second = after(assign(first.after));
  expect(second.after).toEqual(first.after);
  expect(second.recordHistory).toBe(false);
  expect(second.after.referenceMarks).toHaveLength(1);
});
test("protects quantities and already registered longer keywords", () => {
  const patent = fixture("支架10mm、支架2个、复合支架以及支架。");
  patent.referenceMarks.push({
    referenceMarkId: "00000000-0000-4000-8000-000000000088",
    keyword: "复合支架",
    number: 8,
  });
  const plan = after(assign(patent, 3));
  expect(descriptionText(plan.after)).toContain("支架10mm、支架2个、复合支架以及支架3。");
});
test("does not register a keyword when every occurrence is a quantity", () => {
  expect(assign(fixture("支架10mm及支架2个。")).ok).toBe(false);
});
test("skips occupied handwritten numbers for sequential numbering and rejects custom collisions", () => {
  const patent = fixture("底座1与支架。");
  expect(after(assign(patent)).after.referenceMarks[0]?.number).toBe(2);
  expect(assign(patent, 1).ok).toBe(false);
});
test("does not override an occupied registration", () => {
  const patent = fixture();
  patent.referenceMarks.push({
    referenceMarkId: "00000000-0000-4000-8000-000000000088",
    keyword: "底座",
    number: 3,
  });
  expect(assign(patent, 3).ok).toBe(false);
});
test("rejects inconsistent body numbers instead of partially changing text", () => {
  const patent = fixture("支架2和支架3以及支架。");
  const before = structuredClone(patent);
  expect(assign(patent).ok).toBe(false);
  expect(patent).toEqual(before);
});
test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid custom number: %s",
  (number) => {
    expect(assign(fixture(), number).ok).toBe(false);
  },
);
test("retains text formatting and paragraph geometry", () => {
  const patent = fixture();
  const block = patent.books.find((book) => book.kind === "description")!.document.content[3]!;
  if (block.type !== "paragraph") throw new Error("fixture");
  block.content = [{ type: "text", text: "支架。", marks: [{ type: "bold" }] }];
  const plan = after(assign(patent));
  const next = plan.after.books.find((book) => book.kind === "description")!.document.content[3]!;
  expect(next.type === "paragraph" && next.attrs).toEqual(block.attrs);
  expect(
    next.type === "paragraph" &&
      next.content.some(
        (node) => node.type === "text" && node.marks.some((mark) => mark.type === "bold"),
      ),
  ).toBe(true);
});
test("does not number when drawing books have been removed", () => {
  const patent = fixture();
  patent.drawingBooksEnabled = false;
  expect(assign(patent).ok).toBe(false);
});

test("reuses a matching claims number without changing claims", () => {
  const patent = fixture();
  const claims = patent.books.find((book) => book.kind === "claims")!.document;
  const paragraph = structuredClone(
    patent.books.find((book) => book.kind === "description")!.document.content[3]!,
  );
  if (paragraph.type !== "paragraph") throw new Error("fixture");
  paragraph.content = [{ type: "text", text: "一种装置，包括支架(5)。", marks: [] }];
  claims.content = [paragraph];
  const before = structuredClone(claims);
  const plan = after(assign(patent));
  expect(plan.after.referenceMarks[0]?.number).toBe(5);
  expect(plan.after.books.find((book) => book.kind === "claims")!.document).toEqual(before);
  expect(
    assign({
      ...patent,
      referenceMarks: [{ referenceMarkId: deps.createId(), keyword: "支架", number: 3 }],
    }).ok,
  ).toBe(false);
});

test("stops if an existing shorter mark interrupts the selected compound name", () => {
  const patent = fixture("支架1主体与支架主体连接。");
  patent.referenceMarks = [
    { referenceMarkId: "00000000-0000-4000-8000-000000000088", keyword: "支架", number: 1 },
  ];
  expect(assign(patent, undefined, 3, "支架主体").ok).toBe(false);
});

test("numbers table cell text without changing table layout", () => {
  const patent = fixture();
  const description = patent.books.find((book) => book.kind === "description")!.document;
  const { table } = tableRegressionDocument();
  table.rows[0]!.cells[0]!.content[0]!.content = [{ type: "text", text: "支架", marks: [] }];
  description.content[3] = table;
  const plan = after(assign(patent));
  const changed = plan.after.books.find((book) => book.kind === "description")!.document
    .content[3]!;
  if (changed.type !== "table") throw new Error("fixture");
  expect(changed.columnWidthsMm).toEqual(table.columnWidthsMm);
  expect(
    changed.rows.map((row) =>
      row.cells.map((cell) => [
        cell.colSpan,
        cell.rowSpan,
        cell.horizontalAlignment,
        cell.verticalAlignment,
        cell.borderStyle,
      ]),
    ),
  ).toEqual(
    table.rows.map((row) =>
      row.cells.map((cell) => [
        cell.colSpan,
        cell.rowSpan,
        cell.horizontalAlignment,
        cell.verticalAlignment,
        cell.borderStyle,
      ]),
    ),
  );
  expect(descriptionText(plan.after)).toContain("支架1");
});

test("numbers list items without changing list numbering", () => {
  const patent = fixture();
  const description = patent.books.find((book) => book.kind === "description")!.document;
  const paragraph = description.content[3]!;
  if (paragraph.type !== "paragraph") throw new Error("fixture");
  description.content[3] = {
    id: "00000000-0000-4000-8000-000000000077",
    type: "ordered-list",
    start: 5,
    items: [{ id: "00000000-0000-4000-8000-000000000078", content: [paragraph] }],
  };
  const plan = after(assign(patent));
  expect(
    plan.after.books.find((book) => book.kind === "description")!.document.content[3],
  ).toMatchObject({ type: "ordered-list", start: 5 });
  expect(descriptionText(plan.after)).toContain("支架1设置");
});

test("claims subsequently reuse the description registration with their own parenthesized style", () => {
  const first = after(assign(fixture(), 7));
  const patent = structuredClone(first.after);
  const claims = patent.books.find((book) => book.kind === "claims")!.document;
  const paragraph = structuredClone(
    patent.books.find((book) => book.kind === "description")!.document.content[3]!,
  );
  if (paragraph.type !== "paragraph") throw new Error("fixture");
  paragraph.content = [{ type: "text", text: "支架。", marks: [] }];
  claims.content = [paragraph];
  const result = planAssignReferenceNumber(patent, "支架", deps);
  if (!result.ok) throw new Error(result.message);
  expect(
    documentText(result.plan.after.books.find((book) => book.kind === "claims")!.document),
  ).toBe("支架(7)。");
  expect(descriptionText(result.plan.after)).toBe(descriptionText(patent));
  expect(result.plan.after.referenceMarks).toHaveLength(1);
});

test("supplementing after explicit description numbering does not append the number twice", () => {
  const first = after(assign(fixture()));
  const result = planSupplementDescriptionReferenceNumbers(first.after);
  if (!result.ok) throw new Error(result.message);
  expect(result.plan.counts.description).toBe(0);
  expect(result.plan.after).toEqual(first.after);
});
