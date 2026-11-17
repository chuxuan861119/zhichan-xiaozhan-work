import type { BlockNode, InlineNode, ParagraphNode } from "../document/model.js";
import type { CanonicalPatent, PatentType } from "./model.js";
import {
  PATENT_TEMPLATE_TOKENS,
  type PatentBookTemplate,
  PatentBookTemplateSchema,
} from "./templates.js";

export type CapturedThreeBookTemplate = {
  books: Record<"claims" | "description" | "abstract", PatentBookTemplate>;
  omittedOrdinaryImageCount: number;
  referencedChemicalPreviewAssetIds: string[];
  detectedPatentTitle: string | null;
};

export function makeTemplateTypeDynamic(template: PatentBookTemplate): PatentBookTemplate {
  let result = replaceText(template, "本发明", `本${PATENT_TEMPLATE_TOKENS.typeName}`);
  result = replaceText(result, "本实用新型", `本${PATENT_TEMPLATE_TOKENS.typeName}`);
  for (const title of ["发明内容", "实用新型内容"]) {
    result = replaceStandaloneHeading(result, title, `${PATENT_TEMPLATE_TOKENS.typeName}内容`);
  }
  return result;
}

export function captureThreeBookTemplate(input: {
  patent: CanonicalPatent;
  targetPatentType: PatentType;
}): CapturedThreeBookTemplate {
  const source = {
    claims: copyBook(input.patent, "claims"),
    description: copyBook(input.patent, "description"),
    abstract: copyBook(input.patent, "abstract"),
  };
  const omittedOrdinaryImageCount = Object.values(source).reduce(
    (count, template) => count + ordinaryImageCount(template),
    0,
  );
  const books = {
    claims: withoutOrdinaryImages(source.claims),
    description: withoutOrdinaryImages(source.description),
    abstract: withoutOrdinaryImages(source.abstract),
  };

  const detectedPatentTitle = detectDescriptionTitle(books.description);
  if (detectedPatentTitle) {
    const first = books.description.content[0];
    if (first?.type === "paragraph") {
      first.content = [tokenNode(PATENT_TEMPLATE_TOKENS.patentName, first.content)];
    }
    books.claims = replaceText(
      books.claims,
      detectedPatentTitle,
      PATENT_TEMPLATE_TOKENS.patentName,
    );
    books.abstract = replaceText(
      books.abstract,
      detectedPatentTitle,
      PATENT_TEMPLATE_TOKENS.patentName,
    );
  }

  for (const kind of ["claims", "description", "abstract"] as const) {
    books[kind] = replaceText(
      replaceText(books[kind], "本发明", `本${PATENT_TEMPLATE_TOKENS.typeName}`),
      "本实用新型",
      `本${PATENT_TEMPLATE_TOKENS.typeName}`,
    );
  }

  if (input.patent.patentType !== input.targetPatentType) {
    const from = input.patent.patentType === "invention" ? "发明内容" : "实用新型内容";
    const to = input.targetPatentType === "invention" ? "发明内容" : "实用新型内容";
    books.description = replaceStandaloneHeading(books.description, from, to);
  }

  const referencedChemicalPreviewAssetIds = [
    ...new Set(
      Object.values(books).flatMap((template) =>
        template.content.flatMap((block) =>
          block.type === "chemical-structure" ? [block.previewAssetId] : [],
        ),
      ),
    ),
  ];

  return {
    books: {
      claims: PatentBookTemplateSchema.parse(books.claims),
      description: PatentBookTemplateSchema.parse(books.description),
      abstract: PatentBookTemplateSchema.parse(books.abstract),
    },
    omittedOrdinaryImageCount,
    referencedChemicalPreviewAssetIds,
    detectedPatentTitle,
  };
}

function copyBook(
  patent: CanonicalPatent,
  kind: "claims" | "description" | "abstract",
): PatentBookTemplate {
  const book = patent.books.find((candidate) => candidate.kind === kind);
  if (!book) throw new Error(`专利缺少${kind}书册。`);
  return {
    page: structuredClone(book.document.page),
    content: structuredClone(book.document.content),
  };
}

function withoutOrdinaryImages(template: PatentBookTemplate): PatentBookTemplate {
  const withoutInlineFigures = (paragraph: ParagraphNode): ParagraphNode => ({
    ...structuredClone(paragraph),
    content: paragraph.content
      .filter((node) => node.type !== "inline-figure")
      .map((node) => structuredClone(node)),
  });
  return {
    page: structuredClone(template.page),
    content: template.content.flatMap((block): BlockNode[] => {
      if (block.type === "figure") return [];
      if (block.type === "paragraph") return [withoutInlineFigures(block)];
      if (block.type === "heading") {
        return [
          {
            ...structuredClone(block),
            content: block.content
              .filter((node) => node.type !== "inline-figure")
              .map((node) => structuredClone(node)),
          },
        ];
      }
      if (block.type === "bullet-list" || block.type === "ordered-list") {
        return [
          {
            ...structuredClone(block),
            items: block.items.map((item) => ({
              ...structuredClone(item),
              content: item.content.map(withoutInlineFigures),
            })),
          },
        ];
      }
      if (block.type === "table") {
        return [
          {
            ...structuredClone(block),
            rows: block.rows.map((row) => ({
              ...structuredClone(row),
              cells: row.cells.map((cell) => ({
                ...structuredClone(cell),
                content: cell.content.map(withoutInlineFigures),
              })),
            })),
          },
        ];
      }
      return [structuredClone(block)];
    }),
  };
}

