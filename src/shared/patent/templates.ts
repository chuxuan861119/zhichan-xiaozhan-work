import { z } from "zod";
import { DEFAULT_PAGE_SETTINGS } from "../document/defaults.js";
import { defaultDocumentFontSizePt } from "../document/font-policy.js";
import {
  type BlockNode,
  BlockNodeSchema,
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type InlineNode,
  MAX_DOCUMENT_NODES,
  PageSettingsSchema,
  type ParagraphAttributes,
  type ParagraphNode,
  ParagraphNodeSchema,
  type PatentBookDocument,
  type TextNode,
} from "../document/model.js";
import {
  PATENT_BODY_PARAGRAPH_ATTRIBUTES,
  PATENT_HEADING_ATTRIBUTES,
  PATENT_TITLE_ATTRIBUTES,
} from "./formatting.js";
import type { PatentType } from "./model.js";

export const PATENT_TEMPLATE_TOKENS = {
  patentName: "{{patentName}}",
  typeSelfReference: "{{typeSelfReference}}",
  typeName: "{{typeName}}",
  figureNumber: "{{figureNumber}}",
} as const;

export const PatentBookTemplateSchema = z
  .object({
    page: PageSettingsSchema,
    content: z.array(BlockNodeSchema).max(MAX_DOCUMENT_NODES),
  })
  .strict()
  .superRefine((template, ctx) => {
    template.content.forEach((block, index) => {
      if (block.type === "figure") {
        ctx.addIssue({
          code: "custom",
          message: "全局模板不支持图片节点。",
          path: ["content", index],
        });
      }
    });
  });
export type PatentBookTemplate = z.infer<typeof PatentBookTemplateSchema>;

export const PatentTemplateSlotSchema = z.enum([
  "claims",
  "description",
  "abstract",
  "figure-explanation",
  "drawing-legend",
]);
export type PatentTemplateSlot = z.infer<typeof PatentTemplateSlotSchema>;

export type PatentTemplateIssue = {
  patentType: PatentType;
  slot: PatentTemplateSlot;
  code: "missing-token" | "missing-chapter" | "unsupported-node" | "broken-token";
  message: string;
};

export const PatentTemplateGroupSchema = z
  .object({
    claims: PatentBookTemplateSchema,
    description: PatentBookTemplateSchema,
    abstract: PatentBookTemplateSchema,
    figureExplanation: ParagraphNodeSchema,
    drawingLegend: ParagraphNodeSchema,
  })
  .strict();

export const PatentTemplateSettingsSchema = z
  .object({
    enabled: z.boolean(),
    invention: PatentTemplateGroupSchema,
    "utility-model": PatentTemplateGroupSchema,
  })
  .strict();
export type PatentTemplateSettings = z.infer<typeof PatentTemplateSettingsSchema>;

const RETIRED_DESCRIPTION_STRUCTURE_ROLES = new Set([
  "invention-title",
  "description-technical-field",
  "description-background",
  "description-summary",
  "description-technical-problem",
  "description-technical-solution",
  "description-beneficial-effects",
  "description-drawings",
  "description-embodiments",
]);

export function createFactoryPatentTemplates(createId: () => string): PatentTemplateSettings {
  return {
    enabled: true,
    invention: createTemplateGroup("invention", createId),
    "utility-model": createTemplateGroup("utility-model", createId),
  };
}

/**
 * Frozen factory used only to classify settings written before the editable
 * template catalog existed. Keep this output stable even when the current
 * system template changes.
 */
export function createLegacyFactoryPatentTemplatesV1(
  createId: () => string,
): PatentTemplateSettings {
  return {
    enabled: true,
    invention: createTemplateGroup("invention", createId, true),
    "utility-model": createTemplateGroup("utility-model", createId, true),
  };
}

export function instantiateBookTemplate(input: {
  template: PatentBookTemplate;
  kind: "claims" | "description" | "abstract";
  patentName: string | null;
  patentType: PatentType;
  timestamp: string;
  createId: () => string;
}): PatentBookDocument {
  return {
    formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
    documentId: input.createId(),
    title: bookTitle(input.kind),
    createdAt: input.timestamp,
    modifiedAt: input.timestamp,
    page: structuredClone(input.template.page),
    content: input.template.content.map((block) => {
      const instantiated = instantiateBlock(block, input);
      return input.kind === "description"
        ? withoutRetiredDescriptionStructureRole(instantiated)
        : instantiated;
    }),
  };
}

