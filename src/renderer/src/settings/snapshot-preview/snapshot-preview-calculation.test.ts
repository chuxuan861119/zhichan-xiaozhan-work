import {
  createBlankBookDocument,
  DEFAULT_PARAGRAPH_ATTRIBUTES,
} from "../../../../shared/document/defaults";
import { PATENT_BOOK_ORDER } from "../../../../shared/patent/model";
import type { SnapshotContentPreview } from "../../../../shared/snapshot/model";
import {
  buildSnapshotPreviewCalculation,
  needsBackgroundSnapshotCalculation,
} from "./snapshot-preview-calculation";

function fixture(): SnapshotContentPreview {
  const version = {
    revision: 0,
    createdAt: new Date().toISOString(),
    books: PATENT_BOOK_ORDER.map((kind) => ({ kind, document: createBlankBookDocument(kind) })),
  };
  return {
    current: { ...version, revision: 1 },
    baseline: structuredClone(version),
    comparison: "compared",
    skippedRevisions: [],
  };
}

test("keeps small previews immediate and includes large auxiliary documents in the background threshold", () => {
  const preview = fixture();
  expect(needsBackgroundSnapshotCalculation(preview)).toBe(false);
  const document = createBlankBookDocument("材料");
  document.content.push({
    id: "00000000-0000-4000-8000-000000000123",
    type: "paragraph",
    attrs: DEFAULT_PARAGRAPH_ATTRIBUTES,
    content: [{ type: "text", text: "资料".repeat(5000), marks: [] }],
  });
  preview.current.auxiliaryDocuments = [{ auxiliaryDocumentId: "aux", title: "材料", document }];
  expect(needsBackgroundSnapshotCalculation(preview)).toBe(true);
});

test("calculates every book and auxiliary document without changing the source snapshot", () => {
  const preview = fixture();
  const document = createBlankBookDocument("材料");
  document.content.push({
    id: "00000000-0000-4000-8000-000000000123",
    type: "paragraph",
    attrs: DEFAULT_PARAGRAPH_ATTRIBUTES,
    content: [{ type: "text", text: "新增资料", marks: [] }],
  });
  preview.current.auxiliaryDocuments = [{ auxiliaryDocumentId: "aux", title: "材料", document }];
  const before = JSON.stringify(preview);
  const result = buildSnapshotPreviewCalculation(preview);
  expect(result.books.map((book) => book.bookKind)).toEqual(PATENT_BOOK_ORDER);
  expect(result.auxiliary.aux?.changes.some((change) => change.kind === "insert")).toBe(true);
  expect(JSON.stringify(preview)).toBe(before);
});
