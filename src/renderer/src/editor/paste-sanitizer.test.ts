import { PATENT_FIRST_LINE_INDENT_MM } from "../../../shared/patent/formatting";
import {
  extractClipboardDataImages,
  sanitizePastedHtml,
  sanitizePastedHtmlWithFormulas,
} from "./paste-sanitizer";

test("preserves table annotations and alignment in copied table HTML", () => {
  const html = sanitizePastedHtml(
    '<table data-pm-slice="1 1 []" data-table-name-enabled="true" data-table-name="测试结果" data-table-note-enabled="false" data-table-note="保留说明" data-table-alignment="center"><tr><td>数据</td></tr></table>',
  );
  for (const attribute of [
    'data-table-name-enabled="true"',
    'data-table-name="测试结果"',
    'data-table-note-enabled="false"',
    'data-table-note="保留说明"',
    'data-table-alignment="center"',
  ])
    expect(html).toContain(attribute);
});

const DEFAULT_INDENT = String(PATENT_FIRST_LINE_INDENT_MM);

/** 依次取出清洗结果中每个 `<p>` 的段落缩进属性（未写入为 null）。 */
function paragraphIndents(html: string): (string | null)[] {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return [...parsed.body.querySelectorAll("p")].map((element) =>
    element.getAttribute("data-paragraph-indent-mm"),
  );
}

test("keeps supported patent content and removes executable, hidden, remote, and Word noise", () => {
  const input = `
    <script>alert(1)</script>
    <p onclick="alert(2)" style="mso-margin-top-alt:auto;color:#123456;text-align:center">技术方案</p>
    <p style="display:none">隐藏内容</p>
    <a href="javascript:alert(3)">危险链接</a>
    <img src="https://evil.test/tracker.png">
    <img src="data:image/png;base64,AAAA">
    <p><strong>加粗</strong><span style="font-size:999pt;font-family:SimSun">正文</span></p>
    <ul><li>项目</li></ul>
    <table><tbody><tr><td colspan="2">单元格</td></tr></tbody></table>`;

  const output = sanitizePastedHtml(input);

  expect(output).toContain("技术方案");
  expect(
    new DOMParser().parseFromString(output, "text/html").querySelector("strong")?.textContent,
  ).toBe("加粗");
  expect(output).toContain("<ul>");
  expect(output).toContain("<table ");
  expect(output).toContain('colspan="2"');
  expect(output).not.toMatch(/script|onclick|javascript:|evil\.test|<img|隐藏内容|mso-/iu);
});

test("strips font typography but keeps paragraph indent, color, and alignment", () => {
  const input =
    "<p style=\"font-size:28pt;font-family:'Times New Roman';color:#ff0000;text-indent:10mm;text-align:center\">超大字号文字</p>";
  const output = sanitizePastedHtml(input);
  expect(output).not.toMatch(/font-size|font-family/iu);
  expect(output).toContain('data-paragraph-indent-mm="10"');
  expect(output).toContain("color: #ff0000");
  expect(output).toContain("text-align: center");
  expect(output).toContain("超大字号文字");
});

test("keeps text colors in hex, rgb, rgba opacity one, and named forms normalized to #RRGGBB", () => {
  const input =
    '<p style="color:#0f0">三色</p><p style="color:rgb(255, 0, 128)">RGB</p><p style="color:rgba(12, 34, 56, 1.0)">RGBA</p><p style="color:red">命名</p><p style="color:#abcdef">六位</p>';
  const output = sanitizePastedHtml(input);
  expect(output).toContain("color: #00ff00");
  expect(output).toContain("color: #ff0080");
  expect(output).toContain("color: #0c2238");
  expect(output).toContain("color: #ff0000");
  expect(output).toContain("color: #abcdef");
});

test("migrates Word font colors and preserves strict highlight colors", () => {
  const input =
    '<p><font color="#123abc" size="7" face="Unsafe">字体颜色</font><span style="background-color:rgb(255, 255, 0);color:rgba(0, 16, 32, 1)">高亮</span></p>';
  const output = sanitizePastedHtml(input);
  expect(output).toContain("字体颜色");
  expect(output).toContain("高亮");
  expect(output).toContain("color: #123abc");
  expect(output).toContain("color: #001020");
  expect(output).toContain("background-color: #ffff00");
  expect(output).not.toMatch(/<font|\bsize=|\bface=/iu);
});

