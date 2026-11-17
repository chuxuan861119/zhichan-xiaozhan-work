import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
} from "@xmldom/xmldom";
import { LIST_CONTINUATION_STYLE_ID } from "../../shared/document/docx-list-style.js";
import type { TableNode } from "../../shared/document/model.js";
import { ommlXmlToLatex } from "../../shared/document/omml-to-latex.js";
import type { DocxPackage } from "./docx-package-reader.js";

export type WordRunStyle = Readonly<{
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  backgroundColor?: string;
  verticalAlign?: "superscript" | "subscript";
}>;

export type WordInline =
  | Readonly<{ type: "text"; text: string; style: WordRunStyle }>
  | Readonly<{ type: "break" }>
  | Readonly<{ type: "page-break" }>
  | Readonly<{ type: "formula"; latex: string }>
  | Readonly<{
      type: "image";
      relationshipId: string;
      partName: string | null;
      widthEmu: number | null;
      heightEmu: number | null;
    }>
  | Readonly<{
      type: "unsupported";
      label: string;
      warningCode: WordImportWarningCode;
    }>;

export type WordParagraphBlock = Readonly<{
  type: "paragraph";
  headingLevel: 1 | 2 | 3 | null;
  alignment: "left" | "center" | "right" | "justify";
  firstLineIndentMm: number | null;
  lineSpacing: number | null;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  list: Readonly<{
    kind: "ordered" | "bullet";
    level: number;
    start: number;
    id?: string;
    ordinal?: number;
  }> | null;
  listContinuation?: boolean;
  inlines: readonly WordInline[];
}>;

export type WordTableCell = Readonly<{
  colSpan: number;
  verticalMerge: "restart" | "continue" | null;
  paragraphs: readonly WordParagraphBlock[];
  verticalAlignment?: "top" | "middle" | "bottom";
  paddingMm?: NonNullable<TableNode["rows"][number]["cells"][number]["paddingMm"]>;
  borderEdges?: NonNullable<TableNode["rows"][number]["cells"][number]["borderEdges"]>;
}>;

export type WordTableBlock = Readonly<{
  type: "table";
  columnWidthsTwips: readonly number[];
  layoutMode?: "fit-page" | "fixed";
  widthTwips?: number;
  rows: readonly Readonly<{
    cells: readonly WordTableCell[];
    header?: boolean;
    rowHeightMm?: number;
    rowHeightRule?: "exact" | "at-least";
  }>[];
}>;

export type WordBlock = WordParagraphBlock | WordTableBlock;

export type WordSection = Readonly<{
  startBlockIndex: number;
  endBlockIndex: number;
  headerText: string | null;
}>;

export type WordImportWarningCode =
  | "UNSUPPORTED_SMARTART"
  | "UNSUPPORTED_CHART"
  | "UNSUPPORTED_TEXT_BOX"
  | "UNSUPPORTED_OBJECT"
  | "SIMPLIFIED_NESTED_TABLE"
  | "SIMPLIFIED_PARAGRAPH_SPACING"
  | "UNSUPPORTED_FORMULA";

export type WordImportWarning = Readonly<{
  code: WordImportWarningCode;
  message: string;
}>;

export type ParsedWordDocument = Readonly<{
  blocks: readonly WordBlock[];
  warnings: readonly WordImportWarning[];
  sections?: readonly WordSection[];
}>;

type NumberingLevel = { kind: "ordered" | "bullet"; start: number; nextOrdinal: number };

type RunStyleDefinition = Readonly<{
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  hidden?: boolean;
  fontFamily?: string;
  fontSizePt?: number;
  color?: string | null;
  backgroundColor?: string | null;
  highlightColor?: string | null;
  verticalAlign?: "superscript" | "subscript" | null;
}>;

type ParagraphStyleDefinition = Readonly<{
  alignment?: "left" | "center" | "right" | "justify";
  firstLineIndentMm?: number;
  lineValue?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineRule?: string;
}>;

type StyleDefinition = Readonly<{
  basedOn: string | null;
  paragraph: ParagraphStyleDefinition;
  run: RunStyleDefinition;
}>;

type WordStyleCatalog = Readonly<{
  defaultParagraph: ParagraphStyleDefinition;
  defaultParagraphStyleId: string | null;
  defaultRun: RunStyleDefinition;
  styles: ReadonlyMap<string, StyleDefinition>;
}>;

type FieldEntry = {
  instruction: string;
  resultVisible: boolean;
  suppressResult: boolean;
};
type FieldState = { stack: FieldEntry[] };

