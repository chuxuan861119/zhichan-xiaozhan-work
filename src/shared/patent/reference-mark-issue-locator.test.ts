import { describe, expect, test } from "vitest";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../document/defaults.js";
import type { InlineNode, PatentBookDocument } from "../document/model.js";
import { createBlankPatent } from "./defaults.js";
import type { CanonicalPatent, PatentBookKind } from "./model.js";
import { locateReferenceMarkIssues } from "./reference-mark-issue-locator.js";
import { inspectReferenceMarkStatus } from "./reference-mark-operations.js";

const REFERENCE_MARK_ID = "00000000-0000-4000-8000-000000008801";

function patentWithMark(): CanonicalPatent {
  const patent = createBlankPatent({ patentType: "invention", name: "问题定位" });
  patent.referenceMarks = [{ referenceMarkId: REFERENCE_MARK_ID, number: 1, keyword: "电池包" }];
  return patent;
}

function setBookContent(
  patent: CanonicalPatent,
  kind: Extract<PatentBookKind, "claims" | "description" | "abstract">,
  content: InlineNode[],
  suffix: string,
): PatentBookDocument {
  const book = patent.books.find((candidate) => candidate.kind === kind);
  if (!book) throw new Error(`missing ${kind}`);
  book.document.content = [
    {
      id: `00000000-0000-4000-8000-00000000${suffix}`,
      type: "paragraph",
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content,
    },
  ];
  return book.document;
}

