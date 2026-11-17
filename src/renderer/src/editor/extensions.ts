import { mergeAttributes, type Node as TiptapNode } from "@tiptap/core";
import CharacterCount from "@tiptap/extension-character-count";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import Placeholder from "@tiptap/extension-placeholder";
import Superscript from "@tiptap/extension-superscript";
import { TableKit } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { BackgroundColor, TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import UniqueID from "@tiptap/extension-unique-id";
import StarterKit from "@tiptap/starter-kit";
import { displayDocumentFont } from "../../../shared/document/font-policy";
import { effectiveParagraphFontSizePt } from "../../../shared/document/line-spacing";
import { ListBehavior } from "./extensions/list-behavior";
import "katex/contrib/mhchem";
import "katex/dist/katex.min.css";
import { FindReplaceHighlights } from "./extensions/find-replace-highlights";
import { InspectionSelection } from "./extensions/inspection-selection";
import {
  PATENT_BODY_TIPTAP_ATTRIBUTES,
  PatentParagraphRules,
} from "./extensions/patent-paragraph-rules";
import { PlatformSubscript } from "./extensions/platform-subscript";
import { ReferenceMarkIssueHighlights } from "./extensions/reference-mark-issue-highlights";
import { ReferenceMarkKeywordDecorations } from "./extensions/reference-mark-keyword-decorations";
import { ReferenceMarkReviewHighlights } from "./extensions/reference-mark-review-highlights";
import { ScriptInputMode } from "./extensions/script-input-mode";
import {
  ChemicalStructure,
  type ChemicalStructureEditRequest,
} from "./nodes/chemical-structure-node";
import { ClaimReferenceReview } from "./nodes/claim-reference-review";
import type { AssetPreviewLoader } from "./nodes/figure-node";
import { PatentFigure } from "./nodes/figure-node";
import { createMathematicsExtension, type FormulaEditRequest } from "./nodes/formula-node";
import { PatentInlineFigure } from "./nodes/inline-figure-node";
import { PageBreak } from "./nodes/page-break";
import { ReferenceMarkToken } from "./nodes/reference-mark-token";
import {
  PATENT_TABLE_CELL_MIN_WIDTH_PX,
  PatentTable,
  PatentTableCell,
  PatentTableHeader,
  PatentTableRow,
} from "./nodes/table-nodes";
import { PatentTextAttributes } from "./nodes/text-attributes";
import type { RichTextEditorCapabilities } from "./rich-text-editor-core";
import { TableColumnWidthSync } from "./table/table-column-width-sync";
import { TableExit } from "./table/table-exit";
import { TableInsertionControls } from "./table/table-insertion-controls";
import { TableRowResize } from "./table/table-row-resize";
import { TableSelectionControls } from "./table/table-selection-controls";
import { TableWidthPolicy } from "./table/table-width-policy";

const BLOCK_TYPES_WITH_IDS = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "pageBreak",
  "figure",
  "inlineFigure",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "blockMath",
  "chemicalStructure",
];

const FlatListStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) =>
      extension.type === "node" && extension.name === "paragraph"
        ? (extension as TiptapNode).extend({
            renderHTML({ node, HTMLAttributes }) {
              const sizes: number[] = [];
              node.forEach((child) => {
                if (child.isText)
                  sizes.push(
                    child.marks.find((mark) => mark.type.name === "textStyle")?.attrs.fontSizePt ??
                      node.attrs.defaultFontSizePt,
                  );
              });
              const size = effectiveParagraphFontSizePt(node.attrs.defaultFontSizePt, sizes);
              return this.parent!({
                node,
                HTMLAttributes: mergeAttributes(HTMLAttributes, { style: `font-size: ${size}pt` }),
              });
            },
          })
        : extension.type === "node" && extension.name === "listItem"
          ? extension.extend({ content: "paragraph+" })
          : extension,
    );
  },
});

const PlatformFontFamily = FontFamily.extend({
  addGlobalAttributes() {
    return (this.parent?.() ?? []).map((group) => ({
      ...group,
      attributes: {
        ...group.attributes,
        fontFamily: {
          ...group.attributes.fontFamily,
          parseHTML: (element) =>
            element.getAttribute("data-document-font-family") ??
            group.attributes.fontFamily?.parseHTML?.(element),
          renderHTML: (attributes) =>
            attributes.fontFamily
              ? {
                  "data-document-font-family": attributes.fontFamily,
                  style: `font-family: "${displayDocumentFont(attributes.fontFamily)}"`,
                }
              : {},
        },
      },
    }));
  },
});