const HIGHLIGHT_COLORS: Readonly<Record<string, string>> = {
  black: "#000000",
  blue: "#0000FF",
  cyan: "#00FFFF",
  green: "#00FF00",
  magenta: "#FF00FF",
  red: "#FF0000",
  yellow: "#FFFF00",
  white: "#FFFFFF",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#C0C0C0",
};

export async function parseWordprocessingDocument(pkg: DocxPackage): Promise<ParsedWordDocument> {
  const documentBytes = pkg.parts.get("word/document.xml");
  if (!documentBytes) throw new Error("DOCX main document part is missing.");
  const document = parseXml(documentBytes);
  const relationships = parseRelationships(pkg.parts.get("word/_rels/document.xml.rels"));
  const numbering = parseNumbering(pkg.parts.get("word/numbering.xml"));
  const styleBytes = pkg.parts.get("word/styles.xml");
  const headingStyles = parseHeadingStyles(styleBytes);
  const styles = parseWordStyles(styleBytes);
  const warnings: WordImportWarning[] = [];
  const body = descendants(xmlRoot(document)).find((element) => localName(element) === "body");
  if (!body) return { blocks: [], warnings: [] };
  const blocks: WordBlock[] = [];
  const sections: WordSection[] = [];
  let sectionStartBlockIndex = 0;
  let inheritedHeaderPart: string | null = null;
  const finishSection = (sectionProperties: XmlElement) => {
    inheritedHeaderPart =
      sectionHeaderPart(sectionProperties, relationships) ?? inheritedHeaderPart;
    if (sectionStartBlockIndex >= blocks.length) return;
    sections.push({
      startBlockIndex: sectionStartBlockIndex,
      endBlockIndex: blocks.length,
      headerText: headerText(pkg, inheritedHeaderPart),
    });
    sectionStartBlockIndex = blocks.length;
  };
  const appendBodyChild = (bodyChild: XmlElement): void => {
    const name = localName(bodyChild);
    if (name === "p") {
      blocks.push(
        parseParagraph(bodyChild, relationships, numbering, headingStyles, styles, warnings),
      );
      const sectionProperties = child(child(bodyChild, "pPr"), "sectPr");
      if (sectionProperties) finishSection(sectionProperties);
    } else if (name === "tbl") {
      blocks.push(parseTable(bodyChild, relationships, numbering, headingStyles, styles, warnings));
    } else if (name === "sectPr") {
      finishSection(bodyChild);
    } else if (
      name === "sdt" ||
      name === "sdtContent" ||
      name === "customXml" ||
      name === "ins" ||
      name === "moveTo"
    ) {
      for (const nestedChild of elementChildren(bodyChild)) appendBodyChild(nestedChild);
    }
  };
  for (const bodyChild of elementChildren(body)) {
    appendBodyChild(bodyChild);
  }
  return { blocks, warnings, ...(sections.length > 0 ? { sections } : {}) };
}

function parseParagraph(
  paragraph: XmlElement,
  relationships: ReadonlyMap<string, string>,
  numbering: ReadonlyMap<string, NumberingLevel>,
  headingStyles: ReadonlyMap<string, 1 | 2 | 3>,
  styles: WordStyleCatalog,
  warnings: WordImportWarning[],
): WordParagraphBlock {
  const properties = child(paragraph, "pPr");
  const styleId = attribute(child(properties, "pStyle"), "val");
  const inheritedStyle = resolveStyleDefinition(
    styleId ?? styles.defaultParagraphStyleId,
    styles.styles,
  );
  const paragraphStyle = {
    ...styles.defaultParagraph,
    ...inheritedStyle.paragraph,
    ...parseParagraphStyle(properties),
  };
  const paragraphRunStyle = { ...styles.defaultRun, ...inheritedStyle.run };
  const fixedSpacing = paragraphStyle.lineRule === "exact" || paragraphStyle.lineRule === "atLeast";
  if (
    fixedSpacing &&
    !warnings.some((warning) => warning.code === "SIMPLIFIED_PARAGRAPH_SPACING")
  ) {
    warnings.push({
      code: "SIMPLIFIED_PARAGRAPH_SPACING",
      message: "固定值或最小值行距暂不支持，已使用默认行距。",
    });
  }
  const headingLevel = headingLevelFor(styleId, headingStyles);
  const numProperties = child(properties, "numPr");
  const numId = attribute(child(numProperties, "numId"), "val");
  const level = numberAttribute(child(numProperties, "ilvl"), "val") ?? 0;
  const numberingLevel = numId ? (numbering.get(`${numId}:${level}`) ?? null) : null;
  const ordinal = numberingLevel?.nextOrdinal;
  if (numberingLevel) numberingLevel.nextOrdinal += 1;
  const inlines: WordInline[] = [];
  appendParagraphChildren(
    paragraph,
    inlines,
    relationships,
    styles,
    paragraphRunStyle,
    { stack: [] },
    warnings,
  );
  return {
    type: "paragraph",
    headingLevel,
    alignment: paragraphStyle.alignment ?? "left",
    firstLineIndentMm: paragraphStyle.firstLineIndentMm ?? null,
    ...(paragraphStyle.spaceBeforePt !== undefined
      ? { spaceBeforePt: paragraphStyle.spaceBeforePt }
      : {}),
    ...(paragraphStyle.spaceAfterPt !== undefined
      ? { spaceAfterPt: paragraphStyle.spaceAfterPt }
      : {}),
    lineSpacing:
      fixedSpacing || paragraphStyle.lineValue === undefined
        ? null
        : Math.max(1, Math.min(3, paragraphStyle.lineValue / 240)),
    list:
      numberingLevel && numId && ordinal !== undefined
        ? {
            kind: numberingLevel.kind,
            start: numberingLevel.start,
            level,
            id: numId,
            ordinal,
          }
        : null,
    ...(styleId === LIST_CONTINUATION_STYLE_ID ? { listContinuation: true } : {}),
    inlines,
  };
}