function withoutRetiredDescriptionStructureRole(block: BlockNode): BlockNode {
  if (
    "semanticRole" in block &&
    block.semanticRole &&
    RETIRED_DESCRIPTION_STRUCTURE_ROLES.has(block.semanticRole)
  ) {
    const untagged = structuredClone(block);
    delete untagged.semanticRole;
    return untagged;
  }
  return block;
}

export function instantiateFigureExplanation(input: {
  template: ParagraphNode;
  figureNumber: number;
  patentName: string | null;
  patentType: PatentType;
  createId: () => string;
}): ParagraphNode {
  return instantiateParagraph(input.template, input);
}

export function templateIssues(settings: PatentTemplateSettings): PatentTemplateIssue[] {
  const issues: PatentTemplateIssue[] = [];
  for (const patentType of ["invention", "utility-model"] as const) {
    const group = settings[patentType];
    inspectBookTemplate(issues, patentType, "claims", group.claims, []);
    inspectBookTemplate(issues, patentType, "description", group.description, [
      "patentName",
      "typeSelfReference",
    ]);
    inspectBookTemplate(issues, patentType, "abstract", group.abstract, ["patentName"]);
    inspectParagraphTemplate(issues, patentType, "figure-explanation", group.figureExplanation, [
      "figureNumber",
    ]);
    inspectParagraphTemplate(issues, patentType, "drawing-legend", group.drawingLegend, []);

    const headings = group.description.content
      .filter((block) => block.type === "heading")
      .map((block) =>
        textNodeText(block.content).replaceAll(
          PATENT_TEMPLATE_TOKENS.typeName,
          patentType === "invention" ? "发明" : "实用新型",
        ),
      );
    for (const chapter of descriptionChapters(patentType)) {
      if (!headings.includes(chapter)) {
        issues.push({
          patentType,
          slot: "description",
          code: "missing-chapter",
          message: `说明书模板缺少章节：${chapter}`,
        });
      }
    }
  }
  return issues;
}

export function blockingTemplateIssues(settings: PatentTemplateSettings): PatentTemplateIssue[] {
  return templateIssues(settings).filter(
    (issue) =>
      issue.code === "unsupported-node" ||
      issue.code === "broken-token" ||
      (issue.code === "missing-token" && issue.slot === "figure-explanation"),
  );
}

