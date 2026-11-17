import { Editor } from "@tiptap/core";
import { createPatentExtensions } from "./extensions";
import { sanitizePastedHtmlWithFormulas } from "./paste-sanitizer";

function pasted(html: string, mode?: "source" | "body") {
  const cleaned = sanitizePastedHtmlWithFormulas(html, undefined, mode);
  const editor = new Editor({ extensions: createPatentExtensions(), content: cleaned.html });
  try {
    return { doc: editor.state.doc, issues: cleaned.simplifications, mode: cleaned.paragraphMode };
  } finally {
    editor.destroy();
  }
}

test.each(["source", "body"] as const)(
  "keeps inherited text color after removing a web layout wrapper (%s)",
  (mode) => {
    const paragraph = pasted(
      '<div style="color:#123456"><p>继承<span style="color:#654321">独立颜色</span></p></div>',
      mode,
    ).doc.firstChild;
    expect(paragraph?.firstChild?.marks.find((m) => m.type.name === "textStyle")?.attrs.color).toBe(
      "#123456",
    );
    expect(paragraph?.lastChild?.marks.find((m) => m.type.name === "textStyle")?.attrs.color).toBe(
      "#654321",
    );
  },
);

test("keeps a paragraph text color and an explicit child color override", () => {
  const paragraph = pasted(
    '<p style="color:red">红字<strong>加粗红字</strong><span style="color:blue">蓝字</span></p>',
  ).doc.firstChild;
  expect(paragraph?.child(0).marks.find((m) => m.type.name === "textStyle")?.attrs.color).toBe(
    "#ff0000",
  );
  expect(paragraph?.child(1).marks.map((m) => m.type.name)).toContain("bold");
  expect(paragraph?.child(1).marks.find((m) => m.type.name === "textStyle")?.attrs.color).toBe(
    "#ff0000",
  );
  expect(paragraph?.lastChild?.marks.find((m) => m.type.name === "textStyle")?.attrs.color).toBe(
    "#0000ff",
  );
});

test("legacy font color overrides the inherited paragraph color", () => {
  const paragraph = pasted('<div style="color:red"><p><font color="blue">蓝字</font></p></div>').doc
    .firstChild;
  expect(paragraph?.firstChild?.marks.find((m) => m.type.name === "textStyle")?.attrs.color).toBe(
    "#0000ff",
  );
});

test("keeps text color from a Word paragraph style", () => {
  const paragraph = pasted(
    '<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><style>p.MsoBody {color:#123456}</style></head><body><p class="MsoBody">彩色文字</p></body></html>',
  ).doc.firstChild;
  expect(paragraph?.firstChild?.marks.find((m) => m.type.name === "textStyle")?.attrs.color).toBe(
    "#123456",
  );
});

test("internal font metadata stays bounded and external paste does not opt into font preservation", () => {
  const external = pasted(
    '<p data-default-font-family="KaiTi"><span data-document-font-family="FangSong" style="font-family:FangSong">原文</span></p>',
  ).doc.firstChild;
  expect(external?.attrs.defaultFontFamily).toBe("SimSun");
  expect(
    external?.firstChild?.marks.find((m) => m.type.name === "textStyle")?.attrs.fontFamily ?? null,
  ).toBeNull();
  const cleaned = pasted(
    `<p data-pm-slice="0 0 []" data-default-font-family="${"x".repeat(101)}"><span data-document-font-family="${"x".repeat(101)}">原文</span></p>`,
  ).doc.firstChild;
  expect(cleaned?.attrs.defaultFontFamily).toBe("SimSun");
  expect(
    cleaned?.firstChild?.marks.find((m) => m.type.name === "textStyle")?.attrs.fontFamily ?? null,
  ).toBeNull();
  expect(cleaned?.textContent).toBe("原文");
});

