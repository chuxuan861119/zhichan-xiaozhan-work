import { DOMParser } from "@xmldom/xmldom";
import { Document, Packer, Paragraph } from "docx";
import katex from "katex";
import sharp from "sharp";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { ommlXmlToLatex } from "../../shared/document/omml-to-latex.js";
import { convertParsedWordDocument } from "../docx-import/docx-canonical-converter.js";
import { readDocxPackageBuffer } from "../docx-import/docx-package-reader.js";
import { parseWordprocessingDocument } from "../docx-import/wordprocessingml-parser.js";
import { exportFormula, normalizeKatexMathMl, parseMathMlToAst } from "./formula-exporter.js";

const NODE_ID = "00000000-0000-4000-8000-000000000812";

test("chemical raster preserves formula color without rewriting its source", async () => {
  const source = String.raw`\ce{H2O}`;
  const result = await exportFormula(source, NODE_ID, "chemistry", 10.5, "#FF0000");
  if (result.kind !== "raster") throw new Error("Expected raster");
  const { data, info } = await sharp(result.image.png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let opaque = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if ((data[i + 3] ?? 0) < 128) continue;
    opaque++;
    expect(data[i]).toBeGreaterThan(200);
    expect(data[i + 1]).toBeLessThan(30);
    expect(data[i + 2]).toBeLessThan(30);
  }
  expect(opaque).toBeGreaterThan(0);
  expect(result.image.altText).toContain(source);
});

test("explicit formula size is exported to Office Math runs", async () => {
  const result = await exportFormula("x^2", NODE_ID, "math", 10.5);
  expect(result.kind).toBe("native");
  if (result.kind !== "native") throw new Error("Expected native formula");
  expect(await documentXmlFor(result.math)).toContain('<w:sz w:val="21"');
});

test("chemical formula raster display dimensions follow font size without reducing bitmap quality", async () => {
  const small = await exportFormula(String.raw`\ce{H2O}`, NODE_ID, "chemistry", 10.5);
  const large = await exportFormula(String.raw`\ce{H2O}`, NODE_ID, "chemistry", 21);
  if (small.kind !== "raster" || large.kind !== "raster") throw new Error("Expected raster");
  expect(large.image.widthPx).toBeCloseTo(small.image.widthPx * 2);
  expect(large.image.heightPx).toBeCloseTo(small.image.heightPx * 2);
  expect(large.image.png).toEqual(small.image.png);
});

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("DOCX ZIP could not be opened"));
      else resolve(zip);
    });
  });
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("DOCX ZIP entry could not be read"));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function documentXmlFor(math: import("docx").Math): Promise<string> {
  const buffer = await Packer.toBuffer(
    new Document({ sections: [{ children: [new Paragraph({ children: [math] })] }] }),
  );
  const zip = await openZip(buffer);
  return new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("entry", (entry: Entry) => {
      if (entry.fileName !== "word/document.xml") {
        zip.readEntry();
        return;
      }
      void readEntry(zip, entry).then((bytes) => resolve(bytes.toString("utf8")), reject);
    });
    zip.on("end", () => reject(new Error("DOCX document XML is missing")));
    zip.readEntry();
  });
}