test("drops transparent and unsupported CSS colors while retaining safe content", () => {
  const output = sanitizePastedHtml(
    '<p style="color:rgba(1,2,3,0.5);background-color:hsl(0, 100%, 50%)">无效颜色</p><p style="color:rgb(256, 0, 0);background-color:var(--word-highlight)">仍然保留文本</p>',
  );
  expect(output).toContain("无效颜色");
  expect(output).toContain("仍然保留文本");
  expect(output).not.toMatch(/rgba|hsl|var\(|color:/iu);
});

test("converts restricted font colors and keeps only fully opaque rgba highlights", () => {
  const output = sanitizePastedHtml(
    '<p><font color="#F00" onclick="alert(1)" size="7" face="Unsafe">红色文字</font><span style="background-color:rgba(1,2,3,1)">不透明高亮</span><span style="background-color:rgba(1,2,3,0.99)">透明高亮</span></p>',
  );

  expect(output).toContain("color: #ff0000");
  expect(output).toContain("background-color: #010203");
  expect(output).toContain("红色文字");
  expect(output).toContain("不透明高亮");
  expect(output).toContain("透明高亮");
  expect(output).not.toMatch(/<font|onclick|\bsize=|\bface=|rgba\(/iu);
  expect(output).not.toContain("background-color: rgba(1,2,3,0.99)");
});

test("keeps explicit right, justify and left alignment", () => {
  const output = sanitizePastedHtml(
    '<p style="text-align:right">右对齐</p><p style="text-align:justify">两端</p><p style="text-align:left">左对齐</p>',
  );
  expect(output).toContain("text-align: right");
  expect(output).toContain("text-align: justify");
  expect(output).toContain("text-align: left");
});

test("keeps alignment from HTML align attribute (Word common format)", () => {
  const output = sanitizePastedHtml(
    '<p align="center">居中</p><p align="right">右对齐</p><p align="justify">两端</p><p align="left">左对齐</p>',
  );
  expect(output).toContain("text-align: center");
  expect(output).toContain("text-align: right");
  expect(output).toContain("text-align: justify");
  expect(output).toContain("text-align: left");
  // 原始 align 属性已被 DOMPurify 剥离，对齐转为 inline style 保留
  expect(output).not.toMatch(/\balign="/iu);
});

test("normalizes Word numbered item indent to patent 2-character standard", () => {
  const input =
    '<p style="margin-left:21.0pt;text-indent:-21.0pt;mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">1.</span><span style="mso-tab-count:1">   </span>一种设备</p>' +
    '<p style="margin-left:21.0pt;text-indent:-21.0pt;mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">2.</span><span style="mso-tab-count:1">   </span>另一种设备</p>';
  const output = sanitizePastedHtml(input);
  const parsed = new DOMParser().parseFromString(output, "text/html");
  const paragraphs = [...parsed.body.querySelectorAll("p")];
  expect(paragraphs).toHaveLength(2);
  // Word 编号项缩进统一为专利标准两字符缩进（9.88mm），不再保留 Word 原始 margin-left。
  expect(paragraphs[0]?.getAttribute("data-paragraph-indent-mm")).toBe("9.88");
  expect(paragraphs[1]?.getAttribute("data-paragraph-indent-mm")).toBe("9.88");
  // 编号与正文之间的多余空白压缩为单个空格：1. 一种设备
  expect(parsed.body.textContent).toContain("1. 一种设备");
  expect(parsed.body.textContent).toContain("2. 另一种设备");
});

test("collapses the gap after bracketed list numbers", () => {
  const output = sanitizePastedHtml(
    '<p style="margin-left:21.0pt;mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">（1）</span><span>　　</span>步骤</p>',
  );
  const parsed = new DOMParser().parseFromString(output, "text/html");
  expect(parsed.body.textContent).toContain("（1） 步骤");
});

test("does not touch plain paragraphs that start with digits without a number pattern", () => {
  const output = sanitizePastedHtml("<p>2026 年  统计</p>");
  expect(output).toContain("2026 年");
});

test("converts Word first-line indent units to millimeters", () => {
  // Word 2 字符缩进：五号字(10.5pt) 时导出为 text-indent:21.0pt。
  const ptOutput = sanitizePastedHtml('<p style="text-indent:21.0pt">方案</p>');
  expect(ptOutput).toContain('data-paragraph-indent-mm="7.41"');

  // 来源未给字号时使用本软件的 14pt 正文基准（2em ≈ 9.88mm）。
  const emOutput = sanitizePastedHtml('<p style="text-indent:2em">方案</p>');
  expect(emOutput).toContain('data-paragraph-indent-mm="9.88"');

  // 厘米与英寸同样换算为毫米。
  expect(sanitizePastedHtml('<p style="text-indent:0.74cm">甲</p>')).toContain(
    'data-paragraph-indent-mm="7.4"',
  );
  expect(sanitizePastedHtml('<p style="text-indent:0.5in">乙</p>')).toContain(
    'data-paragraph-indent-mm="12.7"',
  );
});

test("keeps the indent on every pasted paragraph and drops indent on inline spans", () => {
  const output = sanitizePastedHtml(
    '<p style="text-indent:10mm">第一段</p><p style="mso-char-indent-count:2.0;text-indent:2em">第二段</p><p><span style="text-indent:10mm">行内不生效</span></p>',
  );
  const parsed = new DOMParser().parseFromString(output, "text/html");
  const paragraphs = [...parsed.body.querySelectorAll("p")];
  expect(paragraphs[0]?.getAttribute("data-paragraph-indent-mm")).toBe("10");
  expect(paragraphs[1]?.getAttribute("data-paragraph-indent-mm")).toBe("9.88");
  // 行内 span 上的 text-indent 无效，不保留。
  expect(parsed.body.querySelector("span")?.getAttribute("data-paragraph-indent-mm")).toBeNull();
  expect(output).toContain("行内不生效");
});

test("preserves runs of spaces and expands every external tab to four visible spaces", () => {
  const output = sanitizePastedHtml("<p>技术  方案\t\t及其改进\t完成</p>");
  expect(output).toContain("&nbsp;");
  const parsed = new DOMParser().parseFromString(output, "text/html");
  // 外部 HTML 的普通空格按原数量保留；每个制表符统一显示为四个空格。
  expect(parsed.body.textContent).toContain(
    `技术\u00A0\u00A0方案${"\u00A0".repeat(8)}及其改进${"\u00A0".repeat(4)}完成`,
  );
  // 单个空格不受影响（保持普通空格）。
  expect(sanitizePastedHtml("<p>技术 方案</p>")).toContain("技术 方案");
});

test("expands a standalone external tab between inline elements to four visible spaces", () => {
  const output = sanitizePastedHtml("<p><span>技术</span>\t<span>方案</span></p>");
  const parsed = new DOMParser().parseFromString(output, "text/html");

  expect(parsed.body.textContent).toBe(`技术${"\u00A0".repeat(4)}方案`);
});

test("keeps ordinary spaces unchanged for internal ProseMirror clipboard html", () => {
  const result = sanitizePastedHtmlWithFormulas('<p data-pm-slice="1 1 []">甲    乙</p>');

  expect(result.internalProseMirrorSlice).toBe(true);
  const parsed = new DOMParser().parseFromString(result.html, "text/html");
  expect(parsed.body.textContent).toBe("甲    乙");
  expect(parsed.body.textContent).not.toContain("\u00A0");
});

test("keeps the gap after numbered text unchanged for internal ProseMirror clipboard html", () => {
  const result = sanitizePastedHtmlWithFormulas('<p data-pm-slice="1 1 []">1.    一种设备</p>');

  expect(result.internalProseMirrorSlice).toBe(true);
  const parsed = new DOMParser().parseFromString(result.html, "text/html");
  expect(parsed.body.textContent).toBe("1.    一种设备");
});

test("does not treat an ordinary external numbered paragraph as a Word auto-numbered item", () => {
  const output = sanitizePastedHtml("<p>1.    一种设备</p>");
  const parsed = new DOMParser().parseFromString(output, "text/html");

  expect(parsed.body.textContent).toBe(`1.${"\u00A0".repeat(4)}一种设备`);
});

test("keeps block structure while stripping inline styles", () => {
  const input = `
    <h1 style="font-size:48pt">标题</h1>
    <ol style="list-style-type:decimal"><li style="font-size:20pt">条目</li></ol>
    <table style="width:600px"><tbody><tr style="height:40pt"><td style="font-size:30pt">甲</td><td>乙</td></tr></tbody></table>`;
  const output = sanitizePastedHtml(input);
  expect(output).toContain("<h1>");
  expect(output).toContain("<ol>");
  expect(output).toContain("<table ");
  expect(output).toContain("<li>");
  expect(output).not.toMatch(/style=|font-size/iu);
});

test("drops remote images instead of creating import markers", () => {
  const result = sanitizePastedHtmlWithFormulas(
    '<p>正文</p><img src="https://evil.test/tracker.png"><img src="data:image/png;base64,AAAA">',
  );
  expect(result.html).toContain("正文");
  expect(result.html).toContain("\uE010PIMG0\uE011");
  expect(result.html).not.toContain("\uE010PIMG1\uE011");
  expect(result.html).not.toContain("evil.test");
  expect(result.pasteImageCount).toBe(1);
});

test("extracts embedded clipboard image bytes before removing image markup", () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQMBgQlpWQAAAABJRU5ErkJggg==";
  const result = extractClipboardDataImages(
    `<p>附图</p><img src="data:image/png;base64,${png}"><img src="https://evil.test/x.png">`,
  );

  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    mediaType: "image/png",
    originalName: "clipboard-image-1.png",
  });
  expect(result[0]?.bytes.slice(0, 8)).toEqual(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
});

test("rejects more than 100 embedded clipboard images", () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQMBgQlpWQAAAABJRU5ErkJggg==";
  const html = Array.from({ length: 101 }, () => `<img src="data:image/png;base64,${png}">`).join(
    "",
  );

  expect(() => extractClipboardDataImages(html)).toThrow("最多导入 100 张图片");
});

