import { DOMParser, type Element, XMLSerializer } from "@xmldom/xmldom";
import { ImportedXmlComponent, type MathComponent, Math as OfficeMath } from "docx";
import katex from "katex";
import type { FormulaKind } from "../../shared/document/model.js";
import type { ExportIssue } from "../../shared/exports/report.js";
import { type FormulaFallbackImage, renderFormulaFallback } from "./formula-fallback.js";

const MAX_AST_NODES = 10_000;
const MAX_AST_DEPTH = 128;
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
const RASTERIZED_MESSAGE = "公式已转换为图片，无法在 Word 公式编辑器中编辑。";
const CHEMISTRY_RENDERED_AS_IMAGE_MESSAGE =
  "化学方程式已按设计导出为图形；源数据已保留，可在本应用中编辑，未丢失数据。";
const UNTRUSTED_TEX =
  /\\(?:def|edef|gdef|global|href|htmlClass|htmlData|htmlId|htmlStyle|includegraphics|let|newcommand|providecommand|renewcommand|require|url|xdef)\b|\\begin\s*\{\s*tikz/iu;

export type MathAst =
  | { kind: "row"; children: MathAst[] }
  | { kind: "token"; text: string; variant?: string }
  | { kind: "accent"; base: MathAst; character: string }
  | { kind: "bar"; base: MathAst; position: "top" | "bot" }
  | { kind: "brace"; base: MathAst; position: "top" | "bot" }
  | { kind: "fraction"; numerator: MathAst; denominator: MathAst; noBar?: boolean }
  | { kind: "delimiter"; begin: string; end: string; bodies: MathAst[]; separator?: string }
  | { kind: "root"; radicand: MathAst; degree?: MathAst }
  | { kind: "sub"; base: MathAst; subscript: MathAst }
  | { kind: "sup"; base: MathAst; superscript: MathAst }
  | { kind: "subsup"; base: MathAst; subscript: MathAst; superscript: MathAst }
  | { kind: "under"; base: MathAst; limit: MathAst }
  | { kind: "over"; base: MathAst; limit: MathAst }
  | { kind: "underover"; base: MathAst; lower: MathAst; upper: MathAst }
  | { kind: "matrix"; rows: MathAst[][]; columnAlign?: string[] };

export type FormulaExport =
  | { kind: "native"; math: OfficeMath; issues: [] }
  | { kind: "raster"; image: FormulaFallbackImage; issues: [ExportIssue] };

type ParseState = {
  nodeCount: number;
};

function elementChildren(element: Element): Element[] {
  const children: Element[] = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (!child) continue;
    if (child.nodeType === 1) {
      children.push(child as Element);
      continue;
    }
    if (child.nodeType === 3 && (child.nodeValue ?? "").trim().length === 0) continue;
    throw new Error("公式 MathML 包含不允许的节点。");
  }
  return children;
}

function exactChildren(element: Element, count: number): Element[] {
  const children = elementChildren(element);
  if (children.length !== count) {
    throw new Error(`公式 MathML 节点 ${element.localName} 的子节点数量无效。`);
  }
  return children;
}

function isScalableFence(element: Element | undefined): element is Element {
  return Boolean(
    element?.localName === "mo" &&
      element.getAttribute("fence") === "true" &&
      element.getAttribute("stretchy") !== "false" &&
      !element.hasAttribute("minsize") &&
      !element.hasAttribute("maxsize"),
  );
}