function ordinaryImageCount(template: PatentBookTemplate): number {
  const inlineCount = (paragraph: ParagraphNode): number =>
    paragraph.content.filter((node) => node.type === "inline-figure").length;
  return template.content.reduce((count, block) => {
    if (block.type === "figure") return count + 1;
    if (block.type === "paragraph" || block.type === "heading") {
      return count + block.content.filter((node) => node.type === "inline-figure").length;
    }
    if (block.type === "bullet-list" || block.type === "ordered-list") {
      return (
        count +
        block.items.reduce(
          (itemCount, item) =>
            itemCount +
            item.content.reduce(
              (paragraphCount, paragraph) => paragraphCount + inlineCount(paragraph),
              0,
            ),
          0,
        )
      );
    }
    if (block.type === "table") {
      return (
        count +
        block.rows.reduce(
          (rowCount, row) =>
            rowCount +
            row.cells.reduce(
              (cellCount, cell) =>
                cellCount +
                cell.content.reduce(
                  (paragraphCount, paragraph) => paragraphCount + inlineCount(paragraph),
                  0,
                ),
              0,
            ),
          0,
        )
      );
    }
    return count;
  }, 0);
}

function detectDescriptionTitle(template: PatentBookTemplate): string | null {
  const first = template.content[0];
  if (first?.type !== "paragraph" || first.attrs.alignment !== "center") return null;
  const title = inlineText(first.content).trim();
  return title.length > 0 ? title : null;
}

function tokenNode(token: string, source: ParagraphNode["content"]): InlineNode {
  const marked = source.find((node) => node.type === "text");
  return {
    type: "text",
    text: token,
    marks: marked?.type === "text" ? structuredClone(marked.marks) : [],
  };
}

function replaceText(
  template: PatentBookTemplate,
  search: string,
  replacement: string,
): PatentBookTemplate {
  return {
    page: structuredClone(template.page),
    content: template.content.map((block) => mapBlockText(block, search, replacement)),
  };
}

function replaceStandaloneHeading(
  template: PatentBookTemplate,
  search: string,
  replacement: string,
): PatentBookTemplate {
  return {
    page: structuredClone(template.page),
    content: template.content.map((block) => {
      if (block.type !== "heading" || inlineText(block.content).trim() !== search) {
        return structuredClone(block);
      }
      return {
        ...structuredClone(block),
        content: mapInlineText(block.content, search, replacement),
      };
    }),
  };
}

function mapBlockText(block: BlockNode, search: string, replacement: string): BlockNode {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return {
        ...structuredClone(block),
        content: mapInlineText(block.content, search, replacement),
      };
    case "bullet-list":
    case "ordered-list":
      return {
        ...structuredClone(block),
        items: block.items.map((item) => ({
          ...structuredClone(item),
          content: item.content.map((paragraph) => ({
            ...structuredClone(paragraph),
            content: mapInlineText(paragraph.content, search, replacement),
          })),
        })),
      };
    case "table":
      return {
        ...structuredClone(block),
        rows: block.rows.map((row) => ({
          ...structuredClone(row),
          cells: row.cells.map((cell) => ({
            ...structuredClone(cell),
            content: cell.content.map((paragraph) => ({
              ...structuredClone(paragraph),
              content: mapInlineText(paragraph.content, search, replacement),
            })),
          })),
        })),
      };
    default:
      return structuredClone(block);
  }
}

function mapInlineText(
  content: ParagraphNode["content"],
  search: string,
  replacement: string,
): ParagraphNode["content"] {
  const output: ParagraphNode["content"] = [];
  let textRun: Extract<InlineNode, { type: "text" }>[] = [];
  const flushTextRun = () => {
    if (textRun.length === 0) return;
    output.push(...replaceTextRun(textRun, search, replacement));
    textRun = [];
  };
  for (const node of content) {
    if (node.type === "text") {
      textRun.push(node);
      continue;
    }
    flushTextRun();
    output.push(structuredClone(node));
  }
  flushTextRun();
  return output;
}

function replaceTextRun(
  nodes: Extract<InlineNode, { type: "text" }>[],
  search: string,
  replacement: string,
): Extract<InlineNode, { type: "text" }>[] {
  const source = nodes.map((node) => node.text).join("");
  if (!source.includes(search)) return nodes.map((node) => structuredClone(node));

  const boundaries: Array<{ start: number; end: number; node: (typeof nodes)[number] }> = [];
  let offset = 0;
  for (const node of nodes) {
    boundaries.push({ start: offset, end: offset + node.text.length, node });
    offset += node.text.length;
  }

  const output: Extract<InlineNode, { type: "text" }>[] = [];
  const appendSlice = (start: number, end: number) => {
    for (const boundary of boundaries) {
      const sliceStart = Math.max(start, boundary.start);
      const sliceEnd = Math.min(end, boundary.end);
      if (sliceStart >= sliceEnd) continue;
      output.push({
        ...structuredClone(boundary.node),
        text: boundary.node.text.slice(sliceStart - boundary.start, sliceEnd - boundary.start),
      });
    }
  };

  let cursor = 0;
  while (cursor <= source.length) {
    const matchStart = source.indexOf(search, cursor);
    if (matchStart < 0) break;
    appendSlice(cursor, matchStart);
    const marked = boundaries.find(
      (boundary) => matchStart >= boundary.start && matchStart < boundary.end,
    )?.node;
    output.push({
      type: "text",
      text: replacement,
      marks: marked ? structuredClone(marked.marks) : [],
    });
    cursor = matchStart + search.length;
  }
  appendSlice(cursor, source.length);
  return output;
}

function inlineText(content: ParagraphNode["content"]): string {
  return content
    .map((node) => (node.type === "text" ? node.text : node.type === "hard-break" ? "\n" : ""))
    .join("");
}
