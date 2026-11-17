import type { JSONContent } from "@tiptap/core";
import type { AppResult } from "../ipc/result.js";
import { defaultDocumentFontSizePt } from "./font-policy.js";
import {
  type AssetDescriptor,
  type BlockNode,
  type CanonicalDocument,
  type InlineNode,
  type ParagraphAttributes,
  type ParagraphNode,
  type PatentBookDocument,
  type SemanticRole,
  SemanticRoleSchema,
  type TextMark,
} from "./model.js";
import { normalizeTableColumnWidths } from "./table-column-widths.js";
import {
  createImmutablePatentBookValidator,
  validateCanonicalDocument,
  validatePatentBookDocument,
} from "./validation.js";

const TABLE_PRINTABLE_WIDTH_MM = 165;

function fitTableWidthsToPage(widths: readonly number[]): number[] {
  if (widths.length === 0) return [];
  const sourceTotal = widths.reduce((sum, width) => sum + width, 0);
  const fitted = widths.map(
    (width) =>
      Math.round(
        (sourceTotal > 0 ? width / sourceTotal : 1 / widths.length) *
          TABLE_PRINTABLE_WIDTH_MM *
          1_000,
      ) / 1_000,
  );
  const difference = TABLE_PRINTABLE_WIDTH_MM - fitted.reduce((sum, width) => sum + width, 0);
  fitted[fitted.length - 1] = Math.round(((fitted.at(-1) ?? 0) + difference) * 1_000) / 1_000;
  return fitted;
}

function invalidAdapterResult<T>(message: string): AppResult<T> {
  return { ok: false, error: { code: "INVALID_INPUT", message } };
}

function canonicalMarksToTiptap(marks: TextMark[]): JSONContent["marks"] {
  const tiptapMarks: NonNullable<JSONContent["marks"]> = [];
  const textStyle: Record<string, string | number> = {};

  for (const mark of marks) {
    switch (mark.type) {
      case "font-family":
        textStyle.fontFamily = mark.value;
        break;
      case "font-size":
        textStyle.fontSizePt = mark.valuePt;
        break;
      case "color":
        textStyle.color = mark.value;
        break;
      case "background-color":
        textStyle.backgroundColor = mark.value;
        break;
      case "claim-reference-review":
        tiptapMarks.push({ type: "claimReferenceReview" });
        break;
      case "reference-mark-token":
        tiptapMarks.push({ type: "referenceMarkToken", attrs: { number: mark.number } });
        break;
      default:
        tiptapMarks.push({ type: mark.type });
    }
  }

  if (Object.keys(textStyle).length > 0) {
    return [{ type: "textStyle", attrs: textStyle }, ...tiptapMarks];
  }
  // 与 ProseMirror TextNode.toJSON() 行为一致：marks 为空时不输出 marks 字段，
  // 避免与 editor.getJSON() 的指纹永久不匹配导致每次挂载都触发内容替换。
  return tiptapMarks.length > 0 ? tiptapMarks : undefined;
}

function canonicalInlineToTiptap(
  node: InlineNode,
  assetAspectRatios: ReadonlyMap<string, number>,
): JSONContent {
  switch (node.type) {
    case "text": {
      const tiptapMarks = canonicalMarksToTiptap(node.marks);
      return tiptapMarks
        ? { type: "text", text: node.text, marks: tiptapMarks }
        : { type: "text", text: node.text };
    }
    case "hard-break":
      return { type: "hardBreak" };
    case "inline-formula":
      return {
        type: "inlineMath",
        attrs: {
          latex: node.source,
          formulaKind: node.formulaKind,
          ...(node.fontSizePt != null ? { fontSizePt: node.fontSizePt } : {}),
          ...(node.color ? { color: node.color } : {}),
        },
      };
    case "inline-figure":
      return {
        type: "inlineFigure",
        attrs: {
          nodeId: node.id,
          assetId: node.assetId,
          widthMm: node.widthMm,
          alignment: node.alignment,
          rotationDeg: node.rotationDeg ?? 0,
          sourceAspectRatio: assetAspectRatios.get(node.assetId) ?? 1,
        },
      };
  }
}