function appendParagraphChildren(
  parent: XmlElement,
  output: WordInline[],
  relationships: ReadonlyMap<string, string>,
  styles: WordStyleCatalog,
  paragraphRunStyle: RunStyleDefinition,
  fieldState: FieldState,
  warnings: WordImportWarning[],
): void {
  for (const element of elementChildren(parent)) {
    const name = localName(element);
    if (
      name === "pPr" ||
      name === "del" ||
      name === "commentRangeStart" ||
      name === "commentRangeEnd"
    ) {
      continue;
    }
    if (name === "r") {
      output.push(
        ...parseRun(element, relationships, styles, paragraphRunStyle, fieldState, warnings),
      );
    } else if (name === "oMath" || name === "oMathPara") {
      const latex = ommlXmlToLatex(new XMLSerializer().serializeToString(element));
      if (latex) output.push({ type: "formula", latex });
      else output.push(unsupportedInline("公式", "UNSUPPORTED_FORMULA", warnings));
    } else if (name === "fldSimple") {
      if (paginationField(attribute(element, "instr") ?? "")) continue;
      appendParagraphChildren(
        element,
        output,
        relationships,
        styles,
        paragraphRunStyle,
        fieldState,
        warnings,
      );
    } else if (name === "hyperlink" || name === "ins" || name === "smartTag" || name === "sdt") {
      appendParagraphChildren(
        element,
        output,
        relationships,
        styles,
        paragraphRunStyle,
        fieldState,
        warnings,
      );
    }
  }
}

function parseRun(
  run: XmlElement,
  relationships: ReadonlyMap<string, string>,
  styles: WordStyleCatalog,
  paragraphRunStyle: RunStyleDefinition,
  fieldState: FieldState,
  warnings: WordImportWarning[],
): WordInline[] {
  const properties = child(run, "rPr");
  const characterStyleId = attribute(child(properties, "rStyle"), "val");
  const characterStyle = resolveStyleDefinition(characterStyleId, styles.styles).run;
  const resolvedStyle = {
    ...paragraphRunStyle,
    ...characterStyle,
    ...parseRunStyleDefinition(properties),
  };
  const style = publicRunStyle(resolvedStyle);
  const output: WordInline[] = [];
  for (const element of elementChildren(run)) {
    const name = localName(element);
    if (name === "fldChar") {
      updateFieldState(attribute(element, "fldCharType"), fieldState);
    } else if (name === "instrText") {
      const currentField = fieldState.stack.at(-1);
      if (currentField) currentField.instruction += element.textContent ?? "";
    } else if (name === "t") {
      const text = element.textContent ?? "";
      if (text && !resolvedStyle.hidden && fieldResultIsVisible(fieldState)) {
        output.push({ type: "text", text, style });
      }
    } else if (name === "tab") {
      if (!resolvedStyle.hidden && fieldResultIsVisible(fieldState)) {
        output.push({ type: "text", text: "\t", style });
      }
    } else if (name === "br" || name === "cr") {
      if (!resolvedStyle.hidden && fieldResultIsVisible(fieldState)) {
        output.push(
          attribute(element, "type") === "page" ? { type: "page-break" } : { type: "break" },
        );
      }
    } else if (name === "drawing") {
      if (!resolvedStyle.hidden && fieldResultIsVisible(fieldState)) {
        output.push(...parseDrawing(element, relationships, warnings));
      }
    } else if (name === "pict") {
      if (descendants(element).some((candidate) => localName(candidate) === "txbxContent")) {
        output.push(unsupportedInline("文本框", "UNSUPPORTED_TEXT_BOX", warnings));
      } else {
        output.push(unsupportedInline("嵌入对象", "UNSUPPORTED_OBJECT", warnings));
      }
    } else if (name === "object") {
      output.push(unsupportedInline("嵌入对象", "UNSUPPORTED_OBJECT", warnings));
    }
  }
  return output;
}

