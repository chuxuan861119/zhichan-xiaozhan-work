import { describe, expect, expectTypeOf, test } from "vitest";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../document/defaults.js";
import type { BlockNode } from "../document/model.js";
import { createBlankPatent as createDefaultPatent } from "./defaults.js";
import { classifyDescriptionChapterBlock } from "./description.js";
import type { CanonicalPatent } from "./model.js";
import { drawingExplanationSegment } from "./reference-mark-legend.js";
import {
  inspectReferenceMarkDescriptionState,
  inspectReferenceMarkStatus,
  planAssignReferenceNumber,
  planCancelReferenceMark,
  planCompleteReferenceMarkReview,
  planFillReferenceMarksIntoDescription,
  planRemoveReferenceMarkRegistration,
  planSetReferenceMarkSync,
  planSupplementClaimsReferenceNumbers,
  planSupplementDescriptionReferenceNumbers,
  planUpdateReferenceMark,
  REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE,
  type ReferenceMarkFailureCode,
  reconcileReferenceMarksFromDescription,
  referenceMarkReviewOccurrenceCount,
} from "./reference-mark-operations.js";
import { referenceNumberColor } from "./reference-marks.js";

const crossDocumentEditingTest = REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE ? test : test.skip;

test.each(["新词", "传动杆"])("corrects a registration absent from claims to %s without inventing body numbers", (keyword) => {
  const patent = createBlankPatent({patentType:"invention", name:"传动杆连接支架"});
  const referenceMarkId = "00000000-0000-4000-8000-000000009900";
  patent.referenceMarks = [{referenceMarkId,number:10,keyword:"错词"}];
  const before = structuredClone(patent);
  const result = planUpdateReferenceMark(patent,{referenceMarkId,number:11,keyword});
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(result.plan.after.referenceMarks).toEqual([{referenceMarkId,number:11,keyword}]);
  expect(result.plan.after.books).toEqual(before.books);
  expect(result.plan.counts).toEqual({claims:0,description:0,abstract:0});
  expect(result.plan.affectedBookKinds).toEqual([]);
  expect(result.plan.recordHistory).toBe(true);
  expect(patent).toEqual(before);
});

test("correcting a claims-missing registration updates its existing description legend and body", () => {
  const patent = createBlankPatent({patentType:"invention",name:"传动机构"});
  const referenceMarkId = "00000000-0000-4000-8000-000000009900";
  patent.referenceMarks = [{referenceMarkId,number:10,keyword:"错词"}];
  setDescriptionBodyText(patent,"错词10连接支架");
  setLegendText(patent,"其中：10、错词。");
  const result = planUpdateReferenceMark(patent,{referenceMarkId,number:11,keyword:"传动杆"});
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(bookText(result.plan.after,"description")).toContain("传动杆11连接支架");
  expect(bookText(result.plan.after,"description")).toContain("11、传动杆");
  expect(result.plan.counts.claims).toBe(0);
});

function setClaimsText(patent: CanonicalPatent, text: string): void {
  const claims = patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("fixture");
  const paragraph = claims.document.content.find((block) => block.type === "paragraph");
  if (paragraph?.type !== "paragraph") throw new Error("fixture");
  paragraph.content = [{ type: "text", text, marks: [] }];
  claims.document.content = [paragraph];
}

function createBlankPatent(input: { patentType: "invention"; name: string }): CanonicalPatent {
  const patent = createDefaultPatent(input);
  setClaimsText(patent, input.name);
  return patent;
}