function paragraphAttrsToTiptap(
  id: string,
  semanticRole: SemanticRole | undefined,
  attrs: ParagraphAttributes,
  figureId?: string,
): Record<string, unknown> {
  return {
    nodeId: id,
    semanticRole: semanticRole ?? null,
    figureId: figureId ?? null,
    textAlign: attrs.alignment,
    lineHeight: attrs.lineSpacing,
    spaceBeforePt: attrs.spaceBeforePt ?? null,
    spaceAfterPt: attrs.spaceAfterPt ?? null,
    paragraphIndentMm: attrs.paragraphIndentMm,
    defaultFontFamily: attrs.defaultFontFamily,
    defaultFontSizePt: attrs.defaultFontSizePt,
  };
}

function paragraphToTiptap(
  paragraph: ParagraphNode,
  assetAspectRatios: ReadonlyMap<string, number>,
): JSONContent {
  return {
    type: "paragraph",
    attrs: paragraphAttrsToTiptap(
      paragraph.id,
      paragraph.semanticRole,
      paragraph.attrs,
      paragraph.figureId,
    ),
    content: paragraph.content.map((node) => canonicalInlineToTiptap(node, assetAspectRatios)),
  };
}

function canonicalBlockToTiptap(
  block: BlockNode,
  assetAspectRatios: ReadonlyMap<string, number>,
): JSONContent {
  switch (block.type) {
    case "paragraph":
      return paragraphToTiptap(block, assetAspectRatios);
    case "heading":
      return {
        type: "heading",
        attrs: {
          ...paragraphAttrsToTiptap(block.id, block.semanticRole, block.attrs),
          level: block.level,
        },
        content: block.content.map((node) => canonicalInlineToTiptap(node, assetAspectRatios)),
      };
    case "bullet-list":
    case "ordered-list":
      return {
        type: block.type === "bullet-list" ? "bulletList" : "orderedList",
        attrs: {
          nodeId: block.id,
          semanticRole: block.semanticRole ?? null,
          ...(block.type === "ordered-list" ? { start: block.start } : {}),
        },
        content: block.items.map((item) => ({
          type: "listItem",
          attrs: { nodeId: item.id },
          content: item.content.map((paragraph) => paragraphToTiptap(paragraph, assetAspectRatios)),
        })),
      };
    case "page-break":
      return {
        type: "pageBreak",
        attrs: { nodeId: block.id, semanticRole: block.semanticRole ?? null },
      };
    case "figure":
      return {
        type: "figure",
        attrs: {
          nodeId: block.id,
          assetId: block.assetId,
          widthMm: block.widthMm,
          alignment: block.alignment,
          rotationDeg: block.rotationDeg ?? 0,
          sourceAspectRatio: assetAspectRatios.get(block.assetId) ?? 1,
          semanticRole: block.semanticRole ?? null,
        },
      };
    case "table": {
      const table = normalizeTableColumnWidths(block);
      const occupiedUntilRow: number[] = [];
      return {
        type: "table",
        attrs: {
          nodeId: block.id,
          semanticRole: block.semanticRole ?? null,
          columnWidthsMm: table.columnWidthsMm,
          headerRowCount: block.headerRowCount ?? 0,
          layoutMode: block.layoutMode ?? "fit-page",
          tableAlignment: block.tableAlignment ?? "left",
          tableNameEnabled: block.tableNameEnabled ?? false,
          tableName: block.tableName ?? "",
          tableNoteEnabled: block.tableNoteEnabled ?? false,
          tableNote: block.tableNote ?? "",
        },
        content: table.rows.map((row, rowIndex) => {
          let columnIndex = 0;
          return {
            type: "tableRow",
            attrs: {
              nodeId: row.id,
              ...(row.rowHeightMm !== undefined && row.rowHeightRule !== undefined
                ? {
                    rowHeightMm: row.rowHeightMm,
                    rowHeightRule: row.rowHeightRule,
                  }
                : {}),
            },
            content: row.cells.map((cell) => {
              // Canonical rows omit positions occupied by earlier row spans.
              while ((occupiedUntilRow[columnIndex] ?? 0) > rowIndex) columnIndex++;
              const colwidth = table.columnWidthsMm
                .slice(columnIndex, columnIndex + cell.colSpan)
                .map((widthMm) => Math.round((widthMm * 96) / 25.4));
              for (let index = columnIndex; index < columnIndex + cell.colSpan; index++)
                occupiedUntilRow[index] = rowIndex + cell.rowSpan;
              columnIndex += cell.colSpan;
              return {
                type:
                  rowIndex === 0 && (block.headerRowCount ?? 0) === 1 ? "tableHeader" : "tableCell",
                attrs: {
                  nodeId: cell.id,
                  colspan: cell.colSpan,
                  rowspan: cell.rowSpan,
                  colwidth,
                  horizontalAlignment: cell.horizontalAlignment,
                  verticalAlignment: cell.verticalAlignment,
                  borderStyle: cell.borderStyle,
                  paddingTopMm: cell.paddingMm?.top ?? null,
                  paddingRightMm: cell.paddingMm?.right ?? null,
                  paddingBottomMm: cell.paddingMm?.bottom ?? null,
                  paddingLeftMm: cell.paddingMm?.left ?? null,
                  borderTop: cell.borderEdges?.top ?? cell.borderStyle,
                  borderRight: cell.borderEdges?.right ?? cell.borderStyle,
                  borderBottom: cell.borderEdges?.bottom ?? cell.borderStyle,
                  borderLeft: cell.borderEdges?.left ?? cell.borderStyle,
                },
                content: cell.content.map((paragraph) =>
                  paragraphToTiptap(paragraph, assetAspectRatios),
                ),
              };
            }),
          };
        }),
      };
    }
    case "block-formula":
      return {
        type: "blockMath",
        attrs: {
          nodeId: block.id,
          latex: block.source,
          formulaKind: block.formulaKind,
          ...(block.fontSizePt != null ? { fontSizePt: block.fontSizePt } : {}),
          ...(block.color ? { color: block.color } : {}),
          alignment: block.alignment ?? "center",
          semanticRole: block.semanticRole ?? null,
        },
      };
    case "chemical-structure":
      return {
        type: "chemicalStructure",
        attrs: {
          nodeId: block.id,
          ketSource: block.ketSource,
          editorMode: block.editorMode ?? "molecule",
          previewAssetId: block.previewAssetId,
          widthMm: block.widthMm,
          alignment: block.alignment,
        },
      };
  }
}

