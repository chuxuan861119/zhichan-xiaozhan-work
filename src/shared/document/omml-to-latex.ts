import { DOMParser as XmlDomParser } from "@xmldom/xmldom";

/**
 * OMML（Office Math Markup Language）→ LaTeX 转换器。
 *
 * Word 复制公式到剪贴板时，text/html 中的主流形态是 `<m:oMath>`（OMML，
 * ECMA-376 Part 1 §22.1）。本模块递归转换专利文档常用的 OMML 子集：
 * 文本运行、分数、上下标、大算符（求和/积分/连乘）、根式、定界符、
 * 多行等式、矩阵、上下横线、重音、组合字符、上下极限、函数。
 *
 * 解析策略：DOM 模式下未知前缀元素保留原 tagName（小写化），
 * 故按 `m:xxx` 小写匹配，不依赖命名空间解析。
 */

/** m:t 内的 Unicode 符号 → LaTeX 命令映射（按字符表驱动，输出含反斜杠）。 */
const SYMBOL_MAP: Readonly<Record<string, string>> = {
  // 希腊字母（小写）
  α: "\\alpha",
  β: "\\beta",
  γ: "\\gamma",
  δ: "\\delta",
  ε: "\\varepsilon",
  ϵ: "\\epsilon",
  ζ: "\\zeta",
  η: "\\eta",
  θ: "\\theta",
  ϑ: "\\vartheta",
  ι: "\\iota",
  κ: "\\kappa",
  λ: "\\lambda",
  μ: "\\mu",
  ν: "\\nu",
  ξ: "\\xi",
  π: "\\pi",
  ϖ: "\\varpi",
  ρ: "\\rho",
  ϱ: "\\varrho",
  σ: "\\sigma",
  ς: "\\varsigma",
  τ: "\\tau",
  υ: "\\upsilon",
  φ: "\\varphi",
  ϕ: "\\phi",
  χ: "\\chi",
  ψ: "\\psi",
  ω: "\\omega",
  // 希腊字母（大写，与拉丁字母同形者不转义）
  Γ: "\\Gamma",
  Δ: "\\Delta",
  Θ: "\\Theta",
  Λ: "\\Lambda",
  Ξ: "\\Xi",
  Π: "\\Pi",
  Σ: "\\Sigma",
  Υ: "\\Upsilon",
  Φ: "\\Phi",
  Ψ: "\\Psi",
  Ω: "\\Omega",
  // 运算与关系
  "×": "\\times",
  "÷": "\\div",
  "±": "\\pm",
  "∓": "\\mp",
  "⋅": "\\cdot",
  "•": "\\cdot",
  "−": "-",
  "|": "\\mid",
  "≤": "\\leq",
  "≥": "\\geq",
  "≠": "\\neq",
  "≈": "\\approx",
  "≅": "\\cong",
  "≡": "\\equiv",
  "∼": "\\sim",
  "∝": "\\propto",
  "∂": "\\partial",
  "∇": "\\nabla",
  "°": "\\degree",
  "′": "\\prime",
  "″": "\\prime\\prime",
  "…": "\\ldots",
  "⋯": "\\cdots",
  "⋮": "\\vdots",
  "∠": "\\angle",
  "⊥": "\\perp",
  "∥": "\\parallel",
  "‖": "\\|",
  "†": "\\dagger",
  "∞": "\\infty",
  "∅": "\\emptyset",
  // 箭头
  "→": "\\rightarrow",
  "←": "\\leftarrow",
  "↔": "\\leftrightarrow",
  "⟶": "\\longrightarrow",
  "⟵": "\\longleftarrow",
  "⇒": "\\Rightarrow",
  "⇐": "\\Leftarrow",
  "⇔": "\\Leftrightarrow",
  "↑": "\\uparrow",
  "↓": "\\downarrow",
  "↕": "\\updownarrow",
  // 集合
  "∈": "\\in",
  "∉": "\\notin",
  "∋": "\\ni",
  "⊂": "\\subset",
  "⊃": "\\supset",
  "⊆": "\\subseteq",
  "⊇": "\\supseteq",
  "∪": "\\cup",
  "∩": "\\cap",
  "∀": "\\forall",
  "∃": "\\exists",
  "∄": "\\nexists",
  "∑": "\\sum",
  "∫": "\\int",
  "∬": "\\iint",
  "∭": "\\iiint",
  "∮": "\\oint",
  "∏": "\\prod",
  "⋃": "\\bigcup",
  "⋂": "\\bigcap",
  "⨁": "\\bigoplus",
  "⨂": "\\bigotimes",
  "⋁": "\\bigvee",
  "⋀": "\\bigwedge",
  // 双写字母数集
  ℕ: "\\mathbb{N}",
  ℤ: "\\mathbb{Z}",
  ℚ: "\\mathbb{Q}",
  ℝ: "\\mathbb{R}",
  ℂ: "\\mathbb{C}",
  ℙ: "\\mathbb{P}",
};

