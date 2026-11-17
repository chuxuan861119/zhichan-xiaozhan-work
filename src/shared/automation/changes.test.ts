import { describe, expect, test } from "vitest";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../document/defaults.js";
import type { BlockNode, ParagraphNode } from "../document/model.js";
import { randomUuid } from "../id.js";
import { createBlankPatent } from "../patent/defaults.js";
import {
  AutomationOperationSchema,
  captureAutomationBaseline,
  prepareAutomationChange,
} from "./changes.js";

function original() {
  const patent = createBlankPatent({ patentType: "invention", name: "原始专利" });
  const block: ParagraphNode = {
    id: randomUuid(),
    type: "paragraph",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [
      { type: "text", text: "原始内容", marks: [{ type: "bold" }] },
      { type: "inline-formula", source: "x^2", formulaKind: "math" },
      { type: "text", text: "末尾", marks: [{ type: "italic" }] },
    ],
  };
  patent.books[0]!.document.content = [block];
  return { patent, block };
}

describe("structured automation changes", () => {
  test("legacy reference review requires an explicit accept-current choice and keeps the books intact", () => {
    const { patent } = original();
    const referenceMarkId = randomUuid();
    patent.referenceMarks = [{ referenceMarkId, number: 1, keyword: "支架" }];
    patent.referenceMarkSettings.pendingReview = {
      referenceMarkId,
      ownerBookKind: "claims",
      previousNumber: 2,
      previousKeyword: "框架",
      number: 1,
      keyword: "支架",
      counts: { claims: 1, description: 0, abstract: 0 },
      createdAt: new Date().toISOString(),
    };
    expect(() =>
      prepareAutomationChange(patent, [
        AutomationOperationSchema.parse({ type: "completeReferenceMarkReview", referenceMarkId }),
      ]),
    ).toThrow();
    const prepared = prepareAutomationChange(patent, [
      { type: "completeReferenceMarkReview", referenceMarkId, acceptCurrentDocument: true },
    ]);
    expect(prepared.patent.referenceMarkSettings.pendingReview).toBeUndefined();
    expect(prepared.patent.books).toEqual(patent.books);
    patent.referenceMarkSettings.synchronizedEditingEnabled = true;
    const disabled = prepareAutomationChange(patent, [
      { type: "setReferenceMarkSync", enabled: false },
    ]);
    expect(disabled.patent.referenceMarkSettings.synchronizedEditingEnabled).toBe(false);
    expect(() =>
      prepareAutomationChange(patent, [{ type: "setReferenceMarkSync", enabled: true }]),
    ).toThrow("SYNC_PAUSED");
  });
  test("preserves formula, unaffected text and marks across partial replacement", () => {
    const { patent, block } = original();
    const prepared = prepareAutomationChange(patent, [
      {
        type: "replaceText",
        bookKind: "claims",
        blockId: block.id,
        start: 1,
        end: 3,
        expectedText: "始内",
        text: "新",
      },
    ]);
    expect(prepared.patent.books[0]!.document.content[0]).toMatchObject({
      content: [
        { type: "text", text: "原", marks: [{ type: "bold" }] },
        { type: "text", text: "新", marks: [{ type: "bold" }] },
        { type: "text", text: "容", marks: [{ type: "bold" }] },
        block.content[1],
        block.content[2],
      ],
    });
    expect(patent.books[0]!.document.content[0]).toEqual(block);
  });
  test("refuses whole mixed-content replacement and ranges intersecting structures", () => {
    const { patent, block } = original();
    expect(() =>
      prepareAutomationChange(patent, [
        {
          type: "replaceText",
          bookKind: "claims",
          blockId: block.id,
          expectedText: "原始内容末尾",
          text: "替换",
        },
      ]),
    ).toThrow("Mixed-content");
    expect(() =>
      prepareAutomationChange(patent, [
        {
          type: "replaceText",
          bookKind: "claims",
          blockId: block.id,
          start: 3,
          end: 6,
          expectedText: "容\uFFFC末",
          text: "替换",
        },
      ]),
    ).toThrow("intersects");
    expect(() =>
      prepareAutomationChange(patent, [
        {
          type: "replaceText",
          bookKind: "claims",
          blockId: block.id,
          start: 0,
          end: 2,
          expectedText: "不匹配",
          text: "替换",
        },
      ]),
    ).toThrow("expectedText");
  });
  test("mark edits retain all substantive original content and are low risk", () => {
    const { patent, block } = original();
    const prepared = prepareAutomationChange(patent, [
      {
        type: "setTextMarks",
        bookKind: "claims",
        blockId: block.id,
        start: 0,
        end: 4,
        expectedText: "原始内容",
        marks: [{ type: "underline" }],
      },
    ]);
    expect(prepared.patent.books[0]!.document.content[0]).toMatchObject({
      content: [
        { type: "text", text: "原始内容", marks: [{ type: "underline" }] },
        block.content[1],
        block.content[2],
      ],
    });
    expect(prepared.risk.requireApproval).toBe(false);
  });
  test("cumulative replacement cannot retain fixed headings as a bypass", () => {
    const { patent } = original();
    const first = {
      id: randomUuid(),
      type: "paragraph" as const,
      attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
      content: [{ type: "text" as const, text: "第一段", marks: [] }],
    };
    const second = {
      ...structuredClone(first),
      id: randomUuid(),
      content: [{ type: "text" as const, text: "第二段", marks: [] }],
    };
    patent.books[0]!.document.content = [first, second];
    const baseline = captureAutomationBaseline(patent);
    const one = prepareAutomationChange(
      patent,
      [
        {
          type: "replaceText",
          bookKind: "claims",
          blockId: first.id,
          expectedText: "第一段",
          text: "新第一段",
        },
      ],
      baseline,
    );
    expect(one.risk.requireApproval).toBe(false);
    const two = prepareAutomationChange(
      one.patent,
      [
        {
          type: "replaceText",
          bookKind: "claims",
          blockId: second.id,
          expectedText: "第二段",
          text: "新第二段",
        },
      ],
      baseline,
    );
    expect(two.risk.reasons).toContain("replaces-entire-original-body:claims");
  });
  test("destructive changes retain warnings without requiring another approval", () => {
    const { patent, block } = original();
    const deleted = prepareAutomationChange(patent, [
      { type: "deleteBlock", bookKind: "claims", blockId: block.id },
    ]);
    expect(deleted.risk.reasons).toContain("destructive-structured-content");
    expect(deleted.risk.reasons).toContain("deletes-nonempty-block");
    expect(deleted.risk.requireApproval).toBe(false);
    const blank = createBlankPatent({ patentType: "invention", name: null });
    expect(
      prepareAutomationChange(blank, [
        { type: "insertParagraph", bookKind: "claims", afterBlockId: null, text: "新写内容" },
      ]).risk.requireApproval,
    ).toBe(false);
  });
  test("rejects client editor state, extra metadata and invalid identifiers", () => {
    expect(
      AutomationOperationSchema.safeParse({ type: "setMetadata", name: "名称", editorState: {} })
        .success,
    ).toBe(false);
    expect(
      AutomationOperationSchema.safeParse({
        type: "deleteBlock",
        bookKind: "claims",
        blockId: "missing",
      }).success,
    ).toBe(false);
  });
});