describe("reference mark issue locator", () => {
  test.each(["电池包9", "电 池包1"])(
    "finds optional bare-number issues in the abstract: %s",
    (text) => {
      const patent = patentWithMark();
      setBookContent(patent, "claims", [{ type: "text", text: "电池包(1)", marks: [] }], "8850");
      setBookContent(patent, "abstract", [{ type: "text", text, marks: [] }], "8851");
      expect(locateReferenceMarkIssues(patent, REFERENCE_MARK_ID)).toContainEqual(
        expect.objectContaining({ bookKind: "abstract", text }),
      );
    },
  );
  test.each(["防护 壳5", "防 护　壳（5）", "防护\u00a0壳(5)"])(
    "includes the whitespace-damaged description keyword and number: %s",
    (text) => {
      const patent = patentWithMark();
      patent.referenceMarks = [
        { referenceMarkId: REFERENCE_MARK_ID, number: 5, keyword: "防护壳" },
      ];
      setBookContent(patent, "claims", [{ type: "text", text: "防护壳(5)", marks: [] }], "8850");
      const description = setBookContent(
        patent,
        "description",
        [
          { type: "text", text: "所述", marks: [] },
          { type: "text", text, marks: [{ type: "bold" }] },
          { type: "text", text: "与外壳连接。", marks: [] },
        ],
        "8851",
      );
      const before = structuredClone(description);
      expect(locateReferenceMarkIssues(patent, REFERENCE_MARK_ID)).toEqual([
        expect.objectContaining({
          bookKind: "description",
          from: 2,
          to: 2 + text.length,
          text,
          reason: "detached-number",
        }),
      ]);
      expect(description).toEqual(before);
      setBookContent(
        patent,
        "description",
        [{ type: "text", text: "所述防护壳5与外壳连接。", marks: [] }],
        "8851",
      );
      expect(locateReferenceMarkIssues(patent, REFERENCE_MARK_ID)).toEqual([]);
    },
  );

  test("extends a number-only semantic token over the whitespace-damaged description keyword", () => {
    const patent = patentWithMark();
    setBookContent(patent, "claims", [{ type: "text", text: "电池包(1)", marks: [] }], "8852");
    setBookContent(
      patent,
      "description",
      [
        { type: "text", text: "所述电池 包", marks: [] },
        { type: "text", text: "1", marks: [{ type: "reference-mark-token", number: 1 }] },
      ],
      "8853",
    );
    expect(locateReferenceMarkIssues(patent, REFERENCE_MARK_ID)).toEqual([
      expect.objectContaining({ text: "电池 包1", from: 2, to: 7, reason: "detached-number" }),
    ]);
  });

  test.each(["电池包", "电池包1mm", "电池包1个", "电池包１"])(
    "does not turn optional description numbers into a requirement for copied semantic tokens: %s",
    (text) => {
      const patent = patentWithMark();
      setBookContent(patent, "claims", [{ type: "text", text: "电池包(1)", marks: [] }], "8840");
      setBookContent(
        patent,
        "description",
        [{ type: "text", text, marks: [{ type: "reference-mark-token", number: 1 }] }],
        "8841",
      );
      expect(locateReferenceMarkIssues(patent, REFERENCE_MARK_ID)).toEqual([]);
    },
  );

  test("checks optional description numbers while ignoring quantities and dimensions", () => {
    const patent = patentWithMark();
    setBookContent(patent, "claims", [{ type: "text", text: "电池包(1)", marks: [] }], "8813");
    const document = setBookContent(
      patent,
      "description",
      [
        {
          type: "text",
          text: "电池包、电池包1、电池包２、电池包(3)、电池包5mm、电池包5个、电池包5.5毫米、电池包5～8个。",
          marks: [],
        },
      ],
      "8814",
    );
    const before = structuredClone(document);
    expect(
      locateReferenceMarkIssues(patent, REFERENCE_MARK_ID).map(({ text, reason }) => [
        text,
        reason,
      ]),
    ).toEqual([
      ["电池包２", "wrong-number"],
      ["电池包(3)", "wrong-number"],
    ]);
    expect(inspectReferenceMarkStatus(patent).entries[0]?.locatableIssueCounts.description).toBe(2);
    expect(document).toEqual(before);
    setBookContent(
      patent,
      "description",
      [{ type: "text", text: "电池包1、电池包(1)、电池包。", marks: [] }],
      "8814",
    );
    expect(locateReferenceMarkIssues(patent, REFERENCE_MARK_ID)).toEqual([]);
  });

  test("locates a description number whose keyword was changed without guessing the replacement word", () => {
    const patent = patentWithMark();
    setBookContent(patent, "claims", [{ type: "text", text: "电池包(1)", marks: [] }], "8815");
    setBookContent(
      patent,
      "description",
      [
        {
          type: "text",
          text: "所述电池组件1连接于壳体。参见图1、实施例1和权利要求1。数量为1，另有电池组件1个，长度1mm。",
          marks: [],
        },
      ],
      "8816",
    );
    expect(locateReferenceMarkIssues(patent, REFERENCE_MARK_ID)).toEqual([
      expect.objectContaining({
        bookKind: "description",
        text: "1",
        from: 6,
        to: 7,
        reason: "detached-number",
      }),
    ]);
  });

  test("does not assign a longer keyword or another known keyword's wrong number to a shorter mark", () => {
    const patent = patentWithMark();
    patent.referenceMarks.push({
      referenceMarkId: "00000000-0000-4000-8000-000000008899",
      number: 2,
      keyword: "电池包主体",
    });
    setBookContent(
      patent,
      "claims",
      [{ type: "text", text: "电池包(1)、电池包主体(2)", marks: [] }],
      "8817",
    );
    setBookContent(
      patent,
      "description",
      [{ type: "text", text: "电池包主体1，电池包主体2，电池包主体5个。", marks: [] }],
      "8818",
    );
    expect(locateReferenceMarkIssues(patent, REFERENCE_MARK_ID)).toEqual([]);
    expect(locateReferenceMarkIssues(patent, "00000000-0000-4000-8000-000000008899")).toEqual([
      expect.objectContaining({ text: "电池包主体1", reason: "wrong-number" }),
    ]);
  });

  test("locates every provable claims numbering issue in document order", () => {
    const patent = patentWithMark();
    setBookContent(
      patent,
      "claims",
      [{ type: "text", text: "电池包(2)、电池包和电池包（ 1 ）。", marks: [] }],
      "8802",
    );

    const issues = locateReferenceMarkIssues(patent, REFERENCE_MARK_ID);

    expect(issues.map((issue) => issue.reason)).toEqual([
      "wrong-number",
      "missing-number",
      "nonstandard-number",
    ]);
    expect(issues.map((issue) => issue.bookKind)).toEqual(["claims", "claims", "claims"]);
  });

  test("uses semantic number ownership to locate a manually renamed keyword", () => {
    const patent = patentWithMark();
    setBookContent(
      patent,
      "claims",
      [
        {
          type: "text",
          text: "电池组件(1)",
          marks: [{ type: "reference-mark-token", number: 1 }],
        },
      ],
      "8803",
    );

    expect(locateReferenceMarkIssues(patent, REFERENCE_MARK_ID)).toEqual([
      expect.objectContaining({
        bookKind: "claims",
        from: 0,
        to: 7,
        reason: "detached-number",
      }),
    ]);
  });

  test("can locate evidenced mismatches in the description and abstract", () => {
    const patent = patentWithMark();
    setBookContent(patent, "claims", [{ type: "text", text: "电池包(1)。", marks: [] }], "8804");
    setBookContent(
      patent,
      "description",
      [{ type: "text", text: "电池包(3)。", marks: [] }],
      "8805",
    );
    setBookContent(patent, "abstract", [{ type: "text", text: "电池包(4)。", marks: [] }], "8806");

    const issues = locateReferenceMarkIssues(patent, REFERENCE_MARK_ID);

    expect(issues.map((issue) => [issue.bookKind, issue.reason])).toEqual([
      ["description", "wrong-number"],
      ["abstract", "wrong-number"],
    ]);
  });

  test("does not guess a location when both keyword and number evidence disappeared", () => {
    const patent = patentWithMark();
    setBookContent(
      patent,
      "claims",
      [{ type: "text", text: "仅保留了其他正文。", marks: [] }],
      "8807",
    );
    setBookContent(
      patent,
      "description",
      [{ type: "text", text: "说明书中也没有原关键词。", marks: [] }],
      "8808",
    );
    setBookContent(
      patent,
      "abstract",
      [{ type: "text", text: "摘要没有原关键词。", marks: [] }],
      "8809",
    );

    expect(locateReferenceMarkIssues(patent, REFERENCE_MARK_ID)).toEqual([]);
  });

  test("does not report a shorter keyword inside a registered longer keyword", () => {
    const patent = patentWithMark();
    patent.referenceMarks = [
      { referenceMarkId: REFERENCE_MARK_ID, number: 1, keyword: "自行车" },
      {
        referenceMarkId: "00000000-0000-4000-8000-000000008802",
        number: 2,
        keyword: "自行车把手",
      },
    ];
    setBookContent(
      patent,
      "claims",
      [{ type: "text", text: "自行车把手(9)。", marks: [] }],
      "8812",
    );

    const longerMark = patent.referenceMarks[1];
    if (!longerMark) throw new Error("missing longer reference mark fixture");
    expect(locateReferenceMarkIssues(patent, REFERENCE_MARK_ID)).toEqual([]);
    expect(locateReferenceMarkIssues(patent, longerMark.referenceMarkId)).toEqual([
      expect.objectContaining({ reason: "wrong-number", text: "自行车把手(9)" }),
    ]);
  });

  test("publishes the number of locatable positions with the existing status", () => {
    const patent = patentWithMark();
    setBookContent(patent, "claims", [{ type: "text", text: "电池包(9)。", marks: [] }], "8810");
    setBookContent(
      patent,
      "description",
      [{ type: "text", text: "说明书包含电池包。", marks: [] }],
      "8811",
    );

    expect(inspectReferenceMarkStatus(patent).entries[0]).toMatchObject({
      locatableIssueCount: 1,
      locatableIssueCounts: { claims: 1, description: 0, abstract: 0 },
    });
  });
});