/** 需要反斜杠转义的 LaTeX 特殊字符（符号映射未覆盖时）。 */
const LATEX_ESCAPES: Readonly<Record<string, string>> = {
  "&": "\\&",
  "%": "\\%",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "~": "\\textasciitilde",
  "^": "\\textasciicircum",
  "\\": "\\backslash",
};

/** m:nary 大算符字符 → LaTeX 命令。 */
const NARY_MAP: Readonly<Record<string, string>> = {
  "∫": "\\int",
  "∬": "\\iint",
  "∭": "\\iiint",
  "∮": "\\oint",
  "∑": "\\sum",
  "∏": "\\prod",
  "⋃": "\\bigcup",
  "⋂": "\\bigcap",
  "⨁": "\\bigoplus",
  "⨂": "\\bigotimes",
  "⋁": "\\bigvee",
  "⋀": "\\bigwedge",
};

/** m:acc 重音字符 → LaTeX 命令。 */
const ACCENT_MAP: Readonly<Record<string, string>> = {
  ˆ: "\\hat",
  "^": "\\hat",
  "¯": "\\bar",
  ˉ: "\\bar",
  "⃗": "\\vec",
  "˙": "\\dot",
  "¨": "\\ddot",
  "̃": "\\tilde",
  "~": "\\tilde",
  ˇ: "\\check",
  "˘": "\\breve",
  ˊ: "\\acute",
  ˋ: "\\grave",
  "⃛": "\\dddot",
  "́": "\\acute",
  "̀": "\\grave",
  "̂": "\\widehat",
};

/** rPr 字符样式（m:scr）→ LaTeX 命令。 */
const SCRIPT_MAP: Readonly<Record<string, string>> = {
  roman: "\\mathrm",
  script: "\\mathscr",
  fraktur: "\\mathfrak",
  "double-struck": "\\mathbb",
  "sans-serif": "\\mathsf",
  monospace: "\\mathtt",
};

/** rPr 文本样式（m:sty）→ LaTeX 命令。 */
const STYLE_MAP: Readonly<Record<string, string>> = {
  b: "\\mathbf",
  i: "\\mathit",
  bi: "\\boldsymbol",
};

const MS_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/math";

function isElement(node: ChildNode): node is Element {
  return node.nodeType === 1;
}

function elementChildren(element: Element): Element[] {
  const result: Element[] = [];
  for (const child of element.childNodes) {
    if (isElement(child)) result.push(child);
  }
  return result;
}

function firstChild(element: Element, tag: string): Element | null {
  for (const child of elementChildren(element)) {
    if (child.nodeName.toLowerCase() === tag) return child;
  }
  return null;
}

function mVal(element: Element): string {
  return element.getAttribute("m:val") ?? element.getAttribute("val") ?? "";
}

/** 单个 Unicode 字符 → LaTeX 片段（符号映射优先，其次特殊转义，最后原样）。 */
function convertChar(character: string): string {
  const mapped = SYMBOL_MAP[character];
  if (mapped !== undefined) return mapped;
  const escaped = LATEX_ESCAPES[character];
  if (escaped !== undefined) return escaped;
  return character;
}

/** m:t 文本 → LaTeX（逐字符转换，保留空格）。 */
function convertTextNode(text: string): string {
  return joinLatex(Array.from(text.replace(/\u00a0/gu, " "), convertChar));
}

/** Keep adjacent runs from turning e.g. alpha followed by x into an unknown command. */
function joinLatex(parts: string[]): string {
  const output: string[] = [];
  let previous = "";
  for (const part of parts) {
    if (!part) continue;
    if (/\\[a-zA-Z]+$/u.test(previous) && /^[a-zA-Z]/u.test(part)) output.push(" ");
    output.push(part);
    previous = part;
  }
  return output.join("");
}