test("extracts bounded patent image layout metadata from internal clipboard html", () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQMBgQlpWQAAAABJRU5ErkJggg==";
  const [image] = extractClipboardDataImages(
    `<img src="data:image/png;base64,${png}" data-patent-image-layout="inline" data-patent-image-width-mm="999" data-patent-image-alignment="right" data-patent-image-rotation-deg="270">`,
  );

  expect(image?.patentImage).toEqual({
    layout: "inline",
    widthMm: 165,
    alignment: "right",
    rotationDeg: 270,
  });
});

test("restores chemical structure metadata from the system clipboard html", () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARQMBgQlpWQAAAABJRU5ErkJggg==";
  const ketSource = "(ket) (atom C)";
  const ketBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(ketSource)));
  const [image] = extractClipboardDataImages(
    `<img src="data:image/png;base64,${png}" data-patent-chemical-ket-base64="${ketBase64}" data-patent-chemical-editor-mode="macromolecule" data-patent-chemical-width-mm="45" data-patent-chemical-alignment="left">`,
  );

  expect(image?.chemicalStructure).toEqual({
    ketSource,
    editorMode: "macromolecule",
    widthMm: 45,
    alignment: "left",
  });
});

test("keeps the outer table while flattening a pasted nested table to readable text", () => {
  const output = sanitizePastedHtml(`
    <table>
      <tbody><tr><td>外层前<table><tbody><tr><td>内层甲</td><td>内层乙</td></tr></tbody></table>外层后</td></tr></tbody>
    </table>
  `);
  const parsed = new DOMParser().parseFromString(output, "text/html");

  expect(parsed.body.querySelectorAll("table")).toHaveLength(1);
  expect(parsed.body.querySelector("table table")).toBeNull();
  expect(parsed.body.textContent).toContain("外层前");
  expect(parsed.body.textContent).toContain("内层甲 内层乙");
  expect(parsed.body.textContent).toContain("外层后");
});