function parseDrawing(
  drawing: XmlElement,
  relationships: ReadonlyMap<string, string>,
  warnings: WordImportWarning[],
): WordInline[] {
  const graphicData = descendants(drawing).find((element) => localName(element) === "graphicData");
  const uri = attribute(graphicData ?? null, "uri")?.toLowerCase() ?? "";
  if (uri.includes("diagram")) {
    return [unsupportedInline("SmartArt", "UNSUPPORTED_SMARTART", warnings)];
  }
  if (uri.includes("chart")) {
    return [unsupportedInline("图表", "UNSUPPORTED_CHART", warnings)];
  }
  const blip = descendants(drawing).find((element) => localName(element) === "blip");
  const relationshipId = attribute(blip ?? null, "embed");
  if (!relationshipId) return [unsupportedInline("绘图对象", "UNSUPPORTED_OBJECT", warnings)];
  const extent = descendants(drawing).find((element) => localName(element) === "extent");
  return [
    {
      type: "image",
      relationshipId,
      partName: relationships.get(relationshipId) ?? null,
      widthEmu: numberAttribute(extent ?? null, "cx"),
      heightEmu: numberAttribute(extent ?? null, "cy"),
    },
  ];
}

function unwrappedTableChildren(element: XmlElement): XmlElement[] {
  return elementChildren(element).flatMap((entry) => {
    const name = localName(entry);
    return name === "sdt" ||
      name === "sdtContent" ||
      name === "customXml" ||
      name === "ins" ||
      name === "moveTo"
      ? unwrappedTableChildren(entry)
      : [entry];
  });
}

function parseTable(
  table: XmlElement,
  relationships: ReadonlyMap<string, string>,
  numbering: ReadonlyMap<string, NumberingLevel>,
  headingStyles: ReadonlyMap<string, 1 | 2 | 3>,
  styles: WordStyleCatalog,
  warnings: WordImportWarning[],
): WordTableBlock {
  const grid = child(table, "tblGrid");
  const tableWidth = child(child(table, "tblPr"), "tblW");
  const widthTwips =
    attribute(tableWidth, "type") === "dxa" ? numberAttribute(tableWidth, "w") : null;
  const columnWidthsTwips = grid
    ? elementChildren(grid)
        .filter((element) => localName(element) === "gridCol")
        .map((element) => numberAttribute(element, "w") ?? 2400)
    : [];
  const rows = unwrappedTableChildren(table)
    .filter((element) => localName(element) === "tr")
    .map((row) => ({
      ...parseTableRowProperties(child(row, "trPr")),
      cells: unwrappedTableChildren(row)
        .filter((element) => localName(element) === "tc")
        .map((cellElement) => {
          const properties = child(cellElement, "tcPr");
          const merge = child(properties, "vMerge");
          const mergeValue = attribute(merge, "val");
          const verticalMerge: "restart" | "continue" | null = merge
            ? mergeValue === "restart"
              ? "restart"
              : "continue"
            : null;
          const paragraphs: WordParagraphBlock[] = [];
          const appendCellContent = (element: XmlElement): void => {
            const name = localName(element);
            if (name === "p") {
              paragraphs.push(
                parseParagraph(element, relationships, numbering, headingStyles, styles, warnings),
              );
            } else if (name === "tbl") {
              if (!warnings.some((warning) => warning.code === "SIMPLIFIED_NESTED_TABLE")) {
                warnings.push({
                  code: "SIMPLIFIED_NESTED_TABLE",
                  message: "嵌套表格已按阅读顺序转为单元格内段落，内容保留，内层表格布局未保留。",
                });
              }
              const nested = parseTable(
                element,
                relationships,
                numbering,
                headingStyles,
                styles,
                warnings,
              );
              for (const row of nested.rows)
                for (const cell of row.cells) paragraphs.push(...cell.paragraphs);
            } else if (
              name === "sdt" ||
              name === "sdtContent" ||
              name === "customXml" ||
              name === "ins" ||
              name === "moveTo"
            ) {
              for (const childElement of elementChildren(element)) appendCellContent(childElement);
            }
          };
          for (const element of elementChildren(cellElement)) appendCellContent(element);
          return {
            ...parseTableCellProperties(properties, child(child(table, "tblPr"), "tblCellMar")),
            colSpan: numberAttribute(child(properties, "gridSpan"), "val") ?? 1,
            verticalMerge,
            paragraphs: paragraphs.length > 0 ? paragraphs : [emptyParagraph()],
          };
        }),
    }));
  return {
    type: "table",
    columnWidthsTwips,
    rows,
    layoutMode: widthTwips && widthTwips > 0 ? "fixed" : "fit-page",
    ...(widthTwips && widthTwips > 0 ? { widthTwips } : {}),
  };
}