test("internal clipboard keeps run and paragraph font sizes together with paragraph formatting", () => {
  const source = new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: {
            defaultFontSizePt: 18,
            defaultFontFamily: "KaiTi",
            paragraphIndentMm: 14,
            lineHeight: 2,
            spaceBeforePt: 6,
            spaceAfterPt: 8,
            textAlign: "center",
          },
          content: [
            {
              type: "text",
              text: "大字",
              marks: [
                { type: "textStyle", attrs: { fontSizePt: 24, fontFamily: "FangSong" } },
                { type: "bold" },
              ],
            },
          ],
        },
      ],
    },
  });
  try {
    const html = source.view.serializeForClipboard(
      source.state.doc.slice(0, source.state.doc.content.size),
    ).dom.innerHTML;
    const paragraph = pasted(html).doc.firstChild;
    expect(paragraph?.attrs).toMatchObject({
      defaultFontSizePt: 18,
      defaultFontFamily: "KaiTi",
      paragraphIndentMm: 14,
      lineHeight: 2,
      spaceBeforePt: 6,
      spaceAfterPt: 8,
      textAlign: "center",
    });
    expect(
      paragraph?.firstChild?.marks.find((mark) => mark.type.name === "textStyle")?.attrs.fontSizePt,
    ).toBe(24);
    expect(paragraph?.firstChild?.marks.some((mark) => mark.type.name === "bold")).toBe(true);
    expect(
      paragraph?.firstChild?.marks.find((mark) => mark.type.name === "textStyle")?.attrs.fontFamily,
    ).toBe("FangSong");
  } finally {
    source.destroy();
  }
});

test.each([
  ["font-weight:700", "bold"],
  ["font-style:italic", "italic"],
  ["text-decoration:underline", "underline"],
])("retains supported CSS mark %s", (style, mark) => {
  const paragraph = pasted(`<p><span style="${style}">文字</span></p>`).doc.firstChild;
  expect(paragraph?.firstChild?.marks.some((value) => value.type.name === mark)).toBe(true);
});

test("inherits alignment and CSS emphasis without overriding explicit child alignment", () => {
  const doc = pasted(
    '<div style="text-align:center;font-weight:bold"><p>居中</p><p style="text-align:right">右侧</p></div>',
  ).doc;
  expect(doc.child(0).attrs.textAlign).toBe("center");
  expect(doc.child(1).attrs.textAlign).toBe("right");
  expect(doc.child(0).firstChild?.marks.some((mark) => mark.type.name === "bold")).toBe(true);
});

test.each(["    ", "\t", " \t "])("keeps an isolated inline gap %j", (spaces) => {
  expect(
    pasted(`<p><span>甲</span><span>${spaces}</span><span>乙</span></p>`).doc.textContent,
  ).toBe(`甲${spaces.replaceAll("\t", "    ").replaceAll(" ", "\u00a0")}乙`);
});

test("keeps a manually indented cell without an explicit paragraph wrapper", () => {
  const cell = pasted("<table><tr><td>    <strong>正文</strong></td></tr></table>").doc.firstChild
    ?.firstChild?.firstChild;
  expect(cell?.textContent).toBe(`${"\u00a0".repeat(4)}正文`);
  expect(cell?.childCount).toBe(1);
});

test("preserves split multi-space runs while leaving an ordinary word separator unchanged", () => {
  expect(pasted("<p>甲<span> </span><span> </span>乙</p>").doc.textContent).toBe(
    "甲\u00a0\u00a0乙",
  );
  expect(pasted("<p><span>甲</span> <span>乙</span></p>").doc.textContent).toBe("甲 乙");
});

