import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultDocumentFont, documentFontOptions } from "../../../shared/document/font-policy";
import type { AssetDescriptor } from "../../../shared/document/model";
import {
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type PatentBookDocument,
} from "../../../shared/document/model";
import { PATENT_BOOK_LABELS, type PatentBookKind } from "../../../shared/patent/model";
import type { PatentBookTemplate } from "../../../shared/patent/templates";
import { PATENT_TEMPLATE_TOKENS } from "../../../shared/patent/templates";
import { createSettingsId } from "../../../shared/settings/model";
import { EditorCommandBus, type EditorFormatState } from "../app/command-bus";
import { createPatentExtensions } from "../editor/extensions";
import { canonicalToTiptap, tiptapToPatentBookDocument } from "../editor/model-adapter";
import { RichTextEditorCore } from "../editor/rich-text-editor-core";
import { ChemicalStructureRailPanel } from "../editor/ui/chemical-structure-rail-panel";
import { ColorPicker } from "../editor/ui/color-picker";
import {
  TemplateTokenChips,
  templateTokenNodesToText,
  templateTokensToNodes,
} from "./template-token-extension";

const CAPABILITIES = {
  headings: true,
  lists: true,
  tables: true,
  formulas: true,
  chemistry: true,
  chemicalStructures: true,
  images: false,
  pageBreaks: true,
} as const;

const DEFAULT_FORMAT: EditorFormatState = {
  bold: false,
  italic: false,
  underline: false,
  subscript: false,
  superscript: false,
  alignment: "left",
  bulletList: false,
  orderedList: false,
  paragraphStyle: "paragraph",
  fontFamily: "SimSun",
  fontSizePt: 14,
  color: "#000000",
};

type TemplateBookEditorProps = {
  sessionId: string;
  bookKind: Extract<PatentBookKind, "claims" | "description" | "abstract">;
  template: PatentBookTemplate;
  assetDescriptors?: readonly AssetDescriptor[];
  readOnly?: boolean;
  onAssetAdded?(descriptor: AssetDescriptor): void;
  onChange(template: PatentBookTemplate): void;
};

