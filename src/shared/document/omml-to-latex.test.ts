import { describe, expect, test } from "vitest";
import { inferFormulaKind, ommlToLatex, replaceOmmlWithTokens } from "./omml-to-latex.js";

function oMath(inner: string): string {
  return `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${inner}</m:oMath>`;
}

function run(text: string): string {
  return `<m:r><m:t>${text}</m:t></m:r>`;
}

describe("ommlToLatex", () => {
  test.each([
    ["°", String.raw`\degree`],
    ["′", String.raw`\prime`],
    ["″", String.raw`\prime\prime`],
    ["†", String.raw`\dagger`],
    ["φ", String.raw`\varphi`],
    ["ϕ", String.raw`\phi`],
  ])(
    "preserves symbol %s without inventing script structure during Word paste",
    (symbol, latex) => {
      expect(ommlToLatex(oMath(run(symbol)))).toBe(latex);
      expect(
        ommlToLatex(oMath(`<m:sSup><m:e>${run("x")}</m:e><m:sup>${run(symbol)}</m:sup></m:sSup>`)),
      ).toBe(`x^{${latex}}`);
    },
  );
  test("converts a plain text run", () => {
    expect(ommlToLatex(oMath(run("x")))).toBe("x");
  });

  test("converts a fraction to \\frac", () => {
    const input = oMath(`<m:f><m:num>${run("1")}</m:num><m:den>${run("2")}</m:den></m:f>`);
    expect(ommlToLatex(input)).toBe("\\frac{1}{2}");
  });

  test("preserves a barless fraction", () => {
    const input = oMath(
      `<m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>${run("n")}</m:num><m:den>${run("k")}</m:den></m:f>`,
    );
    expect(ommlToLatex(input)).toBe(String.raw`\genfrac{}{}{0pt}{}{n}{k}`);
  });

  test("groups a compound script base", () => {
    expect(
      ommlToLatex(oMath(`<m:sSup><m:e>${run("a+b")}</m:e><m:sup>${run("2")}</m:sup></m:sSup>`)),
    ).toBe("{a+b}^{2}");
  });

  test("converts superscript and subscript", () => {
    const square = oMath(`<m:sSup><m:e>${run("x")}</m:e><m:sup>${run("2")}</m:sup></m:sSup>`);
    expect(ommlToLatex(square)).toBe("x^{2}");

    const sub = oMath(`<m:sSub><m:e>${run("a")}</m:e><m:sub>${run("i")}</m:sub></m:sSub>`);
    expect(ommlToLatex(sub)).toBe("a_{i}");
  });

  test("converts combined sub/superscript", () => {
    const input = oMath(
      "<m:sSubSup><m:e>" +
        run("a") +
        "</m:e><m:sub>" +
        run("i") +
        "</m:sub><m:sup>" +
        run("j") +
        "</m:sup></m:sSubSup>",
    );
    expect(ommlToLatex(input)).toBe("a_{i}^{j}");
  });

  test("converts a quadratic expression with mixed runs", () => {
    const input = oMath(
      "<m:sSup><m:e>" +
        run("x") +
        "</m:e><m:sup>" +
        run("2") +
        "</m:sup></m:sSup>" +
        run("+") +
        "<m:sSup><m:e>" +
        run("y") +
        "</m:e><m:sup>" +
        run("2") +
        "</m:sup></m:sSup>",
    );
    expect(ommlToLatex(input)).toBe("x^{2}+y^{2}");
  });

  test("converts n-ary operator (definite integral)", () => {
    const input = oMath(
      '<m:nary><m:naryPr><m:chr m:val="∫"/><m:limLoc m:val="subSup"/></m:naryPr>' +
        "<m:sub>" +
        run("0") +
        "</m:sub><m:sup>" +
        run("1") +
        "</m:sup><m:e>" +
        run("x") +
        "</m:e></m:nary>",
    );
    expect(ommlToLatex(input)).toBe("\\int_{0}^{1} x");
  });

  test("converts summation with sub limit only", () => {
    const input = oMath(
      '<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="sub"/></m:naryPr>' +
        "<m:sub>" +
        run("i=1") +
        "</m:sub><m:sup></m:sup><m:e>" +
        run("n") +
        "</m:e></m:nary>",
    );
    expect(ommlToLatex(input)).toBe("\\sum_{i=1} n");
  });

  test("converts square root and nth root", () => {
    const sqrt = oMath(`<m:rad><m:deg></m:deg><m:e>${run("x")}</m:e></m:rad>`);
    expect(ommlToLatex(sqrt)).toBe("\\sqrt{x}");

    const root = oMath(`<m:rad><m:deg>${run("3")}</m:deg><m:e>${run("x")}</m:e></m:rad>`);
    expect(ommlToLatex(root)).toBe("\\sqrt[3]{x}");
  });

  test("converts delimiter with explicit brackets and separator", () => {
    const input = oMath(
      '<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/><m:sepChr m:val="|"/></m:dPr>' +
        "<m:e>" +
        run("a") +
        "</m:e><m:e>" +
        run("b") +
        "</m:e></m:d>",
    );
    expect(ommlToLatex(input)).toBe("\\left[a\\middle| b\\right]");
  });

  test("uses the Office default separator when the separator element is absent", () => {
    const input = oMath(`<m:d><m:e>${run("a")}</m:e><m:e>${run("b")}</m:e></m:d>`);
    expect(ommlToLatex(input)).toBe("\\left(a\\middle| b\\right)");
  });

  test.each(["", "<m:dPr/>", '<m:dPr><m:grow m:val="1"/></m:dPr>'])(
    "keeps default parentheses with omitted delimiter characters: %s",
    (properties) => {
      expect(ommlToLatex(oMath(`<m:d>${properties}<m:e>${run("x")}</m:e></m:d>`))).toBe(
        String.raw`\left(x\right)`,
      );
    },
  );

  test("distinguishes explicitly empty delimiters and separators from defaults", () => {
    expect(
      ommlToLatex(
        oMath(
          `<m:d><m:dPr><m:begChr/><m:endChr/><m:sepChr/></m:dPr><m:e>${run("a")}</m:e><m:e>${run("b")}</m:e></m:d>`,
        ),
      ),
    ).toBe(String.raw`\left.ab\right.`);
  });

  test("expands grouped matrix column alignment without changing the number of columns", () => {
    expect(
      ommlToLatex(
        oMath(
          `<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="2"/><m:mcJc m:val="left"/></m:mcPr></m:mc><m:mc><m:mcPr><m:mcJc m:val="right"/></m:mcPr></m:mc></m:mcs></m:mPr><m:mr><m:e>${run("a")}</m:e><m:e>${run("b")}</m:e><m:e>${run("c")}</m:e></m:mr></m:m>`,
        ),
      ),
    ).toBe(String.raw`\begin{array}{llr}a & b & c\end{array}`);
  });

  test("maps Greek letters and styles runs", () => {
    const input = oMath(run("α+β"));
    expect(ommlToLatex(input)).toBe("\\alpha+\\beta");
  });

  test.each([run("αx+βy"), `${run("α")}${run("x+")}${run("β")}${run("y")}`])(
    "separates mapped commands from following letters within and across runs",
    (input) => {
      expect(ommlToLatex(oMath(input))).toBe(String.raw`\alpha x+\beta y`);
    },
  );

  test("applies rPr bold and roman styles", () => {
    const input = oMath('<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>x</m:t></m:r>');
    expect(ommlToLatex(input)).toBe("\\mathbf{x}");

    const doubleStruck = oMath(
      '<m:r><m:rPr><m:scr m:val="double-struck"/></m:rPr><m:t>R</m:t></m:r>',
    );
    expect(ommlToLatex(doubleStruck)).toBe("\\mathbb{R}");
  });

  test.each(['<m:pos m:val="bot"/>', ""])(
    "keeps the standard lower bar position: %s",
    (position) => {
      expect(
        ommlToLatex(oMath(`<m:bar><m:barPr>${position}</m:barPr><m:e>${run("x")}</m:e></m:bar>`)),
      ).toBe(String.raw`\underline{x}`);
    },
  );

  test("retains plain math run styling without turning double-struck letters into roman", () => {
    expect(ommlToLatex(oMath('<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>d</m:t></m:r>'))).toBe(
      String.raw`\mathrm{d}`,
    );
    expect(
      ommlToLatex(
        oMath(
          '<m:r><m:rPr><m:scr m:val="double-struck"/><m:sty m:val="p"/></m:rPr><m:t>R</m:t></m:r>',
        ),
      ),
    ).toBe(String.raw`\mathbb{R}`);
  });

  test("uses the standard lower-brace default when group properties are omitted", () => {
    expect(ommlToLatex(oMath(`<m:groupChr><m:e>${run("x")}</m:e></m:groupChr>`))).toBe(
      String.raw`\underbrace{x}`,
    );
  });

  test("converts an equation array to aligned environment", () => {
    const input = oMath(`<m:eqArr><m:e>${run("x")}</m:e><m:e>${run("y")}</m:e></m:eqArr>`);
    expect(ommlToLatex(input)).toBe("\\begin{aligned}x \\\\ y \\end{aligned}");
  });

  test("converts a matrix", () => {
    const input = oMath(
      "<m:m><m:mr><m:e>" +
        run("a") +
        "</m:e><m:e>" +
        run("b") +
        "</m:e></m:mr><m:mr><m:e>" +
        run("c") +
        "</m:e><m:e>" +
        run("d") +
        "</m:e></m:mr></m:m>",
    );
    expect(ommlToLatex(input)).toBe("\\begin{matrix}a & b \\\\ c & d\\end{matrix}");
  });

  test("converts a chemistry formula H2SO4 and infers chemistry kind", () => {
    const input = oMath(
      "<m:sSub><m:e>" +
        run("H") +
        "</m:e><m:sub>" +
        run("2") +
        "</m:sub></m:sSub>" +
        run("S") +
        "<m:sSub><m:e>" +
        run("O") +
        "</m:e><m:sub>" +
        run("4") +
        "</m:sub></m:sSub>",
    );
    const latex = ommlToLatex(input);
    expect(latex).toBe("H_{2}SO_{4}");
    expect(inferFormulaKind(latex ?? "")).toBe("chemistry");
  });

  test("infers math kind for equations with operators", () => {
    expect(inferFormulaKind("x^{2}+y^{2}")).toBe("math");
    expect(inferFormulaKind("\\frac{1}{2}")).toBe("math");
    expect(inferFormulaKind("H_{2}O")).toBe("chemistry");
    expect(inferFormulaKind("x_{i}")).toBe("math");
  });

  test("escapes latex special characters in text", () => {
    expect(ommlToLatex(oMath(run("a&b%c#d_e")))).toBe("a\\&b\\%c\\#d\\_e");
  });
});