test("partial formatting splits text runs without classifying original content as lost", () => {
  const { patent, block } = original();
  const baseline = captureAutomationBaseline(patent);
  const changed = prepareAutomationChange(
    patent,
    [
      {
        type: "setTextMarks",
        bookKind: "claims",
        blockId: block.id,
        start: 1,
        end: 3,
        expectedText: "始内",
        marks: [{ type: "italic" }],
      },
    ],
    baseline,
  );
  expect(changed.risk.requireApproval).toBe(false);
});

test("mixed content insertions require an unambiguous text anchor", () => {
  const { patent, block } = original();
  block.content = [
    { type: "inline-formula", source: "x", formulaKind: "math" },
    { type: "text", text: "正文", marks: [] },
  ];
  patent.books[0]!.document.content = [block];
  expect(() =>
    prepareAutomationChange(patent, [
      {
        type: "replaceText",
        bookKind: "claims",
        blockId: block.id,
        start: 0,
        end: 0,
        expectedText: "",
        text: "插入",
      },
    ]),
  ).toThrow("text anchor");
  const prepared = prepareAutomationChange(patent, [
    {
      type: "replaceText",
      bookKind: "claims",
      blockId: block.id,
      start: 1,
      end: 1,
      expectedText: "",
      text: "插入",
    },
  ]);
  expect(prepared.patent.books[0]!.document.content[0]).toMatchObject({
    content: [block.content[0], { type: "text", text: "插入" }, block.content[1]],
  });
});