function parseElement(element: Element, depth: number, state: ParseState): MathAst | null {
  if (depth > MAX_AST_DEPTH) throw new Error("公式 MathML 嵌套过深。");
  if (element.namespaceURI !== MATHML_NAMESPACE) {
    throw new Error("公式 MathML 包含不允许的命名空间。");
  }
  const name = element.localName;
  if (name === "annotation") return null;
  state.nodeCount += 1;
  if (state.nodeCount > MAX_AST_NODES) throw new Error("公式 MathML 节点过多。");

  const parseChildren = (): MathAst[] =>
    elementChildren(element)
      .map((child) => parseElement(child, depth + 1, state))
      .filter((child): child is MathAst => child !== null);
  const parseRequired = (child: Element): MathAst => {
    const parsed = parseElement(child, depth + 1, state);
    if (!parsed) throw new Error("公式 MathML 结构无效。");
    return parsed;
  };

  switch (name) {
    case "math":
    case "semantics":
      return { kind: "row", children: parseChildren() };
    case "mrow": {
      const children = elementChildren(element);
      const first = children[0];
      const last = children.at(-1);
      const hasBegin = isScalableFence(first);
      const hasEnd = first !== last && isScalableFence(last);
      if (!children.some(isScalableFence)) return { kind: "row", children: parseChildren() };
      // KaTeX puts each \left/\right pair (including a missing side) in its own row.
      const fenceText = (fence: Element): string => {
        const parsed = parseRequired(fence);
        if (parsed.kind !== "token") throw new Error("公式括号结构无效。");
        return parsed.text;
      };
      const bodies: MathAst[] = [];
      let body: MathAst[] = [];
      let separator: string | undefined;
      for (const child of children.slice(hasBegin ? 1 : 0, hasEnd ? -1 : undefined)) {
        if (isScalableFence(child)) {
          const character = fenceText(child);
          if (separator !== undefined && separator !== character)
            throw new Error("不同的中间分隔符暂不支持原生导出。");
          separator = character;
          bodies.push({ kind: "row", children: body });
          body = [];
        } else {
          body.push(parseRequired(child));
        }
      }
      bodies.push({ kind: "row", children: body });
      return {
        kind: "delimiter",
        begin: hasBegin ? fenceText(first) : "",
        end: hasEnd ? fenceText(last) : "",
        bodies,
        ...(separator === undefined ? {} : { separator }),
      };
    }
    case "mi":
    case "mn":
    case "mo":
    case "mtext": {
      for (let index = 0; index < element.childNodes.length; index += 1) {
        const child = element.childNodes.item(index);
        if (child && child.nodeType !== 3) {
          throw new Error("公式 MathML 文本节点不得包含其他节点。");
        }
      }
      const text = element.textContent ?? "";
      const variant =
        element.getAttribute("mathvariant") ||
        (name === "mi" && Array.from(text).length === 1 ? undefined : "normal");
      return { kind: "token", text, ...(variant ? { variant } : {}) };
    }
    case "mfrac": {
      const [numerator, denominator] = exactChildren(element, 2);
      if (!numerator || !denominator) throw new Error("分数结构无效。");
      return {
        kind: "fraction",
        numerator: parseRequired(numerator),
        denominator: parseRequired(denominator),
        ...(element.getAttribute("linethickness") === "0px" ? { noBar: true } : {}),
      };
    }
    case "msqrt":
      return { kind: "root", radicand: { kind: "row", children: parseChildren() } };
    case "mroot": {
      const [radicand, degree] = exactChildren(element, 2);
      if (!radicand || !degree) throw new Error("根式结构无效。");
      return { kind: "root", radicand: parseRequired(radicand), degree: parseRequired(degree) };
    }
    case "msub": {
      const [base, subscript] = exactChildren(element, 2);
      if (!base || !subscript) throw new Error("下标结构无效。");
      return { kind: "sub", base: parseRequired(base), subscript: parseRequired(subscript) };
    }
    case "msup": {
      const [base, superscript] = exactChildren(element, 2);
      if (!base || !superscript) throw new Error("上标结构无效。");
      return { kind: "sup", base: parseRequired(base), superscript: parseRequired(superscript) };
    }
    case "msubsup": {
      const [base, subscript, superscript] = exactChildren(element, 3);
      if (!base || !subscript || !superscript) throw new Error("上下标结构无效。");
      return {
        kind: "subsup",
        base: parseRequired(base),
        subscript: parseRequired(subscript),
        superscript: parseRequired(superscript),
      };
    }
    case "munder": {
      const [base, limit] = exactChildren(element, 2);
      if (!base || !limit) throw new Error("下限结构无效。");
      if (limit.localName === "mo" && limit.textContent === "⏟")
        return { kind: "brace", base: parseRequired(base), position: "bot" };
      if (element.getAttribute("accentunder") === "true") {
        if (limit.textContent === "‾")
          return { kind: "bar", base: parseRequired(base), position: "bot" };
        throw new Error("下方重音暂不支持原生公式导出。");
      }
      if (limit.getAttribute("stretchy") === "true")
        throw new Error("伸展标注暂不支持原生公式导出。");
      return { kind: "under", base: parseRequired(base), limit: parseRequired(limit) };
    }
    case "mover": {
      const [base, limit] = exactChildren(element, 2);
      if (!base || !limit) throw new Error("上限结构无效。");
      if (limit.localName === "mo" && limit.textContent === "⏞")
        return { kind: "brace", base: parseRequired(base), position: "top" };
      if (element.getAttribute("accent") === "true") {
        if (limit.textContent === "‾")
          return { kind: "bar", base: parseRequired(base), position: "top" };
        const mark = parseRequired(limit);
        if (mark.kind !== "token" || Array.from(mark.text).length !== 1)
          throw new Error("重音结构无效。");
        return { kind: "accent", base: parseRequired(base), character: mark.text };
      }
      if (limit.getAttribute("stretchy") === "true")
        throw new Error("伸展标注暂不支持原生公式导出。");
      return { kind: "over", base: parseRequired(base), limit: parseRequired(limit) };
    }
    case "munderover": {
      const [base, lower, upper] = exactChildren(element, 3);
      if (!base || !lower || !upper) throw new Error("上下限结构无效。");
      return {
        kind: "underover",
        base: parseRequired(base),
        lower: parseRequired(lower),
        upper: parseRequired(upper),
      };
    }
    case "mtable": {
      const columnAlign = (element.getAttribute("columnalign") || "center").trim().split(/\s+/u);
      if (columnAlign.some((value) => !["left", "center", "right"].includes(value)))
        throw new Error("矩阵列对齐方式暂不支持原生导出。");
      return {
        kind: "matrix",
        columnAlign,
        rows: elementChildren(element).map((row) => {
          if (row.localName !== "mtr" || row.namespaceURI !== MATHML_NAMESPACE) {
            throw new Error("矩阵行结构无效。");
          }
          if (depth + 1 > MAX_AST_DEPTH) throw new Error("公式 MathML 嵌套过深。");
          state.nodeCount += 1;
          if (state.nodeCount > MAX_AST_NODES) throw new Error("公式 MathML 节点过多。");
          return elementChildren(row).map((cell) => {
            if (cell.localName !== "mtd" || cell.namespaceURI !== MATHML_NAMESPACE) {
              throw new Error("矩阵单元格结构无效。");
            }
            const parsed = parseElement(cell, depth + 2, state);
            if (!parsed) throw new Error("矩阵单元格结构无效。");
            return parsed;
          });
        }),
      };
    }
    case "mtr":
    case "mtd":
      return { kind: "row", children: parseChildren() };
    default:
      throw new Error(`公式 MathML 包含不支持的元素：${name}`);
  }
}