/** 包裹一组文本为 LaTeX 命令参数：单字符/简单序列直接参数化。 */
function wrapLatex(content: string): string {
  if (content === "") return "";
  return `{${content}}`;
}

/** m:r 文本运行 → LaTeX（应用 rPr 的样式/字体）。 */
function convertRun(element: Element): string {
  const children = elementChildren(element);
  const textElement = children.find((child) => child.nodeName.toLowerCase() === "m:t");
  const text = textElement?.textContent ?? "";
  let content = convertTextNode(text);
  if (content === "") return "";
  const properties = firstChild(element, "m:rpr");
  const styleValue = properties ? mVal(firstChild(properties, "m:sty") ?? properties) : "";
  const scriptValue = properties ? mVal(firstChild(properties, "m:scr") ?? properties) : "";
  const styleCommand = styleValue ? STYLE_MAP[styleValue] : undefined;
  const scriptCommand =
    scriptValue && !(scriptValue === "roman" && styleCommand) ? SCRIPT_MAP[scriptValue] : undefined;
  if (styleValue === "p" && !scriptCommand) content = `\\mathrm${wrapLatex(content)}`;
  if (scriptCommand !== undefined) content = `${scriptCommand}${wrapLatex(content)}`;
  if (styleCommand !== undefined) content = `${styleCommand}${wrapLatex(content)}`;
  return content;
}

/** m:f 分数 → \frac{num}{den}。 */
function convertFraction(element: Element): string {
  const num = firstChild(element, "m:num");
  const den = firstChild(element, "m:den");
  const properties = firstChild(element, "m:fpr");
  const type = properties ? firstChild(properties, "m:type") : null;
  const command = type && mVal(type) === "noBar" ? "\\genfrac{}{}{0pt}{}" : "\\frac";
  return `${command}{${num ? convertElement(num) : ""}}{${den ? convertElement(den) : ""}}`;
}

/** m:sSup / m:sSub / m:sSubSup 上下标。 */
function convertScript(element: Element): string {
  const baseElement = requiredChild(element, "m:e");
  const baseChildren = elementChildren(baseElement);
  const singleRun =
    baseChildren.length === 1 && baseChildren[0]?.nodeName.toLowerCase() === "m:r"
      ? baseChildren[0]
      : null;
  const singleCharacter =
    singleRun && Array.from(firstChild(singleRun, "m:t")?.textContent ?? "").length === 1;
  const content = convertElement(baseElement);
  const base = singleCharacter ? content : `{${content}}`;
  const sub = firstChild(element, "m:sub");
  const sup = firstChild(element, "m:sup");
  const hasSub = sub !== null && sub.childNodes.length > 0;
  const hasSup = sup !== null && sup.childNodes.length > 0;
  const subLatex = hasSub ? convertElement(sub) : "";
  const supLatex = hasSup ? convertElement(sup) : "";
  const tag = element.nodeName.toLowerCase();
  if (tag === "m:ssubsup") {
    return `${base}_{${subLatex}}^{${supLatex}}`;
  }
  if (tag === "m:ssup") return `${base}^{${supLatex}}`;
  return `${base}_{${subLatex}}`;
}

function requiredChild(element: Element, tag: string): Element {
  const child = firstChild(element, tag);
  if (!child) throw new Error(`OMML 元素 ${element.nodeName} 缺少 ${tag} 子节点。`);
  return child;
}

/** m:nary 大算符（求和/积分/连乘）。 */
function convertNary(element: Element): string {
  const properties = firstChild(element, "m:narypr");
  const chr = properties ? mVal(firstChild(properties, "m:chr") ?? properties) : "∫";
  const command = NARY_MAP[chr] ?? SYMBOL_MAP[chr] ?? "\\int";
  const limLoc = properties ? mVal(firstChild(properties, "m:limloc") ?? properties) : "subSup";
  const sub = firstChild(element, "m:sub");
  const sup = firstChild(element, "m:sup");
  const subLatex = sub && sub.childNodes.length > 0 ? convertElement(sub) : "";
  const supLatex = sup && sup.childNodes.length > 0 ? convertElement(sup) : "";
  const body = convertElement(requiredChild(element, "m:e"));
  if (limLoc === "sub") return `${command}_{${subLatex}} ${body}`;
  if (limLoc === "upp") return `${command}^{${supLatex}} ${body}`;
  return `${command}_{${subLatex}}^{${supLatex}} ${body}`;
}

