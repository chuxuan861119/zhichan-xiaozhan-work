import type { BlockNode, ParagraphNode, PatentBookDocument } from "../document/model.js";
import { createBlankPatent } from "./defaults.js";
import {
  PATENT_BODY_PARAGRAPH_ATTRIBUTES,
  PATENT_HEADING_ATTRIBUTES,
  PATENT_TITLE_ATTRIBUTES,
} from "./formatting.js";
import { PATENT_BOOK_LABELS } from "./model.js";
import {
  createFactoryPatentTemplates,
  createLegacyFactoryPatentTemplatesV1,
  instantiateBookTemplate,
  instantiateFigureExplanation,
  PATENT_TEMPLATE_TOKENS,
  type PatentBookTemplate,
  PatentBookTemplateSchema,
  type PatentTemplateSettings,
  templateIssues,
} from "./templates.js";

function blockText(block: BlockNode | undefined): string {
  if (!block || !("content" in block) || !Array.isArray(block.content)) return "";
  return block.content
    .map((node) =>
      node.type === "text"
        ? node.text
        : node.type === "hard-break"
          ? "\n"
          : node.type === "inline-formula"
            ? node.source
            : "",
    )
    .join("");
}

function underlinedWhitespaceRuns(block: BlockNode | undefined): string[] {
  if (!block || !("content" in block) || !Array.isArray(block.content)) return [];
  return block.content.flatMap((node) =>
    node.type === "text" &&
    /^ +$/u.test(node.text) &&
    node.marks.some((mark) => mark.type === "underline")
      ? [node.text]
      : [],
  );
}

function fixtureInstantiation(template: PatentBookTemplate) {
  return {
    template,
    kind: "description" as const,
    patentName: "环保回收装置",
    patentType: "invention" as const,
    timestamp: "2026-08-02T00:00:00.000Z",
    createId: () => crypto.randomUUID(),
  };
}

test.each(["invention", "utility-model"] as const)(
  "keeps the dynamic invention-content heading bold and recognizable for %s",
  (patentType) => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const template = templates[patentType].description;
    const heading = template.content.find(
      (block) =>
        block.type === "heading" && blockText(block) === `${PATENT_TEMPLATE_TOKENS.typeName}内容`,
    );
    expect(heading).toBeDefined();
    expect(heading).toMatchObject({ content: [{ marks: [{ type: "bold" }] }] });
    expect(templateIssues(templates)).toEqual([]);
    const document = instantiateBookTemplate({ ...fixtureInstantiation(template), patentType });
    const title = patentType === "invention" ? "发明内容" : "实用新型内容";
    expect(
      document.content.find((block) => block.type === "heading" && blockText(block) === title),
    ).toMatchObject({ content: [{ type: "text", text: title, marks: [{ type: "bold" }] }] });
  },
);

test.each(["invention", "utility-model"] as const)(
  "renders type-only tokens independently while preserving legacy wording for %s",
  (patentType) => {
    const template = createFactoryPatentTemplates(() => crypto.randomUUID())[patentType]
      .description;
    const paragraph = template.content.find(
      (block) =>
        block.type === "paragraph" && blockText(block).includes(PATENT_TEMPLATE_TOKENS.typeName),
    );
    if (!paragraph || paragraph.type !== "paragraph") throw new Error("Missing factory type token");
    expect(blockText(paragraph)).toContain(`本${PATENT_TEMPLATE_TOKENS.typeName}`);
    paragraph.content = [
      {
        type: "text",
        marks: [],
        text: `${PATENT_TEMPLATE_TOKENS.typeName}|本${PATENT_TEMPLATE_TOKENS.typeName}|${PATENT_TEMPLATE_TOKENS.typeSelfReference}`,
      },
    ];
    const output = instantiateBookTemplate({ ...fixtureInstantiation(template), patentType });
    const name = patentType === "invention" ? "发明" : "实用新型";
    expect(output.content.map(blockText)).toContain(`${name}|本${name}|本${name}`);
  },
);