function createTemplateGroup(
  patentType: PatentType,
  createId: () => string,
  legacyClaims = false,
): PatentTemplateSettings["invention"] {
  type TemplatePart =
    | string
    | { readonly blankLength: number }
    | { readonly text: string; readonly red: true; readonly bold?: boolean };
  const shortBlank = (): TemplatePart => ({ blankLength: 6 });
  const longBlank = (): TemplatePart => ({ blankLength: 12 });
  const redPatentName = (bold = false): TemplatePart => ({
    text: PATENT_TEMPLATE_TOKENS.patentName,
    red: true,
    ...(bold ? { bold: true } : {}),
  });
  const typeSelfReference = patentType === "invention" ? "本发明" : "本实用新型";
  const inventionContent = legacyClaims
    ? patentType === "invention"
      ? "发明内容"
      : "实用新型内容"
    : `${PATENT_TEMPLATE_TOKENS.typeName}内容`;
  const paragraph = (
    value: TemplatePart | readonly TemplatePart[],
    options: {
      bold?: boolean;
      attrs?: ParagraphAttributes;
    } = {},
  ): ParagraphNode => {
    const parts = Array.isArray(value) ? value : [value];
    const content: InlineNode[] = [];
    for (const part of parts) {
      if (typeof part === "string") {
        if (part) {
          content.push({
            type: "text",
            text: part,
            marks: options.bold ? [{ type: "bold" }] : [],
          });
        }
      } else if ("blankLength" in part) {
        content.push({
          type: "text",
          text: " ".repeat(part.blankLength),
          marks: [{ type: "underline" }],
        });
      } else {
        content.push({
          type: "text",
          text: part.text,
          marks: [
            ...(options.bold || part.bold ? [{ type: "bold" as const }] : []),
            { type: "color", value: "#FF0000" },
          ],
        });
      }
    }
    return {
      id: createId(),
      type: "paragraph",
      attrs: {
        ...(options.attrs ?? PATENT_BODY_PARAGRAPH_ATTRIBUTES),
        defaultFontSizePt: legacyClaims ? 14 : defaultDocumentFontSizePt(),
      },
      content,
    };
  };
  const heading = (text: string): Extract<BlockNode, { type: "heading" }> => ({
    id: createId(),
    type: "heading",
    level: 1,
    attrs: {
      ...PATENT_HEADING_ATTRIBUTES,
      defaultFontSizePt: legacyClaims ? 14 : defaultDocumentFontSizePt(),
    },
    content: [{ type: "text", text, marks: [{ type: "bold" }] }],
  });
  const descriptionContent: BlockNode[] = legacyClaims
    ? [
        paragraph(PATENT_TEMPLATE_TOKENS.patentName, {
          bold: true,
          attrs: PATENT_TITLE_ATTRIBUTES,
        }),
        heading("技术领域"),
        paragraph(`${PATENT_TEMPLATE_TOKENS.typeSelfReference}涉及______技术领域。`),
        heading("背景技术"),
        paragraph(""),
        heading(inventionContent),
        paragraph(`${PATENT_TEMPLATE_TOKENS.typeSelfReference}要解决的技术问题是______。`),
        paragraph(
          `为解决上述技术问题，${PATENT_TEMPLATE_TOKENS.typeSelfReference}采用的技术方案是______。`,
        ),
        heading("有益效果"),
        paragraph(`${PATENT_TEMPLATE_TOKENS.typeSelfReference}具有以下有益效果：______。`),
        heading("附图说明"),
        paragraph(""),
        heading("具体实施方式"),
        paragraph(
          `下面结合附图和具体实施方式对${PATENT_TEMPLATE_TOKENS.typeSelfReference}作进一步说明。`,
        ),
      ]
    : [
        paragraph(redPatentName(true), { attrs: PATENT_TITLE_ATTRIBUTES }),
        heading("技术领域"),
        paragraph([`本${PATENT_TEMPLATE_TOKENS.typeName}`, "涉及", shortBlank(), "技术领域。"]),
        heading("背景技术"),
        paragraph(""),
        heading(inventionContent),
        paragraph([
          `本${PATENT_TEMPLATE_TOKENS.typeName}`,
          "要解决的技术问题是",
          shortBlank(),
          "。",
        ]),
        paragraph([
          "为解决上述技术问题，",
          `本${PATENT_TEMPLATE_TOKENS.typeName}`,
          "采用的技术方案是",
          shortBlank(),
          "。",
        ]),
        heading("有益效果"),
        paragraph([
          `本${PATENT_TEMPLATE_TOKENS.typeName}`,
          "具有以下有益效果：",
          shortBlank(),
          "。",
        ]),
        heading("附图说明"),
        paragraph(""),
        heading("具体实施方式"),
        paragraph([
          "下面结合附图和具体实施方式对",
          `本${PATENT_TEMPLATE_TOKENS.typeName}`,
          "作进一步说明。",
        ]),
      ];

  return {
    claims: {
      page: { ...DEFAULT_PAGE_SETTINGS },
      content: legacyClaims
        ? [paragraph(`1. ${PATENT_TEMPLATE_TOKENS.patentName}，其特征在于：`)]
        : [
            paragraph(["1. ", redPatentName(), "，其特征在于：", longBlank(), "。"]),
            paragraph([
              "2. 根据权利要求1所述的",
              redPatentName(),
              "，其特征在于：",
              { blankLength: 10 },
              "。",
            ]),
          ],
    },
    description: { page: { ...DEFAULT_PAGE_SETTINGS }, content: descriptionContent },
    abstract: {
      page: { ...DEFAULT_PAGE_SETTINGS },
      content: legacyClaims
        ? [
            paragraph(
              `${typeSelfReference}公开了一种${PATENT_TEMPLATE_TOKENS.patentName}，包括______。${typeSelfReference}通过______，解决了______的问题，具有______的有益效果。`,
            ),
          ]
        : [
            paragraph([
              `${typeSelfReference}公开了一种`,
              redPatentName(),
              "，包括",
              shortBlank(),
              `。${typeSelfReference}通过`,
              shortBlank(),
              "，解决了",
              shortBlank(),
              "的问题，具有",
              shortBlank(),
              "的有益效果。",
            ]),
          ],
    },
    figureExplanation: legacyClaims
      ? paragraph(`图${PATENT_TEMPLATE_TOKENS.figureNumber}为${typeSelfReference}的______示意图。`)
      : paragraph([
          `图${PATENT_TEMPLATE_TOKENS.figureNumber}为${typeSelfReference}的`,
          shortBlank(),
          "示意图。",
        ]),
    drawingLegend: legacyClaims
      ? paragraph("其中，______。")
      : paragraph(["其中，", shortBlank(), "。"]),
  };
}

