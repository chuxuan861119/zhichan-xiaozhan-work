import type { ParagraphAttributes, PatentBookDocument } from "../document/model.js";
import { createBlankPatent } from "./defaults.js";
import {
  buildDocumentStructureRulerIndex,
  buildDocumentStructureRulerModel,
  collectPatentStructureIssues,
} from "./document-structure-ruler.js";

const LEFT: ParagraphAttributes = {
  alignment: "left",
  paragraphIndentMm: 0,
  lineSpacing: 1.5,
  defaultFontFamily: "SimSun",
  defaultFontSizePt: 12,
};

function documentFor(
  kind: "claims" | "description",
  entries: readonly Readonly<{
    text: string;
    alignment?: "left" | "center";
    indent?: number;
  }>[],
): PatentBookDocument {
  const patent = createBlankPatent({ patentType: "invention", name: "结构标尺测试" });
  const book = patent.books.find((candidate) => candidate.kind === kind);
  if (!book) throw new Error(`missing ${kind} book`);
  return {
    ...book.document,
    content: entries.map((entry, index) => ({
      id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      type: "paragraph",
      attrs: {
        ...LEFT,
        alignment: entry.alignment ?? "left",
        paragraphIndentMm: entry.indent ?? 0,
      },
      content: [{ type: "text", text: entry.text, marks: [] }],
    })),
  };
}