/** m:rad 根式。 */
function convertRadical(element: Element): string {
  const degree = firstChild(element, "m:deg");
  const base = convertElement(requiredChild(element, "m:e"));
  if (degree && degree.childNodes.length > 0) {
    return `\\sqrt[${convertElement(degree)}]${wrapLatex(base)}`;
  }
  return `\\sqrt${wrapLatex(base)}`;
}

/** 定界符字符（\left...\right 边界）的 LaTeX 表示。 */
function delimiterChar(character: string): string {
  if (character === "") return ".";
  if (character === "∣" || character === "│") return "|";
  if (character === "|") return "|";
  if (character === "{") return "\\{";
  if (character === "}") return "\\}";
  if (character === "[" || character === "]") return character;
  if (character === "(" || character === ")") return character;
  if (character === "<" || character === ">") return character;
  return convertChar(character);
}

/** m:d 定界符（括号）→ \left...\right。 */
function convertDelimiter(element: Element): string {
  const properties = firstChild(element, "m:dpr");
  const beginElement = properties ? firstChild(properties, "m:begchr") : null;
  const endElement = properties ? firstChild(properties, "m:endchr") : null;
  const beg = beginElement ? mVal(beginElement) : "(";
  const end = endElement ? mVal(endElement) : ")";
  const separatorElement = properties ? firstChild(properties, "m:sepchr") : null;
  const separator = separatorElement ? mVal(separatorElement) : "|";
  const contents = elementChildren(element).filter(
    (child) => child.nodeName.toLowerCase() === "m:e",
  );
  const body = contents
    .map((entry) => convertElement(entry))
    .join(separator ? `\\middle${delimiterChar(separator)} ` : "");
  return `\\left${delimiterChar(beg)}${body}\\right${delimiterChar(end)}`;
}

/** m:eqArr 多行等式 → aligned 环境。 */
function convertEquationArray(element: Element): string {
  const rows = elementChildren(element).filter((child) => child.nodeName.toLowerCase() === "m:e");
  const latexRows = rows.map((row) => convertElement(row).replace(/\u200b/gu, ""));
  return `\\begin{aligned}${latexRows.join(" \\\\ ")}${latexRows.length > 0 ? " " : ""}\\end{aligned}`;
}

/** m:m 矩阵 → matrix 环境。 */
function convertMatrix(element: Element): string {
  const rows = elementChildren(element).filter((child) => child.nodeName.toLowerCase() === "m:mr");
  const latexRows = rows.map((row) =>
    elementChildren(row)
      .filter((child) => child.nodeName.toLowerCase() === "m:e")
      .map((cell) => convertElement(cell))
      .join(" & "),
  );
  const columnCount = Math.max(
    0,
    ...rows.map(
      (row) =>
        elementChildren(row).filter((child) => child.nodeName.toLowerCase() === "m:e").length,
    ),
  );
  const properties = firstChild(element, "m:mpr");
  const columns = properties ? firstChild(properties, "m:mcs") : null;
  const alignment: string[] = [];
  for (const column of columns ? elementChildren(columns) : []) {
    if (column.nodeName.toLowerCase() !== "m:mc") continue;
    const columnProperties = firstChild(column, "m:mcpr");
    const countElement = columnProperties ? firstChild(columnProperties, "m:count") : null;
    const justification = columnProperties ? firstChild(columnProperties, "m:mcjc") : null;
    const count = countElement ? Number(mVal(countElement)) : 1;
    const value = justification ? mVal(justification) : "center";
    // Bound expansion by real cells, not by an untrusted DOCX count attribute.
    const remaining = columnCount - alignment.length;
    const repeat =
      Number.isSafeInteger(count) && count > 0
        ? Math.min(count, remaining)
        : Math.min(1, remaining);
    alignment.push(
      ...Array<string>(repeat).fill(value === "left" ? "l" : value === "right" ? "r" : "c"),
    );
  }
  while (alignment.length < columnCount) alignment.push("c");
  if (alignment.some((value) => value !== "c")) {
    return `\\begin{array}{${alignment.join("")}}${latexRows.join(" \\\\ ")}\\end{array}`;
  }
  return `\\begin{matrix}${latexRows.join(" \\\\ ")}\\end{matrix}`;
}

