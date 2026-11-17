import {
  createDocxEntryBudget,
  DOCX_MAX_ENTRIES,
  DOCX_MAX_ENTRY_BYTES,
  DOCX_MAX_UNCOMPRESSED_BYTES,
  DocxPackageError,
  normalizeDocxEntryName,
  readDocxPackageBuffer,
  validateDocxEntryLimits,
} from "./docx-package-reader.js";
import { createDocxTestPackage } from "./docx-test-package.js";

describe("DOCX package reader", () => {
  test("reads a valid local DOCX package", async () => {
    const bytes = await createDocxTestPackage([["word/styles.xml", '<w:styles xmlns:w="urn:w"/>']]);

    const result = await readDocxPackageBuffer(bytes, "实验记录.docx");

    expect(result.parts.get("word/document.xml")?.byteLength).toBeGreaterThan(0);
    expect(result.parts.get("word/styles.xml")?.byteLength).toBeGreaterThan(0);
    expect(result.findings).toEqual([]);
  });

  test.each(["实验记录.doc", "实验记录.docm", "实验记录.zip"])(
    "rejects unsupported source extension %s",
    async (sourceFileName) => {
      const bytes = await createDocxTestPackage();
      await expect(readDocxPackageBuffer(bytes, sourceFileName)).rejects.toMatchObject({
        code: "UNSUPPORTED_EXTENSION",
      });
    },
  );

  test("rejects a macro-enabled content type", async () => {
    const bytes = await createDocxTestPackage([
      [
        "[Content_Types].xml",
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>',
      ],
    ]);

    await expect(readDocxPackageBuffer(bytes, "宏文档.docx")).rejects.toMatchObject({
      code: "MACRO_ENABLED",
    });
  });

  test("reports external relationships without fetching them", async () => {
    const bytes = await createDocxTestPackage([
      [
        "word/_rels/document.xml.rels",
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="hyperlink" Target="https://example.com/a" TargetMode="External"/></Relationships>',
      ],
    ]);

    const result = await readDocxPackageBuffer(bytes, "链接.docx");

    expect(result.externalRelationships).toEqual([
      { sourcePart: "word/document.xml", relationshipId: "rId1", target: "https://example.com/a" },
    ]);
  });

  test("marks embedded OLE and ActiveX content as blocking findings", async () => {
    const bytes = await createDocxTestPackage([
      ["word/embeddings/oleObject1.bin", new Uint8Array([1, 2, 3])],
      ["word/activeX/activeX1.bin", new Uint8Array([4, 5, 6])],
    ]);

    const result = await readDocxPackageBuffer(bytes, "嵌入对象.docx");

    expect(result.findings.map((finding) => finding.code)).toEqual([
      "UNSUPPORTED_OLE",
      "UNSUPPORTED_ACTIVEX",
    ]);
    expect(result.findings.every((finding) => finding.severity === "blocking")).toBe(true);
  });

  test("rejects missing main document parts", async () => {
    const bytes = await createDocxTestPackage([], { includeDocument: false });

    await expect(readDocxPackageBuffer(bytes, "缺少正文.docx")).rejects.toMatchObject({
      code: "MISSING_DOCUMENT",
    });
  });
});

describe("DOCX entry path normalization", () => {
  test.each(["../secret.xml", "/word/document.xml", "C:/secret.xml", "word\\document.xml"])(
    "rejects unsafe path %s",
    (name) => expect(() => normalizeDocxEntryName(name)).toThrow(DocxPackageError),
  );

  test("normalizes harmless dot segments so duplicate aliases can be detected", () => {
    expect(normalizeDocxEntryName("word/./document.xml")).toBe("word/document.xml");
  });

  test("rejects duplicate normalized names", () => {
    const budget = createDocxEntryBudget();
    validateDocxEntryLimits(
      {
        fileName: "word/document.xml",
        uncompressedSize: 10,
        compressedSize: 10,
        generalPurposeBitFlag: 0,
      },
      budget,
    );
    expect(() =>
      validateDocxEntryLimits(
        {
          fileName: "word/./document.xml",
          uncompressedSize: 10,
          compressedSize: 10,
          generalPurposeBitFlag: 0,
        },
        budget,
      ),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ENTRY" }));
  });

  test.each([
    [
      "TOO_MANY_ENTRIES",
      { entryCount: DOCX_MAX_ENTRIES },
      { fileName: "word/a.xml", uncompressedSize: 1, compressedSize: 1, generalPurposeBitFlag: 0 },
    ],
    [
      "ENTRY_TOO_LARGE",
      {},
      {
        fileName: "word/a.xml",
        uncompressedSize: DOCX_MAX_ENTRY_BYTES + 1,
        compressedSize: DOCX_MAX_ENTRY_BYTES + 1,
        generalPurposeBitFlag: 0,
      },
    ],
    [
      "PACKAGE_TOO_LARGE",
      { totalBytes: DOCX_MAX_UNCOMPRESSED_BYTES },
      { fileName: "word/a.xml", uncompressedSize: 1, compressedSize: 1, generalPurposeBitFlag: 0 },
    ],
    [
      "SUSPICIOUS_COMPRESSION",
      {},
      {
        fileName: "word/a.xml",
        uncompressedSize: 2 * 1024 * 1024,
        compressedSize: 1,
        generalPurposeBitFlag: 0,
      },
    ],
    [
      "ENCRYPTED_PACKAGE",
      {},
      { fileName: "word/a.xml", uncompressedSize: 1, compressedSize: 1, generalPurposeBitFlag: 1 },
    ],
    [
      "ENCRYPTED_PACKAGE",
      {},
      {
        fileName: "EncryptedPackage",
        uncompressedSize: 1,
        compressedSize: 1,
        generalPurposeBitFlag: 0,
      },
    ],
  ] as const)("enforces the %s package boundary", (code, budgetPatch, entry) => {
    const budget = Object.assign(createDocxEntryBudget(), budgetPatch);
    expect(() => validateDocxEntryLimits(entry, budget)).toThrowError(
      expect.objectContaining({ code }),
    );
  });
});