function parseTableRowProperties(properties: XmlElement | null) {
  const header = child(properties, "tblHeader");
  const height = child(properties, "trHeight");
  const value = numberAttribute(height, "val");
  const rowHeightMm = value === null ? 0 : (value * 25.4) / 1440;
  return {
    header: !!header && !["0", "false", "off"].includes(attribute(header, "val") ?? ""),
    // DOCX integer twips can round a supported boundary height slightly out of range.
    ...(rowHeightMm >= 2.99 && rowHeightMm <= 300.01
      ? {
          rowHeightMm: Math.min(300, Math.max(3, rowHeightMm)),
          rowHeightRule:
            attribute(height, "hRule") === "exact" ? ("exact" as const) : ("at-least" as const),
        }
      : {}),
  };
}

function parseTableCellProperties(
  properties: XmlElement | null,
  defaultMargins: XmlElement | null,
): Pick<WordTableCell, "verticalAlignment" | "borderEdges" | "paddingMm"> {
  const margins = child(properties, "tcMar");
  const padding = (side: string) => {
    const value =
      child(margins, side) ??
      child(margins, side === "left" ? "start" : side === "right" ? "end" : side) ??
      child(defaultMargins, side) ??
      child(defaultMargins, side === "left" ? "start" : side === "right" ? "end" : side);
    const twips = numberAttribute(value, "w");
    return twips !== null && attribute(value, "type") !== "pct"
      ? Math.min(20, Math.max(0, (twips * 25.4) / 1440))
      : 2;
  };
  const alignment = attribute(child(properties, "vAlign"), "val");
  const borders = child(properties, "tcBorders");
  const border = (edge: string): "none" | "single" | "double" => {
    const value = attribute(child(borders, edge), "val");
    return value === "none" || value === "nil" ? "none" : value === "double" ? "double" : "single";
  };
  return {
    verticalAlignment:
      alignment === "center" ? "middle" : alignment === "bottom" ? "bottom" : "top",
    ...(margins || defaultMargins
      ? {
          paddingMm: {
            top: padding("top"),
            right: padding("right"),
            bottom: padding("bottom"),
            left: padding("left"),
          },
        }
      : {}),
    ...(borders
      ? {
          borderEdges: {
            top: border("top"),
            bottom: border("bottom"),
            left: border("left"),
            right: border("right"),
          },
        }
      : {}),
  };
}

function emptyParagraph(): WordParagraphBlock {
  return {
    type: "paragraph",
    headingLevel: null,
    alignment: "left",
    firstLineIndentMm: null,
    lineSpacing: null,
    list: null,
    inlines: [],
  };
}