test("converts OMML formulas to tokens and records their latex", () => {
  const input = `
    <p>公式 <m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
      <m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>
    </m:oMath> 之后</p>
    <m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
      <m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>
    </m:oMathPara>`;
  const result = sanitizePastedHtmlWithFormulas(input);

  expect(result.formulas).toHaveLength(2);
  expect(result.formulas[0]).toMatchObject({ latex: "\\frac{1}{2}", kind: "math", block: false });
  expect(result.formulas[1]).toMatchObject({ latex: "x^{2}", kind: "math", block: true });
  expect(result.html).toContain("公式");
  expect(result.html).toContain("\uE000PWF0\uE001");
  expect(result.html).toContain("\uE000PWF1\uE001");
  expect(result.html).not.toContain("m:oMath");
});

test("converts MathML formulas to tokens", () => {
  const input = `
    <p>方程 <math xmlns="http://www.w3.org/1998/Math/MathML">
      <mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><msup><mi>y</mi><mn>2</mn></msup></mrow>
    </math></p>`;
  const result = sanitizePastedHtmlWithFormulas(input);

  expect(result.formulas).toHaveLength(1);
  expect(result.formulas[0]?.latex).toBe("x^{2} + y^{2}");
  expect(result.html).toContain("\uE000PWF0\uE001");
});