/** m:bar 上/下横线。 */
function convertBar(element: Element): string {
  const properties = firstChild(element, "m:barpr");
  const position = properties ? mVal(firstChild(properties, "m:pos") ?? properties) : "";
  const body = convertElement(requiredChild(element, "m:e"));
  return position === "top" ? `\\overline${wrapLatex(body)}` : `\\underline${wrapLatex(body)}`;
}

/** m:acc 重音。 */
function convertAccent(element: Element): string {
  const properties = firstChild(element, "m:accpr");
  const chr = properties ? mVal(firstChild(properties, "m:chr") ?? properties) : "ˆ";
  const command = ACCENT_MAP[chr] ?? "\\hat";
  const body = convertElement(requiredChild(element, "m:e"));
  return `${command}${wrapLatex(body)}`;
}

/** m:groupChr 组合字符（上下大括号）。 */
function convertGroupChar(element: Element): string {
  const properties = firstChild(element, "m:groupchrpr");
  const position = (properties ? mVal(firstChild(properties, "m:pos") ?? properties) : "") || "bot";
  const body = convertElement(requiredChild(element, "m:e"));
  if (position === "bottom" || position === "bot") return `\\underbrace${wrapLatex(body)}`;
  return `\\overbrace${wrapLatex(body)}`;
}

/** m:func 函数 f(x)。 */
function convertFunction(element: Element): string {
  const name = convertElement(requiredChild(element, "m:fname"));
  const body = convertElement(requiredChild(element, "m:e"));
  return `\\operatorname{${name.replace(/[{}]/gu, "")}}${wrapLatex(body)}`;
}

/** m:limLow / m:limUpp 上下极限。 */
function convertLimit(element: Element): string {
  const tag = element.nodeName.toLowerCase();
  const limit = convertElement(requiredChild(element, "m:lim"));
  const body = convertElement(requiredChild(element, "m:e"));
  return tag === "m:limupp"
    ? `\\overset${wrapLatex(limit)}${wrapLatex(body)}`
    : `\\underset${wrapLatex(limit)}${wrapLatex(body)}`;
}

/** m:aln 对齐标记（eqArr 内）→ "&"。 */
function convertAlignment(): string {
  return "&";
}

function convertElement(element: Element): string {
  const tag = element.nodeName.toLowerCase();
  switch (tag) {
    case "m:t":
      return convertTextNode(element.textContent ?? "");
    case "m:r":
      return convertRun(element);
    case "m:f":
      return convertFraction(element);
    case "m:ssup":
    case "m:ssub":
    case "m:ssubsup":
      return convertScript(element);
    case "m:nary":
      return convertNary(element);
    case "m:rad":
      return convertRadical(element);
    case "m:d":
      return convertDelimiter(element);
    case "m:eqarr":
      return convertEquationArray(element);
    case "m:m":
      return convertMatrix(element);
    case "m:bar":
      return convertBar(element);
    case "m:acc":
      return convertAccent(element);
    case "m:groupchr":
      return convertGroupChar(element);
    case "m:func":
      return convertFunction(element);
    case "m:limlow":
    case "m:limupp":
      return convertLimit(element);
    case "m:aln":
      return convertAlignment();
    case "m:omath":
    case "m:omathpara":
    case "m:num":
    case "m:den":
    case "m:e":
    case "m:sup":
    case "m:sub":
    case "m:fname":
    case "m:lim":
    case "m:deg":
    case "m:mr":
    case "m:rpr":
    case "m:sty":
    case "m:scr":
    case "m:narypr":
    case "m:chr":
    case "m:limloc":
    case "m:dpr":
    case "m:begchr":
    case "m:endchr":
    case "m:sepchr":
    case "m:barpr":
    case "m:pos":
    case "m:accpr":
    case "m:groupchrpr":
    case "m:mpr":
    case "m:mcs":
    case "m:mc":
    case "m:mcpr":
    case "m:ctrlpr":
    case "m:argpr":
    case "m:eqarrpr":
    case "m:basejc":
    case "m:maxdist":
    case "m:radpr":
      return joinLatex(elementChildren(element).map((child) => convertElement(child)));
    default:
      // 未知 m: 子元素：递归拼接，防止丢内容。
      return joinLatex(elementChildren(element).map((child) => convertElement(child)));
  }
}