describe("formula Office Math export", () => {
  test.each([
    "phi",
    "varphi",
    "epsilon",
    "varepsilon",
    "theta",
    "vartheta",
    "rho",
    "varrho",
    "pi",
    "varpi",
    "sigma",
    "varsigma",
  ])("preserves the glyph identity of Greek variant %s", async (command) => {
    const source = `\\${command}`;
    const { latex } = await roundTrip(source);
    const glyph = (value: string) =>
      new DOMParser()
        .parseFromString(katex.renderToString(value, { output: "mathml" }), "text/xml")
        .getElementsByTagName("mi")
        .item(0)?.textContent;
    expect(glyph(latex)).toBe(glyph(source));
  });
  test.each(["f'", "f''", String.raw`A^{\dagger}`, "90°"])(
    "does not introduce extra superscripts when reimporting %s",
    async (source) => {
      const { latex } = await roundTrip(source);
      const superscriptCount = (value: string) =>
        (katex.renderToString(value, { output: "mathml" }).match(/<msup>/gu) ?? []).length;
      expect(superscriptCount(latex)).toBe(superscriptCount(source));
    },
  );
  async function roundTrip(source: string): Promise<{ xml: string; latex: string }> {
    const result = await exportFormula(source, NODE_ID);
    expect(result.kind).toBe("native");
    if (result.kind !== "native") throw new Error("Expected editable Office Math");
    const xml = await documentXmlFor(result.math);
    const node = new DOMParser()
      .parseFromString(xml, "text/xml")
      .getElementsByTagName("m:oMath")
      .item(0);
    if (!node) throw new Error("Missing Office Math output");
    const latex = ommlXmlToLatex(node.toString());
    expect(latex).not.toBeNull();
    if (latex === null) throw new Error("Failed to import Office Math");
    expect(() => katex.renderToString(latex, { throwOnError: true })).not.toThrow();
    return { xml, latex };
  }

  test("keeps binomial coefficients barless through native DOCX round trips", async () => {
    const first = await roundTrip(String.raw`\binom{n}{k}`);
    expect(first.xml).toContain('<m:type m:val="noBar"');
    expect(katex.renderToString(first.latex, { output: "mathml" })).toContain(
      'linethickness="0px"',
    );
    expect((await roundTrip(first.latex)).xml).toContain('<m:type m:val="noBar"');
  });

  test.each([
    [String.raw`\left(\frac{a}{b}\right)`, "(", ")"],
    [String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`, "[", "]"],
    [String.raw`\begin{cases}x&x>0\\0&x<0\end{cases}`, "{", ""],
    [String.raw`\left.\frac{a}{b}\right|`, "", "∣"],
  ])("keeps scalable and one-sided delimiters: %s", async (source, begin, end) => {
    const first = await roundTrip(source);
    const second = await roundTrip(first.latex);
    for (const { xml } of [first, second]) {
      expect(xml).toContain("<m:d>");
      expect(xml).toContain(`<m:begChr m:val="${begin}"`);
      expect(xml).toContain(`<m:endChr m:val="${end}"`);
    }
  });

  test("does not merge adjacent or nested delimiter groups", async () => {
    const { xml } = await roundTrip(
      String.raw`\left(\left[\frac{a}{b}\right]\right)+\left(c\right)`,
    );
    expect(xml.match(/<m:d>/gu)).toHaveLength(3);
  });

  test.each([
    String.raw`\left\{\frac{a}{b}\middle|x>0\right\}`,
    String.raw`\left.\frac{a}{b}\middle|x>0\right.`,
  ])("preserves scalable middle separators through repeated round trips: %s", async (source) => {
    const first = await roundTrip(source);
    const second = await roundTrip(first.latex);
    for (const { xml, latex } of [first, second]) {
      expect(xml).toContain('<m:sepChr m:val="|"');
      expect(latex).toContain(String.raw`\middle|`);
    }
  });

  test.each([
    [String.raw`\begin{cases}x&x>0\\0&x<0\end{cases}`, "left left"],
    [String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`, "right left"],
    [String.raw`\begin{array}{lcr}a&b&c\\d&e&f\end{array}`, "left center right"],
  ])("preserves matrix column alignment: %s", async (source, alignment) => {
    const { xml, latex } = await roundTrip(source);
    for (const value of alignment.split(" ")) {
      expect(xml).toContain(`<m:mcJc m:val="${value}"`);
    }
    expect(katex.renderToString(latex, { output: "mathml" })).toContain(
      `columnalign="${alignment}"`,
    );
  });

  test.each(["{x^2}^3", "{x_1}_2", "{x_1^2}_3^4"])(
    "keeps nested script grouping valid after DOCX import: %s",
    async (source) => {
      const first = await roundTrip(source);
      await roundTrip(first.latex);
    },
  );

  test.each([
    String.raw`\alpha x+\beta y`,
    String.raw`\Gamma z`,
    String.raw`\left\langle x\right\rangle y`,
    String.raw`\left\lfloor x\right\rfloor z`,
  ])("keeps command boundaries valid next to ordinary letters: %s", async (source) => {
    const first = await roundTrip(source);
    await roundTrip(first.latex);
  });

  test("imports compound formulas from an actual DOCX without private source metadata", async () => {
    const sources = [
      String.raw`\binom{n}{k}`,
      "{x^2}^3",
      String.raw`\alpha x+\beta y`,
      String.raw`\begin{cases}x&x>0\\0&x<0\end{cases}`,
    ];
    const children: Paragraph[] = [];
    for (const source of sources) {
      const result = await exportFormula(source, NODE_ID);
      if (result.kind !== "native") throw new Error("Expected editable Office Math");
      children.push(new Paragraph({ children: [result.math] }));
    }
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children }] }));
    const parsed = await parseWordprocessingDocument(
      await readDocxPackageBuffer(bytes, "formulas.docx"),
    );
    const result = convertParsedWordDocument(parsed, { title: "公式往返", mode: "auxiliary" });
    expect(result.document.content).toHaveLength(sources.length);
    for (const block of result.document.content) {
      expect(block.type).toBe("paragraph");
      if (block.type !== "paragraph") throw new Error("Expected formula paragraph");
      expect(block.content).toHaveLength(1);
      const formula = block.content[0];
      if (formula?.type !== "inline-formula") throw new Error("Lost imported formula");
      expect(() => katex.renderToString(formula.source, { throwOnError: true })).not.toThrow();
      await roundTrip(formula.source);
    }
  });

  test.each([
    [String.raw`\mathbb{R}`, '<m:scr m:val="double-struck"'],
    [String.raw`\mathbf{F}`, '<m:sty m:val="b"'],
    [String.raw`\mathrm{d}`, '<m:sty m:val="p"'],
    [String.raw`\vec{x}`, "<m:acc>"],
    [String.raw`\hat{x}`, "<m:acc>"],
    [String.raw`\tilde{x}`, "<m:acc>"],
    [String.raw`\check{x}`, "<m:acc>"],
    [String.raw`\breve{x}`, "<m:acc>"],
    [String.raw`\acute{x}`, "<m:acc>"],
    [String.raw`\grave{x}`, "<m:acc>"],
    [String.raw`\dot{x}`, "<m:acc>"],
    [String.raw`\ddot{x}`, "<m:acc>"],
    [String.raw`\bar{x}`, "<m:acc>"],
    [String.raw`\overline{abc}`, '<m:pos m:val="top"'],
    [String.raw`\underline{abc}`, '<m:pos m:val="bot"'],
    [String.raw`\overbrace{abc}`, '<m:chr m:val="⏞"'],
    [String.raw`\underbrace{abc}`, '<m:chr m:val="⏟"'],
  ])("preserves mathematical notation in DOCX: %s", async (source, marker) => {
    const result = await exportFormula(source, NODE_ID);
    expect(result.kind).toBe("native");
    if (result.kind !== "native") throw new Error("Expected editable Office Math");
    const xml = await documentXmlFor(result.math);
    expect(xml).toContain(marker);
    const node = new DOMParser()
      .parseFromString(xml, "text/xml")
      .getElementsByTagName("m:oMath")
      .item(0);
    if (!node) throw new Error("Missing Office Math output");
    expect(ommlXmlToLatex(node.toString())).toBe(source);
  });
  test.each([
    String.raw`\ce{[Cu(NH3)4]^2+ + 4H2O <=> [Cu(H2O)4]^2+ + 4NH3}`,
    String.raw`\ce{^{14}_{6}C -> ^{14}_{7}N + e^- + \bar{\nu}_e}`,
    String.raw`\ce{(R)-CH3CH(OH)CO2H + nCH2=CH2 -> [-CH2-CH2-]_{n}}`,
  ])("exports chemical equation %s as a PNG instead of Office Math", async (source) => {
    const result = await exportFormula(source, NODE_ID, "chemistry");

    expect(result.kind).toBe("raster");
    expect(result.issues).toEqual([
      {
        severity: "warning",
        code: "CHEMISTRY_RENDERED_AS_IMAGE",
        nodeId: NODE_ID,
        message: "化学方程式已按设计导出为图形；源数据已保留，可在本应用中编辑，未丢失数据。",
      },
    ]);
    if (result.kind !== "raster") return;
    expect(Buffer.from(result.image.png).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });

  test("rejects mstyle at the closed MathML parser boundary", () => {
    const mathMl =
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><mtable><mtr><mtd><mstyle scriptlevel="0" displaystyle="false"><mi>x</mi></mstyle></mtd></mtr></mtable></math>';

    expect(() => parseMathMlToAst(mathMl)).toThrow(/mstyle/u);
  });

  test("unwraps only the exact safe KaTeX mstyle shape", () => {
    const safe =
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mstyle scriptlevel="0" displaystyle="true"><mfrac><mi>a</mi><mi>b</mi></mfrac></mstyle></mrow></math>';
    expect(normalizeKatexMathMl(safe)).not.toContain("<mstyle");

    const extraAttribute = safe.replace(
      'displaystyle="true"',
      'displaystyle="true" data-extra="unsafe"',
    );
    expect(() => normalizeKatexMathMl(extraAttribute)).toThrow("KaTeX 公式样式结构无效。");
  });

  test.each([
    ["x+1", "<m:oMath"],
    [String.raw`\alpha+\beta`, "α"],
    ["x_i^2", "<m:sSubSup>"],
    [String.raw`\frac{a+b}{c}`, "<m:f>"],
    [String.raw`\dfrac{a+b}{c}`, "<m:f>"],
    [String.raw`\tfrac{a+b}{c}`, "<m:f>"],
    [String.raw`\displaystyle\frac{a+b}{c}`, "<m:f>"],
    [String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}f(x)\bigm|_{x=a}`, "<m:f>"],
    [String.raw`\dfrac{\mathrm{d}^{n}}{\mathrm{d}x^{n}}f(x)\bigm|_{x=a}`, "<m:f>"],
    [String.raw`\sqrt{x}`, "<m:rad>"],
    [String.raw`\sqrt[3]{x}`, "<m:deg>"],
    [String.raw`\sum_{i=1}^{n}x_i`, "<m:nary>"],
    [String.raw`\prod_{i=1}^{n}x_i`, "<m:nary>"],
    [String.raw`\int_0^1 f(x)\,dx`, "<m:nary>"],
    [String.raw`\lim_{x\to0}\frac{\sin x}{x}`, "<m:limLow>"],
    [String.raw`\begin{matrix}a&b\\c&d\end{matrix}`, "<m:m>"],
  ])("exports %s as editable OMML without a warning", async (source, marker) => {
    const result = await exportFormula(source, NODE_ID);

    expect(result.kind).toBe("native");
    expect(result.issues).toEqual([]);
    if (result.kind !== "native") return;

    const xml = await documentXmlFor(result.math);
    expect(xml).toContain("<m:oMath>");
    expect(xml).not.toContain("<undefined>");
    expect(xml).toContain(marker);
  });

  test.each([
    String.raw`\newcommand{\unsafe}{x}\unsafe`,
    String.raw`\require{html}x`,
    String.raw`\href{https://example.com}{x}`,
    String.raw`\begin{tikzpicture}x\end{tikzpicture}`,
    String.raw`\frac{a}{`,
  ])("rejects invalid or disabled input %s instead of exporting an error image", async (source) => {
    await expect(exportFormula(source, NODE_ID)).rejects.toThrow(/公式/);
  });

  test.each([String.raw`\color{red}{x}`, `${String.raw`\sqrt{`.repeat(129)}x${"}".repeat(129)}`])(
    "rasterizes supported input outside the editable OMML subset %s",
    async (source) => {
      const result = await exportFormula(source, NODE_ID);

      expect(result.kind).toBe("raster");
      expect(result.issues).toEqual([
        {
          severity: "warning",
          code: "FORMULA_RASTERIZED",
          nodeId: NODE_ID,
          message: "公式已转换为图片，无法在 Word 公式编辑器中编辑。",
        },
      ]);
      if (result.kind !== "raster") return;
      expect(result.image.altText).toBe(`复杂公式（LaTeX）：${source}`);
      expect(Buffer.from(result.image.png).subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
    },
  );
});