export function normalizeKatexMathMl(mathMl: string): string {
  if (!mathMl.includes("<mstyle")) return mathMl;
  const document = new DOMParser({
    onError: (_level, message) => {
      throw new Error(`KaTeX MathML 无法解析：${message}`);
    },
  }).parseFromString(mathMl, "application/xml");
  const styleNodes = document.getElementsByTagNameNS(MATHML_NAMESPACE, "mstyle");
  const styles = Array.from({ length: styleNodes.length }, (_, index) => styleNodes.item(index));

  for (const style of styles) {
    if (style?.nodeType !== 1) throw new Error("KaTeX 公式样式结构无效。");
    const parent = style.parentNode;
    if (
      parent?.nodeType !== 1 ||
      parent.namespaceURI !== MATHML_NAMESPACE ||
      style.attributes.length !== 2 ||
      style.getAttribute("scriptlevel") !== "0" ||
      (style.getAttribute("displaystyle") !== "true" &&
        style.getAttribute("displaystyle") !== "false")
    ) {
      throw new Error("KaTeX 公式样式结构无效。");
    }
    const attributes = Array.from({ length: style.attributes.length }, (_, index) =>
      style.attributes.item(index),
    );
    if (
      attributes.some(
        (attribute) =>
          !attribute ||
          !(
            (attribute.name === "scriptlevel" && attribute.value === "0") ||
            (attribute.name === "displaystyle" &&
              (attribute.value === "true" || attribute.value === "false"))
          ),
      )
    ) {
      throw new Error("KaTeX 公式样式结构无效。");
    }
    const children = elementChildren(style);
    if (children.length === 0) throw new Error("KaTeX 公式样式内容为空。");
    for (const child of children) parent.insertBefore(child, style);
    parent.removeChild(style);
  }

  return new XMLSerializer().serializeToString(document, { requireWellFormed: true });
}