test("full structured book editing retains stable identity and supports table/formula/page operations", () => {
  const { patent, block } = original();
  const table: BlockNode = {
    id: randomUuid(),
    type: "table",
    columnWidthsMm: [80],
    rows: [
      {
        id: randomUuid(),
        cells: [
          {
            id: randomUuid(),
            rowSpan: 1,
            colSpan: 1,
            horizontalAlignment: "left",
            verticalAlignment: "middle",
            borderStyle: "single",
            content: [structuredClone(block)],
          },
        ],
      },
    ],
  };
  const formula: BlockNode = {
    id: randomUuid(),
    type: "block-formula",
    source: "E=mc^2",
    formulaKind: "math",
  };
  const prepared = prepareAutomationChange(patent, [
    { type: "replaceBookContent", bookKind: "claims", content: [table] },
    { type: "insertBlock", bookKind: "claims", afterBlockId: table.id, block: formula },
    { type: "moveBlock", bookKind: "claims", blockId: formula.id, afterBlockId: null },
    {
      type: "setBookPage",
      bookKind: "claims",
      page: { ...patent.books[0]!.document.page, marginLeftMm: 23 },
    },
  ]);
  expect(prepared.patent.books[0]!.bookId).toBe(patent.books[0]!.bookId);
  expect(prepared.patent.books[0]!.document.content).toEqual([formula, table]);
  expect(prepared.patent.books[0]!.document.page.marginLeftMm).toBe(23);
  expect(prepared.diff.books).toHaveLength(1);
  expect(patent.books[0]!.document.content).toEqual([block]);
});

test("structured changes reject duplicate node IDs, unknown assets and impossible page margins", () => {
  const { patent, block } = original();
  expect(() =>
    prepareAutomationChange(patent, [
      { type: "replaceBookContent", bookKind: "claims", content: [block, block] },
    ]),
  ).toThrow();
  expect(() =>
    prepareAutomationChange(patent, [
      {
        type: "insertBlock",
        bookKind: "claims",
        afterBlockId: null,
        block: {
          id: randomUuid(),
          type: "figure",
          assetId: randomUuid(),
          widthMm: 80,
          alignment: "center",
        },
      },
    ]),
  ).toThrow();
  expect(() =>
    prepareAutomationChange(patent, [
      {
        type: "setBookPage",
        bookKind: "claims",
        page: {
          ...patent.books[0]!.document.page,
          widthMm: 30,
          marginLeftMm: 20,
          marginRightMm: 20,
        },
      },
    ]),
  ).toThrow();
});

test("auxiliary edits reject foreign IDs, duplicate titles and invalid document nodes", () => {
  const { patent, block } = original();
  const created = prepareAutomationChange(patent, [
    { type: "createAuxiliary", title: "交底", content: [block] },
    { type: "createAuxiliary", title: "交底", content: [] },
  ]).patent;
  expect(created.auxiliaryDocuments.map((entry) => entry.title)).toEqual(["交底", "交底（2）"]);
  const first = created.auxiliaryDocuments[0]!;
  const second = created.auxiliaryDocuments[1]!;
  expect(() =>
    prepareAutomationChange(created, [
      { type: "renameAuxiliary", auxiliaryDocumentId: second.auxiliaryDocumentId, title: "交底" },
    ]),
  ).toThrow();
  expect(() =>
    prepareAutomationChange(created, [
      { type: "deleteAuxiliary", auxiliaryDocumentId: randomUuid() },
    ]),
  ).toThrow();
  expect(() =>
    prepareAutomationChange(created, [
      {
        type: "editAuxiliary",
        auxiliaryDocumentId: first.auxiliaryDocumentId,
        content: [block, block],
      },
    ]),
  ).toThrow();
  const moved = prepareAutomationChange(created, [
    { type: "moveAuxiliary", auxiliaryDocumentId: second.auxiliaryDocumentId, direction: "up" },
    { type: "deleteAuxiliary", auxiliaryDocumentId: first.auxiliaryDocumentId },
  ]).patent;
  expect(moved.auxiliaryDocuments.map((entry) => entry.auxiliaryDocumentId)).toEqual([
    second.auxiliaryDocumentId,
  ]);
});
