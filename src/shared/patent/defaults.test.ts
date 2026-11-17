import { createImportedPatent } from "./defaults.js";
import { PATENT_BOOK_ORDER } from "./model.js";

describe("imported patent defaults", () => {
  test("creates five truly empty official books without applying templates", () => {
    let sequence = 0;
    const patent = createImportedPatent(
      {
        patentType: "invention",
        name: "导入的五书",
        customer: "测试客户",
      },
      {
        now: () => new Date("2026-08-31T00:00:00.000Z"),
        createId: () => `00000000-0000-4000-8000-${(++sequence).toString().padStart(12, "0")}`,
      },
    );

    expect(patent.books.map((book) => book.kind)).toEqual(PATENT_BOOK_ORDER);
    expect(patent.books.every((book) => book.document.content.length === 0)).toBe(true);
    expect(patent.auxiliaryDocuments).toEqual([]);
    expect(patent.docxImportReport).toBeNull();
  });
});
