import { Document, Packer, Paragraph } from "docx";
import { TableNodeSchema } from "../../shared/document/model.js";
import { convertParsedWordDocument } from "./docx-canonical-converter.js";
import { readDocxPackageBuffer } from "./docx-package-reader.js";
import { createDocxTestPackage } from "./docx-test-package.js";
import { parseWordprocessingDocument } from "./wordprocessingml-parser.js";

const namespaces =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

function documentXml(body: string): string {
  return `<w:document ${namespaces}><w:body>${body}</w:body></w:document>`;
}

describe("WordprocessingML parser", () => {
  test.each(["exact", "atLeast"])(
    "does not misread %s point spacing as multiple spacing",
    async (rule) => {
      const bytes = await createDocxTestPackage([
        [
          "word/document.xml",
          documentXml(
            '<w:p><w:r><w:t>正文</w:t></w:r></w:p><w:p><w:pPr><w:spacing w:lineRule="auto" w:line="480"/></w:pPr><w:r><w:t>双倍</w:t></w:r></w:p>',
          ),
        ],
        [
          "word/styles.xml",
          `<w:styles ${namespaces}><w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:lineRule="${rule}" w:line="560"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`,
        ],
      ]);
      const parsed = await parseWordprocessingDocument(
        await readDocxPackageBuffer(bytes, "spacing.docx"),
      );
      expect(parsed.blocks[0]).toMatchObject({ lineSpacing: null });
      expect(parsed.blocks[1]).toMatchObject({ lineSpacing: 2 });
      expect(parsed.warnings).toEqual([
        expect.objectContaining({ code: "SIMPLIFIED_PARAGRAPH_SPACING" }),
      ]);
      const converted = convertParsedWordDocument(parsed, { title: "行距", mode: "auxiliary" });
      expect(converted.warnings).toEqual(parsed.warnings);
    },
  );

  test.each([
    ['<w:highlight w:val="green"/>', "#00FF00"],
    ['<w:highlight w:val="none"/>', "#12AB34"],
    ['<w:highlight w:val="none"/><w:shd w:val="nil"/>', undefined],
    ['<w:highlight w:val="none"/><w:shd w:fill="auto"/>', undefined],
  ])("resolves inherited highlight and shading independently: %s", async (direct, expected) => {
    const bytes = await createDocxTestPackage([
      [
        "word/document.xml",
        documentXml(`<w:p><w:r><w:rPr>${direct}</w:rPr><w:t>背景</w:t></w:r></w:p>`),
      ],
      [
        "word/styles.xml",
        `<w:styles ${namespaces}><w:docDefaults><w:rPrDefault><w:rPr><w:highlight w:val="yellow"/><w:shd w:val="clear" w:fill="12AB34"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`,
      ],
    ]);
    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "background.docx"),
    );
    const paragraph = parsed.blocks[0];
    if (paragraph?.type !== "paragraph" || paragraph.inlines[0]?.type !== "text")
      throw new Error("Missing text");
    expect(paragraph.inlines[0].style.backgroundColor).toBe(expected);
  });
  test("explicit text style resets override inherited formatting", async () => {
    const bytes = await createDocxTestPackage([
      [
        "word/document.xml",
        documentXml(
          '<w:p><w:r><w:rPr><w:u w:val="none"/><w:color w:val="auto"/><w:highlight w:val="none"/><w:vertAlign w:val="baseline"/></w:rPr><w:t>正常文字</w:t></w:r></w:p>',
        ),
      ],
      [
        "word/styles.xml",
        `<w:styles ${namespaces}><w:docDefaults><w:rPrDefault><w:rPr><w:u w:val="single"/><w:color w:val="FF0000"/><w:highlight w:val="yellow"/><w:vertAlign w:val="superscript"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`,
      ],
    ]);
    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "reset.docx"),
    );
    const paragraph = parsed.blocks[0];
    if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
    expect(paragraph.inlines[0]).toMatchObject({ type: "text", text: "正常文字", style: {} });
    if (paragraph.inlines[0]?.type !== "text") throw new Error("Missing text");
    expect(paragraph.inlines[0].style).toEqual({});
  });

  test("retains DOCX run shading as text background color", async () => {
    const bytes = await createDocxTestPackage([
      [
        "word/document.xml",
        documentXml(
          '<w:p><w:r><w:rPr><w:shd w:val="clear" w:fill="12AB34"/></w:rPr><w:t>高亮</w:t></w:r></w:p>',
        ),
      ],
    ]);
    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "shading.docx"),
    );
    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      inlines: [{ type: "text", style: { backgroundColor: "#12AB34" } }],
    });
  });
  test.each(["none", "row", "cell"])(
    "preserves nested content with %s content controls",
    async (wrapper) => {
      const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
      const control = (xml: string) => `<w:sdt><w:sdtContent>${xml}</w:sdtContent></w:sdt>`;
      const cell = `<w:tc>
      ${p("之前")}
      ${control(p("控件内容"))}
      <w:tbl><w:tr><w:tc>${p("内表甲")}</w:tc><w:tc>${p("内表乙")}</w:tc></w:tr></w:tbl>
      <w:del>${p("已删除")}</w:del><w:ins>${p("新增")}</w:ins>
      ${p("之后")}
    </w:tc>`;
      const row = `<w:tr>${wrapper === "cell" ? control(cell) : cell}</w:tr>`;
      const bytes = await createDocxTestPackage([
        [
          "word/document.xml",
          documentXml(`<w:tbl>${wrapper === "row" ? control(row) : row}</w:tbl>`),
        ],
      ]);
      const parsed = await parseWordprocessingDocument(
        await readDocxPackageBuffer(bytes, "nested.docx"),
      );
      const table = parsed.blocks[0];
      if (table?.type !== "table") throw new Error("Missing table");
      expect(
        table.rows[0]?.cells[0]?.paragraphs.map((paragraph) =>
          paragraph.inlines.map((inline) => (inline.type === "text" ? inline.text : "")).join(""),
        ),
      ).toEqual(["之前", "控件内容", "内表甲", "内表乙", "新增", "之后"]);
      expect(parsed.warnings).toContainEqual(
        expect.objectContaining({ code: "SIMPLIFIED_NESTED_TABLE" }),
      );
      const converted = convertParsedWordDocument(parsed, {
        title: "导入表格",
        mode: "formal-book",
        bookKind: "description",
      });
      const savedTable = TableNodeSchema.parse(
        converted.document.content.find((node) => node.type === "table"),
      );
      expect(
        savedTable.rows[0]?.cells[0]?.content.map((paragraph) =>
          paragraph.content.map((inline) => (inline.type === "text" ? inline.text : "")).join(""),
        ),
      ).toEqual(["之前", "控件内容", "内表甲", "内表乙", "新增", "之后"]);
      expect(converted.warnings).toEqual(parsed.warnings);
    },
  );
  test("parses a standard DOCX package produced by docx.js", async () => {
    const bytes = await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph({ text: "真实 DOCX 正文" })] }] }),
    );

    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "标准文档.docx"),
    );

    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      inlines: [{ type: "text", text: "真实 DOCX 正文" }],
    });
  });

  test("parses headings, formatted runs, links, formulas, lists, tables, images and final revisions", async () => {
    const xml = documentXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>实验报告</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:b/><w:i/><w:u w:val="single"/><w:rFonts w:ascii="Arial"/><w:sz w:val="24"/><w:color w:val="FF0000"/><w:highlight w:val="yellow"/><w:vertAlign w:val="superscript"/></w:rPr><w:t>重点</w:t><w:br/></w:r><w:hyperlink r:id="rLink"><w:r><w:t>链接文字</w:t></w:r></w:hyperlink><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>
      <w:tbl><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><a:graphic><a:graphicData uri="picture"><pic:pic><pic:blipFill><a:blip r:embed="rImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
      <w:p><w:del><w:r><w:delText>已删除</w:delText></w:r></w:del><w:ins><w:r><w:t>最终内容</w:t></w:r></w:ins></w:p>
    `);
    const bytes = await createDocxTestPackage([
      ["word/document.xml", xml],
      [
        "word/numbering.xml",
        `<w:numbering ${namespaces}><w:abstractNum w:abstractNumId="9"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="9"/></w:num></w:numbering>`,
      ],
      [
        "word/_rels/document.xml.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rLink" Type="hyperlink" Target="https://example.com" TargetMode="External"/><Relationship Id="rImg" Type="image" Target="media/image1.png"/></Relationships>',
      ],
      ["word/media/image1.png", new Uint8Array([1, 2, 3])],
    ]);
    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "实验报告.docx"),
    );

    expect(parsed.blocks[0]).toMatchObject({ type: "paragraph", headingLevel: 1 });
    expect(parsed.blocks[1]).toMatchObject({
      type: "paragraph",
      inlines: [
        {
          type: "text",
          text: "重点",
          style: {
            bold: true,
            italic: true,
            underline: true,
            fontFamily: "Arial",
            fontSizePt: 12,
            color: "#FF0000",
            backgroundColor: "#FFFF00",
            verticalAlign: "superscript",
          },
        },
        { type: "break" },
        { type: "text", text: "链接文字" },
        { type: "formula", latex: "\\frac{1}{2}" },
      ],
    });
    expect(parsed.blocks[2]).toMatchObject({
      type: "paragraph",
      list: { kind: "ordered", start: 1 },
    });
    expect(parsed.blocks[3]).toMatchObject({ type: "table", rows: [{ cells: [{ colSpan: 2 }] }] });
    expect(parsed.blocks[4]).toMatchObject({
      type: "paragraph",
      inlines: [{ type: "image", relationshipId: "rImg", widthEmu: 914400 }],
    });
    expect(parsed.blocks[5]).toMatchObject({
      type: "paragraph",
      inlines: [{ type: "text", text: "最终内容" }],
    });
  });

  test("creates visible warnings for unsupported SmartArt, charts and text boxes", async () => {
    const bytes = await createDocxTestPackage([
      [
        "word/document.xml",
        documentXml(
          '<w:p><w:r><w:drawing><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:graphic></w:drawing></w:r></w:p><w:p><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>文本框</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>',
        ),
      ],
    ]);

    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "不支持对象.docx"),
    );

    expect(parsed.warnings.map((warning) => warning.code)).toEqual([
      "UNSUPPORTED_SMARTART",
      "UNSUPPORTED_TEXT_BOX",
    ]);
    expect(
      parsed.blocks.flatMap((block) => (block.type === "paragraph" ? block.inlines : [])),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "unsupported", label: "SmartArt" }),
        expect.objectContaining({ type: "unsupported", label: "文本框" }),
      ]),
    );
  });

  test("imports paragraphs and tables wrapped by body-level content controls", async () => {
    const bytes = await createDocxTestPackage([
      [
        "word/document.xml",
        documentXml(`
          <w:sdt>
            <w:sdtPr><w:alias w:val="专利正文"/></w:sdtPr>
            <w:sdtContent>
              <w:p><w:r><w:t>内容控件中的段落</w:t></w:r></w:p>
              <w:tbl><w:tr><w:tc><w:p><w:r><w:t>内容控件中的表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            </w:sdtContent>
          </w:sdt>
        `),
      ],
    ]);

    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "内容控件.docx"),
    );

    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      inlines: [{ type: "text", text: "内容控件中的段落" }],
    });
    expect(parsed.blocks[1]).toMatchObject({
      type: "table",
      rows: [{ cells: [{ paragraphs: [{ inlines: [{ text: "内容控件中的表格" }] }] }] }],
    });
  });

  test("honors explicit false values for Word run formatting switches", async () => {
    const bytes = await createDocxTestPackage([
      [
        "word/document.xml",
        documentXml(
          '<w:p><w:r><w:rPr><w:b w:val="0"/><w:i w:val="false"/><w:u w:val="none"/></w:rPr><w:t>普通文字</w:t></w:r></w:p>',
        ),
      ],
    ]);

    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "关闭格式.docx"),
    );

    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      inlines: [{ type: "text", text: "普通文字", style: {} }],
    });
  });

  test("resolves inherited paragraph and character styles before importing visible formatting", async () => {
    const bytes = await createDocxTestPackage([
      [
        "word/document.xml",
        documentXml(`
          <w:p>
            <w:pPr><w:pStyle w:val="ImportedBody"/></w:pPr>
            <w:r><w:t>继承格式</w:t></w:r>
            <w:r><w:rPr><w:rStyle w:val="Emphasis"/><w:b w:val="0"/></w:rPr><w:t>局部格式</w:t></w:r>
          </w:p>
        `),
      ],
      [
        "word/styles.xml",
        `<w:styles ${namespaces}>
          <w:docDefaults>
            <w:rPrDefault><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="28"/></w:rPr></w:rPrDefault>
            <w:pPrDefault><w:pPr><w:spacing w:line="360"/></w:pPr></w:pPrDefault>
          </w:docDefaults>
          <w:style w:type="paragraph" w:styleId="BasePatent">
            <w:pPr><w:jc w:val="center"/><w:ind w:firstLine="720"/></w:pPr>
            <w:rPr><w:b/><w:rFonts w:ascii="Arial"/></w:rPr>
          </w:style>
          <w:style w:type="paragraph" w:styleId="ImportedBody">
            <w:basedOn w:val="BasePatent"/>
            <w:pPr><w:jc w:val="both"/></w:pPr>
            <w:rPr><w:i/></w:rPr>
          </w:style>
          <w:style w:type="character" w:styleId="Emphasis">
            <w:rPr><w:u w:val="single"/><w:color w:val="FF0000"/></w:rPr>
          </w:style>
        </w:styles>`,
      ],
    ]);

    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "继承样式.docx"),
    );

    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      alignment: "justify",
      firstLineIndentMm: 12.7,
      lineSpacing: 1.5,
      inlines: [
        {
          type: "text",
          text: "继承格式",
          style: {
            bold: true,
            italic: true,
            fontFamily: "Arial",
            fontSizePt: 14,
          },
        },
        {
          type: "text",
          text: "局部格式",
          style: {
            italic: true,
            underline: true,
            fontFamily: "Arial",
            fontSizePt: 14,
            color: "#FF0000",
          },
        },
      ],
    });
  });

  test("applies the default paragraph style when a paragraph has no explicit style", async () => {
    const bytes = await createDocxTestPackage([
      ["word/document.xml", documentXml("<w:p><w:r><w:t>默认样式正文</w:t></w:r></w:p>")],
      [
        "word/styles.xml",
        `<w:styles ${namespaces}>
          <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
            <w:pPr><w:jc w:val="center"/></w:pPr>
            <w:rPr><w:b/><w:rFonts w:eastAsia="宋体"/></w:rPr>
          </w:style>
        </w:styles>`,
      ],
    ]);

    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "默认样式.docx"),
    );

    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      alignment: "center",
      inlines: [
        {
          type: "text",
          text: "默认样式正文",
          style: { bold: true, fontFamily: "宋体" },
        },
      ],
    });
  });

  test("removes pagination fields while retaining other field results and excluding hidden text", async () => {
    const bytes = await createDocxTestPackage([
      [
        "word/document.xml",
        documentXml(`
          <w:p>
            <w:r><w:fldChar w:fldCharType="begin"/></w:r>
            <w:r><w:instrText> PAGE </w:instrText></w:r>
            <w:r><w:fldChar w:fldCharType="separate"/></w:r>
            <w:r><w:t>3</w:t></w:r>
            <w:r><w:fldChar w:fldCharType="end"/></w:r>
            <w:r><w:fldChar w:fldCharType="begin"/></w:r>
            <w:r><w:instrText> REF _Ref123 </w:instrText></w:r>
            <w:r><w:fldChar w:fldCharType="separate"/></w:r>
            <w:r><w:t>技术领域</w:t></w:r>
            <w:r><w:fldChar w:fldCharType="end"/></w:r>
            <w:fldSimple w:instr=" PAGE "><w:r><w:t>4</w:t></w:r></w:fldSimple>
            <w:fldSimple w:instr=" REF _Ref456 "><w:r><w:t>背景技术</w:t></w:r></w:fldSimple>
            <w:r><w:rPr><w:vanish/></w:rPr><w:t>内部隐藏说明</w:t></w:r>
            <w:r><w:t>可见正文</w:t></w:r>
          </w:p>
        `),
      ],
    ]);

    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "字段和隐藏文字.docx"),
    );

    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      inlines: [
        { type: "text", text: "技术领域" },
        { type: "text", text: "背景技术" },
        { type: "text", text: "可见正文" },
      ],
    });
  });

  test("reports section ranges from real Word headers without importing header text", async () => {
    const xml = documentXml(`
      <w:p><w:r><w:t>摘要正文</w:t></w:r><w:pPr><w:sectPr><w:headerReference r:id="rHeader1"/></w:sectPr></w:pPr></w:p>
      <w:p><w:r><w:t>1. 权利要求正文</w:t></w:r></w:p>
      <w:sectPr><w:headerReference r:id="rHeader2"/></w:sectPr>
    `);
    const bytes = await createDocxTestPackage([
      ["word/document.xml", xml],
      [
        "word/_rels/document.xml.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rHeader1" Type="header" Target="header1.xml"/><Relationship Id="rHeader2" Type="header" Target="header2.xml"/></Relationships>',
      ],
      [
        "word/header1.xml",
        `<w:hdr ${namespaces}><w:p><w:r><w:t>说明书摘要</w:t></w:r></w:p></w:hdr>`,
      ],
      [
        "word/header2.xml",
        `<w:hdr ${namespaces}><w:p><w:r><w:t>权利要求书</w:t></w:r></w:p></w:hdr>`,
      ],
    ]);

    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "分节五书.docx"),
    );

    expect(parsed.sections).toEqual([
      { startBlockIndex: 0, endBlockIndex: 1, headerText: "说明书摘要" },
      { startBlockIndex: 1, endBlockIndex: 2, headerText: "权利要求书" },
    ]);
    expect(JSON.stringify(parsed.blocks)).not.toContain("说明书摘要");
    expect(JSON.stringify(parsed.blocks)).not.toContain("权利要求书");
  });
});