export function createPatentExtensions(
  sessionId = "",
  options: {
    capabilities?: RichTextEditorCapabilities;
    onFormulaEdit?(request: FormulaEditRequest): void;
    onChemicalStructureEdit?(request: ChemicalStructureEditRequest): void;
    patentParagraphRules?: boolean;
    loadAssetPreview?: AssetPreviewLoader;
    readOnly?: boolean;
  } = {},
) {
  const capabilities: RichTextEditorCapabilities = options.capabilities ?? {
    headings: true,
    lists: true,
    tables: true,
    formulas: true,
    chemistry: true,
    images: true,
    pageBreaks: true,
  };
  return [
    ReferenceMarkToken,
    FlatListStarterKit.configure({
      blockquote: false,
      code: false,
      codeBlock: false,
      heading: capabilities.headings ? { levels: [1, 2, 3] } : false,
      bulletList: capabilities.lists ? {} : false,
      orderedList: capabilities.lists ? {} : false,
      horizontalRule: false,
      trailingNode: { notAfter: ["table"] },
      link: false,
      strike: false,
      underline: false,
    }),
    ...(capabilities.lists ? [ListBehavior] : []),
    Underline,
    ClaimReferenceReview,
    FindReplaceHighlights,
    InspectionSelection,
    ReferenceMarkKeywordDecorations,
    ReferenceMarkIssueHighlights,
    ReferenceMarkReviewHighlights,
    TextStyle,
    PlatformFontFamily,
    Color,
    BackgroundColor,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    PlatformSubscript,
    Superscript.extend({ excludes: "subscript" }),
    ScriptInputMode,
    CharacterCount,
    Placeholder.configure({ placeholder: "开始撰写专利文档" }),
    UniqueID.configure({ attributeName: "nodeId", types: BLOCK_TYPES_WITH_IDS }),
    PatentTextAttributes,
    ...(options.patentParagraphRules ? [PatentParagraphRules] : []),
    ...(capabilities.pageBreaks ? [PageBreak] : []),
    ...(capabilities.images
      ? [
          PatentFigure.configure({
            sessionId,
            ...(options.loadAssetPreview ? { loadAssetPreview: options.loadAssetPreview } : {}),
            readOnly: options.readOnly ?? false,
          }),
          PatentInlineFigure.configure({
            sessionId,
            ...(options.loadAssetPreview ? { loadAssetPreview: options.loadAssetPreview } : {}),
            readOnly: options.readOnly ?? false,
          }),
        ]
      : []),
    ...(capabilities.tables
      ? [
          TableKit.configure({
            table: false,
            tableRow: false,
            tableCell: false,
            tableHeader: false,
          }),
          PatentTable.configure({
            resizable: !options.readOnly,
            handleWidth: 5,
            cellMinWidth: PATENT_TABLE_CELL_MIN_WIDTH_PX,
            lastColumnResizable: true,
            allowTableNodeSelection: !options.readOnly,
          }),
          PatentTableRow,
          PatentTableCell,
          PatentTableHeader,
          ...(options.readOnly
            ? []
            : [
                TableExit.configure({
                  paragraphAttributes: options.patentParagraphRules
                    ? PATENT_BODY_TIPTAP_ATTRIBUTES
                    : {},
                }),
                TableColumnWidthSync,
                TableWidthPolicy,
                TableSelectionControls,
                TableInsertionControls,
                TableRowResize,
              ]),
        ]
      : []),
    ...(capabilities.formulas ? createMathematicsExtension(options.onFormulaEdit) : []),
    ...(capabilities.chemistry
      ? [
          ChemicalStructure.configure({
            sessionId,
            ...(options.loadAssetPreview ? { loadAssetPreview: options.loadAssetPreview } : {}),
            readOnly: options.readOnly ?? false,
            ...(options.onChemicalStructureEdit ? { onEdit: options.onChemicalStructureEdit } : {}),
          }),
        ]
      : []),
  ];
}