export function parseMathMlToAst(mathMl: string): MathAst {
  if (/<!DOCTYPE|<!ENTITY|\b(?:SYSTEM|PUBLIC)\s+["']/iu.test(mathMl)) {
    throw new Error("公式 MathML 不允许实体或外部声明。");
  }
  const parser = new DOMParser({
    onError: (_level, message) => {
      throw new Error(`公式 MathML 无法解析：${message}`);
    },
  });
  const document = parser.parseFromString(mathMl, "application/xml");
  const root = document.documentElement;
  if (!root) throw new Error("公式 MathML 缺少根节点。");
  const mathElements = document.getElementsByTagNameNS(MATHML_NAMESPACE, "math");
  if (mathElements.length !== 1) throw new Error("公式 MathML 必须包含一个 math 根节点。");
  const math = mathElements.item(0);
  if (!math) throw new Error("公式 MathML 缺少 math 根节点。");
  if (root !== math) {
    const wrapperChildren = elementChildren(root);
    if (
      root.localName !== "span" ||
      root.namespaceURI !== null ||
      root.attributes.length !== 1 ||
      root.getAttribute("class") !== "katex" ||
      wrapperChildren.length !== 1 ||
      wrapperChildren[0] !== math
    ) {
      throw new Error("公式 MathML 包含不允许的外层元素。");
    }
  }
  const parsed = parseElement(math, 1, { nodeCount: 0 });
  if (!parsed) throw new Error("公式 MathML 内容为空。");
  return parsed;
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function astText(ast: MathAst): string {
  switch (ast.kind) {
    case "token":
      return ast.text;
    case "row":
      return ast.children.map(astText).join("");
    default:
      return "";
  }
}

function naryCharacter(ast: MathAst): string | null {
  const text = astText(ast).replaceAll("⁡", "").trim();
  return text === "∑" || text === "∏" || text === "∫" ? text : null;
}

function isLimit(ast: MathAst): boolean {
  return astText(ast).replaceAll("⁡", "").trim() === "lim";
}

function serializeSequence(ast: MathAst): string {
  return serializeMathAstToOmml(ast).join("");
}

function serializeNary(
  character: string,
  subscript: MathAst | undefined,
  superscript: MathAst | undefined,
): string {
  return `<m:nary><m:naryPr><m:chr m:val="${character}"/><m:limLoc m:val="undOvr"/></m:naryPr>${
    subscript ? `<m:sub>${serializeSequence(subscript)}</m:sub>` : "<m:sub/>"
  }${superscript ? `<m:sup>${serializeSequence(superscript)}</m:sup>` : "<m:sup/>"}<m:e/></m:nary>`;
}

const MATH_VARIANTS: Readonly<Record<string, readonly [string, string]>> = {
  normal: ["roman", "p"],
  bold: ["roman", "b"],
  italic: ["roman", "i"],
  "bold-italic": ["roman", "bi"],
  "double-struck": ["double-struck", "p"],
  script: ["script", "p"],
  "bold-script": ["script", "b"],
  fraktur: ["fraktur", "p"],
  "bold-fraktur": ["fraktur", "b"],
  "sans-serif": ["sans-serif", "p"],
  "bold-sans-serif": ["sans-serif", "b"],
  "sans-serif-italic": ["sans-serif", "i"],
  "sans-serif-bold-italic": ["sans-serif", "bi"],
  monospace: ["monospace", "p"],
};

export function serializeMathAstToOmml(ast: MathAst): string[] {
  switch (ast.kind) {
    case "row":
      return ast.children.flatMap(serializeMathAstToOmml);
    case "token": {
      const variant =
        ast.variant && Object.hasOwn(MATH_VARIANTS, ast.variant)
          ? MATH_VARIANTS[ast.variant]
          : undefined;
      if (ast.variant && !variant) throw new Error("公式字体样式暂不支持原生导出。");
      const properties = variant
        ? `<m:rPr>${variant[0] === "roman" ? "" : `<m:scr m:val="${variant[0]}"/>`}<m:sty m:val="${variant[1]}"/></m:rPr>`
        : "";
      return [`<m:r>${properties}<m:t xml:space="preserve">${escapeXmlText(ast.text)}</m:t></m:r>`];
    }
    case "accent":
      return [
        `<m:acc><m:accPr><m:chr m:val="${escapeXmlText(ast.character)}"/></m:accPr><m:e>${serializeSequence(ast.base)}</m:e></m:acc>`,
      ];
    case "bar":
      return [
        `<m:bar><m:barPr><m:pos m:val="${ast.position}"/></m:barPr><m:e>${serializeSequence(ast.base)}</m:e></m:bar>`,
      ];
    case "brace":
      return [
        `<m:groupChr><m:groupChrPr><m:chr m:val="${ast.position === "top" ? "⏞" : "⏟"}"/><m:pos m:val="${ast.position}"/><m:vertJc m:val="${ast.position === "top" ? "bot" : "top"}"/></m:groupChrPr><m:e>${serializeSequence(ast.base)}</m:e></m:groupChr>`,
      ];
    case "fraction":
      return [
        `<m:f>${ast.noBar ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ""}<m:num>${serializeSequence(ast.numerator)}</m:num><m:den>${serializeSequence(ast.denominator)}</m:den></m:f>`,
      ];
    case "delimiter":
      return [
        `<m:d><m:dPr><m:begChr m:val="${escapeXmlText(ast.begin)}"/>${ast.separator === undefined ? "" : `<m:sepChr m:val="${escapeXmlText(ast.separator)}"/>`}<m:endChr m:val="${escapeXmlText(ast.end)}"/><m:grow m:val="1"/></m:dPr>${ast.bodies.map((body) => `<m:e>${serializeSequence(body)}</m:e>`).join("")}</m:d>`,
      ];
    case "root":
      return [
        `<m:rad><m:radPr>${ast.degree ? "" : '<m:degHide m:val="1"/>'}</m:radPr><m:deg>${
          ast.degree ? serializeSequence(ast.degree) : ""
        }</m:deg><m:e>${serializeSequence(ast.radicand)}</m:e></m:rad>`,
      ];
    case "sub": {
      const nary = naryCharacter(ast.base);
      if (nary) return [serializeNary(nary, ast.subscript, undefined)];
      if (isLimit(ast.base)) {
        return [
          `<m:limLow><m:e>${serializeSequence(ast.base)}</m:e><m:lim>${serializeSequence(ast.subscript)}</m:lim></m:limLow>`,
        ];
      }
      return [
        `<m:sSub><m:e>${serializeSequence(ast.base)}</m:e><m:sub>${serializeSequence(ast.subscript)}</m:sub></m:sSub>`,
      ];
    }
    case "sup": {
      const nary = naryCharacter(ast.base);
      if (nary) return [serializeNary(nary, undefined, ast.superscript)];
      return [
        `<m:sSup><m:e>${serializeSequence(ast.base)}</m:e><m:sup>${serializeSequence(ast.superscript)}</m:sup></m:sSup>`,
      ];
    }
    case "subsup": {
      const nary = naryCharacter(ast.base);
      if (nary) return [serializeNary(nary, ast.subscript, ast.superscript)];
      return [
        `<m:sSubSup><m:e>${serializeSequence(ast.base)}</m:e><m:sub>${serializeSequence(ast.subscript)}</m:sub><m:sup>${serializeSequence(ast.superscript)}</m:sup></m:sSubSup>`,
      ];
    }
    case "under": {
      const nary = naryCharacter(ast.base);
      if (nary) return [serializeNary(nary, ast.limit, undefined)];
      return [
        `<m:limLow><m:e>${serializeSequence(ast.base)}</m:e><m:lim>${serializeSequence(ast.limit)}</m:lim></m:limLow>`,
      ];
    }
    case "over": {
      const nary = naryCharacter(ast.base);
      if (nary) return [serializeNary(nary, undefined, ast.limit)];
      return [
        `<m:limUpp><m:e>${serializeSequence(ast.base)}</m:e><m:lim>${serializeSequence(ast.limit)}</m:lim></m:limUpp>`,
      ];
    }
    case "underover": {
      const nary = naryCharacter(ast.base);
      if (nary) return [serializeNary(nary, ast.lower, ast.upper)];
      return [
        `<m:limUpp><m:e><m:limLow><m:e>${serializeSequence(ast.base)}</m:e><m:lim>${serializeSequence(ast.lower)}</m:lim></m:limLow></m:e><m:lim>${serializeSequence(ast.upper)}</m:lim></m:limUpp>`,
      ];
    }
    case "matrix": {
      const columns = Math.max(0, ...ast.rows.map((row) => row.length));
      const properties = ast.columnAlign
        ? `<m:mPr><m:mcs>${Array.from({ length: columns }, (_, index) => {
            const alignment = ast.columnAlign?.[index] ?? ast.columnAlign?.at(-1) ?? "center";
            return `<m:mc><m:mcPr><m:count m:val="1"/><m:mcJc m:val="${alignment}"/></m:mcPr></m:mc>`;
          }).join("")}</m:mcs></m:mPr>`
        : "";
      return [
        `<m:m>${properties}${ast.rows
          .map(
            (row) =>
              `<m:mr>${row.map((cell) => `<m:e>${serializeSequence(cell)}</m:e>`).join("")}</m:mr>`,
          )
          .join("")}</m:m>`,
      ];
    }
  }
}

function importedOmmlMathComponent(xml: string): MathComponent {
  // Audited adapter: xml is emitted only by serializeMathAstToOmml from fixed element names and
  // escaped token text. docx 9.7.1 returns a document-level `<undefined>` wrapper, so unwrap its
  // single validated component before adapting it to docx's closed MathComponent union.
  const importedDocument = ImportedXmlComponent.fromXmlString(xml) as ImportedXmlComponent & {
    rootKey: unknown;
    root: unknown[];
  };
  const [component] = importedDocument.root;
  if (
    importedDocument.rootKey !== undefined ||
    importedDocument.root.length !== 1 ||
    !(component instanceof ImportedXmlComponent)
  ) {
    throw new Error("Office 公式 XML 结构无效。");
  }
  return component as unknown as MathComponent;
}

function nativeFormula(source: string, fontSizePt?: number, color?: string): OfficeMath {
  if (UNTRUSTED_TEX.test(source)) throw new Error("公式包含不可信的 TeX 命令。");
  const mathMl = katex.renderToString(source, {
    output: "mathml",
    throwOnError: true,
    strict: "error",
    trust: false,
    maxSize: 20,
    maxExpand: 1_000,
  });
  const ast = parseMathMlToAst(normalizeKatexMathMl(mathMl));
  const children = serializeMathAstToOmml(ast).map((xml) =>
    importedOmmlMathComponent(
      fontSizePt == null && !color
        ? xml
        : xml.replace(
            /(<m:r>(?:<m:rPr>.*?<\/m:rPr>)?)/gu,
            `$1<w:rPr>${fontSizePt == null ? "" : `<w:sz w:val="${Math.round(fontSizePt * 2)}"/><w:szCs w:val="${Math.round(fontSizePt * 2)}"/>`}${color ? `<w:color w:val="${color.slice(1)}"/>` : ""}</w:rPr>`,
          ),
    ),
  );
  if (children.length === 0) throw new Error("公式不能为空。");
  return new OfficeMath({ children });
}

export async function exportFormula(
  source: string,
  nodeId: string,
  formulaKind: FormulaKind = "math",
  fontSizePt?: number,
  color?: string,
): Promise<FormulaExport> {
  if (color !== undefined && !/^#[0-9A-F]{6}$/u.test(color)) throw new Error("公式颜色无效。");
  const raster = async () => {
    const image = color
      ? await renderFormulaFallback(source, undefined, color)
      : await renderFormulaFallback(source);
    // MathJax renders at 16 CSS pixels (12pt). Keep the high-resolution bitmap;
    // only adjust its display geometry for the requested document font size.
    const scale = (fontSizePt ?? 12) / 12;
    return { ...image, widthPx: image.widthPx * scale, heightPx: image.heightPx * scale };
  };
  if (formulaKind === "chemistry") {
    return {
      kind: "raster",
      image: await raster(),
      issues: [
        {
          severity: "warning",
          code: "CHEMISTRY_RENDERED_AS_IMAGE",
          nodeId,
          message: CHEMISTRY_RENDERED_AS_IMAGE_MESSAGE,
        },
      ],
    };
  }
  try {
    return { kind: "native", math: nativeFormula(source, fontSizePt, color), issues: [] };
  } catch {
    return {
      kind: "raster",
      image: await raster(),
      issues: [
        {
          severity: "warning",
          code: "FORMULA_RASTERIZED",
          nodeId,
          message: RASTERIZED_MESSAGE,
        },
      ],
    };
  }
}
