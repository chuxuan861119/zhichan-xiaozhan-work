import type { BlockNode, ParagraphNode } from "../document/model.js";
import { createBlankPatent } from "./defaults.js";
import { captureThreeBookTemplate, makeTemplateTypeDynamic } from "./template-capture.js";
import { createFactoryPatentTemplates, PATENT_TEMPLATE_TOKENS } from "./templates.js";

function paragraph(text: string, alignment: "left" | "center" = "left"): ParagraphNode {
  return {
    id: crypto.randomUUID(),
    type: "paragraph",
    attrs: {
      alignment,
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 12,
    },
    content: [{ type: "text", text, marks: [{ type: "color", value: "#D92D20" }] }],
  };
}

test("shared template conversion handles split type text and keeps stored content unchanged", () => {
  const source = createFactoryPatentTemplates(() => crypto.randomUUID()).invention.description;
  const heading = source.content.find((block) => block.type === "heading");
  if (!heading || heading.type !== "heading") throw new Error("missing heading");
  heading.content = [
    { type: "text", text: "发明", marks: [{ type: "bold" }] },
    { type: "text", text: "内容", marks: [{ type: "bold" }] },
  ];
  const before = structuredClone(source);
  const converted = makeTemplateTypeDynamic(source);
  const next = converted.content.find((block) => block.id === heading.id);
  expect(next).toMatchObject({
    content: [{ type: "text", text: "{{typeName}}内容", marks: [{ type: "bold" }] }],
  });
  expect(source).toEqual(before);
});

function book(
  patent: ReturnType<typeof createBlankPatent>,
  kind: "claims" | "description" | "abstract",
) {
  const result = patent.books.find((candidate) => candidate.kind === kind);
  if (!result) throw new Error(`missing ${kind}`);
  return result;
}

function text(block: BlockNode): string {
  if (block.type !== "paragraph" && block.type !== "heading") return "";
  return block.content.map((node) => (node.type === "text" ? node.text : "")).join("");
}

test("removes ordinary images from the template copy without mutating the patent", () => {
  const patent = createBlankPatent({
    patentType: "invention",
    name: "图像模板",
    templates: createFactoryPatentTemplates(() => crypto.randomUUID()),
  });
  const figureAssetId = crypto.randomUUID();
  const previewAssetId = crypto.randomUUID();
  const source = [
    {
      ...paragraph(""),
      content: [
        { type: "text" as const, text: "图片", marks: [] },
        {
          id: crypto.randomUUID(),
          type: "inline-figure" as const,
          assetId: figureAssetId,
          widthMm: 30,
          alignment: "center" as const,
          rotationDeg: 90 as const,
        },
        { type: "text" as const, text: "之前", marks: [] },
      ],
    },
    {
      id: crypto.randomUUID(),
      type: "figure",
      assetId: figureAssetId,
      widthMm: 80,
      alignment: "center",
    },
    paragraph("图片之后"),
    {
      id: crypto.randomUUID(),
      type: "chemical-structure",
      ketSource: "(ket) (atom C)",
      previewAssetId,
      widthMm: 80,
      alignment: "center",
    },
  ] satisfies BlockNode[];
  book(patent, "description").document.content = structuredClone(source);

  const captured = captureThreeBookTemplate({ patent, targetPatentType: "invention" });

  expect(captured.omittedOrdinaryImageCount).toBe(2);
  expect(captured.books.description.content.map((block) => block.type)).toEqual([
    "paragraph",
    "paragraph",
    "chemical-structure",
  ]);
  expect(captured.books.description.content.map(text)).toEqual(["图片之前", "图片之后", ""]);
  expect(captured.referencedChemicalPreviewAssetIds).toEqual([previewAssetId]);
  expect(book(patent, "description").document.content).toEqual(source);
});

