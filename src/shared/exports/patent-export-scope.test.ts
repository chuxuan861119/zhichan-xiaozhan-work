import { describe, expect, it } from "vitest";
import { randomUuid } from "../id.js";
import { createImportedPatent } from "../patent/defaults.js";
import { auxiliaryExportDocument, officialPatentBooks } from "./patent-export-scope.js";

describe("patent export scope", () => {
  it("keeps auxiliary documents out of formal five-book exports", () => {
    const patent = createImportedPatent({ patentType: "invention", name: "边界测试" });
    const source = patent.books.find((book) => book.kind === "claims");
    if (!source) throw new Error("claims fixture missing");
    patent.auxiliaryDocuments.push({
      auxiliaryDocumentId: randomUuid(),
      title: "检索报告",
      document: { ...source.document, documentId: randomUuid(), title: "检索报告" },
      editorState: {},
      localRevision: 0,
      persistedRevision: 0,
      sourceFileName: "检索报告.docx",
    });

    expect(officialPatentBooks(patent)).toHaveLength(5);
    expect(officialPatentBooks(patent).map((book) => book.kind)).not.toContain("auxiliary");
  });

  it("creates a standalone export document for exactly one auxiliary document", () => {
    const patent = createImportedPatent({ patentType: "utility-model", name: "边界测试" });
    const source = patent.books.find((book) => book.kind === "claims");
    if (!source) throw new Error("claims fixture missing");
    const auxiliaryDocumentId = randomUuid();
    patent.auxiliaryDocuments.push({
      auxiliaryDocumentId,
      title: "实验记录",
      document: { ...source.document, documentId: randomUuid(), title: "实验记录" },
      editorState: {},
      localRevision: 0,
      persistedRevision: 0,
      sourceFileName: null,
    });

    expect(auxiliaryExportDocument(patent, auxiliaryDocumentId)).toMatchObject({
      title: "实验记录",
      patentType: "utility-model",
      assets: [],
    });
    expect(() => auxiliaryExportDocument(patent, randomUuid())).toThrow("其他文档不存在");
  });
});