test("Office character styles retain emphasis while explicit normal text stays normal", () => {
  const doc = pasted(
    '<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><style>span.Emphasis {font-weight:700;font-style:italic;text-decoration:underline}</style></head><body><p><span class="Emphasis">强调</span><span style="font-weight:normal;font-style:normal">普通</span></p></body></html>',
  ).doc;
  expect(doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual(
    expect.arrayContaining(["bold", "italic", "underline"]),
  );
  expect(
    doc.firstChild?.lastChild?.marks.some((mark) =>
      ["bold", "italic", "underline"].includes(mark.type.name),
    ),
  ).toBe(false);
});

test("external font sizes remain normalized and invalid internal sizes are rejected", () => {
  for (const html of [
    '<p><span style="font-size:24pt" data-font-size-pt="24">正文</span></p>',
    '<p data-pm-slice="0 0 []" data-default-font-size-pt="999"><span data-font-size-pt="999" style="font-size:999pt">正文</span></p>',
  ]) {
    const p = pasted(html).doc.firstChild;
    expect(p?.attrs.defaultFontSizePt).toBe(14);
    expect(
      p?.firstChild?.marks.find((mark) => mark.type.name === "textStyle")?.attrs.fontSizePt ?? null,
    ).toBeNull();
  }
});

test.each([
  [14, 9.88],
  [10.5, 7.41],
  [18, 12.7],
])("converts em indentation using inherited %s pt size", (size, expected) => {
  const p = pasted(`<div style="font-size:${size}pt"><p style="text-indent:2em">正文</p></div>`).doc
    .firstChild;
  expect(p?.attrs.paragraphIndentMm).toBe(expected);
});

test("source mode keeps supported line and paragraph spacing; body mode resets it", () => {
  const html = '<p style="text-indent:0;line-height:2;margin-top:6pt;margin-bottom:8pt">正文</p>';
  const source = pasted(html, "source");
  expect(source.doc.firstChild?.attrs).toMatchObject({
    lineHeight: 2,
    spaceBeforePt: 6,
    spaceAfterPt: 8,
  });
  expect(source.issues).not.toContain("行距或段间距");
  const body = pasted(html, "body");
  expect(body.doc.firstChild?.attrs).toMatchObject({
    paragraphIndentMm: 9.88,
    lineHeight: 1.5,
    spaceBeforePt: null,
    spaceAfterPt: null,
  });
});

test("inherited em indentation uses the declaring container font size", () => {
  const p = pasted(
    '<div style="font-size:18pt;text-indent:2em"><p style="font-size:14pt">正文</p></div>',
  ).doc.firstChild;
  expect(p?.attrs.paragraphIndentMm).toBe(12.7);
});

test("normal child style cancels inherited bold and italic", () => {
  const p = pasted(
    '<div style="font-weight:bold;font-style:italic"><p><span style="font-weight:normal;font-style:normal">普通</span>强调</p></div>',
  ).doc.firstChild;
  expect(p?.firstChild?.marks.some((mark) => ["bold", "italic"].includes(mark.type.name))).toBe(
    false,
  );
  expect(p?.lastChild?.marks.map((mark) => mark.type.name)).toEqual(
    expect.arrayContaining(["bold", "italic"]),
  );
});

test("explicit align attribute wins over inherited alignment", () => {
  expect(
    pasted('<div style="text-align:center"><p align="right">右侧</p></div>').doc.firstChild?.attrs
      .textAlign,
  ).toBe("right");
});

test("semantic emphasis inside a normal styled container stays emphasized", () => {
  const p = pasted(
    '<div style="font-weight:normal;font-style:normal"><p><strong><span>粗体</span></strong><em><span>斜体</span></em></p></div>',
  ).doc.firstChild;
  expect(p?.firstChild?.marks.some((mark) => mark.type.name === "bold")).toBe(true);
  expect(p?.lastChild?.marks.some((mark) => mark.type.name === "italic")).toBe(true);
});

test("source spacing can come from Office stylesheet or inherited container", () => {
  const doc = pasted(
    '<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><style>p.Body {margin-top:6pt;margin-bottom:8pt;line-height:150%}</style></head><body><div style="line-height:2"><p class="Body">甲</p><p>乙</p></div></body></html>',
  ).doc;
  expect(doc.child(0).attrs).toMatchObject({ lineHeight: 1.5, spaceBeforePt: 6, spaceAfterPt: 8 });
  expect(doc.child(1).attrs.lineHeight).toBe(2);
});

test("reports unsupported fixed line heights instead of silently losing them", () => {
  const result = pasted(
    '<p style="line-height:24pt;margin-top:-6pt;margin-bottom:999pt">正文</p>',
    "source",
  );
  expect(result.issues).toContain("固定行距或不支持的行距已采用默认值");
  expect(result.issues).toContain("不支持的段前或段后间距已采用默认值");
});