describe("replaceOmmlWithTokens", () => {
  test("replaces each oMath with a token and records latex", () => {
    const html =
      "<p>" +
      oMath(`<m:sSup><m:e>${run("x")}</m:e><m:sup>${run("2")}</m:sup></m:sSup>`) +
      "</p><p>中间文字</p><p>" +
      oMath(`<m:f><m:num>${run("1")}</m:num><m:den>${run("2")}</m:den></m:f>`) +
      "</p>";
    const result = replaceOmmlWithTokens(html);
    expect(result.formulas).toHaveLength(2);
    expect(result.formulas[0]?.latex).toBe("x^{2}");
    expect(result.formulas[1]?.latex).toBe("\\frac{1}{2}");
    expect(result.html).toContain("中间文字");
    expect(result.html).not.toContain("m:oMath");
    expect(result.html).toContain("\uE000PWF0\uE001");
    expect(result.html).toContain("\uE000PWF1\uE001");
  });

  test("keeps unconvertible formulas as empty latex without crashing", () => {
    const html = `<p>${oMath("<m:unknown><m:t>??</m:t></m:unknown>")}</p>`;
    const result = replaceOmmlWithTokens(html);
    expect(result.formulas).toHaveLength(1);
    expect(result.html).not.toContain("m:oMath");
  });

  test("returns null when no oMath present", () => {
    expect(ommlToLatex("<p>plain</p>")).toBeNull();
  });
});