function setDescriptionBodyText(patent: CanonicalPatent, text: string): void {
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const embodimentsIndex = description.document.content.findIndex(
    (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
  );
  const paragraph = description.document.content
    .slice(embodimentsIndex + 1)
    .find((block) => block.type === "paragraph");
  if (paragraph?.type !== "paragraph") throw new Error("fixture");
  paragraph.content = [{ type: "text", text, marks: [] }];
}

function setAbstractText(patent: CanonicalPatent, text: string): void {
  const abstractBook = patent.books.find((book) => book.kind === "abstract");
  if (!abstractBook) throw new Error("fixture");
  const paragraph = abstractBook.document.content.find((block) => block.type === "paragraph");
  if (paragraph?.type !== "paragraph") throw new Error("fixture");
  paragraph.content = [{ type: "text", text, marks: [] }];
}

/** 在附图说明章节内写入图例段（文本模式：以“其中”开头；无标记）。 */
function setLegendText(patent: CanonicalPatent, text: string): void {
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const segment = drawingExplanationSegment(description.document);
  let legend: Extract<BlockNode, { type: "paragraph" }> | null = null;
  if (segment) {
    for (let index = segment.end - 1; index >= segment.start; index -= 1) {
      const block = description.document.content[index];
      if (
        block?.type === "paragraph" &&
        /^其中/u.test(
          block.content
            .map((node) => (node.type === "text" ? node.text : ""))
            .join("")
            .trim(),
        )
      ) {
        legend = block;
        break;
      }
    }
  }
  if (!legend) {
    legend = {
      id: "00000000-0000-4000-8000-000000009979",
      type: "paragraph",
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content: [],
    };
    if (segment) {
      description.document.content.splice(segment.end, 0, legend);
    } else {
      description.document.content.push(legend);
    }
  }
  legend.content = [{ type: "text", text, marks: [] }];
}

function claimsText(patent: CanonicalPatent): string {
  const claims = patent.books.find((book) => book.kind === "claims");
  if (!claims) throw new Error("fixture");
  return claims.document.content
    .filter((block) => block.type === "paragraph")
    .map((block) =>
      block.content.map((inline) => (inline.type === "text" ? inline.text : "")).join(""),
    )
    .join("");
}

function bookText(
  patent: CanonicalPatent,
  kind: Extract<CanonicalPatent["books"][number]["kind"], "description" | "abstract">,
): string {
  const book = patent.books.find((candidate) => candidate.kind === kind);
  if (!book) throw new Error("fixture");
  return book.document.content
    .map((block) =>
      block.type === "paragraph" || block.type === "heading"
        ? block.content.map((inline) => (inline.type === "text" ? inline.text : "")).join("")
        : "",
    )
    .join("\n");
}

describe("reference mark patent plans", () => {
  test("supplements registered claims keywords only, preserving other books and existing numbers", () => {
    const patent = createBlankPatent({
      patentType: "invention",
      name: "连接杆和杆，连接杆(2)，未登记词",
    });
    patent.referenceMarks = [
      { referenceMarkId: crypto.randomUUID(), keyword: "杆", number: 1 },
      { referenceMarkId: crypto.randomUUID(), keyword: "连接杆", number: 2 },
    ];
    const before = structuredClone(patent);
    const result = planSupplementClaimsReferenceNumbers(patent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toBe("连接杆(2)和杆(1)，连接杆(2)，未登记词");
    expect(result.plan.counts.claims).toBe(2);
    expect(result.plan.affectedBookKinds).toEqual(["claims"]);
    expect(result.plan.historyBookKind).toBe("claims");
    expect(result.plan.recordHistory).toBe(true);
    expect(JSON.stringify(result.plan.after.books)).toContain("reference-mark-token");
    expect(result.plan.after.referenceMarks).toEqual(patent.referenceMarks);
    expect(patent).toEqual(before);
    const repeat = planSupplementClaimsReferenceNumbers(result.plan.after);
    expect(repeat.ok && repeat.plan.recordHistory).toBe(false);
    expect(repeat.ok && repeat.plan.after).toEqual(result.plan.after);
    const single = planSupplementClaimsReferenceNumbers(
      patent,
      patent.referenceMarks[0]!.referenceMarkId,
    );
    expect(single.ok && claimsText(single.plan.after)).toBe("连接杆和杆(1)，连接杆(2)，未登记词");
  });

  test("claims supplement refuses conflicts atomically and rejects stale registrations", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "杆和箱体，箱体(9)" });
    patent.referenceMarks = [
      { referenceMarkId: crypto.randomUUID(), keyword: "杆", number: 1 },
      { referenceMarkId: crypto.randomUUID(), keyword: "箱体", number: 2 },
    ];
    const before = structuredClone(patent);
    expect(planSupplementClaimsReferenceNumbers(patent).ok).toBe(false);
    expect(patent).toEqual(before);
    expect(planSupplementClaimsReferenceNumbers(patent, crypto.randomUUID()).ok).toBe(false);
    patent.drawingBooksEnabled = false;
    expect(planSupplementClaimsReferenceNumbers(patent).ok).toBe(false);
  });
  test("supplements only missing embodiment numbers in purple and is idempotent", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "连接杆和杆" });
    patent.referenceMarks = [
      { referenceMarkId: crypto.randomUUID(), keyword: "杆", number: 1 },
      { referenceMarkId: crypto.randomUUID(), keyword: "连接杆", number: 2 },
    ];
    setDescriptionBodyText(patent, "连接杆与杆，连接杆2、杆（1）、杆９，新增连接杆。");
    const before = structuredClone(patent);
    const result = planSupplementDescriptionReferenceNumbers(patent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(bookText(result.plan.after, "description")).toContain(
      "连接杆2与杆1，连接杆2、杆（1）、杆９，新增连接杆2。",
    );
    expect(result.plan.counts.description).toBe(3);
    expect(result.plan.affectedBookKinds).toEqual(["description"]);
    expect(result.plan.historyBookKind).toBe("description");
    expect(result.plan.after.referenceMarks).toEqual(patent.referenceMarks);
    expect(patent).toEqual(before);
    expect(JSON.stringify(result.plan.after.books)).toContain("#7C3AED");
    const repeat = planSupplementDescriptionReferenceNumbers(result.plan.after);
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) throw new Error(repeat.message);
    expect(repeat.plan.counts.description).toBe(0);
    expect(repeat.plan.recordHistory).toBe(false);
    expect(repeat.plan.after).toEqual(result.plan.after);
  });

  test("does not guess a missing or duplicate embodiment chapter", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "杆" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), keyword: "杆", number: 1 }];
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const heading = description.document.content.find(
      (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
    );
    if (!heading) throw new Error("fixture");
    description.document.content.push({ ...structuredClone(heading), id: crypto.randomUUID() });
    expect(planSupplementDescriptionReferenceNumbers(patent).ok).toBe(false);
    description.document.content = description.document.content.filter(
      (block) => classifyDescriptionChapterBlock(block) !== "detailed-embodiments",
    );
    expect(planSupplementDescriptionReferenceNumbers(patent).ok).toBe(false);
  });

  test("preserves split formatting, quantities and other chapters", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), keyword: "箱体", number: 3 }];
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const heading = description.document.content.findIndex(
      (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
    );
    const body = description.document.content
      .slice(heading + 1)
      .find((block) => block.type === "paragraph");
    if (body?.type !== "paragraph") throw new Error("fixture");
    body.content = [
      { type: "text", text: "箱", marks: [{ type: "bold" }] },
      {
        type: "text",
        text: "体，箱体3米，箱体３，箱体(9)。",
        marks: [{ type: "color", value: "#FF0000" }],
      },
    ];
    const result = planSupplementDescriptionReferenceNumbers(patent);
    if (!result.ok) throw new Error(result.message);
    const after = result.plan.after.books.find((book) => book.kind === "description")?.document;
    expect(after?.content.slice(0, heading + 1)).toEqual(
      description.document.content.slice(0, heading + 1),
    );
    expect(result.plan.counts.description).toBe(1);
    const changed = after?.content.find((block) => block.id === body.id);
    if (changed?.type !== "paragraph") throw new Error("fixture");
    expect(changed.content[0]).toMatchObject({
      text: "箱",
      marks: expect.arrayContaining([{ type: "bold" }, { type: "color", value: "#7C3AED" }]),
    });
    expect(bookText(result.plan.after, "description")).toContain(
      "箱体3，箱体3米，箱体３，箱体(9)。",
    );
    const repeat = planSupplementDescriptionReferenceNumbers(result.plan.after);
    expect(repeat.ok && repeat.plan.counts.description).toBe(0);
  });

  test("supplements keywords inside embodiment table cells", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), keyword: "箱体", number: 4 }];
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    description.document.content.push({
      id: crypto.randomUUID(),
      type: "table",
      columnWidthsMm: [100],
      rows: [
        {
          id: crypto.randomUUID(),
          cells: [
            {
              id: crypto.randomUUID(),
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "left",
              verticalAlignment: "top",
              borderStyle: "single",
              content: [
                {
                  id: crypto.randomUUID(),
                  type: "paragraph",
                  attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
                  content: [{ type: "text", text: "箱体", marks: [] }],
                },
              ],
            },
          ],
        },
      ],
    });
    const result = planSupplementDescriptionReferenceNumbers(patent);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.counts.description).toBe(1);
    const table = result.plan.after.books
      .find((book) => book.kind === "description")
      ?.document.content.at(-1);
    if (table?.type !== "table") throw new Error("fixture");
    expect(table.rows[0]?.cells[0]?.content[0]?.content).toEqual([
      {
        type: "text",
        text: "箱体4",
        marks: [
          { type: "reference-mark-token", number: 4 },
          { type: "color", value: "#7C3AED" },
        ],
      },
    ]);
  });
  test("does not restore reference marks from the description while drawing books are disabled", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "无附图工艺" });
    patent.drawingBooksEnabled = false;
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    setLegendText(patent, "其中：1、旧部件。");

    const result = reconcileReferenceMarksFromDescription(patent, description.document);

    expect(result).toEqual({
      ok: false,
      code: "SYNC_PAUSED",
      message: "说明书附图已删除，无法进行编号或附图标记同步。",
    });
    expect(patent.referenceMarks).toEqual([]);
  });

  test("rejects assigning a reference number while drawing books are disabled", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "无附图工艺" });
    patent.drawingBooksEnabled = false;
    setClaimsText(patent, "反应器包括壳体。");

    expect(
      planAssignReferenceNumber(patent, "反应器", {
        now: () => new Date("2026-08-08T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009900",
      }),
    ).toEqual({
      ok: false,
      code: "SYNC_PAUSED",
      message: "说明书附图已删除，无法进行编号或附图标记同步。",
    });
  });

  test("inspects fallback chapter headings without mutating the live patent state", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "状态守卫" });
    const description = patent.books.find((book) => book.kind === "description");
    const drawings = description?.document.content.find(
      (block) => classifyDescriptionChapterBlock(block) === "drawing-explanation",
    );
    if (!drawings || (drawings.type !== "paragraph" && drawings.type !== "heading")) {
      throw new Error("fixture");
    }
    delete drawings.semanticRole;
    const before = structuredClone(patent);

    expect(inspectReferenceMarkStatus(patent).sync).toMatchObject({ status: "active" });
    expect(patent).toEqual(before);
  });

  test("keeps a fresh patent ready for its first reference number", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });

    expect(inspectReferenceMarkStatus(patent).sync).toEqual({
      status: "active",
      legendParagraphId: null,
    });
  });

  test("keeps cross-document editing disabled", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "停用同步" });
    const before = structuredClone(patent);

    const result = planSetReferenceMarkSync(patent, true);

    expect(result).toEqual({
      ok: false,
      code: "SYNC_PAUSED",
      message: "跨文档同步修改已暂时停用；仍可在权利要求书中进行附图标记编号。",
    });
    expect(patent).toEqual(before);
  });

  test.each(["claims", "description", "abstract"] as const)(
    "rejects a panel renumber to an unregistered occupied number in %s",
    (kind) => {
      const patent = createBlankPatent({ patentType: "invention", name: "正文重号" });
      const referenceMarkId = crypto.randomUUID();
      patent.referenceMarks = [{ referenceMarkId, number: 5, keyword: "箱体" }];
      setClaimsText(patent, kind === "claims" ? "箱体(5)和机架(8)" : "箱体(5)");
      if (kind === "description") setDescriptionBodyText(patent, "机架8");
      if (kind === "abstract") setAbstractText(patent, "机架8");
      const before = structuredClone(patent);
      expect(
        planUpdateReferenceMark(patent, { referenceMarkId, number: 8, keyword: "箱体" }),
      ).toMatchObject({ ok: false, code: "BODY_NUMBER_CONFLICT" });
      expect(patent).toEqual(before);
    },
  );

  test("rejects filling a malformed duplicate-number legend without appending a second legend", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "损坏图例" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 5, keyword: "箱体" }];
    setLegendText(patent, "其中：5、箱体；5、箱盖。");
    const before = structuredClone(patent);
    expect(inspectReferenceMarkDescriptionState(patent)).toMatchObject({ status: "invalid" });
    expect(inspectReferenceMarkStatus(patent).sync).toMatchObject({ status: "paused" });
    expect(planFillReferenceMarksIntoDescription(patent)).toMatchObject({ ok: false });
    expect(patent).toEqual(before);
  });

  test("updates panel edits in all text books even when legacy synchronization is disabled", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "仅权利要求书修改" });
    const referenceMarkId = "00000000-0000-4000-8000-000000009931";
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    patent.referenceMarkSettings.synchronizedEditingEnabled = false;
    setClaimsText(patent, "箱体(1)");
    setDescriptionBodyText(patent, "箱体1保持不变");
    setAbstractText(patent, "箱体保持不变");
    setLegendText(patent, "其中：1、箱体。");
    const before = structuredClone(patent);

    const result = planUpdateReferenceMark(patent, {
      referenceMarkId,
      number: 2,
      keyword: "壳体",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toBe("壳体(2)");
    expect(bookText(result.plan.after, "description")).toContain("壳体2保持不变");
    expect(bookText(result.plan.after, "description")).toContain("其中：2、壳体。");
    expect(bookText(result.plan.after, "abstract")).toContain("壳体保持不变");
    expect(patent).toEqual(before);
    expect(result.plan.affectedBookKinds).toEqual(["claims", "description", "abstract"]);
    expect(result.plan.after.referenceMarkSettings).toEqual({
      synchronizedEditingEnabled: false,
    });
    expect(result.plan.counts).toEqual({ claims: 2, description: 3, abstract: 1 });
  });

  test.each([
    [8, "箱体", "箱体和箱体8"],
    [5, "外壳", "外壳和外壳5"],
  ] as const)(
    "propagates an edit to %s / %s without adding numbers to bare keywords",
    (number, keyword, expected) => {
      const patent = createBlankPatent({ patentType: "invention", name: "单字段修改" });
      const referenceMarkId = crypto.randomUUID();
      patent.referenceMarks = [{ referenceMarkId, number: 5, keyword: "箱体" }];
      setClaimsText(patent, "箱体(5)");
      setDescriptionBodyText(patent, "箱体和箱体5");
      setAbstractText(patent, "箱体和箱体5");
      const result = planUpdateReferenceMark(patent, { referenceMarkId, number, keyword });
      if (!result.ok) throw new Error(result.message);
      expect(bookText(result.plan.after, "description")).toContain(expected);
      expect(bookText(result.plan.after, "abstract")).toContain(expected);
    },
  );

  test("does not rename a newly updated legend twice when the new keyword contains the old keyword", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "图例替换" });
    const referenceMarkId = crypto.randomUUID();
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    setClaimsText(patent, "箱体(1)");
    setLegendText(patent, "其中：1、箱体。");
    const result = planUpdateReferenceMark(patent, {
      referenceMarkId,
      number: 2,
      keyword: "新箱体",
    });
    if (!result.ok) throw new Error(result.message);
    expect(bookText(result.plan.after, "description")).toContain("其中：2、新箱体。");
    expect(bookText(result.plan.after, "description")).not.toContain("新新箱体");
  });

  test.each(["description", "abstract"] as const)(
    "synchronizes bare and numbered keywords throughout %s without changing quantities or longer registered words",
    (kind) => {
      const patent = createBlankPatent({ patentType: "invention", name: "同步边界" });
      const referenceMarkId = crypto.randomUUID();
      patent.referenceMarks = [
        { referenceMarkId, number: 5, keyword: "防护壳" },
        { referenceMarkId: crypto.randomUUID(), number: 6, keyword: "防护壳盖" },
      ];
      setClaimsText(patent, "防护壳(5)和防护壳盖(6)");
      const book = patent.books.find((item) => item.kind === kind);
      if (!book) throw new Error("fixture");
      // No embodiment heading: all text sections must be covered.
      book.document.content = [
        {
          id: crypto.randomUUID(),
          type: "paragraph",
          attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
          content: [
            {
              type: "text",
              marks: [],
              text: "防护壳、防护壳5、防护壳（5）、防护壳 ( ５ )、防护壳5mm、防护壳5个、防护壳50、防护壳5.5、防护壳5至10、防护壳盖6",
            },
          ],
        },
      ];
      const result = planUpdateReferenceMark(patent, {
        referenceMarkId,
        number: 8,
        keyword: "外壳",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(bookText(result.plan.after, kind)).toBe(
        "外壳、外壳8、外壳（8）、外壳 ( ８ )、外壳5mm、外壳5个、外壳50、外壳5.5、外壳5至10、防护壳盖6",
      );
    },
  );

  test("cancels a reference mark only in claims without rewriting the manual description legend", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "仅权利要求书取消" });
    const referenceMarkId = "00000000-0000-4000-8000-000000009932";
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    setClaimsText(patent, "箱体(1)");
    setDescriptionBodyText(patent, "箱体1保持不变");
    setLegendText(patent, "其中：1、箱体。");
    const descriptionBefore = structuredClone(
      patent.books.find((book) => book.kind === "description")?.document,
    );

    const result = planCancelReferenceMark(patent, referenceMarkId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toBe("箱体");
    expect(result.plan.after.referenceMarks).toEqual([]);
    expect(result.plan.after.books.find((book) => book.kind === "description")?.document).toEqual(
      descriptionBefore,
    );
    expect(result.plan.after.referenceMarkSettings).toEqual({
      synchronizedEditingEnabled: false,
    });
    expect(result.plan.counts).toEqual({ claims: 1, description: 0, abstract: 0 });
  });

  test("fills an existing untagged legend candidate from structured marks", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    const embodimentsIndex = description.document.content.findIndex(
      (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
    );
    description.document.content.splice(embodimentsIndex, 0, {
      id: "00000000-0000-4000-8000-000000009902",
      type: "paragraph",
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content: [{ type: "text", text: "其中：2、箱盖。", marks: [] }],
    });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009903", number: 3, keyword: "箱体" },
    ];

    const result = planFillReferenceMarksIntoDescription(patent);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const descriptionAfter = result.plan.after.books.find((book) => book.kind === "description");
    if (!descriptionAfter) throw new Error("fixture");
    const legends = descriptionAfter.document.content.filter(
      (block) =>
        block.type === "paragraph" &&
        /^其中/u.test(
          block.content
            .map((node) => (node.type === "text" ? node.text : ""))
            .join("")
            .trim(),
        ),
    );
    expect(legends).toHaveLength(1);
    expect(legends[0]?.id).toBe("00000000-0000-4000-8000-000000009902");
    const legend = legends[0];
    if (legend?.type !== "paragraph") throw new Error("fixture");
    expect(legend.content.map((node) => (node.type === "text" ? node.text : "")).join("")).toBe(
      "其中：3、箱体。",
    );
  });

  test("treats the system drawing legend placeholder as an empty reusable candidate", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    setLegendText(patent, "其中，______。");

    expect(inspectReferenceMarkStatus(patent).sync).toMatchObject({ status: "active" });
  });

  test("assigns a claim number without reading or changing an invalid description", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    const description = patent.books.find((book) => book.kind === "description");
    const drawingsHeading = description?.document.content.find(
      (block) => classifyDescriptionChapterBlock(block) === "drawing-explanation",
    );
    if (
      !description ||
      !drawingsHeading ||
      (drawingsHeading.type !== "heading" && drawingsHeading.type !== "paragraph")
    ) {
      throw new Error("fixture");
    }
    delete drawingsHeading.semanticRole;
    drawingsHeading.content = [{ type: "text", text: "已损坏的章节标题", marks: [] }];
    const descriptionBefore = structuredClone(description.document);

    const result = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-08-09T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009901",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.affectedBookKinds).toEqual(["claims"]);
    expect(result.plan.after.books.find((book) => book.kind === "description")?.document).toEqual(
      descriptionBefore,
    );
  });

  test("explains a missing drawing-description section only when filling the description", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    const description = patent.books.find((book) => book.kind === "description");
    const drawingsHeading = description?.document.content.find(
      (block) => classifyDescriptionChapterBlock(block) === "drawing-explanation",
    );
    if (
      !drawingsHeading ||
      (drawingsHeading.type !== "heading" && drawingsHeading.type !== "paragraph")
    ) {
      throw new Error("fixture");
    }
    delete drawingsHeading.semanticRole;
    drawingsHeading.content = [{ type: "text", text: "已删除的章节", marks: [] }];
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009910", number: 1, keyword: "箱体" },
    ];

    expect(planFillReferenceMarksIntoDescription(patent)).toEqual({
      ok: false,
      code: "MISSING_DESCRIPTION_HEADING",
      message: "找不到说明书中的“附图说明”部分。请先在说明书中添加“附图说明”标题，然后重试。",
    });
  });

  test("assigns max plus one and updates claims as one immutable plan", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    const result = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009999",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.after.referenceMarks).toEqual([
      expect.objectContaining({ number: 1, keyword: "箱体" }),
    ]);
    expect(JSON.stringify(result.plan.after.books[0]?.document)).toContain("箱体(1)");
    expect(JSON.stringify(result.plan.after.books[1]?.document)).not.toContain("其中：1、箱体。");
    expect(patent.referenceMarks).toEqual([]);
  });

  test("marks an entry missing from either claims or description", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "状态测试" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009998", number: 1, keyword: "不存在" },
    ];
    expect(inspectReferenceMarkStatus(patent).missingReferenceMarkIds).toEqual(
      new Set(["00000000-0000-4000-8000-000000009998"]),
    );
  });

  test("fills a valid directly edited description legend without changing structured state", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "图例测试" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009997", number: 1, keyword: "图例测试" },
    ];
    setLegendText(patent, "其中：3、回收箱。");
    const result = planFillReferenceMarksIntoDescription(patent);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.after.referenceMarks).toEqual(patent.referenceMarks);
  });

  crossDocumentEditingTest(
    "orders legend entries by claim appearance after editing and reconciling",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "排序测试" });
      setClaimsText(patent, "箱体和箱盖");
      const first = planAssignReferenceNumber(patent, "箱体", {
        now: () => new Date("2026-08-08T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009904",
      });
      if (!first.ok) throw new Error(first.message);
      const second = planAssignReferenceNumber(first.plan.after, "箱盖", {
        now: () => new Date("2026-08-08T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009905",
      });
      if (!second.ok) throw new Error(second.message);
      const box = second.plan.after.referenceMarks.find((entry) => entry.keyword === "箱体");
      if (!box) throw new Error("fixture");

      const updated = planUpdateReferenceMark(second.plan.after, {
        referenceMarkId: box.referenceMarkId,
        number: 3,
        keyword: "箱体",
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) throw new Error(updated.message);
      expect(updated.plan.after.referenceMarks.map((entry) => entry.number)).toEqual([2, 3]);
      // 图例条目按关键词在权利要求书中的出现先后排列（“箱体”先于“箱盖”）。
      expect(JSON.stringify(updated.plan.after.books[1]?.document)).toContain(
        "其中：3、箱体；2、箱盖。",
      );

      const completed = planCompleteReferenceMarkReview(updated.plan.after, box.referenceMarkId);
      expect(completed.ok).toBe(true);
      if (!completed.ok) throw new Error(completed.message);
      const description = structuredClone(completed.plan.after.books[1]?.document);
      if (!description) throw new Error("fixture");
      const legend = description.content.find(
        (block) =>
          block.type === "paragraph" &&
          /^其中/u.test(
            block.content
              .map((node) => (node.type === "text" ? node.text : ""))
              .join("")
              .trim(),
          ),
      );
      if (legend?.type !== "paragraph") throw new Error("fixture");
      legend.content = [{ type: "text", text: "其中：5、箱体；2、箱盖。", marks: [] }];
      const reconciled = reconcileReferenceMarksFromDescription(completed.plan.after, description);
      expect(reconciled.ok).toBe(true);
      if (!reconciled.ok) throw new Error(reconciled.message);
      expect(reconciled.plan.after.referenceMarks.map((entry) => entry.number)).toEqual([2, 5]);
    },
  );

  crossDocumentEditingTest(
    "renames and renumbers embodiment references while updating a mark",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
      const assigned = planAssignReferenceNumber(patent, "箱体", {
        now: () => new Date("2026-08-07T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009996",
      });
      if (!assigned.ok) throw new Error(assigned.message);
      const description = assigned.plan.after.books.find((book) => book.kind === "description");
      const embodimentsIndex =
        description?.document.content.findIndex(
          (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
        ) ?? -1;
      const embodiment = description?.document.content
        .slice(embodimentsIndex + 1)
        .find((block) => block.type === "paragraph");
      if (embodiment?.type !== "paragraph") throw new Error("fixture");
      embodiment.content = [{ type: "text", text: "箱体1", marks: [] }];
      const embodimentId = embodiment.id;

      const result = planUpdateReferenceMark(assigned.plan.after, {
        referenceMarkId: "00000000-0000-4000-8000-000000009996",
        number: 2,
        keyword: "壳体",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      const updatedEmbodiment = result.plan.after.books[1]?.document.content.find(
        (block) => block.type === "paragraph" && block.id === embodimentId,
      );
      if (updatedEmbodiment?.type !== "paragraph") throw new Error("fixture");
      expect(
        updatedEmbodiment.content.map((node) => (node.type === "text" ? node.text : "")).join(""),
      ).toBe("壳体2");
      expect(JSON.stringify(result.plan.after.books[1]?.document)).not.toContain("箱体1");
    },
  );

  crossDocumentEditingTest(
    "renumbers only references inside the description embodiments section",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
      const assigned = planAssignReferenceNumber(patent, "箱体", {
        now: () => new Date("2026-08-08T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009906",
      });
      if (!assigned.ok) throw new Error(assigned.message);
      const description = assigned.plan.after.books.find((book) => book.kind === "description");
      if (!description) throw new Error("fixture");
      const background = description.document.content.find(
        (block) =>
          block.type === "paragraph" &&
          description.document.content.indexOf(block) <
            description.document.content.findIndex(
              (item) => classifyDescriptionChapterBlock(item) === "detailed-embodiments",
            ),
      );
      const embodimentsIndex = description.document.content.findIndex(
        (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
      );
      const embodiment = description.document.content
        .slice(embodimentsIndex + 1)
        .find((block) => block.type === "paragraph");
      if (background?.type !== "paragraph" || embodiment?.type !== "paragraph") {
        throw new Error("fixture");
      }
      background.content = [{ type: "text", text: "背景中的箱体1保持不变", marks: [] }];
      embodiment.content = [{ type: "text", text: "实施方式中的箱体1需要修改", marks: [] }];
      const backgroundId = background.id;
      const embodimentId = embodiment.id;
      const entry = assigned.plan.after.referenceMarks[0];
      if (!entry) throw new Error("fixture");

      const result = planUpdateReferenceMark(assigned.plan.after, {
        referenceMarkId: entry.referenceMarkId,
        number: 2,
        keyword: "箱体",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      const resultDescription = result.plan.after.books[1]?.document;
      const backgroundAfter = resultDescription?.content.find((block) => block.id === backgroundId);
      const embodimentAfter = resultDescription?.content.find((block) => block.id === embodimentId);
      if (backgroundAfter?.type !== "paragraph" || embodimentAfter?.type !== "paragraph") {
        throw new Error("fixture");
      }
      expect(backgroundAfter.content).toEqual([
        { type: "text", text: "背景中的箱体1保持不变", marks: [] },
      ]);
      expect(
        embodimentAfter.content.map((node) => (node.type === "text" ? node.text : "")).join(""),
      ).toBe("实施方式中的箱体2需要修改");
    },
  );

  crossDocumentEditingTest(
    "cancels numbers only inside the description embodiments section",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
      const assigned = planAssignReferenceNumber(patent, "箱体", {
        now: () => new Date("2026-08-08T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009907",
      });
      if (!assigned.ok) throw new Error(assigned.message);
      const description = assigned.plan.after.books.find((book) => book.kind === "description");
      if (!description) throw new Error("fixture");
      const embodimentsIndex = description.document.content.findIndex(
        (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
      );
      const background = description.document.content
        .slice(0, embodimentsIndex)
        .find((block) => block.type === "paragraph");
      const embodiment = description.document.content
        .slice(embodimentsIndex + 1)
        .find((block) => block.type === "paragraph");
      if (background?.type !== "paragraph" || embodiment?.type !== "paragraph") {
        throw new Error("fixture");
      }
      background.content = [{ type: "text", text: "背景中的箱体1保持不变", marks: [] }];
      embodiment.content = [{ type: "text", text: "实施方式中的箱体1取消编号", marks: [] }];
      const backgroundId = background.id;
      const embodimentId = embodiment.id;
      const entry = assigned.plan.after.referenceMarks[0];
      if (!entry) throw new Error("fixture");

      const result = planCancelReferenceMark(assigned.plan.after, entry.referenceMarkId);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      const resultDescription = result.plan.after.books[1]?.document;
      const backgroundAfter = resultDescription?.content.find((block) => block.id === backgroundId);
      const embodimentAfter = resultDescription?.content.find((block) => block.id === embodimentId);
      if (backgroundAfter?.type !== "paragraph" || embodimentAfter?.type !== "paragraph") {
        throw new Error("fixture");
      }
      expect(backgroundAfter.content).toEqual([
        { type: "text", text: "背景中的箱体1保持不变", marks: [] },
      ]);
      expect(
        embodimentAfter.content.map((node) => (node.type === "text" ? node.text : "")).join(""),
      ).toBe("实施方式中的箱体取消编号");
    },
  );

  crossDocumentEditingTest("removes embodiment numbers when cancelling a mark", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    const assigned = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009995",
    });
    if (!assigned.ok) throw new Error(assigned.message);
    const description = assigned.plan.after.books.find((book) => book.kind === "description");
    const embodimentsIndex =
      description?.document.content.findIndex(
        (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
      ) ?? -1;
    const embodiment = description?.document.content
      .slice(embodimentsIndex + 1)
      .find((block) => block.type === "paragraph");
    if (embodiment?.type !== "paragraph") throw new Error("fixture");
    embodiment.content = [{ type: "text", text: "箱体1", marks: [] }];

    const result = planCancelReferenceMark(
      assigned.plan.after,
      "00000000-0000-4000-8000-000000009995",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(JSON.stringify(result.plan.after.books[1]?.document)).toContain('"text":"箱体"');
    expect(JSON.stringify(result.plan.after.books[1]?.document)).not.toContain("箱体1");
  });

  test("reuses the registered number for the same keyword", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009994", number: 2, keyword: "箱体" },
    ];
    setClaimsText(patent, "一种箱体结构。");

    const result = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009993",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.after.referenceMarks).toEqual([
      { referenceMarkId: "00000000-0000-4000-8000-000000009994", number: 2, keyword: "箱体" },
    ]);
    expect(claimsText(result.plan.after)).toContain("箱体(2)");
  });

  test("adopts and registers a single handwritten old number without double brackets", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    setClaimsText(patent, "箱体（3）和箱体");

    const result = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009992",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.after.referenceMarks).toEqual([
      expect.objectContaining({ number: 3, keyword: "箱体" }),
    ]);
    expect(claimsText(result.plan.after)).toBe("箱体(3)和箱体(3)");
    expect(JSON.stringify(result.plan.after.books[0]?.document)).not.toContain("(3)(3)");
  });

  test("returns AMBIGUOUS_EXISTING_NUMBER and leaves the patent unchanged for multiple old numbers", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    setClaimsText(patent, "箱体（3）和箱体（5）");
    const before = JSON.stringify(patent);

    const result = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009991",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("fixture");
    expect(result.code).toBe("AMBIGUOUS_EXISTING_NUMBER");
    expect(JSON.stringify(patent)).toBe(before);
  });

  test("assigns an unused requested positive integer instead of the next sequential number", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "自定义序号" });
    setClaimsText(patent, "装置包括箱体。");

    const result = planAssignReferenceNumber(
      patent,
      "箱体",
      {
        now: () => new Date("2026-08-09T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009987",
      },
      12,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.after.referenceMarks).toEqual([
      expect.objectContaining({ number: 12, keyword: "箱体" }),
    ]);
    expect(claimsText(result.plan.after)).toContain("箱体(12)");
  });

  test.each([
    ["uses the most recently created mark instead of the largest custom number", [7, 701, 8], 9],
    ["continues after a large most recently created mark", [7, 8, 701], 702],
  ] as const)("%s", (_, existingNumbers, expectedNumber) => {
    const patent = createBlankPatent({ patentType: "invention", name: "顺序编号基准" });
    patent.referenceMarks = existingNumbers.map((number, index) => ({
      referenceMarkId: `00000000-0000-4000-8000-${String(9700 + index).padStart(12, "0")}`,
      number,
      keyword: `已有部件${index + 1}`,
    }));
    setClaimsText(patent, "装置包括封闭板。");

    const result = planAssignReferenceNumber(patent, "封闭板", {
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009799",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.after.referenceMarks.at(-1)?.number).toBe(expectedNumber);
    expect(claimsText(result.plan.after)).toContain(`封闭板(${expectedNumber})`);
  });

  test.each([
    ["顺序编号", undefined, 1],
    ["自定义编号", 7, 7],
  ] as const)(
    "%s detects an unregistered body use of the proposed number",
    (_, requestedNumber, number) => {
      const patent = createBlankPatent({ patentType: "invention", name: "正文序号冲突" });
      setClaimsText(patent, `底座(${number})与把手`);
      const before = structuredClone(patent);

      const result = planAssignReferenceNumber(
        patent,
        "把手",
        {
          now: () => new Date("2026-09-02T00:00:00.000Z"),
          createId: () => "00000000-0000-4000-8000-000000009984",
        },
        requestedNumber,
      );

      expect(result).toMatchObject({
        ok: false,
        code: "BODY_NUMBER_CONFLICT",
        bodyNumberConflict: {
          keyword: "把手",
          number,
          matchCount: 1,
        },
      });
      expect(patent).toEqual(before);
    },
  );

  test("continues numbering only after the user accepts an unregistered body-number conflict", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "确认正文序号冲突" });
    setClaimsText(patent, "底座(1)与把手");

    const result = planAssignReferenceNumber(
      patent,
      "把手",
      {
        now: () => new Date("2026-09-02T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009983",
      },
      undefined,
      { bodyNumberConflictDecision: "use-anyway" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toContain("底座(1)与把手(1)");
  });

  test.each([undefined, 8] as const)(
    "protects a registered longer keyword while assigning an overlapping shorter keyword with requested number %s",
    (requestedNumber) => {
      const patent = createBlankPatent({ patentType: "invention", name: "交叠关键词" });
      patent.referenceMarks = [
        {
          referenceMarkId: "00000000-0000-4000-8000-000000009981",
          number: 1,
          keyword: "自行车把手",
        },
      ];
      setClaimsText(patent, "自行车把手(1)与自行车");

      const result = planAssignReferenceNumber(
        patent,
        "自行车",
        {
          now: () => new Date("2026-09-01T00:00:00.000Z"),
          createId: () => "00000000-0000-4000-8000-000000009982",
        },
        requestedNumber,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      const expectedNumber = requestedNumber ?? 2;
      expect(claimsText(result.plan.after)).toBe(`自行车把手(1)与自行车(${expectedNumber})`);
      expect(claimsText(result.plan.after)).not.toContain(`自行车(${expectedNumber})把手`);
    },
  );

  test.each([undefined, 8] as const)(
    "rejects cross-boundary numbering without changing existing keywords (%s)",
    (requestedNumber) => {
      for (const keyword of ["所述电池包", "所述的电池包", "所述的电池包主"]) {
        const patent = createBlankPatent({ patentType: "invention", name: "边界保护" });
        patent.referenceMarks = [
          {
            referenceMarkId: "00000000-0000-4000-8000-000000009981",
            number: 1,
            keyword: "电池包主体",
          },
        ];
        setClaimsText(patent, "所述电池包主体(1)与所述的电池包主体（1）");
        const before = structuredClone(patent);
        const result = planAssignReferenceNumber(
          patent,
          keyword,
          {
            now: () => new Date("2026-09-04T00:00:00.000Z"),
            createId: () => "00000000-0000-4000-8000-000000009982",
          },
          requestedNumber,
        );
        expect(result, keyword).toMatchObject({ ok: false, code: "INVALID_SELECTION" });
        expect(patent).toEqual(before);
      }
    },
  );

  test.each([undefined, 8] as const)(
    "numbers only independent matches and keeps cross-boundary rich text intact (%s)",
    (requestedNumber) => {
      const patent = createBlankPatent({ patentType: "invention", name: "边界保护" });
      patent.referenceMarks = [
        {
          referenceMarkId: "00000000-0000-4000-8000-000000009981",
          number: 1,
          keyword: "电池包主体",
        },
      ];
      setClaimsText(patent, "");
      const paragraph = patent.books.find((book) => book.kind === "claims")?.document.content[0];
      if (paragraph?.type !== "paragraph") throw new Error("fixture");
      paragraph.content = [
        { type: "text", text: "所述", marks: [] },
        { type: "text", text: "电池", marks: [{ type: "bold" }] },
        { type: "text", text: "包主体(1)", marks: [{ type: "reference-mark-token", number: 1 }] },
        { type: "text", text: "与所述电池包", marks: [] },
      ];
      const protectedContent = structuredClone(paragraph.content.slice(0, 3));
      const result = planAssignReferenceNumber(
        patent,
        "所述电池包",
        {
          now: () => new Date("2026-09-04T00:00:00.000Z"),
          createId: () => "00000000-0000-4000-8000-000000009982",
        },
        requestedNumber,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(claimsText(result.plan.after)).toBe(
        `所述电池包主体(1)与所述电池包(${requestedNumber ?? 2})`,
      );
      const afterParagraph = result.plan.after.books.find((book) => book.kind === "claims")
        ?.document.content[0];
      if (afterParagraph?.type !== "paragraph") throw new Error("fixture");
      expect(afterParagraph.content.slice(0, 3)).toEqual(protectedContent);
      const status = inspectReferenceMarkStatus(result.plan.after).entries.find(
        (entry) => entry.referenceMarkId === "00000000-0000-4000-8000-000000009982",
      );
      expect(status).toMatchObject({
        unnumberedInClaims: false,
        numberMismatch: false,
        locatableIssueCount: 0,
      });
    },
  );

  test("requires a decision before numbering a long keyword that existing numbers have interrupted", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "打断关键词" });
    patent.referenceMarks = [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009983",
        number: 1,
        keyword: "自行车",
      },
    ];
    setClaimsText(patent, "自行车(1)把手与后来加入的自行车把手");
    const before = structuredClone(patent);

    const result = planAssignReferenceNumber(patent, "自行车把手", {
      now: () => new Date("2026-09-01T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009984",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected confirmation");
    expect(result.code).toBe("INTERRUPTED_KEYWORD_MATCHES");
    if (result.code !== "INTERRUPTED_KEYWORD_MATCHES") throw new Error(result.message);
    expect(result.interruptedKeywordRepair).toEqual({
      keyword: "自行车把手",
      number: 2,
      matchCount: 1,
      examples: ["自行车(1)把手"],
      contexts: ["自行车(1)把手与后来加入的自行车把手"],
    });
    expect(patent).toEqual(before);
  });

  test.each([
    ["keep", "自行车(1)把手与后来加入的自行车把手(2)"],
    ["repair", "自行车把手(2)与后来加入的自行车把手(2)"],
  ] as const)("applies the explicit interrupted-keyword decision %s", (decision, expected) => {
    const patent = createBlankPatent({ patentType: "invention", name: "打断关键词" });
    patent.referenceMarks = [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009985",
        number: 1,
        keyword: "自行车",
      },
    ];
    setClaimsText(patent, "自行车(1)把手与后来加入的自行车把手");

    const result = planAssignReferenceNumber(
      patent,
      "自行车把手",
      {
        now: () => new Date("2026-09-01T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009986",
      },
      undefined,
      { interruptedKeywordDecision: decision },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toBe(expected);
  });

  test("uses the requested custom number when repairing interrupted long keywords", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "自定义打断关键词" });
    patent.referenceMarks = [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009987",
        number: 1,
        keyword: "自行车",
      },
    ];
    setClaimsText(patent, "自行车（1）把手与自行车把手");

    const pending = planAssignReferenceNumber(
      patent,
      "自行车把手",
      {
        now: () => new Date("2026-09-01T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009988",
      },
      9,
    );
    expect(pending.ok).toBe(false);
    if (pending.ok || pending.code !== "INTERRUPTED_KEYWORD_MATCHES") {
      throw new Error("expected interrupted keyword confirmation");
    }
    expect(pending.interruptedKeywordRepair.number).toBe(9);

    const repaired = planAssignReferenceNumber(
      patent,
      "自行车把手",
      {
        now: () => new Date("2026-09-01T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009988",
      },
      9,
      { interruptedKeywordDecision: "repair" },
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error(repaired.message);
    expect(claimsText(repaired.plan.after)).toBe("自行车把手(9)与自行车把手(9)");
  });

  test("repairs a long keyword interrupted by multiple registered shorter keywords", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "多重打断关键词" });
    patent.referenceMarks = [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009989",
        number: 1,
        keyword: "自行车",
      },
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009990",
        number: 2,
        keyword: "把手",
      },
    ];
    setClaimsText(patent, "自行车(1)把手(2)组件与后来加入的自行车把手组件");

    const pending = planAssignReferenceNumber(patent, "自行车把手组件", {
      now: () => new Date("2026-09-01T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009991",
    });
    expect(pending.ok).toBe(false);
    if (pending.ok || pending.code !== "INTERRUPTED_KEYWORD_MATCHES") {
      throw new Error("expected interrupted keyword confirmation");
    }
    expect(pending.interruptedKeywordRepair.examples).toEqual(["自行车(1)把手(2)组件"]);

    const repaired = planAssignReferenceNumber(
      patent,
      "自行车把手组件",
      {
        now: () => new Date("2026-09-01T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009991",
      },
      undefined,
      { interruptedKeywordDecision: "repair" },
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error(repaired.message);
    expect(claimsText(repaired.plan.after)).toBe("自行车把手组件(3)与后来加入的自行车把手组件(3)");
  });

  test("does not treat an interrupted occurrence inside another registered longer keyword as repairable", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "嵌套保护关键词" });
    patent.referenceMarks = [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009992",
        number: 1,
        keyword: "自行车",
      },
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009993",
        number: 4,
        keyword: "自行车把手组件",
      },
    ];
    setClaimsText(patent, "自行车(1)把手组件(4)与自行车把手");

    const result = planAssignReferenceNumber(patent, "自行车把手", {
      now: () => new Date("2026-09-01T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009994",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toBe("自行车(1)把手组件(4)与自行车把手(5)");
  });

  test("rejects invalid or duplicate requested numbers without changing the patent", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "非法自定义序号" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009986", number: 7, keyword: "箱盖" },
    ];
    setClaimsText(patent, "装置包括箱体。");
    const before = JSON.stringify(patent);
    const dependencies = {
      now: () => new Date("2026-08-09T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009985",
    };

    for (const number of [0, -2, 1.5, 7]) {
      const result = planAssignReferenceNumber(patent, "箱体", dependencies, number);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(patent)).toBe(before);
    }
  });

  test("stops when a registered number conflicts with a handwritten body number", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "箱体" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009990", number: 5, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱体（3）");
    const before = JSON.stringify(patent);

    const result = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009989",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("fixture");
    expect(result.code).toBe("AMBIGUOUS_EXISTING_NUMBER");
    expect(JSON.stringify(patent)).toBe(before);
    expect(JSON.stringify(patent.books[0]?.document)).toContain("箱体（3）");
  });

  test("returns a failure result for invalid reference numbers without changing the patent", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "非法序号" });
    const assigned = planAssignReferenceNumber(patent, "非法序号", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009988",
    });
    if (!assigned.ok) throw new Error(assigned.message);
    const id = assigned.plan.after.referenceMarks[0]?.referenceMarkId;
    if (!id) throw new Error("fixture");
    for (const number of [0, -2, 1.5]) {
      const before = JSON.stringify(assigned.plan.after);
      const result = planUpdateReferenceMark(assigned.plan.after, {
        referenceMarkId: id,
        number,
        keyword: "非法序号",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("fixture");
      expect(result.code).toBe("INVALID_REFERENCE_MARK");
      expect(JSON.stringify(assigned.plan.after)).toBe(before);
    }
  });

  test("returns a failure result when cancelling an unknown mark", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "未知标记" });
    const before = JSON.stringify(patent);
    const result = planCancelReferenceMark(patent, "00000000-0000-4000-8000-000000000000");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("fixture");
    expect(result.code).toBe("INVALID_REFERENCE_MARK");
    expect(JSON.stringify(patent)).toBe(before);
  });

  crossDocumentEditingTest(
    "rewrites the legend preserving unchanged fragments and highlighting only changed ones",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "图例标红" });
      setClaimsText(patent, "箱体与箱盖结构。");
      const first = planAssignReferenceNumber(patent, "箱体", {
        now: () => new Date("2026-08-07T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009986",
      });
      if (!first.ok) throw new Error(first.message);
      const second = planAssignReferenceNumber(first.plan.after, "箱盖", {
        now: () => new Date("2026-08-07T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009985",
      });
      if (!second.ok) throw new Error(second.message);
      setLegendText(second.plan.after, "其中：1、箱体；2、箱盖。");
      const description = second.plan.after.books.find((book) => book.kind === "description");
      const legend = description?.document.content.find(
        (block) =>
          block.type === "paragraph" &&
          /^其中/u.test(
            block.content
              .map((node) => (node.type === "text" ? node.text : ""))
              .join("")
              .trim(),
          ),
      );
      if (!description || legend?.type !== "paragraph") throw new Error("fixture");
      legend.content = [
        { type: "text", text: "其中：", marks: [] },
        { type: "text", text: "1、箱体", marks: [{ type: "bold" }] },
        { type: "text", text: "；2、箱盖。", marks: [{ type: "color", value: "#123456" }] },
      ];
      const boxEntry = second.plan.after.referenceMarks.find((entry) => entry.keyword === "箱体");
      if (!boxEntry) throw new Error("fixture");

      const result = planUpdateReferenceMark(second.plan.after, {
        referenceMarkId: boxEntry.referenceMarkId,
        number: 1,
        keyword: "回收箱",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      const afterLegend = result.plan.after.books[1]?.document.content.find(
        (block) =>
          block.type === "paragraph" &&
          /^其中/u.test(
            block.content
              .map((node) => (node.type === "text" ? node.text : ""))
              .join("")
              .trim(),
          ),
      );
      if (afterLegend?.type !== "paragraph") throw new Error("fixture");
      const text = afterLegend.content
        .map((node) => (node.type === "text" ? node.text : ""))
        .join("");
      expect(text).toBe("其中：1、回收箱；2、箱盖。");
      const changedNode = afterLegend.content.find(
        (node) => node.type === "text" && node.text.includes("1、回收箱"),
      );
      const unchangedNode = afterLegend.content.find(
        (node) => node.type === "text" && node.text.includes("2、箱盖"),
      );
      if (changedNode?.type !== "text" || unchangedNode?.type !== "text")
        throw new Error("fixture");
      expect(changedNode.marks).toContainEqual({ type: "color", value: "#D92D20" });
      expect(changedNode.marks).not.toContainEqual({ type: "color", value: "#123456" });
      expect(unchangedNode.marks).toContainEqual({ type: "color", value: "#123456" });
      expect(unchangedNode.marks).not.toContainEqual({ type: "color", value: "#D92D20" });
    },
  );

  crossDocumentEditingTest("reports real per-book replacement counts when renaming", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "夹具专利" });
    setClaimsText(patent, "箱体");
    const assigned = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009984",
    });
    if (!assigned.ok) throw new Error(assigned.message);
    const entry = assigned.plan.after.referenceMarks[0];
    if (!entry) throw new Error("fixture");
    setDescriptionBodyText(assigned.plan.after, "箱体1");
    setAbstractText(assigned.plan.after, "箱体");

    const result = planUpdateReferenceMark(assigned.plan.after, {
      referenceMarkId: entry.referenceMarkId,
      number: 1,
      keyword: "回收箱",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.counts).toEqual({ claims: 2, description: 2, abstract: 1 });
  });

  crossDocumentEditingTest(
    "creates one persisted review task after an atomic full-document edit",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "夹具专利" });
      setClaimsText(patent, "箱体和箱体");
      const assigned = planAssignReferenceNumber(patent, "箱体", {
        now: () => new Date("2026-09-01T00:00:00.000Z"),
        createId: () => "00000000-0000-4000-8000-000000009980",
      });
      if (!assigned.ok) throw new Error(assigned.message);
      const entry = assigned.plan.after.referenceMarks[0];
      if (!entry) throw new Error("fixture");
      setDescriptionBodyText(assigned.plan.after, "箱体1与备用箱体");
      setAbstractText(assigned.plan.after, "箱体");

      const result = planUpdateReferenceMark(
        assigned.plan.after,
        { referenceMarkId: entry.referenceMarkId, number: 2, keyword: "新箱体" },
        {
          now: () => new Date("2026-09-01T01:02:03.000Z"),
          ownerBookKind: "description",
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.plan.after.referenceMarkSettings.pendingReview).toEqual({
        referenceMarkId: entry.referenceMarkId,
        ownerBookKind: "description",
        previousNumber: 1,
        previousKeyword: "箱体",
        number: 2,
        keyword: "新箱体",
        counts: { claims: 2, description: 2, abstract: 1 },
        descriptionNumberedCount: 1,
        createdAt: "2026-09-01T01:02:03.000Z",
      });
      expect(result.plan.recordHistory).toBe(true);
      // “箱体”是“新箱体”的子串；不能用修改后的旧词残留扫描误报失败。
      expect(claimsText(result.plan.after)).toBe("新箱体(2)和新箱体(2)");
    },
  );

  test("rejects an empty keyword or a no-op edit without creating review state", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "输入门禁" });
    patent.referenceMarks = [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009975",
        number: 1,
        keyword: "箱体",
      },
    ];
    const before = structuredClone(patent);

    const empty = planUpdateReferenceMark(patent, {
      referenceMarkId: patent.referenceMarks[0]?.referenceMarkId ?? "",
      number: 1,
      keyword: "   ",
    });
    const unchanged = planUpdateReferenceMark(patent, {
      referenceMarkId: patent.referenceMarks[0]?.referenceMarkId ?? "",
      number: 1,
      keyword: "箱体",
    });

    expect(empty).toMatchObject({ ok: false, message: "关键词不能为空。" });
    expect(unchanged).toMatchObject({ ok: false, message: "序号和关键词没有变化。" });
    expect(patent).toEqual(before);
  });

  test("blocks renaming a registered mark to a keyword that already exists in claims", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "目标关键词已存在" });
    const referenceMarkId = "00000000-0000-4000-8000-000000009976";
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    setClaimsText(patent, "箱体(1)与外壳");
    const before = structuredClone(patent);

    const result = planUpdateReferenceMark(patent, {
      referenceMarkId,
      number: 1,
      keyword: "外壳",
    });

    expect(result).toMatchObject({ ok: false, code: "TARGET_KEYWORD_ALREADY_EXISTS" });
    if (result.ok) throw new Error("expected an existing-target-keyword failure");
    expect(result.message).toContain("权利要求书中已经存在");
    expect(result.message).toContain("先取消当前编号");
    expect(patent).toEqual(before);
  });

  test.each([
    ["箱体。", "关键词不能包含句读标点"],
    ["箱体(2)", "请只输入不含编号的关键词"],
    [`${"箱".repeat(101)}`, "关键词不能超过 100 个字符"],
  ])("rejects an unsafe edited keyword %s", (keyword, message) => {
    const patent = createBlankPatent({ patentType: "invention", name: "编辑输入门禁" });
    setClaimsText(patent, "箱体(1)");
    patent.referenceMarks = [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009974",
        number: 1,
        keyword: "箱体",
      },
    ];
    const before = structuredClone(patent);

    const result = planUpdateReferenceMark(patent, {
      referenceMarkId: patent.referenceMarks[0]?.referenceMarkId ?? "",
      number: 1,
      keyword,
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("expected rejection");
    expect(result.message).toContain(message);
    expect(patent).toEqual(before);
  });

  test("clears a legacy review instead of blocking claims-only editing", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "单任务门禁" });
    patent.referenceMarks = [
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009979",
        number: 1,
        keyword: "箱体",
      },
    ];
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    patent.referenceMarkSettings.pendingReview = {
      referenceMarkId: "00000000-0000-4000-8000-000000009979",
      ownerBookKind: "claims",
      previousNumber: 1,
      previousKeyword: "旧箱体",
      number: 1,
      keyword: "箱体",
      counts: { claims: 1, description: 0, abstract: 0 },
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    setClaimsText(patent, "箱体(1)");
    const before = structuredClone(patent);
    const descriptionBefore = structuredClone(
      patent.books.find((book) => book.kind === "description")?.document,
    );

    const update = planUpdateReferenceMark(patent, {
      referenceMarkId: patent.referenceMarks[0]?.referenceMarkId ?? "",
      number: 2,
      keyword: "新箱体",
    });
    expect(update.ok).toBe(true);
    if (!update.ok) throw new Error(update.message);
    expect(update.plan.after.referenceMarkSettings).toEqual({
      synchronizedEditingEnabled: false,
    });
    expect(update.plan.after.books.find((book) => book.kind === "description")?.document).toEqual(
      descriptionBefore,
    );
    expect(patent).toEqual(before);
  });

  test("completes review without changing documents or recording another undo step", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "完成核对" });
    const referenceMarkId = "00000000-0000-4000-8000-000000009978";
    patent.referenceMarks = [{ referenceMarkId, number: 2, keyword: "新箱体" }];
    setClaimsText(patent, "新箱体(2)");
    setDescriptionBodyText(patent, "新箱体");
    setAbstractText(patent, "新箱体");
    setLegendText(patent, "其中：2、新箱体。");
    patent.referenceMarkSettings.pendingReview = {
      referenceMarkId,
      ownerBookKind: "claims",
      previousNumber: 1,
      previousKeyword: "箱体",
      number: 2,
      keyword: "新箱体",
      counts: { claims: 1, description: 1, abstract: 1 },
      descriptionNumberedCount: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    const documentsBefore = patent.books.map((book) => structuredClone(book.document));

    const result = planCompleteReferenceMarkReview(patent, referenceMarkId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.after.referenceMarkSettings.pendingReview).toBeUndefined();
    expect(result.plan.after.books.map((book) => book.document)).toEqual(documentsBefore);
    expect(result.plan.recordHistory).toBe(false);
  });

  crossDocumentEditingTest("reports real per-book replacement counts when cancelling", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "夹具专利" });
    setClaimsText(patent, "箱体");
    const assigned = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009983",
    });
    if (!assigned.ok) throw new Error(assigned.message);
    const entry = assigned.plan.after.referenceMarks[0];
    if (!entry) throw new Error("fixture");
    setDescriptionBodyText(assigned.plan.after, "箱体1");

    const result = planCancelReferenceMark(assigned.plan.after, entry.referenceMarkId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.counts).toEqual({ claims: 1, description: 1, abstract: 0 });
  });

  crossDocumentEditingTest(
    "allows full-document editing before reference marks are manually filled into the description",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "手动填入解耦" });
      patent.referenceMarks = [
        { referenceMarkId: "00000000-0000-4000-8000-000000009983", number: 1, keyword: "箱体" },
      ];
      setClaimsText(patent, "箱体(1)");

      expect(inspectReferenceMarkDescriptionState(patent).status).toBe("different");
      const result = planSetReferenceMarkSync(patent, true);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.plan.after.referenceMarkSettings.synchronizedEditingEnabled).toBe(true);
    },
  );

  test("reports zero counts when clearing a legacy sync setting", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "夹具专利" });
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    const result = planSetReferenceMarkSync(patent, false);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.counts).toEqual({ claims: 0, description: 0, abstract: 0 });
    expect(result.plan.after.referenceMarkSettings.synchronizedEditingEnabled).toBe(false);
  });

  test("normalizes already numbered occurrences when reusing a registered number", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "夹具专利" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009982", number: 2, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱体（2）和箱体");
    const result = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009981",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    // 1 处补齐 + 2 处已是同编号位置规范化
    expect(result.plan.counts.claims).toBe(3);
    expect(claimsText(result.plan.after)).toBe("箱体(2)和箱体(2)");
    const claims = result.plan.after.books.find((book) => book.kind === "claims");
    if (!claims) throw new Error("fixture");
    const nodes = claims.document.content.flatMap((block) =>
      block.type === "paragraph" ? block.content : [],
    );
    const numbered = nodes.filter((node) => node.type === "text" && node.text.includes("(2)"));
    expect(numbered.length).toBeGreaterThan(0);
    for (const node of numbered) {
      if (node.type !== "text") continue;
      expect(node.marks).toContainEqual({ type: "reference-mark-token", number: 2 });
      expect(node.marks).not.toContainEqual({
        type: "background-color",
        value: referenceNumberColor(2),
      });
    }
  });

  test("does not swap ids when swapped numbers and keywords coexist", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "夹具专利" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009980", number: 1, keyword: "箱体" },
      { referenceMarkId: "00000000-0000-4000-8000-000000009979", number: 2, keyword: "箱盖" },
    ];
    setLegendText(patent, "其中：1、箱盖；2、箱体。");
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");

    const result = reconcileReferenceMarksFromDescription(patent, description.document);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const ids = result.plan.after.referenceMarks.map((entry) => entry.referenceMarkId);
    expect(ids[0]).not.toBe("00000000-0000-4000-8000-000000009980");
    expect(ids[0]).not.toBe("00000000-0000-4000-8000-000000009979");
    expect(ids[1]).not.toBe("00000000-0000-4000-8000-000000009980");
    expect(ids[1]).not.toBe("00000000-0000-4000-8000-000000009979");
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("reports per-book missing status and number mismatch", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "夹具专利" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009978", number: 5, keyword: "箱体" },
      { referenceMarkId: "00000000-0000-4000-8000-000000009977", number: 2, keyword: "箱盖" },
    ];
    setClaimsText(patent, "箱体（3）");
    setDescriptionBodyText(patent, "箱体与箱盖");
    setLegendText(patent, "其中：5、箱体；2、箱盖。");

    const status = inspectReferenceMarkStatus(patent);
    const byId = new Map(status.entries.map((entry) => [entry.referenceMarkId, entry]));
    expect(byId.get("00000000-0000-4000-8000-000000009978")).toMatchObject({
      missingInClaims: false,
      missingInDescription: false,
      numberMismatch: true,
    });
    expect(byId.get("00000000-0000-4000-8000-000000009977")).toMatchObject({
      missingInClaims: true,
      missingInDescription: false,
      numberMismatch: false,
    });
    expect(status.missingReferenceMarkIds).toEqual(
      new Set(["00000000-0000-4000-8000-000000009977"]),
    );
  });

  test("does not let a longer registered keyword satisfy a shorter description keyword", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "嵌套关键词状态" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009955", number: 1, keyword: "自行车" },
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009956",
        number: 2,
        keyword: "自行车把手",
      },
    ];
    setClaimsText(patent, "自行车(1)和自行车把手(2)");
    setDescriptionBodyText(patent, "自行车把手");
    setLegendText(patent, "其中：1、自行车；2、自行车把手。");

    const status = inspectReferenceMarkStatus(patent);
    const byId = new Map(status.entries.map((entry) => [entry.referenceMarkId, entry]));

    expect(byId.get("00000000-0000-4000-8000-000000009955")?.missingInDescription).toBe(true);
    expect(byId.get("00000000-0000-4000-8000-000000009956")?.missingInDescription).toBe(false);
  });

  test("counts only reviewable occurrences outside longer keywords and the description legend", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "核对位置" });
    const shortId = "00000000-0000-4000-8000-000000009953";
    patent.referenceMarks = [
      { referenceMarkId: shortId, number: 1, keyword: "自行车" },
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009954",
        number: 2,
        keyword: "自行车把手",
      },
    ];
    setClaimsText(patent, "自行车(1)和自行车把手(2)");
    setDescriptionBodyText(patent, "自行车与自行车把手");
    setLegendText(patent, "其中：1、自行车；2、自行车把手。");
    patent.referenceMarkSettings.pendingReview = {
      referenceMarkId: shortId,
      ownerBookKind: "claims",
      previousNumber: 1,
      previousKeyword: "自行车",
      number: 1,
      keyword: "自行车",
      counts: { claims: 1, description: 1, abstract: 0 },
      createdAt: "2026-09-02T00:00:00.000Z",
    };

    const review = patent.referenceMarkSettings.pendingReview;
    expect(referenceMarkReviewOccurrenceCount(patent, "claims", review)).toBe(1);
    expect(referenceMarkReviewOccurrenceCount(patent, "description", review)).toBe(1);
  });

  test("does not flag a number mismatch when the body has no numbered occurrence", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "夹具专利" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009976", number: 5, keyword: "箱体" },
    ];
    setClaimsText(patent, "一种箱体结构。");
    setLegendText(patent, "其中：5、箱体。");

    const status = inspectReferenceMarkStatus(patent);
    expect(status.entries[0]).toMatchObject({
      missingInClaims: false,
      numberMismatch: false,
      unnumberedInClaims: true,
      unnumberedClaimsCount: 1,
    });
  });

  test("reports a partially unnumbered registered keyword", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "部分漏号" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009975", number: 5, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱体(5)与箱体连接。另一个箱体(5)保持不变。");

    const status = inspectReferenceMarkStatus(patent);

    expect(status.entries[0]).toMatchObject({
      missingInClaims: false,
      numberMismatch: false,
      unnumberedInClaims: true,
      unnumberedClaimsCount: 1,
    });
  });

  test("recognizes spaced and full-width handwritten numbers as mismatches", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "宽松识别" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009974", number: 5, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱体 （ ３ ）");

    const status = inspectReferenceMarkStatus(patent);

    expect(status.entries[0]).toMatchObject({
      missingInClaims: false,
      numberMismatch: true,
      nonstandardClaimsCount: 1,
    });
  });

  test("warns when a registered number is detached from its registered keyword", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "孤立编号" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009967", number: 1, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱体(1)与壳体(1)连接。");
    const claims = patent.books.find((book) => book.kind === "claims");
    const paragraph = claims?.document.content.find((block) => block.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [
      { type: "text", text: "箱体(1)与", marks: [] },
      {
        type: "text",
        text: "壳体(1)",
        marks: [{ type: "background-color", value: referenceNumberColor(1) }],
      },
      { type: "text", text: "连接。", marks: [] },
    ];

    const status = inspectReferenceMarkStatus(patent);

    expect(status.entries[0]).toMatchObject({
      missingInClaims: false,
      numberMismatch: false,
      orphanClaimsNumberCount: 1,
    });
  });

  test("does not attach a number from the next paragraph to the previous keyword", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "跨段编号" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009960", number: 1, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱体\n(1)");

    const status = inspectReferenceMarkStatus(patent);

    expect(status.entries[0]).toMatchObject({
      unnumberedClaimsCount: 1,
      orphanClaimsNumberCount: 0,
    });
  });

  test("does not treat an ordinary technical parameter as an orphan reference mark", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "普通技术参数" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009959", number: 1, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱体(1)的第一角度参数为(1)。");

    const status = inspectReferenceMarkStatus(patent);

    expect(status.entries[0]?.orphanClaimsNumberCount).toBe(0);
  });

  test("clearly reports when an existing handwritten number is adopted", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "沿用旧编号" });
    setClaimsText(patent, "箱体(7)");

    const result = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009966",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.message).toContain("检测到正文已有编号 7");
    expect(result.plan.message).toContain("已沿用");
  });

  test("does not silently register a nonstandard handwritten number", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "非标准旧编号" });
    setClaimsText(patent, "箱体 （ ３ ）");

    const result = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009961",
    });

    expect(result).toMatchObject({ ok: false, code: "AMBIGUOUS_EXISTING_NUMBER" });
    if (result.ok) throw new Error("expected a nonstandard-number failure");
    expect(result.message).toContain("编号格式不规范");
    expect(patent.referenceMarks).toHaveLength(0);
  });

  test("does not update the component number when no old body number can be replaced", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "零命中更新" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009973", number: 1, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱体(3)");
    const before = structuredClone(patent);

    const result = planUpdateReferenceMark(patent, {
      referenceMarkId: patent.referenceMarks[0]?.referenceMarkId ?? "",
      number: 2,
      keyword: "箱体",
    });

    expect(result).toMatchObject({ ok: false, code: "REFERENCE_MARK_REPLACEMENT_MISMATCH" });
    expect(patent).toEqual(before);
  });

  test("can remove a broken registration without changing manually edited body text", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "解除异常登记" });
    const referenceMarkId = "00000000-0000-4000-8000-000000009952";
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    setClaimsText(patent, "箱体(9)与手工改名的外壳(1)");
    setLegendText(patent, "其中：1、箱体。");
    const bodyBefore = claimsText(patent);

    const result = planRemoveReferenceMarkRegistration(patent, referenceMarkId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.after.referenceMarks).toEqual([]);
    expect(claimsText(result.plan.after)).toBe(bodyBefore);
    expect(result.plan.recordHistory).toBe(true);
  });

  test("does not update a component while detached registered numbers remain", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "局部手改" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009964", number: 1, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱体(1)与壳体(1)连接。");
    const claims = patent.books.find((book) => book.kind === "claims");
    const paragraph = claims?.document.content.find((block) => block.type === "paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    paragraph.content = [
      { type: "text", text: "箱体(1)与", marks: [] },
      {
        type: "text",
        text: "壳体(1)",
        marks: [{ type: "background-color", value: referenceNumberColor(1) }],
      },
      { type: "text", text: "连接。", marks: [] },
    ];
    const before = structuredClone(patent);

    const result = planUpdateReferenceMark(patent, {
      referenceMarkId: patent.referenceMarks[0]?.referenceMarkId ?? "",
      number: 2,
      keyword: "容器",
    });

    expect(result).toMatchObject({ ok: false, code: "REFERENCE_MARK_REPLACEMENT_MISMATCH" });
    expect(patent).toEqual(before);
  });

  test("does not delete a component when its registered body number is no longer present", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "零命中删除" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009972", number: 1, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱体(3)");
    const before = structuredClone(patent);

    const result = planCancelReferenceMark(patent, patent.referenceMarks[0]?.referenceMarkId ?? "");

    expect(result).toMatchObject({ ok: false, code: "REFERENCE_MARK_REPLACEMENT_MISMATCH" });
    expect(patent).toEqual(before);
  });

  test("allows cancellation when some keyword occurrences are already unnumbered", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "部分无编号取消" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009962", number: 1, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱体(1)与箱体连接。");

    const result = planCancelReferenceMark(patent, patent.referenceMarks[0]?.referenceMarkId ?? "");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toBe("箱体与箱体连接。");
    expect(result.plan.after.referenceMarks).toHaveLength(0);
  });

  test("protects another registered longer keyword during a full-document rename", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "改名保护" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009971", number: 1, keyword: "自行车" },
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009970",
        number: 2,
        keyword: "自行车把手",
      },
    ];
    setClaimsText(patent, "自行车(1)与自行车把手(2)");

    const result = planUpdateReferenceMark(patent, {
      referenceMarkId: "00000000-0000-4000-8000-000000009971",
      number: 1,
      keyword: "车辆",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toBe("车辆(1)与自行车把手(2)");
    expect(result.plan.after.referenceMarks).toContainEqual({
      referenceMarkId: "00000000-0000-4000-8000-000000009970",
      number: 2,
      keyword: "自行车把手",
    });
  });

  test("protects an interrupted longer keyword while renumbering a short keyword", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "改号保护" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009957", number: 1, keyword: "自行车" },
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009956",
        number: 2,
        keyword: "自行车把手",
      },
    ];
    setClaimsText(patent, "自行车(1)与自行车(1)把手及自行车把手(2)");

    const result = planUpdateReferenceMark(patent, {
      referenceMarkId: "00000000-0000-4000-8000-000000009957",
      number: 3,
      keyword: "自行车",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toBe("自行车(3)与自行车(1)把手及自行车把手(2)");
  });

  test("protects an interrupted longer keyword while cancelling a short keyword", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "取消保护" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009955", number: 1, keyword: "自行车" },
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009954",
        number: 2,
        keyword: "自行车把手",
      },
    ];
    setClaimsText(patent, "自行车(1)与自行车(1)把手及自行车把手(2)");

    const result = planCancelReferenceMark(patent, "00000000-0000-4000-8000-000000009955");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toBe("自行车与自行车(1)把手及自行车把手(2)");
  });

  test("allows removing a stale short-keyword registration when only a protected longer term remains", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "清理旧登记" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009953", number: 1, keyword: "自行车" },
      {
        referenceMarkId: "00000000-0000-4000-8000-000000009952",
        number: 2,
        keyword: "自行车把手",
      },
    ];
    setClaimsText(patent, "自行车把手(2)");

    const result = planCancelReferenceMark(patent, "00000000-0000-4000-8000-000000009953");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toBe("自行车把手(2)");
    expect(result.plan.after.referenceMarks).toEqual([
      expect.objectContaining({ number: 2, keyword: "自行车把手" }),
    ]);
  });

  crossDocumentEditingTest(
    "protects an interrupted longer keyword in the description during a short-keyword rename",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "说明书改名保护" });
      patent.referenceMarks = [
        { referenceMarkId: "00000000-0000-4000-8000-000000009941", number: 1, keyword: "自行车" },
        {
          referenceMarkId: "00000000-0000-4000-8000-000000009942",
          number: 2,
          keyword: "自行车把手",
        },
      ];
      setClaimsText(patent, "自行车(1)与自行车把手(2)");
      setDescriptionBodyText(patent, "自行车1与自行车1把手2及自行车把手2。 ");

      const result = planUpdateReferenceMark(patent, {
        referenceMarkId: "00000000-0000-4000-8000-000000009941",
        number: 1,
        keyword: "车辆",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(bookText(result.plan.after, "description")).toContain(
        "车辆1与自行车1把手2及自行车把手2。",
      );
    },
  );

  crossDocumentEditingTest(
    "protects an interrupted longer keyword in the abstract during a short-keyword rename",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "摘要改名保护" });
      patent.referenceMarks = [
        { referenceMarkId: "00000000-0000-4000-8000-000000009943", number: 1, keyword: "自行车" },
        {
          referenceMarkId: "00000000-0000-4000-8000-000000009944",
          number: 2,
          keyword: "自行车把手",
        },
      ];
      setClaimsText(patent, "自行车(1)与自行车把手(2)");
      setAbstractText(patent, "自行车与自行车1把手及自行车把手。");

      const result = planUpdateReferenceMark(patent, {
        referenceMarkId: "00000000-0000-4000-8000-000000009943",
        number: 1,
        keyword: "车辆",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(bookText(result.plan.after, "abstract")).toContain("车辆与自行车1把手及自行车把手。");
    },
  );

  crossDocumentEditingTest(
    "protects an interrupted longer keyword in the description during renumbering",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "说明书改号保护" });
      patent.referenceMarks = [
        { referenceMarkId: "00000000-0000-4000-8000-000000009945", number: 1, keyword: "自行车" },
        {
          referenceMarkId: "00000000-0000-4000-8000-000000009946",
          number: 2,
          keyword: "自行车把手",
        },
      ];
      setClaimsText(patent, "自行车(1)与自行车把手(2)");
      setDescriptionBodyText(patent, "自行车1与自行车1把手2。 ");

      const result = planUpdateReferenceMark(patent, {
        referenceMarkId: "00000000-0000-4000-8000-000000009945",
        number: 3,
        keyword: "自行车",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(bookText(result.plan.after, "description")).toContain("自行车3与自行车1把手2。");
    },
  );

  crossDocumentEditingTest(
    "protects an interrupted longer keyword in the description while cancelling a short keyword",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "说明书取消保护" });
      patent.referenceMarks = [
        { referenceMarkId: "00000000-0000-4000-8000-000000009947", number: 1, keyword: "自行车" },
        {
          referenceMarkId: "00000000-0000-4000-8000-000000009948",
          number: 2,
          keyword: "自行车把手",
        },
      ];
      setClaimsText(patent, "自行车(1)与自行车把手(2)");
      setDescriptionBodyText(patent, "自行车1与自行车1把手2。 ");

      const result = planCancelReferenceMark(patent, "00000000-0000-4000-8000-000000009947");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(bookText(result.plan.after, "description")).toContain("自行车与自行车1把手2。");
    },
  );

  test("reports the owner when a handwritten number is already registered to another keyword", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "手写编号冲突" });
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009949", number: 1, keyword: "箱体" },
    ];
    setClaimsText(patent, "箱盖(1)");

    const result = planAssignReferenceNumber(patent, "箱盖", {
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009950",
    });

    expect(result).toMatchObject({ ok: false, code: "DUPLICATE_REFERENCE_MARK" });
    if (result.ok) throw new Error("expected a duplicate-number failure");
    expect(result.message).toContain("序号 1 已被“箱体”使用");
    expect(patent.referenceMarks).toHaveLength(1);
  });

  test("rejects a manually edited legend keyword longer than the editor limit", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "超长图例" });
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("fixture");
    setLegendText(patent, `其中：1、${"箱".repeat(101)}。`);

    const result = reconcileReferenceMarksFromDescription(patent, description.document);

    expect(result).toMatchObject({ ok: false, code: "INVALID_REFERENCE_MARK" });
    if (result.ok) throw new Error("expected an overlong-keyword failure");
    expect(result.message).toContain("关键词不能超过 100 个字符");
    expect(patent.referenceMarks).toHaveLength(0);
  });

  crossDocumentEditingTest(
    "removes the empty drawing legend after cancelling the final reference mark",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "取消最后标记" });
      patent.referenceMarks = [
        { referenceMarkId: "00000000-0000-4000-8000-000000009939", number: 1, keyword: "箱体" },
      ];
      setClaimsText(patent, "箱体(1)");
      setLegendText(patent, "其中：1、箱体。");

      const result = planCancelReferenceMark(patent, "00000000-0000-4000-8000-000000009939");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(inspectReferenceMarkDescriptionState(result.plan.after)).toEqual({
        status: "empty",
        currentText: "",
        targetText: "",
      });
      expect(bookText(result.plan.after, "description")).not.toContain("其中：。");
    },
  );

  test("ignores unrelated parenthesized technical values when choosing the next number", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "普通括号数字" });
    setClaimsText(patent, "角度为(20)度，装置包括箱体。");

    const result = planAssignReferenceNumber(patent, "箱体", {
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009969",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.after.referenceMarks[0]?.number).toBe(1);
    expect(claimsText(result.plan.after)).toContain("箱体(1)");
  });

  test.each([
    ["箱体。", "关键词不能包含句读标点"],
    ["箱体，箱盖", "关键词不能包含句读标点"],
    ["箱体(1)", "请只选择不含编号的关键词"],
    ["箱体（ １ ）连接件", "请只选择不含编号的关键词"],
    [`${"箱".repeat(101)}`, "关键词不能超过 100 个字符"],
  ])("rejects unsafe numbering selection %s", (selection, expectedMessage) => {
    const patent = createBlankPatent({ patentType: "invention", name: "选区校验" });
    setClaimsText(patent, selection);

    const result = planAssignReferenceNumber(patent, selection, {
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000009963",
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_SELECTION" });
    if (result.ok) throw new Error("expected an invalid selection failure");
    expect(result.message).toContain(expectedMessage);
  });

  test("revalidates the document before completing a review", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "完成前复核" });
    const referenceMarkId = "00000000-0000-4000-8000-000000009968";
    patent.referenceMarks = [{ referenceMarkId, number: 2, keyword: "箱体" }];
    setClaimsText(patent, "箱体(3)");
    patent.referenceMarkSettings.pendingReview = {
      referenceMarkId,
      ownerBookKind: "claims",
      previousNumber: 1,
      previousKeyword: "箱体",
      number: 2,
      keyword: "箱体",
      counts: { claims: 1, description: 0, abstract: 0 },
      createdAt: "2026-09-02T00:00:00.000Z",
    };

    const result = planCompleteReferenceMarkReview(patent, referenceMarkId);

    expect(result).toMatchObject({ ok: false, code: "REFERENCE_MARK_REPLACEMENT_MISMATCH" });
  });

  crossDocumentEditingTest(
    "does not complete a review after an ordinary 其中 paragraph is reverted",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "普通其中段复核" });
      const referenceMarkId = "00000000-0000-4000-8000-000000009938";
      patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
      setClaimsText(patent, "箱体(1)");
      setDescriptionBodyText(patent, "其中一个实施例包含箱体。");
      setLegendText(patent, "其中：1、箱体。");
      const updated = planUpdateReferenceMark(patent, {
        referenceMarkId,
        number: 1,
        keyword: "机箱",
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) throw new Error(updated.message);
      expect(updated.plan.after.referenceMarkSettings.pendingReview?.counts.description).toBe(1);
      setDescriptionBodyText(updated.plan.after, "其中一个实施例包含箱体。");

      const result = planCompleteReferenceMarkReview(updated.plan.after, referenceMarkId);

      expect(result).toMatchObject({ ok: false, code: "REFERENCE_MARK_REPLACEMENT_MISMATCH" });
    },
  );

  crossDocumentEditingTest(
    "does not complete a normal review when the drawing legend was changed manually",
    () => {
      const patent = createBlankPatent({ patentType: "invention", name: "图例复核" });
      const referenceMarkId = "00000000-0000-4000-8000-000000009937";
      patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
      setClaimsText(patent, "箱体(1)");
      setDescriptionBodyText(patent, "实施例包含箱体。");
      setLegendText(patent, "其中：1、箱体。");
      const updated = planUpdateReferenceMark(patent, {
        referenceMarkId,
        number: 1,
        keyword: "机箱",
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) throw new Error(updated.message);
      setLegendText(updated.plan.after, "其中：9、错误内容。");

      expect(inspectReferenceMarkDescriptionState(updated.plan.after)).toMatchObject({
        status: "different",
      });
      const result = planCompleteReferenceMarkReview(updated.plan.after, referenceMarkId);

      expect(result).toMatchObject({ ok: false, code: "REFERENCE_MARK_REPLACEMENT_MISMATCH" });
    },
  );

  crossDocumentEditingTest("revalidates the description number before completing a review", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "说明书编号复核" });
    setClaimsText(patent, "箱体(1)");
    setDescriptionBodyText(patent, "箱体1");
    patent.referenceMarks = [
      { referenceMarkId: "00000000-0000-4000-8000-000000009951", number: 1, keyword: "箱体" },
    ];
    const updated = planUpdateReferenceMark(patent, {
      referenceMarkId: "00000000-0000-4000-8000-000000009951",
      number: 2,
      keyword: "箱体",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error(updated.message);
    setDescriptionBodyText(updated.plan.after, "箱体1");

    const result = planCompleteReferenceMarkReview(
      updated.plan.after,
      "00000000-0000-4000-8000-000000009951",
    );

    expect(result).toMatchObject({ ok: false, code: "REFERENCE_MARK_REPLACEMENT_MISMATCH" });
  });

  test.each([
    ["description", { claims: 0, description: 1, abstract: 0 }],
    ["abstract", { claims: 0, description: 0, abstract: 1 }],
  ] as const)("revalidates the %s before completing a review", (_kind, counts) => {
    const patent = createBlankPatent({ patentType: "invention", name: "跨书册复核" });
    const referenceMarkId = "00000000-0000-4000-8000-000000009958";
    patent.referenceMarks = [{ referenceMarkId, number: 2, keyword: "箱体" }];
    setClaimsText(patent, "箱体(2)");
    patent.referenceMarkSettings.pendingReview = {
      referenceMarkId,
      ownerBookKind: "claims",
      previousNumber: 1,
      previousKeyword: "旧箱体",
      number: 2,
      keyword: "箱体",
      counts,
      createdAt: "2026-09-02T00:00:00.000Z",
    };

    const result = planCompleteReferenceMarkReview(patent, referenceMarkId);

    expect(result).toMatchObject({ ok: false, code: "REFERENCE_MARK_REPLACEMENT_MISMATCH" });
  });

  test("allows the user to keep the current document and finish a warned review", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "保留当前正文" });
    const referenceMarkId = "00000000-0000-4000-8000-000000009965";
    patent.referenceMarks = [{ referenceMarkId, number: 2, keyword: "箱体" }];
    setClaimsText(patent, "箱体(3)");
    patent.referenceMarkSettings.pendingReview = {
      referenceMarkId,
      ownerBookKind: "claims",
      previousNumber: 1,
      previousKeyword: "箱体",
      number: 2,
      keyword: "箱体",
      counts: { claims: 1, description: 0, abstract: 0 },
      createdAt: "2026-09-02T00:00:00.000Z",
    };

    const result = planCompleteReferenceMarkReview(patent, referenceMarkId, {
      acceptCurrentDocument: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.after.referenceMarkSettings.pendingReview).toBeUndefined();
    expect(claimsText(result.plan.after)).toBe("箱体(3)");
    expect(result.plan.recordHistory).toBe(false);
  });

  test("exposes a strict reference failure code union", () => {
    expectTypeOf<ReferenceMarkFailureCode>().toEqualTypeOf<
      | "INVALID_SELECTION"
      | "SYNC_PAUSED"
      | "DUPLICATE_NUMBER"
      | "DUPLICATE_KEYWORD"
      | "AMBIGUOUS_EXISTING_NUMBER"
      | "INVALID_REFERENCE_MARK"
      | "MISSING_DESCRIPTION_HEADING"
      | "DUPLICATE_REFERENCE_MARK"
      | "PENDING_REFERENCE_MARK_REVIEW"
      | "REFERENCE_MARK_REPLACEMENT_MISMATCH"
      | "INTERRUPTED_KEYWORD_MATCHES"
      | "BODY_NUMBER_CONFLICT"
      | "TARGET_KEYWORD_ALREADY_EXISTS"
      | "INVALID_PATENT"
    >();
  });
});

