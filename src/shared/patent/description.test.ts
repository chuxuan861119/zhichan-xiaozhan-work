import type { PatentBookDocument } from "../document/model.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../settings/model.js";
import { createBlankPatent } from "./defaults.js";
import {
  DESCRIPTION_CHAPTER_ORDER,
  descriptionChapterKinds,
  descriptionInventionTitle,
  insertMissingDescriptionChapters,
  missingDescriptionChapters,
} from "./description.js";

function descriptionDocument(): PatentBookDocument {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const book = patent.books.find((candidate) => candidate.kind === "description");
  if (!book) throw new Error("测试专利缺少说明书。");
  return book.document;
}

function headingTexts(document: PatentBookDocument): string[] {
  return document.content
    .filter((block) => block.type === "heading")
    .map((block) =>
      block.content
        .filter((inline) => inline.type === "text")
        .map((inline) => inline.text)
        .join(""),
    );
}

describe("description free-text chapter helpers", () => {
  test("recognizes the invention title from the first centered line without a semantic role", () => {
    const document = descriptionDocument();
    const first = document.content[0];
    if (first?.type !== "paragraph") throw new Error("测试说明书缺少首行");
    const titleWithoutRole: PatentBookDocument = {
      ...document,
      content: [
        {
          ...first,
          semanticRole: undefined,
          attrs: { ...first.attrs, alignment: "center" },
          content: [{ type: "text", text: "居中的发明名称", marks: [] }],
        },
        ...document.content.slice(1),
      ],
    };
    const centeredTitle = titleWithoutRole.content[0];
    if (centeredTitle?.type !== "paragraph") throw new Error("测试说明书缺少首行");

    expect(descriptionInventionTitle(titleWithoutRole)).toBe("居中的发明名称");
    expect(
      descriptionInventionTitle({
        ...titleWithoutRole,
        content: [
          { ...centeredTitle, attrs: { ...first.attrs, alignment: "left" } },
          ...titleWithoutRole.content.slice(1),
        ],
      }),
    ).toBeNull();
  });

  test("recognizes standard chapters only by exact text and flush-left formatting", () => {
    const document = descriptionDocument();
    const technicalField = document.content.find(
      (block) =>
        block.type === "heading" &&
        headingTexts({ ...document, content: [block] })[0] === "技术领域",
    );
    if (technicalField?.type !== "heading") {
      throw new Error("测试说明书缺少技术领域");
    }
    const textOnly = {
      ...technicalField,
      semanticRole: undefined,
      attrs: { ...technicalField.attrs, alignment: "left" as const, paragraphIndentMm: 0 },
    };

    expect(descriptionChapterKinds({ ...document, content: [textOnly] })).toEqual([
      "technical-field",
    ]);
    expect(
      descriptionChapterKinds({
        ...document,
        content: [
          {
            id: textOnly.id,
            type: "paragraph",
            attrs: { ...textOnly.attrs },
            content: structuredClone(textOnly.content),
          },
        ],
      }),
    ).toEqual(["technical-field"]);
    expect(
      descriptionChapterKinds({
        ...document,
        content: [
          {
            ...textOnly,
            semanticRole: "description-technical-field",
            attrs: { ...textOnly.attrs, paragraphIndentMm: 9.88 },
          },
        ],
      }),
    ).toEqual([]);
    expect(
      descriptionChapterKinds({
        ...document,
        content: [{ ...textOnly, content: [{ type: "text", text: "所属技术范围", marks: [] }] }],
      }),
    ).toEqual([]);
  });

  test("factory templates create the confirmed editable chapters", () => {
    expect(descriptionChapterKinds(descriptionDocument())).toEqual(DESCRIPTION_CHAPTER_ORDER);

    const utilityModelPatent = createBlankPatent({ patentType: "utility-model", name: null });
    const utilityModelDescription = utilityModelPatent.books.find(
      (candidate) => candidate.kind === "description",
    );
    if (!utilityModelDescription) throw new Error("测试专利缺少说明书。");

    expect(headingTexts(utilityModelDescription.document)).toContain("实用新型内容");
    expect(headingTexts(utilityModelDescription.document)).toContain("有益效果");
  });

  test("reports missing chapters without restoring deleted user content", () => {
    const document = descriptionDocument();
    const withoutTechnicalField: PatentBookDocument = {
      ...document,
      content: document.content.filter(
        (block) =>
          block.type !== "heading" ||
          block.content.some((inline) => inline.type === "text" && inline.text !== "技术领域"),
      ),
    };

    expect(missingDescriptionChapters(withoutTechnicalField, "invention")).toContain(
      "technical-field",
    );
    expect(headingTexts(withoutTechnicalField)).not.toContain("技术领域");
  });

  test("renamed formerly semantic headings are treated as missing chapters", () => {
    const document = descriptionDocument();
    const renamed: PatentBookDocument = {
      ...document,
      content: document.content.map((block) =>
        block.type === "heading" &&
        block.content.some((inline) => inline.type === "text" && inline.text === "技术领域")
          ? {
              ...block,
              semanticRole: "description-technical-field",
              content: [{ type: "text" as const, text: "所属技术范围", marks: [] }],
            }
          : block,
      ),
    };

    expect(missingDescriptionChapters(renamed, "invention")).toContain("technical-field");
    expect(headingTexts(renamed)).toContain("所属技术范围");
  });

  test("inserts missing chapters only when the explicit helper is invoked", () => {
    const document = descriptionDocument();
    const withoutBackground: PatentBookDocument = {
      ...document,
      content: document.content.filter(
        (block) =>
          block.type !== "heading" ||
          block.content.some((inline) => inline.type === "text" && inline.text !== "背景技术"),
      ),
    };

    const repaired = insertMissingDescriptionChapters(
      withoutBackground,
      "invention",
      DEFAULT_PATENT_TEMPLATE_SETTINGS,
    );

    expect(headingTexts(withoutBackground)).not.toContain("背景技术");
    expect(headingTexts(repaired)).toContain("背景技术");
  });
});