function parseRunStyleDefinition(properties: XmlElement | null): RunStyleDefinition {
  if (!properties) return {};
  const font = child(properties, "rFonts");
  const sizeHalfPoints = numberAttribute(child(properties, "sz"), "val");
  const colorValue = attribute(child(properties, "color"), "val");
  const highlight = attribute(child(properties, "highlight"), "val");
  const shading = child(properties, "shd");
  const fill = attribute(shading, "fill");
  const verticalAlign = attribute(child(properties, "vertAlign"), "val");
  const fontFamily = attribute(font, "eastAsia") ?? attribute(font, "ascii");
  const bold = onOffValue(child(properties, "b"));
  const italic = onOffValue(child(properties, "i"));
  const underline = onOffValue(child(properties, "u"));
  const hidden = onOffValue(child(properties, "vanish"));
  return {
    ...(bold === undefined ? {} : { bold }),
    ...(italic === undefined ? {} : { italic }),
    ...(underline === undefined ? {} : { underline }),
    ...(hidden === undefined ? {} : { hidden }),
    ...(fontFamily ? { fontFamily } : {}),
    ...(sizeHalfPoints ? { fontSizePt: sizeHalfPoints / 2 } : {}),
    ...(colorValue && /^[0-9a-f]{6}$/iu.test(colorValue)
      ? { color: `#${colorValue.toUpperCase()}` }
      : colorValue === "auto"
        ? { color: null }
        : {}),
    ...(highlight && HIGHLIGHT_COLORS[highlight]
      ? { highlightColor: HIGHLIGHT_COLORS[highlight] }
      : highlight === "none"
        ? { highlightColor: null }
        : {}),
    ...(attribute(shading, "val") === "nil" || fill === "auto"
      ? { backgroundColor: null }
      : fill && /^[0-9a-f]{6}$/iu.test(fill)
        ? { backgroundColor: `#${fill.toUpperCase()}` }
        : {}),
    ...(verticalAlign === "superscript" || verticalAlign === "subscript"
      ? { verticalAlign }
      : verticalAlign === "baseline"
        ? { verticalAlign: null }
        : {}),
  };
}