let fixtureParagraphSequence = 0;

/** 在指定章节标题之前插入一个普通段落，返回其 id（用于构造附图说明区域内容）。 */
function insertDescriptionParagraph(
  patent: CanonicalPatent,
  beforeChapter: string,
  text: string,
): string {
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const chapterIndex = description.document.content.findIndex(
    (block) => classifyDescriptionChapterBlock(block) === beforeChapter,
  );
  if (chapterIndex < 0) throw new Error("fixture");
  fixtureParagraphSequence += 1;
  const id = `00000000-0000-4000-8000-${(0x9f00 + fixtureParagraphSequence)
    .toString(16)
    .padStart(12, "0")}`;
  description.document.content.splice(chapterIndex, 0, {
    id,
    type: "paragraph",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: text ? [{ type: "text", text, marks: [] }] : [],
  });
  return id;
}

function legendTextOf(block: BlockNode): string {
  return block.type === "paragraph"
    ? block.content.map((node) => (node.type === "text" ? node.text : "")).join("")
    : "";
}

function isLegendParagraphBlock(block: BlockNode): boolean {
  return block.type === "paragraph" && /^其中/u.test(legendTextOf(block).trim());
}

function descriptionIndexes(patent: CanonicalPatent): {
  legend: number;
  embodiments: number;
  textOf: (index: number) => string;
} {
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  const content = description.document.content;
  return {
    legend: (() => {
      for (let index = content.length - 1; index >= 0; index -= 1) {
        const block = content[index];
        if (block && isLegendParagraphBlock(block)) return index;
      }
      return -1;
    })(),
    embodiments: content.findIndex(
      (block) => classifyDescriptionChapterBlock(block) === "detailed-embodiments",
    ),
    textOf: (index) =>
      content[index]?.type === "paragraph"
        ? content[index].content.map((node) => (node.type === "text" ? node.text : "")).join("")
        : "",
  };
}