function instantiateBlock(
  block: BlockNode,
  input: {
    patentName: string | null;
    patentType: PatentType;
    createId: () => string;
  },
): BlockNode {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return instantiateParagraph(block, input);
    case "bullet-list":
    case "ordered-list":
      return {
        ...structuredClone(block),
        id: input.createId(),
        items: block.items.map((item) => ({
          ...structuredClone(item),
          id: input.createId(),
          content: item.content.map((paragraph) => instantiateParagraph(paragraph, input)),
        })),
      };
    case "table":
      return {
        ...structuredClone(block),
        id: input.createId(),
        rows: block.rows.map((row) => ({
          ...structuredClone(row),
          id: input.createId(),
          cells: row.cells.map((cell) => ({
            ...structuredClone(cell),
            id: input.createId(),
            content: cell.content.map((paragraph) => instantiateParagraph(paragraph, input)),
          })),
        })),
      };
    case "chemical-structure":
      return { ...structuredClone(block), id: input.createId() };
    default:
      return { ...structuredClone(block), id: input.createId() };
  }
}

function instantiateParagraph<T extends ParagraphNode | Extract<BlockNode, { type: "heading" }>>(
  paragraph: T,
  input: {
    patentName: string | null;
    patentType: PatentType;
    createId: () => string;
    figureNumber?: number;
  },
): T {
  const content: InlineNode[] = [];
  for (const node of paragraph.content) {
    if (node.type === "text") content.push(...instantiateTextNode(node, input));
    else content.push(structuredClone(node));
  }
  return {
    ...structuredClone(paragraph),
    id: input.createId(),
    content,
  } as T;
}

function instantiateTextNode(
  node: TextNode,
  input: { patentName: string | null; patentType: PatentType; figureNumber?: number },
): TextNode[] {
  const text = node.text
    .replaceAll(
      PATENT_TEMPLATE_TOKENS.typeName,
      input.patentType === "invention" ? "发明" : "实用新型",
    )
    .replaceAll(
      PATENT_TEMPLATE_TOKENS.typeSelfReference,
      input.patentType === "invention" ? "本发明" : "本实用新型",
    )
    .replaceAll(PATENT_TEMPLATE_TOKENS.figureNumber, String(input.figureNumber ?? 0));
  if (!text.includes(PATENT_TEMPLATE_TOKENS.patentName)) {
    return [{ ...structuredClone(node), text }];
  }

  const patentName = input.patentName?.trim();
  const parts = text.split(PATENT_TEMPLATE_TOKENS.patentName);
  const nodes: TextNode[] = [];
  for (const [index, part] of parts.entries()) {
    if (part) nodes.push({ ...structuredClone(node), text: part });
    if (index === parts.length - 1) continue;
    nodes.push({
      ...structuredClone(node),
      text: patentName || " ".repeat(6),
      marks: patentName
        ? structuredClone(node.marks)
        : [
            ...structuredClone(node.marks),
            ...(node.marks.some((mark) => mark.type === "underline")
              ? []
              : [{ type: "underline" as const }]),
          ],
    });
  }
  return nodes;
}

function inspectBookTemplate(
  issues: PatentTemplateIssue[],
  patentType: PatentType,
  slot: Extract<PatentTemplateSlot, "claims" | "description" | "abstract">,
  template: PatentBookTemplate,
  requiredTokens: readonly (keyof typeof PATENT_TEMPLATE_TOKENS)[],
): void {
  if (template.content.some(containsFigure)) {
    issues.push({
      patentType,
      slot,
      code: "unsupported-node",
      message: "全局模板不支持图片节点。",
    });
  }
  inspectTokens(issues, patentType, slot, template.content.flatMap(blockTextNodes), requiredTokens);
  inspectFormulaTokens(issues, patentType, slot, template.content.flatMap(blockFormulaSources));
}