function collectDocumentIds(document: PatentBookDocument): string[] {
  const ids: string[] = [];
  const visitParagraph = (paragraph: ParagraphNode) => ids.push(paragraph.id);
  for (const block of document.content) {
    ids.push(block.id);
    if (block.type === "bullet-list" || block.type === "ordered-list") {
      for (const item of block.items) {
        ids.push(item.id);
        item.content.forEach(visitParagraph);
      }
    }
    if (block.type === "table") {
      for (const row of block.rows) {
        ids.push(row.id);
        for (const cell of row.cells) {
          ids.push(cell.id);
          cell.content.forEach(visitParagraph);
        }
      }
    }
  }
  return ids;
}

describe("patent templates", () => {
  test("enables factory templates by default", () => {
    expect(createFactoryPatentTemplates(() => crypto.randomUUID()).enabled).toBe(true);
  });

  test("creates all five books with empty content when templates are disabled", () => {
    const patent = createBlankPatent({
      patentType: "invention",
      name: "空白专利",
      templates: {
        ...createFactoryPatentTemplates(() => crypto.randomUUID()),
        enabled: false,
      },
    });

    expect(patent.books.map((book) => book.kind)).toEqual([
      "claims",
      "description",
      "description-drawings",
      "abstract",
      "abstract-drawing",
    ]);
    expect(patent.books.every((book) => book.document.content.length === 0)).toBe(true);
  });

  test.each(["invention", "utility-model"] as const)(
    "instantiates the exact two-claim system template for %s",
    (patentType) => {
      const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
      const document = instantiateBookTemplate({
        template: templates[patentType].claims,
        kind: "claims",
        patentName: "环保回收装置",
        patentType,
        timestamp: "2026-08-02T00:00:00.000Z",
        createId: () => crypto.randomUUID(),
      });
      expect(document.content.map(blockText)).toEqual([
        `1. 环保回收装置，其特征在于：${" ".repeat(12)}。`,
        `2. 根据权利要求1所述的环保回收装置，其特征在于：${" ".repeat(10)}。`,
      ]);
      expect(document.content[0]).toMatchObject({
        type: "paragraph",
        content: [
          { type: "text", text: "1. ", marks: [] },
          {
            type: "text",
            text: "环保回收装置",
            marks: [{ type: "color", value: "#FF0000" }],
          },
          { type: "text", text: "，其特征在于：", marks: [] },
          { type: "text", text: " ".repeat(12), marks: [{ type: "underline" }] },
          { type: "text", text: "。", marks: [] },
        ],
      });
    },
  );

  test.each(["invention", "utility-model"] as const)(
    "fills the creation name into all three system books for %s",
    (patentType) => {
      const patent = createBlankPatent({ patentType, name: "  环保回收装置  " });
      const claims = patent.books.find((book) => book.kind === "claims")?.document;
      const description = patent.books.find((book) => book.kind === "description")?.document;
      const abstract = patent.books.find((book) => book.kind === "abstract")?.document;

      expect(claims?.content.map(blockText)).toEqual([
        `1. 环保回收装置，其特征在于：${" ".repeat(12)}。`,
        `2. 根据权利要求1所述的环保回收装置，其特征在于：${" ".repeat(10)}。`,
      ]);
      expect(blockText(description?.content[0])).toBe("环保回收装置");
      expect(blockText(abstract?.content[0])).toContain("公开了一种环保回收装置");
      expect(claims?.content[0]).toMatchObject({
        type: "paragraph",
        content: expect.arrayContaining([
          {
            type: "text",
            text: "环保回收装置",
            marks: [{ type: "color", value: "#FF0000" }],
          },
        ]),
      });
      expect(description?.content[0]).toMatchObject({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "环保回收装置",
            marks: expect.arrayContaining([{ type: "bold" }, { type: "color", value: "#FF0000" }]),
          },
        ],
      });
      expect(abstract?.content[0]).toMatchObject({
        type: "paragraph",
        content: expect.arrayContaining([
          {
            type: "text",
            text: "环保回收装置",
            marks: [{ type: "color", value: "#FF0000" }],
          },
        ]),
      });
      expect(JSON.stringify(patent.books)).not.toContain("{{patentName}}");
    },
  );

  test.each([
    ["invention", null],
    ["invention", "   "],
    ["utility-model", null],
    ["utility-model", "   "],
  ] as const)("uses underlined spaces for %s with an empty name %s", (patentType, patentName) => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const document = instantiateBookTemplate({
      template: templates[patentType].claims,
      kind: "claims",
      patentName,
      patentType,
      timestamp: "2026-08-02T00:00:00.000Z",
      createId: () => crypto.randomUUID(),
    });
    expect(blockText(document.content[0])).toBe(
      `1. ${" ".repeat(6)}，其特征在于：${" ".repeat(12)}。`,
    );
    expect(underlinedWhitespaceRuns(document.content[0])).toEqual([" ".repeat(6), " ".repeat(12)]);
    expect(blockText(document.content[1])).toBe(
      `2. 根据权利要求1所述的${" ".repeat(6)}，其特征在于：${" ".repeat(10)}。`,
    );
    expect(underlinedWhitespaceRuns(document.content[1])).toEqual([" ".repeat(6), " ".repeat(10)]);
  });

  test("keeps every current factory blank as underlined ASCII spaces", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());

    expect(JSON.stringify(templates)).not.toContain("_");
    for (const patentType of ["invention", "utility-model"] as const) {
      const group = templates[patentType];
      const books = [group.claims, group.description, group.abstract];
      expect(
        books.flatMap((book) => book.content.flatMap(underlinedWhitespaceRuns)).length,
      ).toBeGreaterThan(0);
      expect(underlinedWhitespaceRuns(group.figureExplanation)).toEqual([" ".repeat(6)]);
      expect(underlinedWhitespaceRuns(group.drawingLegend)).toEqual([" ".repeat(6)]);
    }
  });

  test("does not copy retired structure roles from a previously saved description template", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const template = structuredClone(templates.invention.description);
    const title = template.content[0];
    const technicalField = template.content.find(
      (block) => block.type === "heading" && blockText(block) === "技术领域",
    );
    if (title?.type !== "paragraph" || technicalField?.type !== "heading") {
      throw new Error("description template fixture missing");
    }
    title.semanticRole = "invention-title";
    technicalField.semanticRole = "description-technical-field";

    const document = instantiateBookTemplate(fixtureInstantiation(template));

    expect(document.content[0]).not.toHaveProperty("semanticRole");
    expect(
      document.content.find((block) => block.type === "heading" && blockText(block) === "技术领域"),
    ).not.toHaveProperty("semanticRole");
  });

  test("regenerates every nested node id", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const nestedTemplate: PatentBookTemplate = {
      ...templates.invention.description,
      content: [
        ...templates.invention.description.content,
        {
          id: crypto.randomUUID(),
          type: "bullet-list",
          items: [
            {
              id: crypto.randomUUID(),
              content: [paragraph("列表段落")],
            },
          ],
        },
        {
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
                  content: [paragraph("表格段落")],
                },
              ],
            },
          ],
        },
      ],
    };
    const first = instantiateBookTemplate(fixtureInstantiation(nestedTemplate));
    const second = instantiateBookTemplate(fixtureInstantiation(nestedTemplate));
    expect(collectDocumentIds(first)).not.toEqual(collectDocumentIds(second));
    expect(new Set([...collectDocumentIds(first), ...collectDocumentIds(second)]).size).toBe(
      collectDocumentIds(first).length + collectDocumentIds(second).length,
    );
  });

  test("creates the compact description headings and embeds problem/solution in invention content", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const document = instantiateBookTemplate(fixtureInstantiation(templates.invention.description));
    expect(document.content.filter((block) => block.type === "heading").map(blockText)).toEqual([
      "技术领域",
      "背景技术",
      "发明内容",
      "有益效果",
      "附图说明",
      "具体实施方式",
    ]);
    expect(blockText(document.content[0])).toBe("环保回收装置");
    expect(
      templates.invention.description.content
        .filter((block) => block.type === "heading")
        .every((block) => block.semanticRole === undefined),
    ).toBe(true);
    expect(document.content[0]).toMatchObject({
      type: "paragraph",
      attrs: PATENT_TITLE_ATTRIBUTES,
      content: [
        {
          type: "text",
          marks: [{ type: "bold" }, { type: "color", value: "#FF0000" }],
        },
      ],
    });
    expect(document.content[0]).not.toHaveProperty("semanticRole");
    for (const block of document.content.filter((candidate) => candidate.type === "heading")) {
      expect(block).toMatchObject({
        attrs: PATENT_HEADING_ATTRIBUTES,
        content: [{ type: "text", marks: [{ type: "bold" }] }],
      });
    }
    expect(document.content[6]).toMatchObject({
      type: "paragraph",
      attrs: PATENT_BODY_PARAGRAPH_ATTRIBUTES,
    });
    expect(blockText(document.content[6])).toBe(`本发明要解决的技术问题是${" ".repeat(6)}。`);
    expect(underlinedWhitespaceRuns(document.content[6])).toEqual([" ".repeat(6)]);
    expect(document.content[7]).toMatchObject({
      type: "paragraph",
      attrs: PATENT_BODY_PARAGRAPH_ATTRIBUTES,
    });
    expect(blockText(document.content[7])).toBe(
      `为解决上述技术问题，本发明采用的技术方案是${" ".repeat(6)}。`,
    );
    expect(underlinedWhitespaceRuns(document.content[7])).toEqual([" ".repeat(6)]);
  });

  test("replaces invention wording in the utility-model description body", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const document = instantiateBookTemplate({
      ...fixtureInstantiation(templates["utility-model"].description),
      patentType: "utility-model",
    });
    const text = document.content.map(blockText).join("\n");
    expect(text).toContain(`本实用新型要解决的技术问题是${" ".repeat(6)}。`);
    expect(text).toContain(`本实用新型采用的技术方案是${" ".repeat(6)}。`);
  });

  test("creates both complete type-specific abstract template sentences", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    expect(blockText(templates.invention.abstract.content[0])).toBe(
      `本发明公开了一种{{patentName}}，包括${" ".repeat(6)}。本发明通过${" ".repeat(6)}，解决了${" ".repeat(6)}的问题，具有${" ".repeat(6)}的有益效果。`,
    );
    expect(blockText(templates["utility-model"].abstract.content[0])).toBe(
      `本实用新型公开了一种{{patentName}}，包括${" ".repeat(6)}。本实用新型通过${" ".repeat(6)}，解决了${" ".repeat(6)}的问题，具有${" ".repeat(6)}的有益效果。`,
    );
  });

  test("uses an underlined-space run for an empty abstract patent name", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const document = instantiateBookTemplate({
      template: templates.invention.abstract,
      kind: "abstract",
      patentName: "   ",
      patentType: "invention",
      timestamp: "2026-08-02T00:00:00.000Z",
      createId: () => crypto.randomUUID(),
    });
    expect(blockText(document.content[0])).toContain(
      `一种${" ".repeat(6)}，包括${" ".repeat(6)}。`,
    );
    expect(underlinedWhitespaceRuns(document.content[0])).toHaveLength(5);
  });

  test("instantiates the figure explanation tokens", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const paragraph = instantiateFigureExplanation({
      template: templates.invention.figureExplanation,
      figureNumber: 1,
      patentName: "环保回收装置",
      patentType: "invention",
      createId: () => crypto.randomUUID(),
    });
    expect(blockText(paragraph)).toBe(`图1为本发明的${" ".repeat(6)}示意图。`);
    expect(underlinedWhitespaceRuns(paragraph)).toEqual([" ".repeat(6)]);
    expect(blockText(templates.invention.figureExplanation)).toBe(
      `图{{figureNumber}}为本发明的${" ".repeat(6)}示意图。`,
    );
    expect(blockText(templates["utility-model"].figureExplanation)).toBe(
      `图{{figureNumber}}为本实用新型的${" ".repeat(6)}示意图。`,
    );
  });

  test("returns deep-cloned factory defaults", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const restored = createFactoryPatentTemplates(() => crypto.randomUUID());
    const original = templates.invention.claims.content[0];
    if (!original || original.type !== "paragraph")
      throw new Error("claims template paragraph missing");
    original.content[0] = { type: "text", text: "changed", marks: [] };
    expect(blockText(restored.invention.claims.content[0])).toBe(
      `1. ${PATENT_TEMPLATE_TOKENS.patentName}，其特征在于：${" ".repeat(12)}。`,
    );
    expect(blockText(restored.invention.drawingLegend)).toBe(`其中，${" ".repeat(6)}。`);
  });

  test("creates the exact factory drawing legend template", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    expect(blockText(templates.invention.drawingLegend)).toBe(`其中，${" ".repeat(6)}。`);
    expect(blockText(templates["utility-model"].drawingLegend)).toBe(`其中，${" ".repeat(6)}。`);
  });

  test("reports template figures as unsupported", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const invalidTemplates: PatentTemplateSettings = {
      ...templates,
      invention: {
        ...templates.invention,
        description: {
          ...templates.invention.description,
          content: [
            {
              id: crypto.randomUUID(),
              type: "figure",
              assetId: crypto.randomUUID(),
              widthMm: 100,
              alignment: "center",
            },
          ],
        },
      },
    };
    const issues = templateIssues(invalidTemplates);
    expect(issues).toContainEqual(expect.objectContaining({ code: "unsupported-node" }));
    expect(PatentBookTemplateSchema.safeParse(invalidTemplates.invention.description).success).toBe(
      false,
    );
    expect(() =>
      createBlankPatent({ patentType: "invention", name: null, templates: invalidTemplates }),
    ).toThrow();
  });

  test("accepts editable chemical structures in three-book templates", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const invalidTemplates: PatentTemplateSettings = {
      ...templates,
      invention: {
        ...templates.invention,
        description: {
          ...templates.invention.description,
          content: [
            {
              id: crypto.randomUUID(),
              type: "chemical-structure",
              ketSource: "(ket) (atom C)",
              previewAssetId: crypto.randomUUID(),
              widthMm: 80,
              alignment: "center",
            },
          ],
        },
      },
    };

    expect(templateIssues(invalidTemplates)).not.toContainEqual(
      expect.objectContaining({ code: "unsupported-node" }),
    );
    expect(PatentBookTemplateSchema.safeParse(invalidTemplates.invention.description).success).toBe(
      true,
    );
  });

  test("reports a missing figure number token", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const issues = templateIssues({
      ...templates,
      invention: {
        ...templates.invention,
        figureExplanation: paragraph("本发明的示意图。"),
      },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        patentType: "invention",
        slot: "figure-explanation",
        code: "missing-token",
      }),
    );
  });

  test("accepts its own factory templates without diagnostics", () => {
    expect(templateIssues(createFactoryPatentTemplates(() => crypto.randomUUID()))).toEqual([]);
  });

  test("creates patents from custom templates without dynamic fields or standard chapters", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const title = templates.invention.description.content[0];
    if (!title || title.type !== "paragraph") throw new Error("description title missing");
    title.content = [{ type: "text", text: "固定标题", marks: [] }];
    templates.invention.description.content = templates.invention.description.content.filter(
      (block) => block.type !== "heading" || blockText(block) !== "有益效果",
    );

    const patent = createBlankPatent({ patentType: "invention", name: "用户题目", templates });
    const description = patent.books.find((book) => book.kind === "description")?.document;

    expect(description?.content[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "固定标题" }],
    });
    expect(templateIssues(templates)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-token" }),
        expect.objectContaining({ code: "missing-chapter" }),
      ]),
    );
  });

  test("rejects structurally valid templates with broken tokens", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const claim = templates.invention.claims.content[0];
    if (!claim || claim.type !== "paragraph") throw new Error("claims template paragraph missing");
    claim.content = [{ type: "text", text: "1. 一种{{unknown}}，其特征在于：", marks: [] }];

    expect(() => createBlankPatent({ patentType: "invention", name: null, templates })).toThrow(
      /无效动态字段/u,
    );
  });

  test("reports a token split across text nodes as broken", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const claim = templates.invention.claims.content[0];
    if (!claim || claim.type !== "paragraph") throw new Error("claims template paragraph missing");
    claim.content = [
      { type: "text", text: "1. 一种{{patent", marks: [{ type: "bold" }] },
      { type: "text", text: "Name}}，其特征在于：", marks: [{ type: "bold" }] },
    ];

    expect(templateIssues(templates)).toContainEqual(
      expect.objectContaining({ patentType: "invention", slot: "claims", code: "broken-token" }),
    );
  });

  test("does not accept a required token placed only in an inline formula", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const title = templates.invention.description.content[0];
    if (!title || title.type !== "paragraph") throw new Error("description title missing");
    title.content = [{ type: "inline-formula", source: "{{patentName}}", formulaKind: "math" }];

    expect(templateIssues(templates)).toContainEqual(
      expect.objectContaining({
        patentType: "invention",
        slot: "description",
        code: "missing-token",
      }),
    );
    expect(() => createBlankPatent({ patentType: "invention", name: null, templates })).toThrow();
  });

  test("reports token-like inline formula source as broken", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const claim = templates.invention.claims.content[0];
    if (!claim || claim.type !== "paragraph") throw new Error("claims template paragraph missing");
    claim.content = [{ type: "inline-formula", source: "{{patentName}}", formulaKind: "math" }];

    expect(templateIssues(templates)).toContainEqual(
      expect.objectContaining({ patentType: "invention", slot: "claims", code: "broken-token" }),
    );
  });

  test("does not accept a description chapter label placed only in an inline formula", () => {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const chapter = templates.invention.description.content.find(
      (block) => block.type === "heading" && blockText(block) === "有益效果",
    );
    if (chapter?.type !== "heading") throw new Error("beneficial effects heading missing");
    chapter.content = [{ type: "inline-formula", source: "有益效果", formulaKind: "math" }];

    expect(templateIssues(templates)).toContainEqual(
      expect.objectContaining({
        patentType: "invention",
        slot: "description",
        code: "missing-chapter",
      }),
    );
  });

  test("uses the full abstract book label", () => {
    expect(PATENT_BOOK_LABELS.abstract).toBe("说明书摘要");
  });
});

function paragraph(text: string): ParagraphNode {
  return {
    id: crypto.randomUUID(),
    type: "paragraph",
    attrs: {
      alignment: "left",
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 12,
    },
    content: [{ type: "text", text, marks: [] }],
  };
}

test.each([
  ["darwin", 14],
  ["openharmony", 14],
  ["win32", 14],
])("%s creates system patent templates at its default body size", (platform, expected) => {
  vi.stubGlobal("documentFontPlatform", platform);
  try {
    const templates = createFactoryPatentTemplates(() => crypto.randomUUID());
    const blocks = templates.invention.description.content;
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks)
      if (block.type === "paragraph" || block.type === "heading")
        expect(block.attrs.defaultFontSizePt).toBe(expected);
    expect(
      createLegacyFactoryPatentTemplatesV1(() => crypto.randomUUID()).invention.description
        .content[0],
    ).toMatchObject({ attrs: { defaultFontSizePt: 14 } });
  } finally {
    vi.unstubAllGlobals();
  }
});