test("recognizes only a centered first description paragraph as the dynamic patent title", () => {
  const patent = createBlankPatent({ patentType: "invention", name: "原题目" });
  book(patent, "description").document.content = [
    paragraph("精密夹具", "center"),
    paragraph("本发明涉及夹具。"),
  ];
  book(patent, "claims").document.content = [paragraph("一种精密夹具，精密夹具包括底座。")];
  book(patent, "abstract").document.content = [paragraph("精密夹具。本发明结构简单。")];

  const captured = captureThreeBookTemplate({ patent, targetPatentType: "invention" });

  expect(captured.detectedPatentTitle).toBe("精密夹具");
  expect(text(captured.books.description.content[0]!)).toBe(PATENT_TEMPLATE_TOKENS.patentName);
  expect(text(captured.books.claims.content[0]!)).toBe(
    `一种${PATENT_TEMPLATE_TOKENS.patentName}，${PATENT_TEMPLATE_TOKENS.patentName}包括底座。`,
  );
  expect(text(captured.books.abstract.content[0]!)).toBe(
    `${PATENT_TEMPLATE_TOKENS.patentName}。本${PATENT_TEMPLATE_TOKENS.typeName}结构简单。`,
  );
  expect((captured.books.description.content[0] as ParagraphNode).content[0]).toMatchObject({
    marks: [{ type: "color", value: "#D92D20" }],
  });
});

test("replaces a patent title that spans differently formatted text nodes", () => {
  const patent = createBlankPatent({ patentType: "invention", name: "原题目" });
  book(patent, "description").document.content = [paragraph("精密夹具", "center")];
  const splitTitle = paragraph("");
  splitTitle.content = [
    { type: "text", text: "一种精密", marks: [{ type: "bold" }] },
    { type: "text", text: "夹具及其底座", marks: [{ type: "color", value: "#D92D20" }] },
  ];
  book(patent, "claims").document.content = [splitTitle];

  const captured = captureThreeBookTemplate({ patent, targetPatentType: "invention" });
  const claim = captured.books.claims.content[0];
  if (claim?.type !== "paragraph") throw new Error("claim paragraph missing");

  expect(text(claim)).toBe(`一种${PATENT_TEMPLATE_TOKENS.patentName}及其底座`);
  expect(claim.content).toEqual([
    { type: "text", text: "一种", marks: [{ type: "bold" }] },
    { type: "text", text: PATENT_TEMPLATE_TOKENS.patentName, marks: [{ type: "bold" }] },
    { type: "text", text: "及其底座", marks: [{ type: "color", value: "#D92D20" }] },
  ]);
});

test.each([
  { first: paragraph("精密夹具", "left"), label: "not centered" },
  { first: paragraph("", "center"), label: "empty" },
  {
    first: {
      id: crypto.randomUUID(),
      type: "heading" as const,
      level: 1 as const,
      attrs: paragraph("", "center").attrs,
      content: paragraph("精密夹具").content,
    },
    label: "not a paragraph",
  },
])("does not infer a patent title when the first block is $label", ({ first }) => {
  const patent = createBlankPatent({ patentType: "invention", name: "原题目" });
  book(patent, "description").document.content = [first, paragraph("精密夹具", "center")];
  book(patent, "claims").document.content = [paragraph("精密夹具")];

  const captured = captureThreeBookTemplate({ patent, targetPatentType: "invention" });

  expect(captured.detectedPatentTitle).toBeNull();
  expect(text(captured.books.claims.content[0]!)).toBe("精密夹具");
});

test("only swaps a standalone invention-content heading during cross-type capture", () => {
  const patent = createBlankPatent({ patentType: "invention", name: "跨类型" });
  book(patent, "description").document.content = [
    paragraph("跨类型", "center"),
    {
      id: crypto.randomUUID(),
      type: "heading",
      level: 1,
      attrs: paragraph("").attrs,
      content: [{ type: "text", text: "发明内容", marks: [] }],
    },
    paragraph("正文提到发明内容，但本发明保持动态。"),
  ];

  const captured = captureThreeBookTemplate({ patent, targetPatentType: "utility-model" });

  expect(text(captured.books.description.content[1]!)).toBe("实用新型内容");
  expect(text(captured.books.description.content[2]!)).toBe(
    `正文提到发明内容，但本${PATENT_TEMPLATE_TOKENS.typeName}保持动态。`,
  );
});