describe("document structure ruler index", () => {
  test("collects identical issues without building a full marker position index", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "测试" });
    const description = patent.books.find((book) => book.kind === "description");
    if (!description) throw new Error("missing description");
    description.document = documentFor("description", [
      { text: "技术领域" },
      ...Array.from({ length: 2000 }, () => ({ text: "长文档正文" })),
    ]);
    const expected = patent.books.flatMap((book) =>
      book.kind === "claims" || book.kind === "description"
        ? buildDocumentStructureRulerModel(book.document, book.kind).issues
        : [],
    );
    const indexScan = vi.spyOn(description.document.content, "forEach");
    expect(collectPatentStructureIssues(patent)).toEqual(expected);
    expect(indexScan).not.toHaveBeenCalled();
  });

  test("summarizes large missing-number ranges without allocating a marker per number", () => {
    const document = documentFor("claims", [
      { text: "1. 一种装置。" },
      { text: "10000. 粘贴的数字段落。" },
    ]);
    const before = structuredClone(document);
    const model = buildDocumentStructureRulerModel(document, "claims");
    expect(model.markers).toHaveLength(3);
    expect(model.issues.map((issue) => issue.summary)).toEqual(["缺少权利要求 2–9999"]);
    expect(model.markers.find((marker) => marker.virtual)?.targetBlockId).toBe(
      document.content[1]?.id,
    );
    expect(document).toEqual(before);
  });

  test("indexes paragraph positions once instead of searching the document during sort", () => {
    const document = documentFor("description", [
      { text: "技术领域" },
      ...Array.from({ length: 2000 }, (_, index) => ({ text: `正文${index}` })),
    ]);
    const search = vi.spyOn(document.content, "findIndex");
    const model = buildDocumentStructureRulerModel(document, "description");
    expect(model.markers.filter((marker) => marker.kind === "description-paragraph")).toHaveLength(
      2000,
    );
    expect(search).not.toHaveBeenCalled();
    search.mockRestore();
  });

  test("creates claim ranges from numbered starts and reports an unnumbered preface", () => {
    const document = documentFor("claims", [
      { text: "权利要求书前言" },
      { text: "1． 一种装置，包括：" },
      { text: "箱体和控制器。" },
      { text: "2、根据权利要求1所述的装置。" },
      { text: "3. 根据权利要求2所述的装置。" },
    ]);

    expect(buildDocumentStructureRulerIndex(document, "claims")).toEqual([
      {
        id: "warning:00000000-0000-4000-8000-000000000001",
        kind: "warning",
        label: "未识别段落",
        compactLabel: "!",
        targetBlockId: "00000000-0000-4000-8000-000000000001",
        endBlockId: "00000000-0000-4000-8000-000000000001",
        warning: true,
      },
      {
        id: "claim:1:00000000-0000-4000-8000-000000000002",
        kind: "claim",
        label: "权利要求 1",
        compactLabel: "权1",
        targetBlockId: "00000000-0000-4000-8000-000000000002",
        endBlockId: "00000000-0000-4000-8000-000000000003",
        warning: false,
      },
      {
        id: "claim:2:00000000-0000-4000-8000-000000000004",
        kind: "claim",
        label: "权利要求 2",
        compactLabel: "权2",
        targetBlockId: "00000000-0000-4000-8000-000000000004",
        endBlockId: "00000000-0000-4000-8000-000000000004",
        warning: false,
      },
      {
        id: "claim:3:00000000-0000-4000-8000-000000000005",
        kind: "claim",
        label: "权利要求 3",
        compactLabel: "权3",
        targetBlockId: "00000000-0000-4000-8000-000000000005",
        endBlockId: "00000000-0000-4000-8000-000000000005",
        warning: false,
      },
    ]);
  });

  test("creates visible description headings and virtual paragraph numbers without mutating text", () => {
    const document = documentFor("description", [
      { text: "结构标尺测试", alignment: "center" },
      { text: "技术领域" },
      { text: "本发明涉及机械设备。", indent: 7.4 },
      { text: "要解决的技术问题" },
      { text: "需要提高定位精度。", indent: 7.4 },
      { text: "技术方案" },
      { text: "采用可调定位结构。", indent: 7.4 },
      { text: "有益效果" },
      { text: "能够提高定位效率。", indent: 7.4 },
    ]);
    const before = structuredClone(document);

    const markers = buildDocumentStructureRulerIndex(document, "description");

    expect(markers[0]).toEqual(
      expect.objectContaining({
        kind: "description-chapter",
        label: "专利题目",
        compactLabel: "题",
        targetBlockId: "00000000-0000-4000-8000-000000000001",
      }),
    );
    expect(markers.filter((marker) => marker.kind === "description-chapter")).toEqual([
      expect.objectContaining({ label: "专利题目", compactLabel: "题" }),
      expect.objectContaining({ label: "技术领域", compactLabel: "技" }),
      expect.objectContaining({ label: "有益效果", compactLabel: "效" }),
    ]);
    expect(markers.map((marker) => marker.label)).not.toContain("要解决的技术问题");
    expect(markers.map((marker) => marker.label)).not.toContain("技术方案");
    expect(
      markers
        .filter((marker) => marker.kind === "description-paragraph")
        .map((marker) => [marker.label, marker.compactLabel]),
    ).toEqual([
      ["[0001]", "1"],
      ["[0002]", "2"],
      ["[0003]", "3"],
      ["[0004]", "4"],
    ]);
    expect(document).toEqual(before);
  });

  test("marks every duplicate claim and inserts aggregated missing-number errors", () => {
    const document = documentFor("claims", [
      { text: "1. 一种装置。" },
      { text: "2. 根据权利要求1所述的装置。" },
      { text: "2. 根据权利要求1所述的另一装置。" },
      { text: "4. 根据权利要求2所述的装置。" },
    ]);

    const model = buildDocumentStructureRulerModel(document, "claims");

    expect(model.issues.map((issue) => issue.summary)).toEqual([
      "权利要求 2 重复（2 处）",
      "缺少权利要求 3",
    ]);
    expect(model.markers.filter((marker) => marker.error).map((marker) => marker.label)).toEqual([
      "权利要求 2 · 重复",
      "权利要求 2 · 重复",
      "缺少权利要求 3",
    ]);
    expect(
      model.markers.filter((marker) => marker.error).map((marker) => marker.displayLabel),
    ).toEqual(["权2 重复", "权2 重复", "缺权3"]);
    expect(model.markers.find((marker) => marker.label === "缺少权利要求 3")).toEqual(
      expect.objectContaining({
        virtual: true,
        virtualPlacement: "before",
        targetBlockId: "00000000-0000-4000-8000-000000000004",
      }),
    );
  });

  test("reports duplicate visible chapters and missing required description chapters", () => {
    const document = documentFor("description", [
      { text: "结构标尺测试", alignment: "center" },
      { text: "技术领域" },
      { text: "本发明涉及机械设备。", indent: 7.4 },
      { text: "附图说明" },
      { text: "图1为结构示意图。", indent: 7.4 },
      { text: "附图说明" },
      { text: "图2为另一结构示意图。", indent: 7.4 },
      { text: "具体实施方式" },
      { text: "以下结合附图进行说明。", indent: 7.4 },
    ]);

    const model = buildDocumentStructureRulerModel(document, "description");

    expect(model.issues.map((issue) => issue.summary)).toEqual([
      "缺少背景技术",
      "缺少发明内容",
      "附图说明重复（2 处）",
    ]);
    expect(
      model.markers
        .filter((marker) => marker.error && marker.kind === "description-chapter")
        .map((marker) => marker.label),
    ).toEqual(["附图说明 · 重复", "附图说明 · 重复"]);
    expect(
      model.markers.filter((marker) => marker.error).map((marker) => marker.displayLabel),
    ).toEqual(["缺背景技术", "缺发明内容", "附图说明重复", "附图说明重复"]);
    expect(model.markers.map((marker) => marker.label)).not.toContain("要解决的技术问题");
    expect(model.markers.map((marker) => marker.label)).not.toContain("技术方案");
  });

  test("collects claim and description issues for aggregate patent export", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "结构标尺测试" });
    const claims = patent.books.find((book) => book.kind === "claims");
    const description = patent.books.find((book) => book.kind === "description");
    if (!claims || !description) throw new Error("missing patent text books");
    claims.document = documentFor("claims", [
      { text: "1. 一种装置。" },
      { text: "3. 根据权利要求1所述的装置。" },
    ]);
    description.document = documentFor("description", [
      { text: "结构标尺测试", alignment: "center" },
      { text: "技术领域" },
      { text: "本发明涉及机械设备。", indent: 7.4 },
      { text: "具体实施方式" },
      { text: "以下结合附图进行说明。", indent: 7.4 },
    ]);

    expect(collectPatentStructureIssues(patent).map((issue) => issue.summary)).toEqual([
      "缺少权利要求 2",
      "缺少背景技术",
      "缺少发明内容",
      "缺少附图说明",
    ]);
  });

  test("reports required structures when a text book is completely empty", () => {
    const claims = documentFor("claims", []);
    const description = documentFor("description", []);

    expect(
      buildDocumentStructureRulerModel(claims, "claims").issues.map((issue) => issue.summary),
    ).toEqual(["缺少权利要求 1"]);
    expect(
      buildDocumentStructureRulerModel(description, "description").issues.map(
        (issue) => issue.summary,
      ),
    ).toEqual(["缺少技术领域", "缺少背景技术", "缺少发明内容", "缺少附图说明", "缺少具体实施方式"]);
  });

  test("shortens the detailed-embodiments error label without losing its full label", () => {
    const document = documentFor("description", [
      { text: "结构标尺测试", alignment: "center" },
      { text: "技术领域" },
      { text: "背景技术" },
      { text: "发明内容" },
      { text: "附图说明" },
    ]);

    expect(
      buildDocumentStructureRulerModel(document, "description").markers.find(
        (marker) => marker.label === "缺少具体实施方式",
      ),
    ).toEqual(expect.objectContaining({ displayLabel: "缺实施方式" }));
  });
});