export function canonicalToTiptap(
  document: Pick<CanonicalDocument | PatentBookDocument, "content"> & {
    assets?: readonly AssetDescriptor[];
  },
): JSONContent {
  const assetAspectRatios = new Map(
    (document.assets ?? []).map((asset) => [asset.assetId, asset.widthPx / asset.heightPx]),
  );
  return {
    type: "doc",
    content: document.content.map((block) => canonicalBlockToTiptap(block, assetAspectRatios)),
  };
}

function objectAttributes(node: JSONContent): Record<string, unknown> {
  return node.attrs && typeof node.attrs === "object" ? node.attrs : {};
}

function requiredString(attributes: Record<string, unknown>, name: string): string {
  const value = attributes[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`缺少属性 ${name}`);
  return value;
}

function formulaKindAttribute(attributes: Record<string, unknown>): "math" | "chemistry" {
  const value = attributes.formulaKind;
  if (value === undefined || value === "math") return "math";
  if (value === "chemistry") return "chemistry";
  throw new Error("公式类型无效");
}

function editorModeAttribute(
  attributes: Record<string, unknown>,
): "molecule" | "macromolecule" | undefined {
  const value = attributes.editorMode;
  if (value === undefined || value === null) return undefined;
  if (value === "molecule" || value === "macromolecule") return value;
  throw new Error("结构式编辑器模式无效");
}

function optionalSemanticRole(attributes: Record<string, unknown>) {
  const value = attributes.semanticRole;
  if (value === null || value === undefined) return undefined;
  const parsed = SemanticRoleSchema.safeParse(value);
  if (!parsed.success) throw new Error("专利语义角色无效");
  return parsed.data;
}