export function TemplateBookEditor({
  sessionId,
  bookKind,
  template,
  assetDescriptors = [],
  readOnly = false,
  onAssetAdded,
  onChange,
}: TemplateBookEditorProps) {
  const editorId = `${sessionId}:template:${bookKind}`;
  const commandBus = useMemo(() => new EditorCommandBus(), []);
  const [format, setFormat] = useState<EditorFormatState>(DEFAULT_FORMAT);
  const document = useMemo(() => templateDocument(template, bookKind), [template, bookKind]);
  const availableAssetIds = useRef(new Set<string>());
  const availableAssetDescriptors = useRef(new Map<string, AssetDescriptor>());
  for (const descriptor of assetDescriptors) {
    availableAssetIds.current.add(descriptor.assetId);
    availableAssetDescriptors.current.set(descriptor.assetId, descriptor);
  }
  for (const block of template.content) {
    if (block.type === "chemical-structure") availableAssetIds.current.add(block.previewAssetId);
  }
  const addImageAsset = useCallback(
    (current: PatentBookDocument, descriptor: AssetDescriptor) => {
      availableAssetIds.current.add(descriptor.assetId);
      availableAssetDescriptors.current.set(descriptor.assetId, descriptor);
      onAssetAdded?.(descriptor);
      return current;
    },
    [onAssetAdded],
  );

  useEffect(() => commandBus.subscribeFormatState(editorId, setFormat), [commandBus, editorId]);

  return (
    <div
      className={`template-catalog__book-editor${readOnly ? " template-catalog__book-editor--readonly" : ""}`}
    >
      {!readOnly ? (
        <div className="template-catalog__toolbar" role="toolbar" aria-label="模板格式工具栏">
          <fieldset className="template-catalog__tool-group" aria-label="文字格式">
            <button
              type="button"
              className={format.bold ? "is-active" : ""}
              aria-label="加粗"
              onClick={() => commandBus.execute(editorId, "bold")}
            >
              B
            </button>
            <button
              type="button"
              className={format.italic ? "is-active" : ""}
              aria-label="斜体"
              onClick={() => commandBus.execute(editorId, "italic")}
            >
              <i>I</i>
            </button>
            <button
              type="button"
              className={format.underline ? "is-active" : ""}
              aria-label="下划线"
              onClick={() => commandBus.execute(editorId, "underline")}
            >
              <u>U</u>
            </button>
            <select
              aria-label="字体"
              value={format.mixedFontFamily ? "" : (format.fontFamily ?? defaultDocumentFont())}
              onChange={(event) => commandBus.setFontFamily(editorId, event.currentTarget.value)}
            >
              {format.mixedFontFamily ? (
                <option value="" disabled hidden aria-label="混合字体" />
              ) : null}
              {!documentFontOptions().some(
                (font) => font.value === (format.fontFamily ?? defaultDocumentFont()),
              ) ? (
                <option value={format.fontFamily}>{format.fontFamily}（文档字体）</option>
              ) : null}
              {documentFontOptions().map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
              {defaultDocumentFont() === "SimSun" && format.fontFamily !== "SimHei" ? (
                <option value="SimHei">黑体</option>
              ) : null}
            </select>
            <select
              aria-label="字号"
              value={format.mixedFontSize ? "" : String(format.fontSizePt ?? 14)}
              onChange={(event) =>
                commandBus.setFontSizePt(editorId, Number(event.currentTarget.value))
              }
            >
              {format.mixedFontSize ? (
                <option value="" disabled hidden aria-label="混合字号" />
              ) : null}
              <option value="10.5">五号</option>
              <option value="12">小四</option>
              <option value="14">四号</option>
              <option value="16">三号</option>
            </select>
            <ColorPicker
              value={format.color ?? "#000000"}
              onSelect={(color, preserveSelection, focusEditor) =>
                commandBus.setColor(editorId, color, preserveSelection, focusEditor)
              }
            />
          </fieldset>
          <fieldset className="template-catalog__tool-group" aria-label="公式插入">
            <button type="button" onClick={() => commandBus.openFormulaEditor(editorId)}>
              数学公式
            </button>
            <button
              type="button"
              onClick={() => commandBus.openChemistryEditor(editorId, "structure")}
            >
              化学结构式
            </button>
          </fieldset>
          <fieldset
            className="template-catalog__tool-group template-catalog__tool-group--fields"
            aria-label="模板字段"
          >
            <span className="template-catalog__tool-group-label">模板字段</span>
            <button
              type="button"
              title="插入专利题目字段，使用模板时自动替换为当前专利题目"
              onClick={() =>
                commandBus
                  .getEditor(editorId)
                  ?.chain()
                  .focus()
                  .insertContent({
                    type: "templateToken",
                    attrs: { token: PATENT_TEMPLATE_TOKENS.patentName },
                  })
                  .run()
              }
            >
              专利题目
            </button>
            <button
              type="button"
              title="插入专利类型字段，使用模板时自动替换为发明或实用新型"
              onClick={() =>
                commandBus
                  .getEditor(editorId)
                  ?.chain()
                  .focus()
                  .insertContent({
                    type: "templateToken",
                    attrs: { token: PATENT_TEMPLATE_TOKENS.typeName },
                  })
                  .run()
              }
            >
              发明/实用新型
            </button>
          </fieldset>
        </div>
      ) : null}
      <div className="template-catalog__editor-viewport">
        {!readOnly ? (
          <ChemicalStructureRailPanel
            commandBus={commandBus}
            editorId={editorId}
            contentWidthMm={
              document.page.widthMm - document.page.marginLeftMm - document.page.marginRightMm
            }
          />
        ) : null}
        <div className="template-catalog__paper">
          <RichTextEditorCore<PatentBookDocument>
            key={editorId}
            editorId={editorId}
            extensionSessionId={sessionId}
            title={document.title}
            document={document}
            commandBus={commandBus}
            capabilities={CAPABILITIES}
            editable={!readOnly}
            {...(!readOnly ? { addImageAsset } : {})}
            extensionFactory={(extensionSessionId, options) => [
              ...createPatentExtensions(extensionSessionId, {
                ...options,
                patentParagraphRules: true,
              }),
              TemplateTokenChips,
            ]}
            toTiptap={(value) => templateTokensToNodes(canonicalToTiptap(value))}
            fromTiptap={(content, baseDocument) =>
              tiptapToPatentBookDocument(
                templateTokenNodesToText(content),
                baseDocument,
                availableAssetIds.current,
                [...availableAssetDescriptors.current.values()],
              )
            }
            onDocumentChange={(updated) => {
              if (readOnly) return;
              onChange({
                page: structuredClone(updated.page),
                content: structuredClone(updated.content),
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}

function templateDocument(
  template: PatentBookTemplate,
  bookKind: Extract<PatentBookKind, "claims" | "description" | "abstract">,
): PatentBookDocument {
  return {
    formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
    documentId: createSettingsId(),
    title: PATENT_BOOK_LABELS[bookKind],
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    page: structuredClone(template.page),
    content: structuredClone(template.content),
  };
}
