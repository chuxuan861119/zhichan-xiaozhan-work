import { createBlankDocument } from "../../shared/document/defaults.js";
import type { BlockNode, ParagraphNode } from "../../shared/document/model.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { AssetStore } from "../assets/asset-store.js";
import { createDocxPackage } from "../exports/docx-exporter.js";
import { createPatentDocxPackage } from "../exports/patent-docx-exporter.js";
import { convertParsedWordDocument } from "./docx-canonical-converter.js";
import { readDocxPackageBuffer } from "./docx-package-reader.js";
import { createDocxTestPackage } from "./docx-test-package.js";
import { parseWordprocessingDocument } from "./wordprocessingml-parser.js";

function paragraph(text: string): ParagraphNode {
  const base = createBlankDocument("测试").content[0];
  if (base?.type !== "paragraph") throw new Error("Missing paragraph");
  return { ...base, id: crypto.randomUUID(), content: [{ type: "text", text, marks: [] }] };
}

function ordered(start: number, items: string[][]): Extract<BlockNode, { type: "ordered-list" }> {
  return {
    id: crypto.randomUUID(),
    type: "ordered-list",
    start,
    items: items.map((texts) => ({ id: crypto.randomUUID(), content: texts.map(paragraph) })),
  };
}

async function roundtrip(content: ReturnType<typeof createBlankDocument>["content"]) {
  const document = { ...createBlankDocument("列表"), content };
  const exported = await createDocxPackage(
    { sessionId: "list-roundtrip", document },
    new AssetStore(),
  );
  const parsed = await parseWordprocessingDocument(
    await readDocxPackageBuffer(exported.buffer, "列表.docx"),
  );
  return convertParsedWordDocument(parsed, { title: "列表", mode: "auxiliary" }).document.content;
}

test.each([1, 8])(
  "adjacent independent ordered lists retain a separate start of %i",
  async (start) => {
    const result = await roundtrip([
      ordered(1, [["甲"], ["乙"]]),
      ordered(start, [["另甲"], ["另乙"]]),
    ]);
    expect(result).toHaveLength(2);
    expect(result).toMatchObject([
      { type: "ordered-list", start: 1 },
      { type: "ordered-list", start },
    ]);
  },
);

test("a list item continuation survives DOCX roundtrip without restarting later items", async () => {
  const result = await roundtrip([ordered(3, [["甲", "甲的续段"], ["乙"], ["丙", "丙的续段"]])]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    type: "ordered-list",
    start: 3,
    items: [
      { content: [{ content: [{ text: "甲" }] }, { content: [{ text: "甲的续段" }] }] },
      { content: [{ content: [{ text: "乙" }] }] },
      { content: [{ content: [{ text: "丙" }] }, { content: [{ text: "丙的续段" }] }] },
    ],
  });
});

test("independent bullet lists and their continuation paragraphs remain separate", async () => {
  const bullets = (texts: string[][]) => ({ ...ordered(1, texts), type: "bullet-list" as const });
  const result = await roundtrip([bullets([["甲", "续段"], ["乙"]]), bullets([["独立列表"]])]);
  expect(result).toHaveLength(2);
  expect(result).toMatchObject([
    {
      type: "bullet-list",
      items: [
        { content: [{ content: [{ text: "甲" }] }, { content: [{ text: "续段" }] }] },
        { content: [{ content: [{ text: "乙" }] }] },
      ],
    },
    { type: "bullet-list" },
  ]);
});

test.each(["single", "combined"] as const)(
  "%s patent export preserves list identity, numbering and continuation",
  async (mode) => {
    const patent = createBlankPatent({ patentType: "invention", name: "列表测试" });
    const book = patent.books.find((entry) => entry.kind === "description");
    if (!book) throw new Error("Missing description book");
    book.document.content = [ordered(3, [["甲", "续段"], ["乙"]]), ordered(8, [["独立编号"]])];
    const exported = await createPatentDocxPackage({ patent, mode, bookKind: "description" });
    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(exported.buffer, "五书列表.docx"),
    );
    const result = convertParsedWordDocument(parsed, {
      title: "列表",
      mode: "formal-book",
      bookKind: "description",
    }).document.content.filter((node) => node.type === "ordered-list");
    expect(result).toMatchObject([
      {
        start: 3,
        items: [
          { content: [{ content: [{ text: "甲" }] }, { content: [{ text: "续段" }] }] },
          { content: [{ content: [{ text: "乙" }] }] },
        ],
      },
      { start: 8 },
    ]);
  },
);

const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
function wordListParagraph(text: string) {
  return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="4"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

test("Word startOverride and a numbering series interrupted by ordinary text retain their numbers", async () => {
  const bytes = await createDocxTestPackage([
    [
      "word/document.xml",
      `<w:document ${ns}><w:body>${wordListParagraph("甲")}<w:p><w:r><w:t>正文</w:t></w:r></w:p>${wordListParagraph("乙")}</w:body></w:document>`,
    ],
    [
      "word/numbering.xml",
      `<w:numbering ${ns}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="4"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num></w:numbering>`,
    ],
  ]);
  const parsed = await parseWordprocessingDocument(
    await readDocxPackageBuffer(bytes, "重新编号.docx"),
  );
  const result = convertParsedWordDocument(parsed, { title: "列表", mode: "auxiliary" }).document
    .content;
  expect(result).toMatchObject([
    { type: "ordered-list", start: 5 },
    { type: "paragraph" },
    { type: "ordered-list", start: 6 },
  ]);
});