function optionalFigureId(attributes: Record<string, unknown>) {
  const value = attributes.figureId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numericAttribute(
  attributes: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = attributes[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function imageRotationAttribute(attributes: Record<string, unknown>): 0 | 90 | 180 | 270 {
  const value = attributes.rotationDeg ?? 0;
  if (value === 0 || value === 90 || value === 180 || value === 270) return value;
  throw new Error("图片旋转角度无效");
}

/** 将 Tiptap Color 扩展产生的颜色值（浏览器规范化为 rgb() 格式）
 *  转换为文档模型要求的 #RRGGBB 格式。无法识别时返回 null（跳过该颜色）。 */
function tiptapColorToHex(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9A-Fa-f]{6}$/u.test(trimmed)) return trimmed.toUpperCase();
  const shorthand = /^#[0-9A-Fa-f]{3}$/u.exec(trimmed);
  if (shorthand) {
    return [...shorthand[0].slice(1)]
      .map((c) => c + c)
      .join("")
      .toUpperCase();
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/iu.exec(trimmed);
  if (rgb) {
    return (
      "#" +
      [rgb[1], rgb[2], rgb[3]]
        .map((c) =>
          Math.min(Number.parseInt(c ?? "0", 10), 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
    ).toUpperCase();
  }
  return null;
}

function tiptapMarksToCanonical(marks: JSONContent["marks"]): TextMark[] {
  const canonical: TextMark[] = [];
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case "textStyle": {
        const attributes = objectAttributes(mark);
        const allowed = new Set(["fontFamily", "fontSizePt", "color", "backgroundColor"]);
        if (Object.keys(attributes).some((name) => !allowed.has(name))) {
          throw new Error("文字样式包含不支持的属性");
        }
        if (typeof attributes.fontFamily === "string") {
          const fontFamily = attributes.fontFamily.trim();
          if (fontFamily) canonical.push({ type: "font-family", value: fontFamily });
        }
        if (typeof attributes.fontSizePt === "number") {
          canonical.push({ type: "font-size", valuePt: attributes.fontSizePt });
        }
        if (typeof attributes.color === "string") {
          const hex = tiptapColorToHex(attributes.color);
          if (hex) canonical.push({ type: "color", value: hex });
        }
        if (typeof attributes.backgroundColor === "string") {
          const hex = tiptapColorToHex(attributes.backgroundColor);
          if (hex) canonical.push({ type: "background-color", value: hex });
        }
        break;
      }
      case "bold":
      case "italic":
      case "underline":
      case "claimReferenceReview":
      case "subscript":
      case "superscript":
        canonical.push({
          type: mark.type === "claimReferenceReview" ? "claim-reference-review" : mark.type,
        });
        break;
      case "referenceMarkToken": {
        const attributes = objectAttributes(mark);
        if (!Number.isSafeInteger(attributes.number) || Number(attributes.number) <= 0) {
          throw new Error("附图标记语义编号无效");
        }
        canonical.push({ type: "reference-mark-token", number: Number(attributes.number) });
        break;
      }
      default:
        throw new Error(`不支持文字标记 ${mark.type}`);
    }
  }
  return canonical;
}

function formulaColorAttributes(node: JSONContent): { color?: string } {
  // Older editor states stored formula color as a textStyle mark.
  const color =
    objectAttributes(node).color ??
    node.marks?.find((mark) => mark.type === "textStyle")?.attrs?.color;
  const normalized = typeof color === "string" ? tiptapColorToHex(color) : null;
  return normalized && /^#[0-9A-F]{6}$/u.test(normalized) ? { color: normalized } : {};
}

function tiptapInlineToCanonical(node: JSONContent): InlineNode {
  switch (node.type) {
    case "text":
      if (typeof node.text !== "string") throw new Error("文字节点缺少内容");
      return { type: "text", text: node.text, marks: tiptapMarksToCanonical(node.marks) };
    case "hardBreak":
      return { type: "hard-break" };
    case "inlineMath":
      return {
        type: "inline-formula",
        source: requiredString(objectAttributes(node), "latex"),
        formulaKind: formulaKindAttribute(objectAttributes(node)),
        ...formulaColorAttributes(node),
        ...(objectAttributes(node).fontSizePt != null
          ? { fontSizePt: objectAttributes(node).fontSizePt as number }
          : {}),
      };
    case "inlineFigure": {
      const attributes = objectAttributes(node);
      const alignment = attributes.alignment;
      if (alignment !== "left" && alignment !== "center" && alignment !== "right") {
        throw new Error("图片对齐方式无效");
      }
      return {
        id: requiredString(attributes, "nodeId"),
        type: "inline-figure",
        assetId: requiredString(attributes, "assetId"),
        widthMm: numericAttribute(attributes, "widthMm", 80),
        alignment,
        rotationDeg: imageRotationAttribute(attributes),
      };
    }
    default:
      throw new Error(`不支持行内节点 ${node.type ?? "unknown"}`);
  }
}

function tiptapParagraphAttributes(attributes: Record<string, unknown>): ParagraphAttributes {
  const alignment = attributes.textAlign ?? "left";
  if (!(["left", "center", "right", "justify"] as const).includes(alignment as never)) {
    throw new Error("段落对齐方式无效");
  }
  return {
    alignment: alignment as ParagraphAttributes["alignment"],
    paragraphIndentMm: numericAttribute(attributes, "paragraphIndentMm", 0),
    lineSpacing: numericAttribute(attributes, "lineHeight", 1.5),
    ...(attributes.spaceBeforePt != null
      ? { spaceBeforePt: numericAttribute(attributes, "spaceBeforePt", 0) }
      : {}),
    ...(attributes.spaceAfterPt != null
      ? { spaceAfterPt: numericAttribute(attributes, "spaceAfterPt", 0) }
      : {}),
    defaultFontFamily:
      typeof attributes.defaultFontFamily === "string" ? attributes.defaultFontFamily : "SimSun",
    defaultFontSizePt: numericAttribute(
      attributes,
      "defaultFontSizePt",
      defaultDocumentFontSizePt(),
    ),
  };
}

function tiptapParagraphToCanonical(node: JSONContent): ParagraphNode {
  const attributes = objectAttributes(node);
  const semanticRole = optionalSemanticRole(attributes);
  return {
    id: requiredString(attributes, "nodeId"),
    type: "paragraph",
    ...(semanticRole ? { semanticRole } : {}),
    ...(optionalFigureId(attributes) ? { figureId: optionalFigureId(attributes) } : {}),
    attrs: tiptapParagraphAttributes(attributes),
    content: (node.content ?? []).map(tiptapInlineToCanonical),
  };
}

function tiptapBlockToCanonical(node: JSONContent): BlockNode {
  const attributes = objectAttributes(node);
  const semanticRole = optionalSemanticRole(attributes);
  const identity = {
    id: requiredString(attributes, "nodeId"),
    ...(semanticRole ? { semanticRole } : {}),
  };

  switch (node.type) {
    case "paragraph":
      return tiptapParagraphToCanonical(node);
    case "heading": {
      const level = attributes.level;
      if (level !== 1 && level !== 2 && level !== 3) throw new Error("标题级别无效");
      return {
        ...identity,
        type: "heading",
        level,
        attrs: tiptapParagraphAttributes(attributes),
        content: (node.content ?? []).map(tiptapInlineToCanonical),
      };
    }
    case "bulletList":
    case "orderedList": {
      const items = (node.content ?? []).map((item) => {
        if (item.type !== "listItem") throw new Error("列表包含无效项目");
        const itemAttributes = objectAttributes(item);
        return {
          id: requiredString(itemAttributes, "nodeId"),
          content: (item.content ?? []).map((paragraph) => {
            if (paragraph.type !== "paragraph") throw new Error("列表项目仅支持段落");
            return tiptapParagraphToCanonical(paragraph);
          }),
        };
      });
      return node.type === "orderedList"
        ? {
            ...identity,
            type: "ordered-list",
            start: numericAttribute(attributes, "start", 1),
            items,
          }
        : { ...identity, type: "bullet-list", items };
    }
    case "pageBreak":
      return { ...identity, type: "page-break" };
    case "figure": {
      const assetId = requiredString(attributes, "assetId");
      const alignment = attributes.alignment;
      if (alignment !== "left" && alignment !== "center" && alignment !== "right") {
        throw new Error("图片对齐方式无效");
      }
      if (
        semanticRole !== undefined &&
        semanticRole !== "description-drawing" &&
        semanticRole !== "abstract-drawing"
      ) {
        throw new Error("图片语义角色无效");
      }
      return {
        id: identity.id,
        ...(semanticRole ? { semanticRole } : {}),
        type: "figure",
        assetId,
        widthMm: numericAttribute(attributes, "widthMm", 80),
        alignment,
        rotationDeg: imageRotationAttribute(attributes),
      };
    }
    case "table": {
      const rows = (node.content ?? []).map((row) => {
        if (row.type !== "tableRow") throw new Error("表格包含无效行");
        const rowAttributes = objectAttributes(row);
        const rowHeightMm = rowAttributes.rowHeightMm;
        const rowHeightRule = rowAttributes.rowHeightRule;
        const normalizedRowHeightRule =
          rowHeightRule === "at-least" || rowHeightRule === "exact" ? rowHeightRule : undefined;
        const hasValidRowHeight =
          typeof rowHeightMm === "number" &&
          Number.isFinite(rowHeightMm) &&
          rowHeightMm >= 3 &&
          rowHeightMm <= 300 &&
          normalizedRowHeightRule !== undefined;
        return {
          id: requiredString(rowAttributes, "nodeId"),
          ...(hasValidRowHeight
            ? {
                rowHeightMm,
                rowHeightRule: normalizedRowHeightRule as "at-least" | "exact",
              }
            : {}),
          cells: (row.content ?? []).map((cell) => {
            if (cell.type !== "tableCell" && cell.type !== "tableHeader") {
              throw new Error("表格包含无效单元格");
            }
            const cellAttributes = objectAttributes(cell);
            const horizontalAlignment = cellAttributes.horizontalAlignment ?? "left";
            const verticalAlignment = cellAttributes.verticalAlignment ?? "top";
            const borderStyle = cellAttributes.borderStyle ?? "single";
            if (!(["left", "center", "right"] as const).includes(horizontalAlignment as never)) {
              throw new Error("单元格水平对齐无效");
            }
            if (!(["top", "middle", "bottom"] as const).includes(verticalAlignment as never)) {
              throw new Error("单元格垂直对齐无效");
            }
            if (!(["none", "single", "double"] as const).includes(borderStyle as never)) {
              throw new Error("单元格边框样式无效");
            }
            const borderEdge = (
              name: "borderTop" | "borderRight" | "borderBottom" | "borderLeft",
            ) => cellAttributes[name] ?? borderStyle;
            const borderEdges = {
              top: borderEdge("borderTop"),
              right: borderEdge("borderRight"),
              bottom: borderEdge("borderBottom"),
              left: borderEdge("borderLeft"),
            };
            if (
              !Object.values(borderEdges).every((value) =>
                (["none", "single", "double"] as const).includes(value as never),
              )
            ) {
              throw new Error("单元格边框无效");
            }
            const normalizedBorderEdges = borderEdges as {
              top: "none" | "single" | "double";
              right: "none" | "single" | "double";
              bottom: "none" | "single" | "double";
              left: "none" | "single" | "double";
            };
            const normalizedBorderStyle = borderStyle as "none" | "single" | "double";
            return {
              id: requiredString(cellAttributes, "nodeId"),
              rowSpan: numericAttribute(cellAttributes, "rowspan", 1),
              colSpan: numericAttribute(cellAttributes, "colspan", 1),
              horizontalAlignment: horizontalAlignment as "left" | "center" | "right",
              verticalAlignment: verticalAlignment as "top" | "middle" | "bottom",
              borderStyle: normalizedBorderStyle,
              ...(["paddingTopMm", "paddingRightMm", "paddingBottomMm", "paddingLeftMm"].some(
                (key) => cellAttributes[key] != null,
              )
                ? {
                    paddingMm: {
                      top: numericAttribute(cellAttributes, "paddingTopMm", 2),
                      right: numericAttribute(cellAttributes, "paddingRightMm", 2),
                      bottom: numericAttribute(cellAttributes, "paddingBottomMm", 2),
                      left: numericAttribute(cellAttributes, "paddingLeftMm", 2),
                    },
                  }
                : {}),
              ...(Object.values(normalizedBorderEdges).every(
                (value) => value === normalizedBorderStyle,
              )
                ? {}
                : { borderEdges: normalizedBorderEdges }),
              content: (cell.content ?? []).map((paragraph) => {
                if (paragraph.type !== "paragraph") {
                  throw new Error("单元格仅支持段落，不能嵌套表格");
                }
                // Preserve CSS inheritance only when the paragraph has no explicit alignment.
                // An explicit left/justify value must not be replaced by the cell default.
                const paragraphAttributes = objectAttributes(paragraph);
                const inheritedAlignment =
                  horizontalAlignment === "center" || horizontalAlignment === "right"
                    ? horizontalAlignment
                    : cell.type === "tableHeader"
                      ? "center"
                      : "left";
                return tiptapParagraphToCanonical({
                  ...paragraph,
                  attrs: {
                    ...paragraphAttributes,
                    textAlign: paragraphAttributes.textAlign ?? inheritedAlignment,
                  },
                });
              }),
            };
          }),
        };
      });
      const layoutMode = attributes.layoutMode === "fixed" ? "fixed" : "fit-page";
      const preciseColumnWidths = attributes.columnWidthsMm;
      const derivedColumnWidthsMm = (node.content?.[0]?.content ?? []).flatMap((cell) => {
        const attributes = objectAttributes(cell);
        const span = numericAttribute(attributes, "colspan", 1);
        const widths = Array.isArray(attributes.colwidth)
          ? attributes.colwidth.filter(
              (width): width is number => typeof width === "number" && width > 0,
            )
          : [];
        return Array.from({ length: span }, (_, index) => {
          const pixels = widths[index] ?? 113;
          return Math.round(((pixels * 25.4) / 96) * 1_000) / 1_000;
        });
      });
      const columnWidthsMm =
        Array.isArray(preciseColumnWidths) &&
        preciseColumnWidths.length === derivedColumnWidthsMm.length
          ? preciseColumnWidths.filter(
              (width): width is number => typeof width === "number" && Number.isFinite(width),
            )
          : layoutMode === "fit-page" && !Array.isArray(preciseColumnWidths)
            ? fitTableWidthsToPage(derivedColumnWidthsMm)
            : derivedColumnWidthsMm;
      const headerRowCount =
        (node.content?.[0]?.content ?? []).length > 0 &&
        (node.content?.[0]?.content ?? []).every((cell) => cell.type === "tableHeader")
          ? 1
          : 0;
      return {
        ...identity,
        type: "table",
        columnWidthsMm,
        rows,
        ...(headerRowCount === 1 ? { headerRowCount } : {}),
        ...(layoutMode === "fixed" ? { layoutMode } : {}),
        ...(attributes.tableAlignment === "center" || attributes.tableAlignment === "right"
          ? { tableAlignment: attributes.tableAlignment }
          : {}),
        ...(attributes.tableNameEnabled === true ? { tableNameEnabled: true } : {}),
        ...(typeof attributes.tableName === "string" && attributes.tableName
          ? { tableName: attributes.tableName }
          : {}),
        ...(attributes.tableNoteEnabled === true ? { tableNoteEnabled: true } : {}),
        ...(typeof attributes.tableNote === "string" && attributes.tableNote
          ? { tableNote: attributes.tableNote }
          : {}),
      };
    }
    case "blockMath": {
      const alignment = attributes.alignment ?? "center";
      if (alignment !== "left" && alignment !== "center" && alignment !== "right") {
        throw new Error("公式对齐方式无效");
      }
      return {
        ...identity,
        type: "block-formula",
        source: requiredString(attributes, "latex"),
        formulaKind: formulaKindAttribute(attributes),
        ...formulaColorAttributes(node),
        ...(attributes.fontSizePt != null ? { fontSizePt: attributes.fontSizePt as number } : {}),
        ...(alignment === "center" ? {} : { alignment }),
      };
    }
    case "chemicalStructure": {
      const alignment = attributes.alignment;
      if (alignment !== "left" && alignment !== "center" && alignment !== "right") {
        throw new Error("结构式对齐方式无效");
      }
      return {
        id: identity.id,
        type: "chemical-structure",
        ketSource: requiredString(attributes, "ketSource"),
        editorMode: editorModeAttribute(attributes),
        previewAssetId: requiredString(attributes, "previewAssetId"),
        widthMm: numericAttribute(attributes, "widthMm", 80),
        alignment,
      };
    }
    default:
      throw new Error(`不支持块节点 ${node.type ?? "unknown"}`);
  }
}

function parseBlocks(content: JSONContent): AppResult<BlockNode[]> {
  try {
    if (content.type !== "doc" || !Array.isArray(content.content)) {
      return invalidAdapterResult<BlockNode[]>("编辑器内容不是有效文档。");
    }
    return { ok: true, value: content.content.map(tiptapBlockToCanonical) };
  } catch (error) {
    return invalidAdapterResult<BlockNode[]>(
      error instanceof Error ? error.message : "编辑器内容无法转换。",
    );
  }
}

export function tiptapToCanonical(
  content: JSONContent,
  baseDocument: CanonicalDocument,
): AppResult<CanonicalDocument> {
  const blocks = parseBlocks(content);
  if (!blocks.ok) return blocks;
  return validateCanonicalDocument({
    ...baseDocument,
    modifiedAt: new Date().toISOString(),
    content: blocks.value,
  });
}

export function tiptapToPatentBookDocument(
  content: JSONContent,
  baseDocument: PatentBookDocument,
  availableAssetIds: ReadonlySet<string>,
  assets: readonly AssetDescriptor[] = [],
): AppResult<PatentBookDocument> {
  const blocks = parseBlocks(content);
  if (!blocks.ok) return blocks;
  return validatePatentBookDocument(
    {
      ...baseDocument,
      modifiedAt: new Date().toISOString(),
      content: blocks.value,
    },
    availableAssetIds,
    assets,
  );
}

export function tiptapToDocumentBlocks(content: JSONContent): AppResult<BlockNode[]> {
  return parseBlocks(content);
}

/** Editor-private immutable JSON snapshots only. Validation still covers the complete document. */
export function createIncrementalPatentBookAdapter(
  availableAssets: () => readonly AssetDescriptor[],
  availableIds: () => ReadonlySet<string>,
) {
  const blocks = new WeakMap<JSONContent, BlockNode>();
  const validate = createImmutablePatentBookValidator();
  let normalized = new WeakMap<JSONContent, JSONContent>();
  const documents = new WeakMap<PatentBookDocument, JSONContent>();
  let assetKey = "";
  return {
    toTiptap(document: PatentBookDocument): JSONContent {
      return (
        documents.get(document) ?? canonicalToTiptap({ ...document, assets: availableAssets() })
      );
    },
    fromTiptap(content: JSONContent, base: PatentBookDocument): AppResult<PatentBookDocument> {
      if (content.type !== "doc" || !Array.isArray(content.content))
        return invalidAdapterResult("编辑器内容不是有效文档。");
      const assets = availableAssets();
      const nextKey = JSON.stringify(assets);
      if (nextKey !== assetKey) {
        normalized = new WeakMap();
        assetKey = nextKey;
      }
      try {
        const parsed = content.content.map((node) => {
          let block = blocks.get(node);
          if (!block) {
            block = tiptapBlockToCanonical(node);
            blocks.set(node, block);
          }
          return block;
        });
        const result = validate(
          { ...base, modifiedAt: new Date().toISOString(), content: parsed },
          availableIds(),
          assets,
        );
        if (!result.ok) return result;
        const ratios = new Map(
          assets.map((asset) => [asset.assetId, asset.widthPx / asset.heightPx]),
        );
        documents.set(result.value, {
          type: "doc",
          content: result.value.content.map((block, index) => {
            const source = content.content![index]!;
            let node = normalized.get(source);
            if (!node) {
              node = canonicalBlockToTiptap(block, ratios);
              normalized.set(source, node);
            }
            return node;
          }),
        });
        return result;
      } catch (error) {
        return invalidAdapterResult(
          error instanceof Error ? error.message : "编辑器内容无法转换。",
        );
      }
    },
  };
}