test("converts a chemistry formula from Word and infers chemistry kind", () => {
  const input = `
    <m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
      <m:sSub><m:e><m:r><m:t>H</m:t></m:r></m:e><m:sub><m:r><m:t>2</m:t></m:r></m:sub></m:sSub>
      <m:r><m:t>O</m:t></m:r>
    </m:oMath>`;
  const result = sanitizePastedHtmlWithFormulas(input);
  expect(result.formulas).toHaveLength(1);
  expect(result.formulas[0]?.latex).toBe("H_{2}O");
  expect(result.formulas[0]?.kind).toBe("chemistry");
});

test("keeps formula text when the editor does not support formulas", () => {
  const input = `
    <m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
      <m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>
    </m:oMath>`;
  const result = sanitizePastedHtmlWithFormulas(input, {
    headings: true,
    lists: true,
    tables: true,
    formulas: false,
  });
  expect(result.formulas).toHaveLength(0);
  expect(result.html).toContain("x");
  expect(result.html).not.toContain("m:oMath");
  expect(result.html).not.toContain("\uE000PWF");
});

test("extracts block-math and inline-math from Tiptap's own HTML", () => {
  const input = `
    <div data-nodeid="abc" data-latex="x^2" data-formula-kind="math" data-formula-alignment="center" style="text-align:center" data-type="block-math"></div>
    <p> 公式 <span data-latex="a+b" data-formula-kind="math" data-type="inline-math"></span></p>`;
  const result = sanitizePastedHtmlWithFormulas(input);

  expect(result.formulas).toHaveLength(2);
  expect(result.formulas[0]).toMatchObject({
    latex: "x^2",
    kind: "math",
    block: true,
  });
  expect(result.formulas[0]).not.toHaveProperty("alignment");
  expect(result.formulas[1]).toMatchObject({
    latex: "a+b",
    kind: "math",
    block: false,
  });
  expect(result.formulas[1]).not.toHaveProperty("alignment");
  expect(result.html).toContain("\uE000PWF0\uE001");
  expect(result.html).toContain("\uE000PWF1\uE001");
  expect(result.html).not.toContain("block-math");
  expect(result.html).not.toContain("inline-math");
});

test("drops Tiptap formula text when the editor does not support formulas", () => {
  const input = `<div data-nodeid="x" data-latex="x^2" data-formula-kind="math" data-formula-alignment="center" data-type="block-math"></div>`;
  const result = sanitizePastedHtmlWithFormulas(input, {
    headings: true,
    lists: true,
    tables: true,
    formulas: false,
  });
  expect(result.formulas).toHaveLength(0);
  expect(result.html).not.toContain("block-math");
  expect(result.html).not.toContain("\uE000PWF");
});

test("treats alignment default center as undefined", () => {
  const input = `<div data-nodeid="x" data-latex="x^2" data-formula-kind="math" data-formula-alignment="center" data-type="block-math"></div>`;
  const result = sanitizePastedHtmlWithFormulas(input);
  // center is the default—no need to carry it explicitly.
  expect(result.formulas[0]?.alignment).toBeUndefined();
});

test("gives every pasted body paragraph the default first-line indent when the source has none", () => {
  const output = sanitizePastedHtml("<p>第一段</p><p>第二段</p><p>第三段</p>");

  expect(paragraphIndents(output)).toEqual([DEFAULT_INDENT, DEFAULT_INDENT, DEFAULT_INDENT]);
});

test("keeps source paragraph layout when explicit indentation is available", () => {
  const output = sanitizePastedHtml('<p style="text-indent:21pt">保留原缩进</p><p>无缩进段落</p>');

  expect(paragraphIndents(output)).toEqual(["7.41", "0"]);
});

test("leaves titles, structured content, and manually indented paragraphs without the default indent", () => {
  const output = sanitizePastedHtml(
    [
      "<h1>标题</h1>",
      '<p style="text-align:center">居中标题行</p>',
      '<p style="text-align:right">右对齐署名行</p>',
      "<ul><li><p>列表项</p></li></ul>",
      "<table><tbody><tr><td><p>单元格</p></td></tr></tbody></table>",
      "<p>　　已有全角缩进</p>",
      "<p>   已有半角缩进</p>",
    ].join(""),
  );

  expect(paragraphIndents(output)).toEqual([null, null, null, null, null, null]);
  expect(output).toContain("<h1>");
});