function inspectParagraphTemplate(
  issues: PatentTemplateIssue[],
  patentType: PatentType,
  slot: Extract<PatentTemplateSlot, "figure-explanation" | "drawing-legend">,
  template: ParagraphNode,
  requiredTokens: readonly (keyof typeof PATENT_TEMPLATE_TOKENS)[],
): void {
  inspectTokens(issues, patentType, slot, textNodes(template.content), requiredTokens);
  inspectFormulaTokens(issues, patentType, slot, formulaSources(template.content));
}

function inspectFormulaTokens(
  issues: PatentTemplateIssue[],
  patentType: PatentType,
  slot: PatentTemplateSlot,
  sources: readonly string[],
): void {
  if (sources.some((source) => source.includes("{{") || source.includes("}}"))) {
    issues.push({ patentType, slot, code: "broken-token", message: "公式中不能使用动态字段。" });
  }
}

function inspectTokens(
  issues: PatentTemplateIssue[],
  patentType: PatentType,
  slot: PatentTemplateSlot,
  texts: readonly string[],
  requiredTokens: readonly (keyof typeof PATENT_TEMPLATE_TOKENS)[],
): void {
  const source = texts.join("");
  for (const token of requiredTokens) {
    if (token === "typeSelfReference" && source.includes(PATENT_TEMPLATE_TOKENS.typeName)) continue;
    if (!source.includes(PATENT_TEMPLATE_TOKENS[token])) {
      issues.push({
        patentType,
        slot,
        code: "missing-token",
        message: `模板缺少动态字段：${token}`,
      });
    }
  }
  for (const text of texts) {
    const remainder = Object.values(PATENT_TEMPLATE_TOKENS).reduce(
      (value, token) => value.replaceAll(token, ""),
      text,
    );
    if (remainder.includes("{{") || remainder.includes("}}")) {
      issues.push({ patentType, slot, code: "broken-token", message: "模板包含无效动态字段。" });
    }
  }
}

function containsFigure(block: BlockNode): boolean {
  return block.type === "figure";
}

function blockTextNodes(block: BlockNode): string[] {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return textNodes(block.content);
    case "bullet-list":
    case "ordered-list":
      return block.items.flatMap((item) =>
        item.content.flatMap((paragraph) => textNodes(paragraph.content)),
      );
    case "table":
      return block.rows.flatMap((row) =>
        row.cells.flatMap((cell) =>
          cell.content.flatMap((paragraph) => textNodes(paragraph.content)),
        ),
      );
    case "chemical-structure":
      return [];
    default:
      return [];
  }
}

function blockFormulaSources(block: BlockNode): string[] {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return formulaSources(block.content);
    case "bullet-list":
    case "ordered-list":
      return block.items.flatMap((item) =>
        item.content.flatMap((paragraph) => formulaSources(paragraph.content)),
      );
    case "table":
      return block.rows.flatMap((row) =>
        row.cells.flatMap((cell) =>
          cell.content.flatMap((paragraph) => formulaSources(paragraph.content)),
        ),
      );
    case "block-formula":
      return [block.source];
    case "chemical-structure":
      return [];
    default:
      return [];
  }
}

function textNodeText(content: ParagraphNode["content"]): string {
  return textNodes(content).join("");
}

function textNodes(content: ParagraphNode["content"]): string[] {
  return content.filter((node) => node.type === "text").map((node) => node.text);
}

function formulaSources(content: ParagraphNode["content"]): string[] {
  return content.filter((node) => node.type === "inline-formula").map((node) => node.source);
}

function descriptionChapters(patentType: PatentType): string[] {
  return [
    "技术领域",
    "背景技术",
    patentType === "invention" ? "发明内容" : "实用新型内容",
    "有益效果",
    "附图说明",
    "具体实施方式",
  ];
}

function bookTitle(kind: "claims" | "description" | "abstract"): string {
  return kind === "claims" ? "权利要求书" : kind === "description" ? "说明书" : "说明书摘要";
}