function isMathElement(element: Element): boolean {
  const tag = element.nodeName.toLowerCase();
  return tag === "m:omath" || tag === "m:omathpara";
}

/**
 * HTML 解析器不认未知元素（如 `<m:limLoc/>`）的 XML 自闭合写法，
 * 会把后续内容错误嵌套。Word 粘贴的 OMML 大量使用自闭合属性元素，
 * 解析前先把它们展开为成对标签。
 */
export function expandSelfClosingMathElements(input: string): string {
  return input.replace(
    /<m:([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\s*\/>/gu,
    (_match, name: string, attributes: string) => `<m:${name}${attributes}></m:${name}>`,
  );
}

/**
 * 把 HTML 中的 OMML 公式逐个转换为 LaTeX，并以占位 token 替换公式元素。
 * 返回 { html, formulas }，调用方随后将 token 替换为公式节点。
 *
 * @param input 粘贴的 HTML（text/html）。
 * @param tokenFor 生成第 i 个公式占位 token（默认返回私有区字符序列，避免与正文冲突）。
 */
export function replaceOmmlWithTokens(
  input: string,
  tokenFor: (index: number) => string = (index) => `\uE000PWF${index}\uE001`,
): { html: string; formulas: { latex: string }[] } {
  const parsed = new DOMParser().parseFromString(expandSelfClosingMathElements(input), "text/html");
  const formulas: { latex: string }[] = [];
  // 只处理最外层公式元素（oMathPara 内含 oMath 时由外层递归覆盖）。
  const mathElements = [...parsed.body.querySelectorAll("*")].filter(
    (element) =>
      isMathElement(element) && !(element.parentElement && isMathElement(element.parentElement)),
  );
  for (const element of mathElements) {
    let latex: string | null = null;
    try {
      const converted = convertElement(element);
      latex = converted.replace(/\s+/gu, " ").trim();
    } catch {
      latex = null;
    }
    const index = formulas.length;
    formulas.push({ latex: latex ?? "" });
    const token = parsed.createElement("span");
    token.textContent = tokenFor(index);
    element.replaceWith(token);
  }
  return { html: parsed.body.innerHTML, formulas };
}

/** 便捷入口：解析 HTML 取第一个 OMML 公式并转换为 LaTeX。 */
export function ommlToLatex(input: string): string | null {
  const { formulas } = replaceOmmlWithTokens(input);
  const first = formulas.find((formula) => formula.latex !== "");
  if (!first) return null;
  return first.latex;
}

/** Node/main-process entry point for a standalone OMML XML element. */
export function ommlXmlToLatex(input: string): string | null {
  try {
    const document = new XmlDomParser().parseFromString(input, "text/xml");
    const converted = convertElement(document.documentElement as unknown as Element);
    const latex = converted.replace(/\s+/gu, " ").trim();
    return latex || null;
  } catch {
    return null;
  }
}

/** 元素级入口：单个 OMML 元素 → LaTeX（供 paste-sanitizer 批量扫描使用）。 */
export function convertOmmlElement(element: Element): string {
  return convertElement(element);
}

/**
 * 轻量启发式：判定 LaTeX 是否为"纯化学式"（仅元素符号与下标数字）。
 * 命中则作为 formulaKind="chemistry" 的公式节点插入，否则按数学公式。
 */
export function inferFormulaKind(latex: string): "math" | "chemistry" {
  const compact = latex.replace(/\s+/gu, "");
  if (compact === "") return "math";
  if (
    /\\frac|\\sqrt|\\int|\\sum|\\prod|\\left|\\right|\\begin|\\operatorname|\\lim|\\over/gu.test(
      compact,
    )
  ) {
    return "math";
  }
  // 需含数字下标（如 _{2}），且去除下标与数字后的主体须为纯元素符号序列。
  if (!/_(?:\{?\d+\}?)/u.test(compact)) return "math";
  const body = compact
    .replace(/_(?:\{?\d+\}?)/gu, "")
    .replace(/\d+/gu, "")
    .replace(/[+\-·()[\].,]/gu, "");
  if (body === "") return "math";
  if (/^[A-Z][a-z]?(?:[A-Z][a-z]?)*$/u.test(body)) return "chemistry";
  return "math";
}

export { MS_NAMESPACE };