function publicRunStyle(style: RunStyleDefinition): WordRunStyle {
  const backgroundColor = style.highlightColor ?? style.backgroundColor;
  return {
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.underline ? { underline: true } : {}),
    ...(style.fontFamily ? { fontFamily: style.fontFamily } : {}),
    ...(style.fontSizePt ? { fontSizePt: style.fontSizePt } : {}),
    ...(style.color ? { color: style.color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(style.verticalAlign ? { verticalAlign: style.verticalAlign } : {}),
  };
}

function parseParagraphStyle(properties: XmlElement | null): ParagraphStyleDefinition {
  const before = numberAttribute(child(properties, "spacing"), "before");
  const after = numberAttribute(child(properties, "spacing"), "after");
  if (!properties) return {};
  const alignmentValue = attribute(child(properties, "jc"), "val");
  const firstLineTwips = numberAttribute(child(properties, "ind"), "firstLine");
  const lineTwips = numberAttribute(child(properties, "spacing"), "line");
  const lineRule = attribute(child(properties, "spacing"), "lineRule");
  return {
    ...(alignmentValue ? { alignment: paragraphAlignment(alignmentValue) } : {}),
    ...(firstLineTwips === null ? {} : { firstLineIndentMm: (firstLineTwips * 25.4) / 1440 }),
    ...(lineTwips === null ? {} : { lineValue: lineTwips }),
    ...(before === null ? {} : { spaceBeforePt: Math.min(200, Math.max(0, before / 20)) }),
    ...(after === null ? {} : { spaceAfterPt: Math.min(200, Math.max(0, after / 20)) }),
    ...(lineRule === null ? {} : { lineRule }),
  };
}

function parseWordStyles(bytes: Uint8Array | undefined): WordStyleCatalog {
  if (!bytes) {
    return {
      defaultParagraph: {},
      defaultParagraphStyleId: null,
      defaultRun: {},
      styles: new Map(),
    };
  }
  const document = parseXml(bytes);
  const root = xmlRoot(document);
  const defaults = descendants(root).find((element) => localName(element) === "docDefaults");
  const defaultRunProperties = child(child(defaults ?? null, "rPrDefault"), "rPr");
  const defaultParagraphProperties = child(child(defaults ?? null, "pPrDefault"), "pPr");
  const styles = new Map<string, StyleDefinition>();
  let defaultParagraphStyleId: string | null = null;
  for (const style of descendants(root).filter((element) => localName(element) === "style")) {
    const styleId = attribute(style, "styleId");
    if (!styleId) continue;
    const defaultValue = attribute(style, "default");
    if (
      attribute(style, "type") === "paragraph" &&
      defaultValue !== null &&
      onOffValueFromAttribute(defaultValue)
    ) {
      defaultParagraphStyleId = styleId;
    }
    styles.set(styleId, {
      basedOn: attribute(child(style, "basedOn"), "val"),
      paragraph: parseParagraphStyle(child(style, "pPr")),
      run: parseRunStyleDefinition(child(style, "rPr")),
    });
  }
  return {
    defaultParagraph: parseParagraphStyle(defaultParagraphProperties),
    defaultParagraphStyleId,
    defaultRun: parseRunStyleDefinition(defaultRunProperties),
    styles,
  };
}

function resolveStyleDefinition(
  styleId: string | null,
  styles: ReadonlyMap<string, StyleDefinition>,
  visited: ReadonlySet<string> = new Set(),
): Readonly<{ paragraph: ParagraphStyleDefinition; run: RunStyleDefinition }> {
  if (!styleId || visited.has(styleId)) return { paragraph: {}, run: {} };
  const style = styles.get(styleId);
  if (!style) return { paragraph: {}, run: {} };
  const nextVisited = new Set(visited);
  nextVisited.add(styleId);
  const base = resolveStyleDefinition(style.basedOn, styles, nextVisited);
  return {
    paragraph: { ...base.paragraph, ...style.paragraph },
    run: { ...base.run, ...style.run },
  };
}

function updateFieldState(type: string | null, state: FieldState): void {
  if (type === "begin") {
    state.stack.push({ instruction: "", resultVisible: false, suppressResult: false });
  } else if (type === "separate") {
    const currentField = state.stack.at(-1);
    if (!currentField) return;
    currentField.resultVisible = true;
    currentField.suppressResult = paginationField(currentField.instruction);
  } else if (type === "end") {
    state.stack.pop();
  }
}

function fieldResultIsVisible(state: FieldState): boolean {
  return (
    state.stack.length === 0 ||
    state.stack.every((field) => field.resultVisible && !field.suppressResult)
  );
}

function paginationField(instruction: string): boolean {
  return /^\s*(?:PAGE|NUMPAGES|SECTIONPAGES)\b/iu.test(instruction);
}

function parseNumbering(bytes: Uint8Array | undefined): Map<string, NumberingLevel> {
  if (!bytes) return new Map();
  const document = parseXml(bytes);
  const abstractLevels = new Map<string, NumberingLevel>();
  for (const abstract of descendants(xmlRoot(document)).filter(
    (element) => localName(element) === "abstractNum",
  )) {
    const abstractId = attribute(abstract, "abstractNumId");
    if (!abstractId) continue;
    for (const level of elementChildren(abstract).filter(
      (element) => localName(element) === "lvl",
    )) {
      const index = attribute(level, "ilvl") ?? "0";
      const format = attribute(child(level, "numFmt"), "val") ?? "decimal";
      const start = Math.max(
        1,
        Math.min(1_000_000, numberAttribute(child(level, "start"), "val") ?? 1),
      );
      abstractLevels.set(`${abstractId}:${index}`, {
        kind: format === "bullet" ? "bullet" : "ordered",
        start,
        nextOrdinal: start,
      });
    }
  }
  const result = new Map<string, NumberingLevel>();
  for (const num of descendants(xmlRoot(document)).filter(
    (element) => localName(element) === "num",
  )) {
    const numId = attribute(num, "numId");
    const abstractId = attribute(child(num, "abstractNumId"), "val");
    if (!numId || !abstractId) continue;
    for (let level = 0; level <= 8; level += 1) {
      const definition = abstractLevels.get(`${abstractId}:${level}`);
      const override = elementChildren(num).find(
        (entry) =>
          localName(entry) === "lvlOverride" && Number(attribute(entry, "ilvl") ?? 0) === level,
      );
      const overriddenLevel = child(override ?? null, "lvl");
      const format = attribute(child(overriddenLevel, "numFmt"), "val");
      const overriddenStart =
        numberAttribute(child(override ?? null, "startOverride"), "val") ??
        numberAttribute(child(overriddenLevel, "start"), "val");
      if (definition || overriddenLevel) {
        const start = Math.max(1, Math.min(1_000_000, overriddenStart ?? definition?.start ?? 1));
        result.set(`${numId}:${level}`, {
          kind: format
            ? format === "bullet"
              ? "bullet"
              : "ordered"
            : (definition?.kind ?? "ordered"),
          start,
          nextOrdinal: start,
        });
      }
    }
  }
  return result;
}

function parseHeadingStyles(bytes: Uint8Array | undefined): Map<string, 1 | 2 | 3> {
  if (!bytes) return new Map();
  const document = parseXml(bytes);
  const result = new Map<string, 1 | 2 | 3>();
  for (const style of descendants(xmlRoot(document)).filter(
    (element) => localName(element) === "style",
  )) {
    const styleId = attribute(style, "styleId");
    const outline = numberAttribute(child(child(style, "pPr"), "outlineLvl"), "val");
    const name = attribute(child(style, "name"), "val") ?? "";
    const inferred =
      outline !== null && outline < 3 ? ((outline + 1) as 1 | 2 | 3) : headingName(name);
    if (styleId && inferred) result.set(styleId, inferred);
  }
  return result;
}

function headingLevelFor(
  styleId: string | null,
  styles: ReadonlyMap<string, 1 | 2 | 3>,
): 1 | 2 | 3 | null {
  if (!styleId) return null;
  return styles.get(styleId) ?? headingName(styleId);
}

function headingName(value: string): 1 | 2 | 3 | null {
  const match = /(?:heading|标题)\s*([123])/iu.exec(value);
  const level = Number(match?.[1]);
  return level === 1 || level === 2 || level === 3 ? level : null;
}

function parseRelationships(bytes: Uint8Array | undefined): Map<string, string> {
  if (!bytes) return new Map();
  const document = parseXml(bytes);
  const result = new Map<string, string>();
  for (const relationship of descendants(xmlRoot(document)).filter(
    (element) => localName(element) === "Relationship",
  )) {
    if (attribute(relationship, "TargetMode")?.toLowerCase() === "external") continue;
    const id = attribute(relationship, "Id");
    const target = attribute(relationship, "Target");
    if (!id || !target) continue;
    result.set(id, posixWordTarget(target));
  }
  return result;
}

function sectionHeaderPart(
  sectionProperties: XmlElement,
  relationships: ReadonlyMap<string, string>,
): string | null {
  const references = elementChildren(sectionProperties).filter(
    (element) => localName(element) === "headerReference",
  );
  const reference =
    references.find((element) => attribute(element, "type") === "default") ?? references[0];
  const relationshipId = reference ? attribute(reference, "id") : null;
  return relationshipId ? (relationships.get(relationshipId) ?? null) : null;
}

function headerText(pkg: DocxPackage, partName: string | null): string | null {
  if (!partName) return null;
  const bytes = pkg.parts.get(partName);
  if (!bytes) return null;
  const document = parseXml(bytes);
  const text = descendants(xmlRoot(document))
    .filter((element) => localName(element) === "t")
    .map((element) => element.textContent ?? "")
    .join("")
    .trim();
  return text || null;
}

function posixWordTarget(target: string): string {
  const normalized = target.replace(/\\/gu, "/");
  if (normalized.startsWith("/")) return normalized.slice(1);
  return normalized.startsWith("word/") ? normalized : `word/${normalized}`;
}

function unsupportedInline(
  label: string,
  warningCode: WordImportWarningCode,
  warnings: WordImportWarning[],
): WordInline {
  if (!warnings.some((warning) => warning.code === warningCode)) {
    warnings.push({ code: warningCode, message: `${label}暂不支持，已插入可见占位提示。` });
  }
  return { type: "unsupported", label, warningCode };
}

function paragraphAlignment(value: string | null): "left" | "center" | "right" | "justify" {
  if (value === "center" || value === "right" || value === "both" || value === "distribute") {
    return value === "both" || value === "distribute" ? "justify" : value;
  }
  return "left";
}

function parseXml(bytes: Uint8Array): XmlDocument {
  return new DOMParser().parseFromString(Buffer.from(bytes).toString("utf8"), "text/xml");
}

function xmlRoot(document: XmlDocument): XmlElement {
  if (!document.documentElement) throw new Error("WordprocessingML XML has no root element.");
  return document.documentElement;
}

function localName(element: XmlElement): string {
  return element.localName || element.nodeName.split(":").at(-1) || element.nodeName;
}

function elementChildren(element: XmlElement | null): XmlElement[] {
  if (!element) return [];
  return Array.from(element.childNodes).filter((node): node is XmlElement => node.nodeType === 1);
}

function descendants(element: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  const pending = [...elementChildren(element)];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) continue;
    result.push(current);
    pending.unshift(...elementChildren(current));
  }
  return result;
}

function child(parent: XmlElement | null, name: string): XmlElement | null {
  return elementChildren(parent).find((element) => localName(element) === name) ?? null;
}

function attribute(element: XmlElement | null, name: string): string | null {
  if (!element) return null;
  return (
    element.getAttribute(name) ??
    element.getAttribute(`w:${name}`) ??
    element.getAttribute(`r:${name}`) ??
    null
  );
}

function numberAttribute(element: XmlElement | null, name: string): number | null {
  const value = attribute(element, name);
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function onOffValue(element: XmlElement | null): boolean | undefined {
  if (!element) return undefined;
  return onOffValueFromAttribute(attribute(element, "val"));
}

function onOffValueFromAttribute(value: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === null ||
    normalized === undefined ||
    !["0", "false", "off", "none"].includes(normalized)
  );
}