test("converts div-separated paragraphs instead of merging them and indents each one", () => {
  const output = sanitizePastedHtml("<div>甲段</div><div>乙段</div><div>丙段</div>");
  const parsed = new DOMParser().parseFromString(output, "text/html");

  expect([...parsed.body.querySelectorAll("p")].map((element) => element.textContent)).toEqual([
    "甲段",
    "乙段",
    "丙段",
  ]);
  expect(paragraphIndents(output)).toEqual([DEFAULT_INDENT, DEFAULT_INDENT, DEFAULT_INDENT]);
});

test("keeps divs that hold block children as layout containers", () => {
  const output = sanitizePastedHtml("<div><p>正文一</p><p>正文二</p></div>");
  const parsed = new DOMParser().parseFromString(output, "text/html");

  expect(parsed.body.querySelector("p p")).toBeNull();
  expect(paragraphIndents(output)).toEqual([DEFAULT_INDENT, DEFAULT_INDENT]);
});

test("keeps internal ProseMirror clipboard paragraphs exactly as copied", () => {
  const result = sanitizePastedHtmlWithFormulas(
    '<p data-pm-slice="1 1 []" data-paragraph-indent-mm="0">标题行</p>',
  );

  expect(result.internalProseMirrorSlice).toBe(true);
  expect(paragraphIndents(result.html)).toEqual(["0"]);
});

test.each([undefined, "source", "body"] as const)(
  "preserves first-line spaces split across spans in %s mode without adding an indent",
  (mode) => {
    const result = sanitizePastedHtmlWithFormulas(
      "<p><span> </span><strong> </strong><span> </span><em> </em>正文</p>",
      undefined,
      mode,
    );
    const paragraph = new DOMParser().parseFromString(result.html, "text/html").querySelector("p");
    if (!paragraph) throw new Error("Missing paragraph");
    expect(paragraph.textContent).toBe(`${"\u00a0".repeat(4)}正文`);
    expect(Number(paragraph.getAttribute("data-paragraph-indent-mm") ?? 0)).toBe(0);
  },
);

test("does not mistake HTML source indentation for a manual first-line indent", () => {
  const result = sanitizePastedHtml("<p>  \n<span>正文</span>\n</p>\n  <p>下一段</p>");
  expect(result).not.toContain("&nbsp;");
  expect(paragraphIndents(result)).toEqual([DEFAULT_INDENT, DEFAULT_INDENT]);
});

test("preserves explicit zero first-line indentation from external paragraphs", () => {
  const html = sanitizePastedHtml(
    '<p style="text-indent:0">第一段</p><p style="text-indent:0px">第二段</p>',
  );
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const p of document.querySelectorAll("p")) {
    expect(p.getAttribute("data-paragraph-indent-mm")).toBe("0");
  }
});

test("preserves Office zero indentation, including paragraph class styles", () => {
  const result = sanitizePastedHtmlWithFormulas(
    '<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><style>p.MsoNormal {text-indent:0pt;text-align:left} p.Body {text-indent:24pt}</style></head><body><p class="MsoNormal">技术领域</p><p class="Body">正文</p><p>无显式格式</p></body></html>',
  );
  expect(paragraphIndents(result.html)).toEqual(["0", "8.47", "0"]);
  expect(result.html).toContain("text-align: left");
  expect(result.paragraphMode).toBe("source");
  expect(result.simplifications).toEqual([]);
});

test("body mode normalizes ordinary paragraphs but not headings and structured content", () => {
  const result = sanitizePastedHtmlWithFormulas(
    '<h2>小标题</h2><p style="text-indent:0;text-align:left">正文</p><p style="text-align:center">居中标题</p><ul><li><p>列表</p></li></ul>',
    undefined,
    "body",
  );
  expect(paragraphIndents(result.html)).toEqual(["9.88", null, null]);
});

test("source mode keeps unspecified web paragraphs flush left and reports unsupported paragraph formatting", () => {
  const result = sanitizePastedHtmlWithFormulas(
    '<p style="text-indent:-12pt;margin-left:24pt;line-height:1.8">悬挂段落</p><p>普通段落</p>',
    undefined,
    "source",
  );
  expect(paragraphIndents(result.html)).toEqual(["0", "0"]);
  expect(result.simplifications).toContain("悬挂缩进");
  expect(result.simplifications).toContain("段落左右缩进");
  expect(result.simplifications).not.toContain("行距或段间距");
  expect(result.html).toContain('data-line-height="1.8"');
});