describe("drawing legend placement", () => {
  test("appends a new legend paragraph after a trailing figure explanation", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "末尾追加" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
    insertDescriptionParagraph(patent, "detailed-embodiments", "图1为本发明的箱体示意图。");
    insertDescriptionParagraph(patent, "detailed-embodiments", "图2为本发明的箱盖示意图。");

    const result = planFillReferenceMarksIntoDescription(patent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const { legend, embodiments, textOf } = descriptionIndexes(result.plan.after);
    expect(legend).toBeGreaterThan(-1);
    // 图例段紧跟在图2说明之后，且在具体实施方式标题之前。
    expect(textOf(legend - 1)).toBe("图2为本发明的箱盖示意图。");
    expect(embodiments).toBeGreaterThan(legend);
    expect(textOf(legend)).toBe("其中：1、箱体。");
  });

  test("fills an empty trailing paragraph without adding a new one", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "空段填入" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
    const emptyId = insertDescriptionParagraph(patent, "detailed-embodiments", "");

    const result = planFillReferenceMarksIntoDescription(patent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const { legend, textOf } = descriptionIndexes(result.plan.after);
    const legendId = result.plan.after.books.find((book) => book.kind === "description")?.document
      .content[legend]?.id;
    expect(legendId).toBe(emptyId);
    expect(textOf(legend)).toBe("其中：1、箱体。");
  });

  test("preserves a trailing non-figure paragraph and appends the legend", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "保留段落" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
    const targetId = insertDescriptionParagraph(
      patent,
      "detailed-embodiments",
      "本说明书附图说明到此结束。",
    );

    const result = planFillReferenceMarksIntoDescription(patent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const { legend, textOf } = descriptionIndexes(result.plan.after);
    const legendId = result.plan.after.books.find((book) => book.kind === "description")?.document
      .content[legend]?.id;
    expect(legendId).not.toBe(targetId);
    expect(textOf(legend - 1)).toBe("本说明书附图说明到此结束。");
    expect(textOf(legend)).toBe("其中：1、箱体。");
  });

  test.each(["图 1为本发明的箱体示意图。", "附图1为本发明的箱体示意图。"])(
    "preserves a nonstandard figure explanation %s",
    (explanation) => {
      const patent = createBlankPatent({ patentType: "invention", name: "非标准图号" });
      patent.referenceMarks = [
        { referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" },
      ];
      insertDescriptionParagraph(patent, "detailed-embodiments", explanation);

      const result = planFillReferenceMarksIntoDescription(patent);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      const { legend, textOf } = descriptionIndexes(result.plan.after);
      expect(textOf(legend - 1)).toBe(explanation);
      expect(textOf(legend)).toBe("其中：1、箱体。");
    },
  );

  test("refuses to fill when the drawing explanation contains multiple legends", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "重复图例" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
    insertDescriptionParagraph(patent, "detailed-embodiments", "其中：1、箱体。");
    insertDescriptionParagraph(patent, "detailed-embodiments", "其中：2、箱盖。");

    const result = planFillReferenceMarksIntoDescription(patent);

    expect(result).toMatchObject({ ok: false, code: "SYNC_PAUSED" });
    if (result.ok) throw new Error("expected duplicate legends to be rejected");
    expect(result.message).toContain("多个附图标记段落");
  });

  test("updates only matching entries when the description contains multiple manual legends", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "重复图例编辑" });
    const referenceMarkId = crypto.randomUUID();
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "箱体" }];
    setClaimsText(patent, "箱体(1)");
    insertDescriptionParagraph(patent, "detailed-embodiments", "其中：1、箱体。");
    insertDescriptionParagraph(patent, "detailed-embodiments", "其中：2、箱盖。");

    const result = planUpdateReferenceMark(patent, {
      referenceMarkId,
      number: 3,
      keyword: "箱体",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(claimsText(result.plan.after)).toBe("箱体(3)");
    expect(bookText(result.plan.after, "description")).toContain("其中：3、箱体。");
    expect(bookText(result.plan.after, "description")).toContain("其中：2、箱盖。");
  });

  test("updates the only existing legend in place even when a figure follows it", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "保留旧图例" });
    patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
    insertDescriptionParagraph(patent, "detailed-embodiments", "图1为本发明的箱体示意图。");
    insertDescriptionParagraph(patent, "detailed-embodiments", "其中：9、旧部件。");
    insertDescriptionParagraph(patent, "detailed-embodiments", "图2为本发明的箱盖示意图。");

    const result = planFillReferenceMarksIntoDescription(patent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const description = result.plan.after.books.find((book) => book.kind === "description");
    const legends = description?.document.content.filter(isLegendParagraphBlock) ?? [];
    expect(legends.map((block) => legendTextOf(block))).toEqual(["其中：1、箱体。"]);
    const { legend, textOf } = descriptionIndexes(result.plan.after);
    expect(textOf(legend - 1)).toBe("图1为本发明的箱体示意图。");
    expect(textOf(legend + 1)).toBe("图2为本发明的箱盖示意图。");
    expect(textOf(legend)).toBe("其中：1、箱体。");
  });
});
