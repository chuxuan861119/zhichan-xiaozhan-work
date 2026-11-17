import { Editor, type EditorOptions, type JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import {
  type Attrs,
  Fragment,
  DOMParser as ProseMirrorDomParser,
  type Node as ProseMirrorNode,
  type Schema,
  Slice,
} from "@tiptap/pm/model";
import { NodeSelection, type Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { handlePaste as handleTablePaste } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { EditorContent } from "@tiptap/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { initialChemicalStructureWidthMm } from "../../../shared/chemistry/structure-size";
import {
  type AssetDescriptor,
  AssetDescriptorSchema,
  ChemicalStructureNodeSchema,
} from "../../../shared/document/model";
import { randomUuid } from "../../../shared/id";
import { imageClipboardMarker } from "../../../shared/ipc/contract";
import type { AppResult } from "../../../shared/ipc/result";
import type { LibrarySaveState } from "../../../shared/library/model";
import { PATENT_FIRST_LINE_INDENT_MM } from "../../../shared/patent/formatting";
import type { ReferenceMarkIssueLocation } from "../../../shared/patent/reference-mark-issue-locator";
import { findShortcutMode, isSentenceSelectionClick } from "../../../shared/platform";
import { useApplicationClosing } from "../app/application-close-coordinator";
import type { EditorCommandBus } from "../app/command-bus";
import { MotionPresence } from "../app/motion-presence";
import { showAppAlert } from "../shared/app-dialog";
import { editorBelongsToSession, useEditorSessionVisible } from "../shared/editor-session-scope";
import { showApplicationError } from "../shared/error-dialog";
import { hasVisibleElement, isVisibleControl } from "../shared/focusable-elements";
import { StandardDialog } from "../shared/standard-dialog";
import { getEditorCaretColor } from "./caret-contrast";
import type {
  ChemicalEquationDraft,
  ChemicalStructureDraft,
  ChemicalStructureDrawing,
  ChemistryDialogRequest,
} from "./chemistry-dialog";
import { ChemistryDialog, STRUCTURES_UNAVAILABLE_MESSAGE } from "./chemistry-dialog";
import {
  type ContentFingerprint,
  createEditorContentFingerprint,
  documentEcho,
  rememberDocumentEcho,
} from "./content-fingerprint";
import { createEditorJsonCache } from "./editor-json-cache";
import { createPatentExtensions } from "./extensions";
import { isInsideStructuredContainer } from "./extensions/patent-paragraph-rules";
import { setReferenceMarkIssueHighlights } from "./extensions/reference-mark-issue-highlights";
import {
  type ReferenceMarkKeywordDecoration,
  setReferenceMarkKeywordDecorations,
} from "./extensions/reference-mark-keyword-decorations";
import { setReferenceMarkReviewHighlights } from "./extensions/reference-mark-review-highlights";
import type { FormulaDrawingRequest } from "./formula-drawing-request";
import { imageImportLimitError } from "./image/image-import-limits";
import type { ChemicalStructureEditRequest } from "./nodes/chemical-structure-node";
import type { FormulaEditRequest } from "./nodes/formula-node";
import {
  capturePasteFormatting,
  type PasteFormattingSession,
  switchPasteFormatting,
} from "./paste-paragraph-formatting";
import {
  type ClipboardDataImage,
  extractClipboardDataImages,
  FORMULA_TOKEN_PATTERN,
  PASTE_IMAGE_MARKER_PATTERN,
  type PasteFormula,
  type PasteParagraphMode,
  sanitizePastedHtmlWithFormulas,
  startsWithManualFirstLineIndent,
} from "./paste-sanitizer";
import { replaceDocumentContent } from "./replace-document-content";
import { countDocumentText, countSelectedText } from "./status-counts";
import { editorContentWidthMm } from "./table/table-layout-width";
import { normalizeTableTransaction, TABLE_WIDTH_MESSAGE } from "./table/table-width-policy";
import { EditorContextMenus } from "./ui/editor-context-menus";
import { FormulaDialog } from "./ui/formula-dialog";
import { PasteFormattingOptions } from "./ui/paste-formatting-options";
import { useEditorSelectionOverlay } from "./use-editor-selection-overlay";
import "./editor.css";

type RichTextEditorExtensionFactory = (
  sessionId: string,
  options: {
    capabilities: RichTextEditorCapabilities;
    onFormulaEdit?(request: FormulaEditRequest): void;
    onChemicalStructureEdit?(request: ChemicalStructureEditRequest): void;
  },
) => ReturnType<typeof createPatentExtensions>;

type RetainedEditorCallbacks = {
  editorProps: EditorOptions["editorProps"];
  onCreate: EditorOptions["onCreate"];
  onUpdate: EditorOptions["onUpdate"];
  onSelectionUpdate: EditorOptions["onSelectionUpdate"];
  onFocus(): void;
  onFormulaEdit(request: FormulaEditRequest): void;
  onChemicalStructureEdit(request: ChemicalStructureEditRequest): void;
};

type RetainedEditorRuntime = { current: RetainedEditorCallbacks };

const retainedEditorRuntimes = new WeakMap<Editor, RetainedEditorRuntime>();

export type RichTextEditorCapabilities = {
  headings: boolean;
  lists: boolean;
  tables: boolean;
  formulas: boolean;
  chemistry: boolean;
  chemicalStructures?: boolean;
  images: boolean;
  pageBreaks: boolean;
};

export type TextCounts = {
  chineseCharacters: number;
  totalCharacters: number;
  selectedCharacters: number;
};

export type RichTextEditorCoreProps<TDocument> = {
  editorId: string;
  extensionSessionId?: string;
  title: string;
  document: TDocument;
  commandBus: EditorCommandBus;
  capabilities: RichTextEditorCapabilities;
  extensionFactory?: RichTextEditorExtensionFactory;
  importImage?(image: ClipboardDataImage): Promise<AppResult<{ descriptor: AssetDescriptor }>>;
  importImages?(
    images: ClipboardDataImage[],
    operationId: string,
  ): Promise<AppResult<{ descriptor: AssetDescriptor }[]>>;
  addImageAsset?(document: TDocument, descriptor: AssetDescriptor): TDocument;
  getAssetDescriptors?(): readonly AssetDescriptor[];
  toTiptap(document: TDocument): JSONContent;
  fromTiptap(content: JSONContent, base: TDocument): AppResult<TDocument>;
  onDocumentChange(document: TDocument): void;
  onTextCounts?(counts: TextCounts): void;
  onFindModeChange?(mode: "find" | "replace" | null, selectedText?: string): void;
  onNumberSelection?(): void;
  onInsertDependentClaim?(): void;
  saveState?: LibrarySaveState;
  onRetrySave?(): void | Promise<void>;
  onInsertFormulaDrawing?(request: FormulaDrawingRequest): void | Promise<void>;
  editable?: boolean;
  activeSelectionVisible?: boolean;
  inactiveSelectionVisible?: boolean;
  referenceMarkReviewKeyword?: string | null;
  referenceMarkReviewActiveIndex?: number | null;
  referenceMarkIssueLocations?: readonly ReferenceMarkIssueLocation[];
  referenceMarkIssueActiveLocationId?: string | null;
  referenceMarkLocatorEnabled?: boolean;
  referenceMarkBookKind?: "claims" | "description" | "abstract";
  referenceMarks?: readonly ReferenceMarkKeywordDecoration[];
  activeReferenceMarkId?: string | null;
  recentReferenceMarkId?: string | null;
  onReferenceMarkActivate?(referenceMarkId: string | null): void;
};

const LOCAL_ECHO_LIMIT = 32;
export const CHEMICAL_STRUCTURE_CLIPBOARD_MIME =
  "application/x-patent-workbench-chemical-structure+json";
const MAX_CHEMICAL_CLIPBOARD_BYTES = 1024;
const CHEMICAL_CLIPBOARD_TTL_MS = 5 * 60 * 1000;
const MAX_CHEMICAL_CLIPBOARD_ENTRIES = 16;
const ChemicalStructureClipboardSchema = z
  .object({ version: z.literal(1), token: z.string().uuid() })
  .strict();

type ChemicalStructureClipboardEntry = {
  editorId: string;
  createdAt: number;
  structure: z.infer<typeof ChemicalStructureNodeSchema>;
};

type ChemicalStructureClipboardCache = {
  entries: Map<string, ChemicalStructureClipboardEntry>;
  timers: Map<string, ReturnType<typeof globalThis.setTimeout>>;
};

const IMAGE_SELECTION_CLIPBOARD_MIME = "application/x-patent-workbench-image-selection+json";
const IMAGE_SELECTION_CLIPBOARD_TTL_MS = 5 * 60 * 1000;
const MAX_IMAGE_SELECTION_CLIPBOARD_ENTRIES = 16;
const ImageSelectionClipboardSchema = z
  .object({ version: z.literal(1), token: z.string().uuid() })
  .strict();

type ImageSelectionClipboardEntry = {
  createdAt: number;
  sourceSessionId: string;
  htmlTemplate: string;
  text: string;
  images: ClipboardDataImage[];
  descriptors: AssetDescriptor[];
};

const imageSelectionClipboardEntries = new Map<string, ImageSelectionClipboardEntry>();

function removeChemicalStructureClipboardEntry(
  cache: ChemicalStructureClipboardCache,
  token: string,
): void {
  const timer = cache.timers.get(token);
  if (timer !== undefined) globalThis.clearTimeout(timer);
  cache.timers.delete(token);
  cache.entries.delete(token);
}

function clearChemicalStructureClipboardCache(cache: ChemicalStructureClipboardCache): void {
  for (const timer of cache.timers.values()) globalThis.clearTimeout(timer);
  cache.timers.clear();
  cache.entries.clear();
}

function rememberChemicalStructureClipboardEntry(
  cache: ChemicalStructureClipboardCache,
  token: string,
  entry: ChemicalStructureClipboardEntry,
): void {
  while (cache.entries.size >= MAX_CHEMICAL_CLIPBOARD_ENTRIES) {
    const oldestToken = cache.entries.keys().next().value;
    if (typeof oldestToken !== "string") break;
    removeChemicalStructureClipboardEntry(cache, oldestToken);
  }
  cache.entries.set(token, entry);
  cache.timers.set(
    token,
    globalThis.setTimeout(
      () => removeChemicalStructureClipboardEntry(cache, token),
      CHEMICAL_CLIPBOARD_TTL_MS,
    ),
  );
}

function selectedChemicalStructure(editor: Pick<Editor, "state">) {
  const structures: z.infer<typeof ChemicalStructureNodeSchema>[] = [];
  editor.state.doc.nodesBetween(editor.state.selection.from, editor.state.selection.to, (node) => {
    if (node.type.name !== "chemicalStructure") return;
    const parsed = ChemicalStructureNodeSchema.safeParse({
      id: node.attrs.nodeId,
      type: "chemical-structure",
      ketSource: node.attrs.ketSource,
      editorMode: node.attrs.editorMode ?? "molecule",
      previewAssetId: node.attrs.previewAssetId,
      widthMm: node.attrs.widthMm,
      alignment: node.attrs.alignment,
    });
    if (parsed.success) structures.push(parsed.data);
  });
  return structures.length === 1 ? structures[0] : null;
}

function writeChemicalStructureClipboard(
  event: ClipboardEvent,
  editor: EditorView,
  editorId: string,
  cache: ChemicalStructureClipboardCache,
): boolean {
  if (!(editor.state.selection instanceof NodeSelection)) return false;
  const structure = selectedChemicalStructure(editor);
  if (!structure || !event.clipboardData) return false;
  const now = Date.now();
  let token = randomUuid();
  while (cache.entries.has(token)) token = randomUuid();
  rememberChemicalStructureClipboardEntry(cache, token, { editorId, createdAt: now, structure });
  const { dom, text } = editor.serializeForClipboard(editor.state.selection.content());
  event.preventDefault();
  event.clipboardData.clearData();
  event.clipboardData.setData("text/html", dom.innerHTML);
  event.clipboardData.setData("text/plain", text);
  event.clipboardData.setData(
    CHEMICAL_STRUCTURE_CLIPBOARD_MIME,
    JSON.stringify({ version: 1, token }),
  );
  return true;
}

function writeImageClipboard(
  event: ClipboardEvent,
  view: EditorView,
  sessionId: string,
  assetDescriptors: readonly AssetDescriptor[],
  chemicalPayload?: string,
): "copied" | "blocked" | false {
  const slice = view.state.selection.content();
  const images: Array<{
    assetId: string;
    rotationDeg: 0 | 90 | 180 | 270;
    layout: "block" | "inline";
    widthMm: number;
    alignment: "left" | "center" | "right";
    label: string;
    chemicalStructure?: ClipboardDataImage["chemicalStructure"];
  }> = [];
  let ordinaryImageCount = 0;
  slice.content.descendants((node) => {
    if (node.type.name === "chemicalStructure") {
      images.push({
        assetId: String(node.attrs.previewAssetId),
        rotationDeg: 0,
        layout: "block",
        widthMm: Number(node.attrs.widthMm),
        alignment:
          node.attrs.alignment === "left" || node.attrs.alignment === "right"
            ? node.attrs.alignment
            : "center",
        label: "化学结构式",
        chemicalStructure: {
          ketSource: String(node.attrs.ketSource),
          editorMode: node.attrs.editorMode === "macromolecule" ? "macromolecule" : "molecule",
          widthMm: Number(node.attrs.widthMm),
          alignment:
            node.attrs.alignment === "left" || node.attrs.alignment === "right"
              ? node.attrs.alignment
              : "center",
        },
      });
      return;
    }
    if (node.type.name !== "figure" && node.type.name !== "inlineFigure") return;
    ordinaryImageCount += 1;
    const rotationDeg = node.attrs.rotationDeg;
    images.push({
      assetId: String(node.attrs.assetId),
      rotationDeg:
        rotationDeg === 90 || rotationDeg === 180 || rotationDeg === 270 ? rotationDeg : 0,
      layout: node.type.name === "inlineFigure" ? "inline" : "block",
      widthMm: Number(node.attrs.widthMm),
      alignment:
        node.attrs.alignment === "left" || node.attrs.alignment === "right"
          ? node.attrs.alignment
          : "center",
      label: `图片${ordinaryImageCount}`,
    });
  });
  const countLimitError = imageImportLimitError(images.map(() => ({ size: 0 })));
  if (countLimitError) {
    event.preventDefault();
    showApplicationError({ code: "IMAGE_IMPORT_LIMIT", message: countLimitError });
    return "blocked";
  }
  if (images.length === 0) return false;

  const descriptorsById = new Map(
    assetDescriptors.map((descriptor) => [descriptor.assetId, descriptor]),
  );
  const selectedDescriptors = images.flatMap((image) => {
    const descriptor = descriptorsById.get(image.assetId);
    return descriptor ? [descriptor] : [];
  });
  if (
    event.type === "cut" &&
    (!event.clipboardData || selectedDescriptors.length !== images.length)
  ) {
    event.preventDefault();
    showApplicationError({ code: "INVALID_INPUT", message: "图片资源尚未就绪，请稍后重试剪切。" });
    return "blocked";
  }

  const { dom, text: clipboardText } = view.serializeForClipboard(slice);
  const fallbackHtml = dom.innerHTML;
  const container = dom.cloneNode(true) as HTMLElement;
  const imageElements = container.querySelectorAll(
    "figure[data-patent-asset-id], span[data-patent-inline-asset-id], figure[data-chemical-structure-node-id]",
  );
  imageElements.forEach((element, index) => {
    element.replaceWith(window.document.createTextNode(imageClipboardMarker(index)));
  });
  const htmlTemplate = container.innerHTML;
  const text = slice.content.textBetween(0, slice.content.size, "\n\n", (node) =>
    node.isInline ? "" : "\n",
  );
  const clipboardData = event.clipboardData;
  if (clipboardData && selectedDescriptors.length === images.length) {
    const now = Date.now();
    for (const [token, entry] of imageSelectionClipboardEntries) {
      if (now - entry.createdAt > IMAGE_SELECTION_CLIPBOARD_TTL_MS) {
        imageSelectionClipboardEntries.delete(token);
      }
    }
    while (imageSelectionClipboardEntries.size >= MAX_IMAGE_SELECTION_CLIPBOARD_ENTRIES) {
      const oldestToken = imageSelectionClipboardEntries.keys().next().value as string | undefined;
      if (!oldestToken) break;
      imageSelectionClipboardEntries.delete(oldestToken);
    }
    const token = randomUuid();
    imageSelectionClipboardEntries.set(token, {
      createdAt: now,
      sourceSessionId: sessionId,
      htmlTemplate,
      text,
      images: images.map((image, index) => ({
        originalName:
          selectedDescriptors[index]?.originalName ?? `clipboard-image-${index + 1}.png`,
        mediaType: selectedDescriptors[index]?.mediaType ?? "image/png",
        bytes: new Uint8Array(),
        ...(image.chemicalStructure
          ? { chemicalStructure: image.chemicalStructure }
          : {
              patentImage: {
                layout: image.layout,
                widthMm: image.widthMm,
                alignment: image.alignment,
                rotationDeg: image.rotationDeg,
              },
            }),
      })),
      descriptors: selectedDescriptors,
    });
    event.preventDefault();
    clipboardData.clearData();
    clipboardData.setData("text/html", fallbackHtml);
    clipboardData.setData("text/plain", clipboardText);
    clipboardData.setData(IMAGE_SELECTION_CLIPBOARD_MIME, JSON.stringify({ version: 1, token }));
    if (chemicalPayload) clipboardData.setData(CHEMICAL_STRUCTURE_CLIPBOARD_MIME, chemicalPayload);
  }
  void window.patentApi.assets
    .copyImages({
      sessionId,
      images,
      htmlTemplate,
      text,
    })
    .then((result) => {
      if (!result.ok) showApplicationError(result.error);
    })
    .catch(() => showApplicationError({ code: "INTERNAL", message: "normalized" }));
  return clipboardData !== null && selectedDescriptors.length === images.length ? "copied" : false;
}

function documentAssetDescriptors(document: unknown): AssetDescriptor[] {
  if (typeof document !== "object" || document === null || !("assets" in document)) {
    return [];
  }
  const assets = (document as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return [];
  return assets.flatMap((asset) => {
    const parsed = AssetDescriptorSchema.safeParse(asset);
    return parsed.success ? [parsed.data] : [];
  });
}

function chemicalPreviewAssetIds(document: unknown): ReadonlySet<string> {
  return new Set(documentAssetDescriptors(document).map((asset) => asset.assetId));
}

function readChemicalStructureClipboard(
  event: ClipboardEvent,
  view: EditorView,
  editorId: string,
  cache: ChemicalStructureClipboardCache,
  previewAssetIds: ReadonlySet<string>,
): boolean {
  const source = event.clipboardData?.getData(CHEMICAL_STRUCTURE_CLIPBOARD_MIME) ?? "";
  if (!source || new TextEncoder().encode(source).byteLength > MAX_CHEMICAL_CLIPBOARD_BYTES) {
    return false;
  }
  try {
    const parsed = ChemicalStructureClipboardSchema.safeParse(JSON.parse(source));
    if (!parsed.success) return false;
    const entry = cache.entries.get(parsed.data.token);
    if (
      !entry ||
      entry.editorId !== editorId ||
      Date.now() - entry.createdAt > CHEMICAL_CLIPBOARD_TTL_MS
    ) {
      removeChemicalStructureClipboardEntry(cache, parsed.data.token);
      return false;
    }
    const structure = ChemicalStructureNodeSchema.safeParse(entry.structure);
    if (!structure.success || !previewAssetIds.has(structure.data.previewAssetId)) return false;
    const type = view.state.schema.nodes.chemicalStructure;
    if (!type) return false;
    event.preventDefault();
    if (isInsideStructuredContainer(view.state.selection.$from)) {
      showApplicationError({
        code: "INVALID_INPUT",
        message: "结构式不能插入表格或列表内部，请将光标移至普通正文段落。",
      });
      return true;
    }
    view.dispatch(
      view.state.tr.replaceSelectionWith(
        type.create({
          nodeId: randomUuid(),
          ketSource: structure.data.ketSource,
          editorMode: structure.data.editorMode ?? "molecule",
          previewAssetId: structure.data.previewAssetId,
          widthMm: structure.data.widthMm,
          alignment: structure.data.alignment,
        }),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

type ChemicalStructureReplacement = {
  editor: Editor;
  request: ChemicalStructureEditRequest;
  draft: ChemicalStructureDraft;
  addAsset(descriptor: AssetDescriptor): void;
  isCurrent?(): boolean;
};

type ChemistryEditorRequest =
  | { type: "new"; initialKind: "equation" | "structure"; generation: number }
  | { type: "formula"; request: FormulaEditRequest; generation: number }
  | { type: "structure"; request: ChemicalStructureEditRequest; generation: number };

function chemistryDialogRequest(request: ChemistryEditorRequest): ChemistryDialogRequest {
  if (request.type === "new") return { type: "new", initialKind: request.initialKind };
  if (request.type === "formula") {
    return {
      type: "edit",
      kind: "equation",
      mode: request.request.mode,
      source: request.request.latex,
    };
  }
  return {
    type: "edit",
    kind: "structure",
    ketSource: request.request.ketSource,
    targetKey: request.request.nodeId,
    ...(request.request.editorMode ? { editorMode: request.request.editorMode } : {}),
  };
}

function updateFormulaPosition(
  editor: Editor,
  position: number,
  mode: "inline" | "block",
  attributes: { latex: string; formulaKind?: string },
): boolean {
  const node = editor.state.doc.nodeAt(position);
  if (!node || !["inlineMath", "blockMath"].includes(node.type.name)) return false;
  const type = mode === "inline" ? "inlineMath" : "blockMath";
  if (node.type.name === type) {
    return mode === "inline"
      ? editor
          .chain()
          .focus()
          .updateInlineMath({ ...attributes, pos: position })
          .run()
      : editor
          .chain()
          .focus()
          .updateBlockMath({ ...attributes, pos: position })
          .run();
  }
  if (mode === "block" && isInsideStructuredContainer(editor.state.doc.resolve(position)))
    return false;
  const formula = { type, attrs: { ...node.attrs, ...attributes } };
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      closeHistory(tr);
      return true;
    })
    .insertContentAt(
      { from: position, to: position + node.nodeSize },
      mode === "inline" ? { type: "paragraph", content: [formula] } : formula,
    )
    .run();
}

function insertChemicalEquation(
  editor: Editor,
  draft: ChemicalEquationDraft,
  request?: FormulaEditRequest,
  insertionFormat?: { fontSizePt?: number; color?: string },
): boolean {
  const attributes = { latex: draft.source, formulaKind: "chemistry" };
  if (request?.position === undefined) {
    return editor
      .chain()
      .focus()
      .insertContent({
        type: draft.mode === "inline" ? "inlineMath" : "blockMath",
        attrs: { ...attributes, ...insertionFormat },
      })
      .run();
  }
  return updateFormulaPosition(editor, request.position, draft.mode, attributes);
}

function validChemicalStructureDraft(draft: ChemicalStructureDraft): boolean {
  if (!draft.ketSource.trim()) return false;
  if (!draft.previewAssetId || draft.previewAssetId !== draft.previewDescriptor.assetId) {
    return false;
  }
  if (draft.previewDescriptor.kind !== "chemical-preview") return false;
  if (
    draft.editorMode !== undefined &&
    draft.editorMode !== "molecule" &&
    draft.editorMode !== "macromolecule"
  ) {
    return false;
  }
  return true;
}

function chemicalStructurePosition(
  editor: Editor,
  request: ChemicalStructureEditRequest,
): number | null {
  let position: number | null = null;
  editor.state.doc.descendants((node, currentPosition) => {
    if (
      position === null &&
      node.type.name === "chemicalStructure" &&
      node.attrs.nodeId === request.nodeId
    ) {
      position = currentPosition;
      return false;
    }
    return true;
  });
  return position;
}

export async function replaceChemicalStructureWithDraft({
  editor,
  request,
  draft,
  addAsset,
  isCurrent = () => true,
}: ChemicalStructureReplacement): Promise<AppResult<void>> {
  if (editor.isDestroyed || !editor.isEditable) {
    return {
      ok: false,
      error: { code: "REVISION_CONFLICT", message: "原文档已关闭或不可编辑，结构式未修改。" },
    };
  }
  if (!validChemicalStructureDraft(draft)) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "结构式内容无效。" } };
  }
  const position = chemicalStructurePosition(editor, request);
  const structureType = editor.state.schema.nodes.chemicalStructure;
  if (position === null || !structureType) {
    return { ok: false, error: { code: "NOT_FOUND", message: "要编辑的结构式已不存在。" } };
  }
  const existing = editor.state.doc.nodeAt(position);
  if (existing?.type.name !== "chemicalStructure") {
    return { ok: false, error: { code: "NOT_FOUND", message: "要编辑的结构式已不存在。" } };
  }
  if (
    existing.attrs.ketSource !== request.ketSource ||
    (existing.attrs.editorMode ?? "molecule") !== (request.editorMode ?? "molecule")
  ) {
    return {
      ok: false,
      error: { code: "REVISION_CONFLICT", message: "原结构式已发生变化，请重新打开后编辑。" },
    };
  }
  const next = {
    id: request.nodeId,
    type: "chemical-structure" as const,
    ketSource: draft.ketSource,
    editorMode: (draft.editorMode ?? "molecule") as "molecule" | "macromolecule",
    previewAssetId: draft.previewAssetId,
    widthMm: Number(existing.attrs.widthMm),
    alignment: existing.attrs.alignment,
  };
  if (!ChemicalStructureNodeSchema.safeParse(next).success) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "结构式内容无效。" } };
  }
  if (!isCurrent()) return { ok: false, error: { code: "CANCELLED", message: "操作已取消。" } };

  addAsset(draft.previewDescriptor);
  editor.view.dispatch(
    editor.state.tr.replaceWith(
      position,
      position + existing.nodeSize,
      structureType.create({
        nodeId: next.id,
        ketSource: next.ketSource,
        editorMode: next.editorMode,
        previewAssetId: next.previewAssetId,
        widthMm: next.widthMm,
        alignment: next.alignment,
      }),
    ),
  );
  return { ok: true, value: undefined };
}

async function insertChemicalStructureDraft({
  editor,
  draft,
  addAsset,
  isCurrent,
}: Omit<ChemicalStructureReplacement, "request">): Promise<AppResult<void>> {
  if (editor.isDestroyed || !editor.isEditable) {
    return {
      ok: false,
      error: { code: "REVISION_CONFLICT", message: "原文档已关闭或不可编辑，结构式未插入。" },
    };
  }
  if (isInsideStructuredContainer(editor.state.selection.$from)) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "结构式不能插入表格或列表内部，请将光标移至普通正文段落。",
      },
    };
  }
  if (!validChemicalStructureDraft(draft)) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "结构式内容无效。" } };
  }
  if (!isCurrent?.()) {
    return { ok: false, error: { code: "CANCELLED", message: "操作已取消。" } };
  }
  const next = {
    id: randomUuid(),
    type: "chemical-structure" as const,
    ketSource: draft.ketSource,
    editorMode: (draft.editorMode ?? "molecule") as "molecule" | "macromolecule",
    previewAssetId: draft.previewAssetId,
    widthMm: initialChemicalStructureWidthMm(draft.previewDescriptor),
    alignment: "center" as const,
  };
  if (!ChemicalStructureNodeSchema.safeParse(next).success) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "结构式内容无效。" } };
  }
  const content = {
    type: "chemicalStructure",
    attrs: {
      nodeId: next.id,
      ketSource: next.ketSource,
      editorMode: next.editorMode,
      previewAssetId: next.previewAssetId,
      widthMm: next.widthMm,
      alignment: next.alignment,
    },
  };
  if (!editor.can().insertContent(content)) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "当前位置无法插入结构式。" } };
  }
  addAsset(draft.previewDescriptor);
  editor.chain().focus().insertContent(content).run();
  return { ok: true, value: undefined };
}

function replaceContentPreservingSelection(editor: Editor, content: JSONContent): void {
  const previous = editor.state.selection;
  const nextDocument = editor.schema.nodeFromJSON(content);
  const transaction = replaceDocumentContent(editor.state.tr, nextDocument);
  if (!transaction.docChanged) return;
  closeHistory(transaction);
  transaction.setMeta("preventUpdate", true);
  transaction.setMeta("addToHistory", false);
  const maximum = transaction.doc.content.size;
  const from = Math.min(previous.from, maximum);
  const to = Math.min(Math.max(previous.to, from), maximum);
  transaction.setSelection(TextSelection.create(transaction.doc, from, to));
  editor.view.dispatch(transaction);
}

/** 把文本中匹配的公式 token 拆分为 inlineMath 节点（含前后普通文本）。 */
function splitTokenText(
  text: string,
  marks: ProseMirrorNode["marks"],
  formulas: readonly PasteFormula[],
  schema: Schema,
  consumed: Set<number>,
): ProseMirrorNode[] {
  const parts: ProseMirrorNode[] = [];
  let lastIndex = 0;
  FORMULA_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (true) {
    match = FORMULA_TOKEN_PATTERN.exec(text);
    if (match === null) break;
    const index = Number(match[1]);
    const formula = formulas[index];
    if (match.index > lastIndex) {
      parts.push(schema.text(text.slice(lastIndex, match.index), marks));
    }
    if (formula) {
      consumed.add(index);
      const nodeType = schema.nodes.inlineMath;
      if (nodeType) {
        const inheritedColor = marks.find((mark) => mark.type.name === "textStyle")?.attrs.color;
        parts.push(
          nodeType.create({
            latex: formula.latex,
            formulaKind: formula.kind,
            ...(formula.fontSizePt != null ? { fontSizePt: formula.fontSizePt } : {}),
            ...(formula.color || inheritedColor ? { color: formula.color ?? inheritedColor } : {}),
          }),
        );
      }
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(schema.text(text.slice(lastIndex), marks));
  }
  return parts;
}

/**
 * 递归把粘贴内容中的公式占位 token 替换为公式节点：
 * - 单独成段的 block 公式 token → blockMath；
 * - 与文本混排（含标记的文本流）的 token → inlineMath（保持文档结构合法）。
 * 返回替换后的节点数组，并把已消费的公式下标写入 consumed。
 */
function replaceFormulaTokens(
  fragment: Fragment,
  formulas: readonly PasteFormula[],
  schema: Schema,
  consumed: Set<number>,
  inlineOnly = false,
): ProseMirrorNode[] {
  const output: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      const text = node.text ?? "";
      if (!text.includes("\uE000PWF")) {
        output.push(node);
        return;
      }
      output.push(...splitTokenText(text, node.marks, formulas, schema, consumed));
      return;
    }
    if (node.isBlock) {
      if (
        !inlineOnly &&
        node.type.name === "paragraph" &&
        node.childCount === 1 &&
        node.firstChild?.isText
      ) {
        const tokenText = node.firstChild.text ?? "";
        FORMULA_TOKEN_PATTERN.lastIndex = 0;
        const match = FORMULA_TOKEN_PATTERN.exec(tokenText);
        if (match && match[0] === tokenText) {
          const formula = formulas[Number(match[1])];
          if (formula?.block && schema.nodes.blockMath) {
            consumed.add(Number(match[1]));
            output.push(
              schema.nodes.blockMath.create({
                latex: formula.latex,
                formulaKind: formula.kind,
                ...(formula.fontSizePt != null ? { fontSizePt: formula.fontSizePt } : {}),
                ...(formula.color ? { color: formula.color } : {}),
                ...(formula.alignment ? { alignment: formula.alignment } : {}),
              }),
            );
            return;
          }
        }
      }
      const children = replaceFormulaTokens(
        node.content,
        formulas,
        schema,
        consumed,
        inlineOnly || ["tableCell", "tableHeader", "listItem"].includes(node.type.name),
      );
      output.push(node.type.create(node.attrs, children, node.marks));
      return;
    }
    output.push(node);
  });
  return output;
}

function replacePasteImageTokens(
  fragment: Fragment,
  images: readonly ClipboardDataImage[],
  descriptors: readonly AssetDescriptor[],
  schema: Schema,
  inlineOnly = false,
): ProseMirrorNode[] {
  const output: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.isText && node.text?.includes("\uE010PIMG") && schema.nodes.paragraph) {
      output.push(
        ...replacePasteImageTokens(
          Fragment.from(schema.nodes.paragraph.create(null, node)),
          images,
          descriptors,
          schema,
          inlineOnly,
        ),
      );
      return;
    }
    if (node.isTextblock) {
      if (!node.textContent.includes("\uE010PIMG")) {
        output.push(node);
        return;
      }
      let inlineNodes: ProseMirrorNode[] = [];
      const flushParagraph = () => {
        if (inlineNodes.length === 0) return;
        output.push(node.type.create(node.attrs, inlineNodes, node.marks));
        inlineNodes = [];
      };
      node.content.forEach((child) => {
        if (!child.isText || !child.text?.includes("\uE010PIMG")) {
          inlineNodes.push(child);
          return;
        }
        const pattern = new RegExp(PASTE_IMAGE_MARKER_PATTERN.source, "g");
        let lastIndex = 0;
        let match = pattern.exec(child.text);
        while (match !== null) {
          if (match.index > lastIndex) {
            inlineNodes.push(schema.text(child.text.slice(lastIndex, match.index), child.marks));
          }
          const index = Number(match[1]);
          const descriptor = descriptors[index];
          const metadata = images[index]?.patentImage;
          if (descriptor) {
            const chemicalStructure = images[index]?.chemicalStructure;
            if (chemicalStructure && schema.nodes.chemicalStructure) {
              flushParagraph();
              output.push(
                schema.nodes.chemicalStructure.create({
                  nodeId: randomUuid(),
                  ketSource: chemicalStructure.ketSource,
                  editorMode: chemicalStructure.editorMode,
                  previewAssetId: descriptor.assetId,
                  widthMm: chemicalStructure.widthMm,
                  alignment: chemicalStructure.alignment,
                }),
              );
              lastIndex = match.index + match[0].length;
              match = pattern.exec(child.text);
              continue;
            }
            const attributes = {
              nodeId: randomUuid(),
              assetId: descriptor.assetId,
              widthMm: metadata?.widthMm ?? 80,
              alignment: metadata?.alignment ?? "center",
              rotationDeg: metadata?.rotationDeg ?? 0,
              sourceAspectRatio: descriptor.widthPx / descriptor.heightPx,
            };
            if (
              (inlineOnly || node.type.name !== "paragraph" || metadata?.layout === "inline") &&
              schema.nodes.inlineFigure
            ) {
              inlineNodes.push(schema.nodes.inlineFigure.create(attributes));
            } else if (schema.nodes.figure) {
              flushParagraph();
              output.push(schema.nodes.figure.create({ ...attributes, semanticRole: null }));
            }
          }
          lastIndex = match.index + match[0].length;
          match = pattern.exec(child.text);
        }
        if (lastIndex < child.text.length) {
          inlineNodes.push(schema.text(child.text.slice(lastIndex), child.marks));
        }
      });
      flushParagraph();
      return;
    }
    if (node.childCount > 0) {
      output.push(
        node.type.create(
          node.attrs,
          replacePasteImageTokens(
            node.content,
            images,
            descriptors,
            schema,
            inlineOnly || ["tableCell", "tableHeader", "listItem"].includes(node.type.name),
          ),
          node.marks,
        ),
      );
      return;
    }
    output.push(node);
  });
  return output;
}

/**
 * 纯文本 → 段落 fragment（\r\n 归一化为 \n，每个 \n 一个新段落）。
 * `defaultAttributes` 只加在开头没有手工缩进空白的段落上，避免与既有缩进叠加。
 */
function plainTextToFragment(
  text: string,
  schema: Schema,
  defaultAttributes?: Attrs | null,
): Fragment {
  const paragraphType = schema.nodes.paragraph;
  if (!paragraphType) return Fragment.empty;
  const normalized = text.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const paragraphs = lines.map((line) => {
    const content = line.replaceAll("\t", "    ");
    const attributes = startsWithManualFirstLineIndent(content) ? null : defaultAttributes;
    return paragraphType.create(attributes ?? null, content.length > 0 ? schema.text(content) : []);
  });
  return Fragment.from(paragraphs);
}

/** Returns whether a parsed paste slice contains text or a meaningful atomic node. */
function hasInsertableSliceContent(nodes: readonly ProseMirrorNode[]): boolean {
  for (const node of nodes) {
    if (node.type.spec.tableRole) return true;
    if (node.isText && (node.text?.length ?? 0) > 0) return true;
    if (node.isAtom || node.isLeaf) return true;
    if (
      node.childCount > 0 &&
      hasInsertableSliceContent(
        Array.from({ length: node.childCount }, (_value, index) => node.child(index)),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Preserve pasted block formatting without moving the caret into the following paragraph. */
type PasteFormattingRequest = {
  alternate: Slice;
  mode: PasteParagraphMode;
  simplifications: string[];
  onInserted(session: PasteFormattingSession): void;
};

function clampPasteSliceOpenness(slice: Slice, selection: Selection): Slice {
  // Replacing a paragraph marker with a block atom removes a nesting level.
  // Keeping the parsed HTML's open depth would discard that atom during fitting.
  const maximum = Slice.maxOpen(slice.content);
  // Outside a list, keep its boundary closed so fitting cannot consume its first
  // item into ordinary text and leave the remaining items with a shifted ordinal.
  const rootParagraphSelection = selection.$from.depth === 1 && selection.$to.depth === 1;
  const isRootList = (node: ProseMirrorNode | null) =>
    rootParagraphSelection &&
    (node?.type.name === "orderedList" || node?.type.name === "bulletList");
  // Whole tables are block boundaries: opening through their cells would move
  // the destination paragraph's trailing text into the last pasted cell.
  return new Slice(
    slice.content,
    slice.content.firstChild?.type.spec.tableRole === "table" ||
      isRootList(slice.content.firstChild)
      ? 0
      : Math.min(slice.openStart, maximum.openStart),
    slice.content.lastChild?.type.spec.tableRole === "table" || isRootList(slice.content.lastChild)
      ? 0
      : Math.min(slice.openEnd, maximum.openEnd),
  );
}

function replaceSelectionWithPasteSlice(
  view: EditorView,
  slice: Slice,
  selection = view.state.selection,
  formatting?: PasteFormattingRequest,
): void {
  slice = clampPasteSliceOpenness(slice, selection);
  if (formatting)
    formatting = {
      ...formatting,
      alternate: clampPasteSliceOpenness(formatting.alternate, selection),
    };
  // Sanitization intercepts the DOM paste event before ProseMirror's table handler.
  // Give that handler the sanitized slice, so cells replace/grow the target grid
  // instead of attempting to nest a table in a paragraph-only cell.
  const insideTable = Array.from({ length: selection.$from.depth }, (_, index) => index + 1).some(
    (depth) => selection.$from.node(depth).type.spec.tableRole === "table",
  );
  if (insideTable) {
    const pasteState = view.state.apply(view.state.tr.setSelection(selection));
    let inserted = false;
    const pasteView = new Proxy(view, {
      get(target, property) {
        if (property === "state") return pasteState;
        if (property === "dispatch")
          return (transaction: Transaction) => {
            if (
              !normalizeTableTransaction(transaction, editorContentWidthMm({ view }) ?? 165, {
                paste: true,
              })
            ) {
              showAppAlert(TABLE_WIDTH_MESSAGE);
              return;
            }
            view.dispatch(closeHistory(transaction.setMeta("uiEvent", "paste")));
            inserted = true;
          };
        return Reflect.get(target, property, target);
      },
    });
    if (handleTablePaste(pasteView, new Event("paste") as ClipboardEvent, slice)) {
      if (!inserted) return;
      view.dispatch(closeHistory(view.state.tr));
      formatting?.onInserted({
        document: view.state.doc,
        mode: formatting.mode,
        targets: [],
        simplifications: formatting.simplifications,
      });
      return;
    }
  }
  const pastingBlocksIntoEmptyTextblock =
    selection.empty &&
    selection.$from.parent.isTextblock &&
    selection.$from.parent.content.size === 0 &&
    slice.content.firstChild?.isBlock === true &&
    slice.content.lastChild?.isBlock === true;
  const transaction = view.state.tr
    .setSelection(selection)
    .replaceSelection(pastingBlocksIntoEmptyTextblock ? new Slice(slice.content, 0, 0) : slice);
  const alternateTransaction = formatting
    ? view.state.tr
        .setSelection(selection)
        .replaceSelection(
          pastingBlocksIntoEmptyTextblock
            ? new Slice(formatting.alternate.content, 0, 0)
            : formatting.alternate,
        )
    : null;
  const bodyWidth = editorContentWidthMm({ view }) ?? 165;
  if (
    !normalizeTableTransaction(transaction, bodyWidth, { paste: true }) ||
    (alternateTransaction &&
      !normalizeTableTransaction(alternateTransaction, bodyWidth, { paste: true }))
  ) {
    showAppAlert(TABLE_WIDTH_MESSAGE);
    return;
  }
  const alternate = alternateTransaction?.doc ?? null;
  if (pastingBlocksIntoEmptyTextblock && slice.content.lastChild?.isTextblock) {
    // Closed slices use a forward selection bias. Resolve the insertion boundary
    // backwards instead, so typing continues inside the last pasted text block.
    let insertionEnd: number | undefined;
    transaction.mapping.maps.at(-1)?.forEach((_from, _to, _newFrom, newTo) => {
      insertionEnd ??= newTo;
    });
    if (insertionEnd !== undefined) {
      transaction.setSelection(TextSelection.near(transaction.doc.resolve(insertionEnd), -1));
    }
  }
  view.dispatch(closeHistory(transaction.setMeta("uiEvent", "paste")));
  // Typing immediately after paste belongs to the next undo unit as well.
  view.dispatch(closeHistory(view.state.tr));
  if (formatting && alternate) {
    formatting.onInserted(
      capturePasteFormatting(
        transaction,
        alternate,
        view.state.doc,
        formatting.mode,
        formatting.simplifications,
      ),
    );
  }
}

/**
 * Replaces the current selection with normalized plain clipboard text.
 * 正文段落补上专利标准首行缩进；粘贴到列表项 / 表格单元格时不加缩进。
 */
function replaceSelectionWithPlainText(
  view: EditorView,
  plain: string,
  onInserted?: (session: PasteFormattingSession) => void,
): void {
  const defaultAttributes = isInsideStructuredContainer(view.state.selection.$from)
    ? null
    : { paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM };
  replaceSelectionWithPasteSlice(
    view,
    Slice.maxOpen(plainTextToFragment(plain, view.state.schema, defaultAttributes)),
    view.state.selection,
    onInserted
      ? {
          alternate: Slice.maxOpen(
            plainTextToFragment(plain, view.state.schema, { paragraphIndentMm: 0 }),
          ),
          mode: "body",
          simplifications: [],
          onInserted,
        }
      : undefined,
  );
}

export function RichTextEditorCore<TDocument>({
  editorId,
  extensionSessionId,
  title,
  document,
  commandBus,
  capabilities,
  extensionFactory = createPatentExtensions,
  importImage,
  importImages,
  addImageAsset,
  getAssetDescriptors,
  toTiptap,
  fromTiptap,
  onDocumentChange,
  onTextCounts,
  onFindModeChange,
  onNumberSelection,
  onInsertDependentClaim,
  saveState,
  onRetrySave,
  onInsertFormulaDrawing,
  editable = true,
  activeSelectionVisible = false,
  inactiveSelectionVisible = false,
  referenceMarkReviewKeyword = null,
  referenceMarkReviewActiveIndex = null,
  referenceMarkIssueLocations = [],
  referenceMarkIssueActiveLocationId = null,
  referenceMarkLocatorEnabled = false,
  referenceMarkBookKind = "claims",
  referenceMarks = [],
  activeReferenceMarkId = null,
  recentReferenceMarkId = null,
  onReferenceMarkActivate = () => undefined,
}: RichTextEditorCoreProps<TDocument>) {
  const applicationClosing = useApplicationClosing();
  const writesAllowed = useRef(true);
  const importEpoch = useRef(0);
  if (writesAllowed.current !== (editable && !applicationClosing)) importEpoch.current += 1;
  writesAllowed.current = editable && !applicationClosing;
  const readEditorJson = useMemo(() => createEditorJsonCache(), []);
  const fingerprintContent = useMemo(() => createEditorContentFingerprint(), []);
  const baseDocument = useRef(document);
  const [pasteFormatting, setPasteFormatting] = useState<PasteFormattingSession | null>(null);
  const [pendingPaste, setPendingPaste] = useState<{ issues: string[]; apply(): void } | null>(
    null,
  );
  const [initialContent] = useState(() => toTiptap(document));
  const lastValidContent = useRef(initialContent);
  const onDocumentChangeRef = useRef(onDocumentChange);
  const onTextCountsRef = useRef(onTextCounts);
  const emittedFingerprint = useRef<ContentFingerprint | null>(null);
  const echoConverter = useRef(toTiptap);
  const localEchoFingerprints = useRef<ContentFingerprint[]>([]);
  const chemicalRequestGeneration = useRef(0);
  const chemicalClipboardCache = useRef<ChemicalStructureClipboardCache>({
    entries: new Map(),
    timers: new Map(),
  });
  const chemicalClipboardEditorId = useRef(editorId);
  const mounted = useRef(true);
  const formulaGeneration = useRef(0);
  const formulaTarget = useRef<
    (Omit<FormulaEditRequest, "position"> & { position: number | null }) | null
  >(null);
  const chemicalFormulaTarget = useRef<
    (Omit<FormulaEditRequest, "position"> & { position: number | null }) | null
  >(null);
  const [formulaRequest, setFormulaRequest] = useState<
    (FormulaEditRequest & { generation?: number }) | null
  >(null);
  const [formulaDialogOpen, setFormulaDialogOpen] = useState(false);
  const [chemistryRequest, setChemistryRequest] = useState<ChemistryEditorRequest | null>(null);
  const [chemistryDialogOpen, setChemistryDialogOpen] = useState(false);
  const [chemistryError, setChemistryError] = useState<string | null>(null);
  const modalEditorOpen = useRef(false);
  const supportsChemicalStructures = capabilities.chemicalStructures !== false;
  const editorSessionVisible = useEditorSessionVisible();
  modalEditorOpen.current =
    editorSessionVisible &&
    Boolean(
      pendingPaste ||
        (formulaRequest && formulaDialogOpen) ||
        (chemistryRequest && chemistryDialogOpen),
    );
  baseDocument.current = document;
  onDocumentChangeRef.current = onDocumentChange;
  onTextCountsRef.current = onTextCounts;
  if (chemicalClipboardEditorId.current !== editorId) {
    clearChemicalStructureClipboardCache(chemicalClipboardCache.current);
    chemicalClipboardEditorId.current = editorId;
  }

  useEffect(() => {
    // 开发模式的 React StrictMode 会执行一次“挂载 → 清理 → 再挂载”探测。
    // 必须在每次 effect 建立时恢复标记，否则后续化学方程式确认回调会被
    // isCurrent() 静默拦截，表现为“插入”按钮没有任何反应。
    mounted.current = true;
    return () => {
      mounted.current = false;
      chemicalRequestGeneration.current += 1;
      clearChemicalStructureClipboardCache(chemicalClipboardCache.current);
    };
  }, []);

  const nextChemistryRequestGeneration = useCallback(() => {
    chemicalRequestGeneration.current += 1;
    return chemicalRequestGeneration.current;
  }, []);

  const openChemicalStructureEditor = useCallback(
    (request: ChemicalStructureEditRequest) => {
      const generation = nextChemistryRequestGeneration();
      setChemistryError(null);
      setChemistryRequest({ type: "structure", request, generation });
      setChemistryDialogOpen(true);
    },
    [nextChemistryRequestGeneration],
  );

  const lastPublishedCounts = useRef<{
    editorId: string;
    callback: (counts: TextCounts) => void;
    counts: TextCounts;
  } | null>(null);
  const publishCounts = useCallback(
    (updatedEditor: {
      state: {
        doc: Parameters<typeof countDocumentText>[0];
        selection: { from: number; to: number };
      };
    }) => {
      const callback = onTextCountsRef.current;
      if (!callback) return;
      const documentCounts = countDocumentText(updatedEditor.state.doc);
      const counts = {
        ...documentCounts,
        selectedCharacters: countSelectedText(
          updatedEditor.state.doc,
          updatedEditor.state.selection.from,
          updatedEditor.state.selection.to,
        ),
      };
      const previous = lastPublishedCounts.current;
      if (
        previous?.editorId === editorId &&
        previous.callback === callback &&
        previous.counts.chineseCharacters === counts.chineseCharacters &&
        previous.counts.totalCharacters === counts.totalCharacters &&
        previous.counts.selectedCharacters === counts.selectedCharacters
      )
        return;
      lastPublishedCounts.current = { editorId, callback, counts };
      callback(counts);
    },
    [editorId],
  );

  const updateCaretColor = useCallback((updatedEditor: Editor) => {
    const textStyleAttributes = updatedEditor.getAttributes("textStyle") as {
      backgroundColor?: unknown;
    };
    const backgroundColor =
      typeof textStyleAttributes.backgroundColor === "string"
        ? textStyleAttributes.backgroundColor
        : null;
    updatedEditor.view.dom.style.setProperty(
      "--editor-caret-color",
      getEditorCaretColor(backgroundColor),
    );
  }, []);

  const addAsset = useCallback(
    (descriptor: AssetDescriptor) => {
      const current = baseDocument.current;
      if (!addImageAsset) return;
      baseDocument.current = addImageAsset(current, descriptor);
    },
    [addImageAsset],
  );
  const discardImportedAssets = useCallback(
    (descriptors: readonly AssetDescriptor[], operationId: string) => {
      if (descriptors.length === 0) return;
      void window.patentApi.assets
        .discardImports({
          sessionId: extensionSessionId ?? editorId,
          operationId,
          assetIds: [...new Set(descriptors.map((descriptor) => descriptor.assetId))],
        })
        .then((result) => {
          if (!result.ok) showApplicationError(result.error);
        })
        .catch(() => showApplicationError({ code: "INTERNAL", message: "normalized" }));
    },
    [editorId, extensionSessionId],
  );
  const openChemistryEditor = useCallback(
    (initialKind: "equation" | "structure" = "equation") => {
      const generation = nextChemistryRequestGeneration();
      setChemistryError(null);
      setChemistryRequest((current) =>
        current?.type === "new"
          ? { ...current, initialKind, generation }
          : {
              type: "new",
              initialKind,
              generation,
            },
      );
      setChemistryDialogOpen(true);
    },
    [nextChemistryRequestGeneration],
  );
  const openFormulaEdit = useCallback(
    (request: FormulaEditRequest) => {
      if (request.kind === "chemistry") {
        if (!capabilities.chemistry) return;
        chemicalFormulaTarget.current =
          request.position === undefined ? null : { ...request, position: request.position };
        setChemistryError(null);
        setChemistryRequest({
          type: "formula",
          request,
          generation: nextChemistryRequestGeneration(),
        });
        setChemistryDialogOpen(true);
        return;
      }
      const previous = formulaTarget.current;
      if (
        previous &&
        previous.position !== null &&
        previous.position === request.position &&
        previous.latex === request.latex &&
        previous.mode === request.mode
      ) {
        setFormulaDialogOpen(true);
        return;
      }
      formulaTarget.current =
        request.position === undefined ? null : { ...request, position: request.position };
      setFormulaRequest({ ...request, generation: ++formulaGeneration.current });
      setFormulaDialogOpen(true);
    },
    [capabilities.chemistry, nextChemistryRequestGeneration],
  );

  const openFormulaEditor = useCallback(() => {
    const selection = commandBus.getEditor(editorId)?.state.selection;
    if (
      selection instanceof NodeSelection &&
      (selection.node.type.name === "inlineMath" || selection.node.type.name === "blockMath")
    ) {
      openFormulaEdit({
        mode: selection.node.type.name === "inlineMath" ? "inline" : "block",
        latex: String(selection.node.attrs.latex),
        kind: selection.node.attrs.formulaKind === "chemistry" ? "chemistry" : "math",
        position: selection.from,
      });
      return;
    }
    formulaTarget.current = null;
    setFormulaRequest((current) =>
      current?.kind === "math" && current.position === undefined
        ? current
        : { mode: "inline", latex: "", kind: "math" },
    );
    setFormulaDialogOpen(true);
  }, [commandBus, editorId, openFormulaEdit]);

  const rememberLocalEcho = useCallback((value: ContentFingerprint) => {
    const echoes = localEchoFingerprints.current.filter((entry) => !entry.sameSerialized(value));
    echoes.push(value);
    localEchoFingerprints.current = echoes.slice(-LOCAL_ECHO_LIMIT);
  }, []);

  const importBytesAtSelection = async (
    view: EditorView,
    image: ClipboardDataImage,
    position?: number,
  ) => {
    if (!importImage) return;
    const epoch = importEpoch.current;
    const documentAtImport = view.state.doc;
    const result = await importImage(image);
    if (!result.ok) {
      showApplicationError(result.error);
      return;
    }
    if (
      !mounted.current ||
      view.isDestroyed ||
      !view.editable ||
      !writesAllowed.current ||
      epoch !== importEpoch.current ||
      view.state.doc !== documentAtImport
    )
      return;
    addAsset(result.value.descriptor);
    const figureType = isInsideStructuredContainer(
      view.state.doc.resolve(position ?? view.state.selection.from),
    )
      ? view.state.schema.nodes.inlineFigure
      : view.state.schema.nodes.figure;
    if (!figureType) return;
    const figure = figureType.create({
      nodeId: randomUuid(),
      assetId: result.value.descriptor.assetId,
      widthMm: 80,
      alignment: "center",
      rotationDeg: 0,
      sourceAspectRatio: result.value.descriptor.widthPx / result.value.descriptor.heightPx,
      semanticRole: null,
    });
    view.dispatch(
      position === undefined
        ? view.state.tr.replaceSelectionWith(figure)
        : view.state.tr.insert(position, figure),
    );
  };
  const importFileAtSelection = async (view: EditorView, file: File, position?: number) => {
    const limitError = imageImportLimitError([file]);
    if (limitError) {
      showApplicationError({ code: "IMAGE_IMPORT_LIMIT", message: limitError });
      return;
    }
    return importBytesAtSelection(
      view,
      {
        originalName: file.name,
        mediaType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      },
      position,
    );
  };
  const importFilesAtSelection = async (view: EditorView, files: File[], position?: number) => {
    if (!importImages) return;
    const epoch = importEpoch.current;
    const limitError = imageImportLimitError(files);
    if (limitError) {
      showApplicationError({ code: "IMAGE_IMPORT_LIMIT", message: limitError });
      return;
    }
    const documentAtImport = view.state.doc;
    const selectionAtImport = view.state.selection;
    const images = await Promise.all(
      files.map(async (file) => ({
        originalName: file.name,
        mediaType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    const operationId = randomUuid();
    const result = await importImages(images, operationId);
    if (!result.ok) {
      showApplicationError(result.error);
      return;
    }
    if (
      !mounted.current ||
      view.isDestroyed ||
      !view.editable ||
      !writesAllowed.current ||
      epoch !== importEpoch.current
    ) {
      discardImportedAssets(
        result.value.map(({ descriptor }) => descriptor),
        operationId,
      );
      return;
    }
    if (view.state.doc !== documentAtImport) {
      discardImportedAssets(
        result.value.map(({ descriptor }) => descriptor),
        operationId,
      );
      showApplicationError({
        code: "REVISION_CONFLICT",
        message: "图片导入期间文档已发生变化，请重新插入。",
      });
      return;
    }
    const figureType = isInsideStructuredContainer(
      documentAtImport.resolve(position ?? selectionAtImport.from),
    )
      ? view.state.schema.nodes.inlineFigure
      : view.state.schema.nodes.figure;
    if (!figureType) return;
    const figures = result.value.map(({ descriptor }) => {
      addAsset(descriptor);
      return figureType.create({
        nodeId: randomUuid(),
        assetId: descriptor.assetId,
        widthMm: 80,
        alignment: "center",
        rotationDeg: 0,
        sourceAspectRatio: descriptor.widthPx / descriptor.heightPx,
        semanticRole: null,
      });
    });
    const fragment = Fragment.fromArray(figures);
    view.dispatch(
      position === undefined
        ? view.state.tr.setSelection(selectionAtImport).replaceSelection(new Slice(fragment, 0, 0))
        : view.state.tr.insert(position, fragment),
    );
  };
  /**
   * 在粘贴后遍历文档，查找 {@link PASTE_IMAGE_MARKER_PATTERN} 标记，
   * 删除标记文本并在原位置异步导入图片，保持图片在粘贴内容中的原始位置。
   */
  const importEmbeddedImagesAtMarkers = async (
    view: EditorView,
    images: ClipboardDataImage[],
    pattern: RegExp,
  ) => {
    const markers: { pos: number; end: number; index: number }[] = [];
    view.state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const text = node.text ?? "";
      const re = new RegExp(pattern.source, "g");
      let match = re.exec(text);
      while (match !== null) {
        const capture = match[1];
        if (capture === undefined) {
          match = re.exec(text);
          continue;
        }
        const index = Number.parseInt(capture, 10);
        if (index < images.length) {
          markers.push({
            pos: pos + match.index,
            end: pos + match.index + match[0].length,
            index,
          });
        }
        match = re.exec(text);
      }
    });
    if (markers.length === 0) return;
    // 逆序删除标记，保持位置有效
    markers.sort((a, b) => b.pos - a.pos);
    for (const marker of markers) {
      const image = images[marker.index];
      if (!image) continue;
      const tr = view.state.tr;
      tr.delete(marker.pos, marker.end);
      view.dispatch(tr);
      await importBytesAtSelection(view, image, marker.pos);
    }
  };

  const currentEditorCallbacks: RetainedEditorCallbacks = {
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": `编辑 ${title}`,
        "aria-multiline": "true",
        "data-patent-editor-id": editorId,
        lang: "zh-CN",
        spellcheck: "false",
        class: "patent-prosemirror",
      },
      handleDOMEvents: {
        mousedown: (_view, rawEvent) => {
          if (!referenceMarkLocatorEnabled) return false;
          const event = rawEvent as MouseEvent;
          if (event.detail < 2) return false;
          const target =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-reference-mark-id]")
              : null;
          if (!target?.dataset.referenceMarkId) return false;
          event.preventDefault();
          return true;
        },
        dblclick: (_view, rawEvent) => {
          if (!referenceMarkLocatorEnabled) return false;
          const event = rawEvent as MouseEvent;
          const target =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-reference-mark-id]")
              : null;
          const referenceMarkId = target?.dataset.referenceMarkId;
          if (!referenceMarkId) return false;
          event.preventDefault();
          onReferenceMarkActivate(
            activeReferenceMarkId === referenceMarkId ? null : referenceMarkId,
          );
          return true;
        },
        click: (_view, rawEvent) => {
          const event = rawEvent as MouseEvent;
          if (!isSentenceSelectionClick(event)) return false;
          event.preventDefault();
          return commandBus.selectSentenceFromCoordinates(editorId, {
            x: event.clientX,
            y: event.clientY,
          });
        },
        copy: (view, rawEvent) => {
          const event = rawEvent as ClipboardEvent;
          const chemicalCopied = writeChemicalStructureClipboard(
            event,
            view,
            editorId,
            chemicalClipboardCache.current,
          );
          const imageCopied = writeImageClipboard(
            event,
            view,
            extensionSessionId ?? editorId,
            getAssetDescriptors?.() ?? documentAssetDescriptors(baseDocument.current),
            chemicalCopied
              ? event.clipboardData?.getData(CHEMICAL_STRUCTURE_CLIPBOARD_MIME)
              : undefined,
          );
          return chemicalCopied || Boolean(imageCopied);
        },
        cut: (view, rawEvent) => {
          if (!view.editable || !writesAllowed.current) return false;
          const event = rawEvent as ClipboardEvent;
          const handled = writeImageClipboard(
            event,
            view,
            extensionSessionId ?? editorId,
            getAssetDescriptors?.() ?? documentAssetDescriptors(baseDocument.current),
          );
          if (!handled) return false;
          if (handled === "copied") {
            view.dispatch(
              view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"),
            );
          }
          return true;
        },
        drop: (view, rawEvent) => {
          if (!view.editable || !writesAllowed.current) return false;
          // Internal drags belong to ProseMirror's move/copy transaction, even
          // when the browser also exposes the dragged image as a file.
          if (view.dragging) return false;
          if (!capabilities.images || (!importImages && !importImage)) return false;
          const event = rawEvent as DragEvent;
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          const position =
            typeof window.document.elementFromPoint === "function"
              ? view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
              : undefined;
          const importFiles = importImages
            ? importFilesAtSelection(view, files, position)
            : importFileAtSelection(view, files[0] as File, position);
          void importFiles.catch(() =>
            showApplicationError({ code: "INTERNAL", message: "normalized" }),
          );
          return true;
        },
        paste: (view, rawEvent) => {
          if (!view.editable || !writesAllowed.current) return false;
          const epoch = importEpoch.current;
          const event = rawEvent as ClipboardEvent;
          if (
            readChemicalStructureClipboard(
              event,
              view,
              editorId,
              chemicalClipboardCache.current,
              getAssetDescriptors
                ? new Set(getAssetDescriptors().map((asset) => asset.assetId))
                : chemicalPreviewAssetIds(baseDocument.current),
            )
          ) {
            return true;
          }
          let internalImageSelection: ImageSelectionClipboardEntry | undefined;
          const internalImagePayload = event.clipboardData?.getData(IMAGE_SELECTION_CLIPBOARD_MIME);
          if (internalImagePayload && internalImagePayload.length <= 256) {
            try {
              const parsed = ImageSelectionClipboardSchema.parse(JSON.parse(internalImagePayload));
              const cached = imageSelectionClipboardEntries.get(parsed.token);
              if (cached && Date.now() - cached.createdAt <= IMAGE_SELECTION_CLIPBOARD_TTL_MS) {
                internalImageSelection = cached;
              } else {
                imageSelectionClipboardEntries.delete(parsed.token);
              }
            } catch {
              internalImageSelection = undefined;
            }
          }
          const html = internalImageSelection
            ? internalImageSelection.images.reduce(
                (content, _image, index) =>
                  content.replaceAll(imageClipboardMarker(index), `\uE010PIMG${index}\uE011`),
                internalImageSelection.htmlTemplate,
              )
            : event.clipboardData?.getData("text/html");
          const files = Array.from(event.clipboardData?.files ?? []);
          let embeddedClipboardImages: ClipboardDataImage[] = [];
          try {
            embeddedClipboardImages =
              capabilities.images && html
                ? (internalImageSelection?.images ?? extractClipboardDataImages(html))
                : [];
          } catch (error) {
            event.preventDefault();
            showApplicationError({
              code: "IMAGE_IMPORT_LIMIT",
              message: error instanceof Error ? error.message : "图片导入超出限制。",
            });
            return true;
          }
          if (
            capabilities.images &&
            (importImages || importImage) &&
            files.length > 0 &&
            embeddedClipboardImages.length === 0
          ) {
            event.preventDefault();
            const importFiles = importImages
              ? importFilesAtSelection(view, files)
              : importFileAtSelection(view, files[0] as File);
            void importFiles.catch(() =>
              showApplicationError({ code: "INTERNAL", message: "normalized" }),
            );
            return true;
          }
          const plain = event.clipboardData?.getData("text/plain") ?? "";
          if (!html) {
            // 无 HTML：纯文本按换行转段落粘贴，避免默认的硬换行语义。
            if (plain) {
              event.preventDefault();
              replaceSelectionWithPlainText(view, plain, setPasteFormatting);
              return true;
            }
            return false;
          }

          const canImportEmbeddedImages =
            capabilities.images &&
            (internalImageSelection !== undefined ||
              importImages !== undefined ||
              importImage !== undefined);
          if (
            embeddedClipboardImages.some((image) => image.chemicalStructure) &&
            isInsideStructuredContainer(view.state.selection.$from)
          ) {
            event.preventDefault();
            showApplicationError({
              code: "INVALID_INPUT",
              message: "结构式不能插入表格或列表内部，请将光标移至普通正文段落。",
            });
            return true;
          }
          let sanitizedHtml: string;
          let formulas: PasteFormula[];
          let internalProseMirrorSlice = false;
          let paragraphMode: PasteParagraphMode = "body";
          let simplifications: string[] = [];
          let alternateSlice: Slice | undefined;
          let slice: Slice;
          try {
            ({
              html: sanitizedHtml,
              formulas,
              internalProseMirrorSlice,
              paragraphMode,
              simplifications,
            } = sanitizePastedHtmlWithFormulas(html, capabilities));
            const container = window.document.createElement("div");
            // 图片 marker 仅用于后续异步导入。当前编辑器不支持图片时，必须在解析前
            // 移除 marker，不能把它作为普通文本插入或误判为可插入 HTML 内容。
            PASTE_IMAGE_MARKER_PATTERN.lastIndex = 0;
            container.innerHTML = canImportEmbeddedImages
              ? sanitizedHtml
              : sanitizedHtml.replace(PASTE_IMAGE_MARKER_PATTERN, "");
            slice = ProseMirrorDomParser.fromSchema(view.state.schema).parseSlice(container, {
              preserveWhitespace: internalProseMirrorSlice,
            });
            if (!internalProseMirrorSlice) {
              const alternate = sanitizePastedHtmlWithFormulas(
                html,
                capabilities,
                paragraphMode === "source" ? "body" : "source",
              );
              container.innerHTML = canImportEmbeddedImages
                ? alternate.html
                : alternate.html.replace(PASTE_IMAGE_MARKER_PATTERN, "");
              const parsedAlternate = ProseMirrorDomParser.fromSchema(view.state.schema).parseSlice(
                container,
              );
              alternateSlice = new Slice(
                Fragment.from(
                  replaceFormulaTokens(
                    parsedAlternate.content,
                    alternate.formulas,
                    view.state.schema,
                    new Set(),
                    isInsideStructuredContainer(view.state.selection.$from),
                  ),
                ),
                parsedAlternate.openStart,
                parsedAlternate.openEnd,
              );
            }
          } catch {
            event.preventDefault();
            if (plain) replaceSelectionWithPlainText(view, plain);
            return true;
          }

          event.preventDefault();
          if (!canImportEmbeddedImages && /\uE010PIMG/u.test(sanitizedHtml))
            simplifications.push("当前文档无法接收这些图片，请通过插入图片补充");
          const issues = [
            ...new Set(
              simplifications.filter(
                (issue) => issue.includes("补充") || issue.includes("不支持公式"),
              ),
            ),
          ];
          const documentAtConfirmation = view.state.doc;
          const selectionAtConfirmation = view.state.selection;
          const applyPaste = () => {
            if (!mounted.current || view.isDestroyed) return;
            if (view.state.doc !== documentAtConfirmation) {
              showApplicationError({
                code: "REVISION_CONFLICT",
                message: "文档已发生变化，请重新粘贴。",
              });
              return;
            }
            view.dispatch(view.state.tr.setSelection(selectionAtConfirmation));
            const consumed = new Set<number>();
            const nodes = replaceFormulaTokens(
              slice.content,
              formulas,
              view.state.schema,
              consumed,
              isInsideStructuredContainer(view.state.selection.$from),
            );
            if (!hasInsertableSliceContent(nodes)) {
              event.preventDefault();
              if (plain) replaceSelectionWithPlainText(view, plain);
              if (simplifications.length > 0)
                setPasteFormatting({
                  document: view.state.doc,
                  mode: paragraphMode,
                  targets: [],
                  simplifications,
                });
              return true;
            }

            event.preventDefault();
            const embeddedImages = canImportEmbeddedImages ? embeddedClipboardImages : [];
            const insertImages = (
              descriptors: readonly AssetDescriptor[],
              selection = view.state.selection,
            ) => {
              const finalNodes = replacePasteImageTokens(
                Fragment.from(nodes),
                embeddedImages,
                descriptors,
                view.state.schema,
                isInsideStructuredContainer(selection.$from),
              );
              const finalContent = Fragment.from(finalNodes);
              for (const descriptor of descriptors) addAsset(descriptor);
              replaceSelectionWithPasteSlice(
                view,
                new Slice(finalContent, slice.openStart, slice.openEnd),
                selection,
                alternateSlice
                  ? {
                      alternate: new Slice(
                        Fragment.from(
                          replacePasteImageTokens(
                            alternateSlice.content,
                            embeddedImages,
                            descriptors,
                            view.state.schema,
                            isInsideStructuredContainer(selection.$from),
                          ),
                        ),
                        alternateSlice.openStart,
                        alternateSlice.openEnd,
                      ),
                      mode: paragraphMode,
                      simplifications,
                      onInserted: setPasteFormatting,
                    }
                  : undefined,
              );
            };
            if (internalImageSelection && embeddedImages.length > 0) {
              const targetSessionId = extensionSessionId ?? editorId;
              if (internalImageSelection.sourceSessionId === targetSessionId) {
                insertImages(internalImageSelection.descriptors);
                return true;
              }
              const documentAtPaste = view.state.doc;
              const selectionAtPaste = view.state.selection;
              const operationId = randomUuid();
              void window.patentApi.assets
                .stageReferences({
                  sourceSessionId: internalImageSelection.sourceSessionId,
                  targetSessionId,
                  operationId,
                  assetIds: [
                    ...new Set(
                      internalImageSelection.descriptors.map((descriptor) => descriptor.assetId),
                    ),
                  ],
                })
                .then((result) => {
                  if (!result.ok) {
                    showApplicationError(result.error);
                    return;
                  }
                  if (
                    !mounted.current ||
                    view.isDestroyed ||
                    !view.editable ||
                    !writesAllowed.current ||
                    epoch !== importEpoch.current
                  ) {
                    discardImportedAssets(
                      result.value.map(({ descriptor }) => descriptor),
                      operationId,
                    );
                    return;
                  }
                  if (view.state.doc !== documentAtPaste) {
                    discardImportedAssets(
                      result.value.map(({ descriptor }) => descriptor),
                      operationId,
                    );
                    showApplicationError({
                      code: "REVISION_CONFLICT",
                      message: "图片复制期间文档已发生变化，请重新粘贴。",
                    });
                    return;
                  }
                  const stagedById = new Map(
                    result.value.map(({ descriptor }) => [descriptor.assetId, descriptor]),
                  );
                  insertImages(
                    internalImageSelection.descriptors.map(
                      (descriptor) => stagedById.get(descriptor.assetId) ?? descriptor,
                    ),
                    selectionAtPaste,
                  );
                })
                .catch(() => showApplicationError({ code: "INTERNAL", message: "normalized" }));
              return true;
            }
            if (embeddedImages.length > 0 && importImages) {
              const documentAtPaste = view.state.doc;
              const selectionAtPaste = view.state.selection;
              const operationId = randomUuid();
              void importImages(embeddedImages, operationId)
                .then((result) => {
                  if (!result.ok) {
                    showApplicationError(result.error);
                    return;
                  }
                  if (
                    !mounted.current ||
                    view.isDestroyed ||
                    !view.editable ||
                    !writesAllowed.current ||
                    epoch !== importEpoch.current
                  ) {
                    discardImportedAssets(
                      result.value.map(({ descriptor }) => descriptor),
                      operationId,
                    );
                    return;
                  }
                  if (view.state.doc !== documentAtPaste) {
                    discardImportedAssets(
                      result.value.map(({ descriptor }) => descriptor),
                      operationId,
                    );
                    showApplicationError({
                      code: "REVISION_CONFLICT",
                      message: "图片导入期间文档已发生变化，请重新粘贴。",
                    });
                    return;
                  }
                  insertImages(
                    result.value.map(({ descriptor }) => descriptor),
                    selectionAtPaste,
                  );
                })
                .catch(() => showApplicationError({ code: "INTERNAL", message: "normalized" }));
              return true;
            }
            const content = Fragment.from(nodes);
            replaceSelectionWithPasteSlice(
              view,
              new Slice(content, slice.openStart, slice.openEnd),
              view.state.selection,
              alternateSlice
                ? {
                    alternate: alternateSlice,
                    mode: paragraphMode,
                    simplifications,
                    onInserted: setPasteFormatting,
                  }
                : undefined,
            );
            if (embeddedImages.length > 0)
              void importEmbeddedImagesAtMarkers(
                view,
                embeddedImages,
                PASTE_IMAGE_MARKER_PATTERN,
              ).catch(() => showApplicationError({ code: "INTERNAL", message: "normalized" }));
            return true;
          };
          if (issues.length > 0) {
            setPendingPaste({
              issues,
              apply: () => {
                applyPaste();
              },
            });
          } else applyPaste();
          return true;
        },
      },
      handleKeyDown: (view, event) => {
        if (!event.ctrlKey && !event.metaKey && event.key === "Escape") {
          setPasteFormatting(null);
          if (!modalEditorOpen.current) onFindModeChange?.(null);
          return false;
        }
        const findMode = findShortcutMode(event);
        if (!findMode) return false;
        if (modalEditorOpen.current) {
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        const { from, to } = view.state.selection;
        const selectedText = from === to ? undefined : view.state.doc.textBetween(from, to, "\n");
        onFindModeChange?.(findMode, selectedText);
        return true;
      },
    },
    onCreate: ({ editor: createdEditor }) => {
      updateCaretColor(createdEditor);
      publishCounts(createdEditor);
    },
    onUpdate: ({ editor: updatedEditor }) => {
      setPasteFormatting(null);
      updateCaretColor(updatedEditor);
      const updatedContent = readEditorJson(updatedEditor.state.doc);
      const result = fromTiptap(updatedContent, baseDocument.current);
      if (result.ok) {
        const normalizedContent = toTiptap(result.value);
        lastValidContent.current = normalizedContent;
        const normalizedFingerprint = fingerprintContent(normalizedContent);
        emittedFingerprint.current = normalizedFingerprint;
        rememberLocalEcho(normalizedFingerprint);
        rememberDocumentEcho(result.value, normalizedFingerprint);
        onDocumentChangeRef.current(result.value);
      } else {
        console.error(
          `[RichTextEditorCore] fromTiptap failed for editor "${editorId}":`,
          result.error.message,
        );
        showApplicationError(result.error);
        replaceContentPreservingSelection(updatedEditor, lastValidContent.current);
        emittedFingerprint.current = fingerprintContent(lastValidContent.current);
        rememberLocalEcho(emittedFingerprint.current);
      }
      publishCounts(updatedEditor);
    },
    onSelectionUpdate: ({ editor: updatedEditor }) => {
      commandBus.publishEditorFocus(editorId);
      updateCaretColor(updatedEditor);
      publishCounts(updatedEditor);
    },
    onFocus: () => {
      commandBus.publishEditorFocus(editorId);
    },
    onFormulaEdit: openFormulaEdit,
    onChemicalStructureEdit: openChemicalStructureEditor,
  };

  // Layout changes intentionally unmount and remount editor React surfaces. Reusing the
  // Tiptap Editor instance preserves ProseMirror's native history stack across those moves.
  // All component-owned callbacks are routed through a mutable runtime so a remounted
  // surface never calls stale state setters or stale document callbacks.
  // biome-ignore lint/correctness/useExhaustiveDependencies: editor identity is defined by command bus + editor id.
  const editor = useMemo(
    () =>
      commandBus.retainEditor(editorId, () => {
        const runtime: RetainedEditorRuntime = { current: currentEditorCallbacks };
        const editorProps: EditorOptions["editorProps"] = {
          ...(runtime.current.editorProps.attributes
            ? { attributes: runtime.current.editorProps.attributes }
            : {}),
          handleDOMEvents: {
            mousedown: (view, event) =>
              runtime.current.editorProps.handleDOMEvents?.mousedown?.(view, event) ?? false,
            dblclick: (view, event) =>
              runtime.current.editorProps.handleDOMEvents?.dblclick?.(view, event) ?? false,
            click: (view, event) =>
              runtime.current.editorProps.handleDOMEvents?.click?.(view, event) ?? false,
            copy: (view, event) =>
              runtime.current.editorProps.handleDOMEvents?.copy?.(view, event) ?? false,
            cut: (view, event) =>
              runtime.current.editorProps.handleDOMEvents?.cut?.(view, event) ?? false,
            drop: (view, event) =>
              runtime.current.editorProps.handleDOMEvents?.drop?.(view, event) ?? false,
            paste: (view, event) =>
              runtime.current.editorProps.handleDOMEvents?.paste?.(view, event) ?? false,
          },
          handleKeyDown: (view, event) =>
            runtime.current.editorProps.handleKeyDown?.(view, event) ?? false,
        };
        const retainedEditor = new Editor({
          editable: editable && !applicationClosing,
          enableInputRules: false,
          extensions: extensionFactory(extensionSessionId ?? editorId, {
            capabilities,
            onFormulaEdit: (request) => runtime.current.onFormulaEdit(request),
            onChemicalStructureEdit: (request) => runtime.current.onChemicalStructureEdit(request),
          }),
          content: toTiptap(document),
          editorProps,
          onCreate: (event) => runtime.current.onCreate(event),
          onUpdate: (event) => runtime.current.onUpdate(event),
          onSelectionUpdate: (event) => runtime.current.onSelectionUpdate(event),
          onFocus: () => runtime.current.onFocus(),
        });
        retainedEditorRuntimes.set(retainedEditor, runtime);
        return retainedEditor;
      }),
    [commandBus, editorId],
  );
  const retainedRuntime = retainedEditorRuntimes.get(editor);
  if (!retainedRuntime) throw new Error(`编辑器 ${editorId} 缺少运行时绑定。`);
  retainedRuntime.current = currentEditorCallbacks;

  useLayoutEffect(() => {
    const trackTarget = ({
      transaction,
      appendedTransactions,
    }: {
      transaction: Transaction;
      appendedTransactions: Transaction[];
    }) => {
      for (const target of [formulaTarget.current, chemicalFormulaTarget.current]) {
        if (!target) continue;
        for (const change of [transaction, ...appendedTransactions]) {
          if (target.position === null) break;
          if (!change.docChanged) continue;
          const mapped = change.mapping.mapResult(target.position, 1);
          const node = mapped.pos < change.doc.content.size ? change.doc.nodeAt(mapped.pos) : null;
          const matches =
            node?.type.name === (target.mode === "inline" ? "inlineMath" : "blockMath") &&
            node.attrs.latex === target.latex &&
            (node.attrs.formulaKind ?? "math") === target.kind;
          target.position = !mapped.deleted && matches ? mapped.pos : null;
        }
      }
    };
    editor.on("transaction", trackTarget);
    return () => {
      editor.off("transaction", trackTarget);
    };
  }, [editor]);

  useLayoutEffect(() => {
    editor.setOptions({ editable: editable && !applicationClosing });
  }, [editable, applicationClosing, editor]);

  useLayoutEffect(() => {
    updateCaretColor(editor);
    publishCounts(editor);
  }, [editor, publishCounts, updateCaretColor]);

  useEditorSelectionOverlay({
    editor,
    enabled: activeSelectionVisible || inactiveSelectionVisible,
    tone: inactiveSelectionVisible ? "background" : "active",
  });

  useLayoutEffect(() => {
    setReferenceMarkKeywordDecorations(editor, {
      enabled: referenceMarkLocatorEnabled,
      bookKind: referenceMarkBookKind,
      referenceMarks,
      activeReferenceMarkId,
      recentReferenceMarkId,
    });
  }, [
    activeReferenceMarkId,
    editor,
    recentReferenceMarkId,
    referenceMarkBookKind,
    referenceMarkLocatorEnabled,
    referenceMarks,
  ]);

  useLayoutEffect(() => {
    setReferenceMarkReviewHighlights(
      editor,
      referenceMarkReviewKeyword,
      referenceMarkReviewActiveIndex,
    );
  }, [editor, referenceMarkReviewActiveIndex, referenceMarkReviewKeyword]);

  useLayoutEffect(() => {
    setReferenceMarkIssueHighlights(
      editor,
      referenceMarkIssueLocations,
      referenceMarkIssueActiveLocationId,
    );
  }, [editor, referenceMarkIssueActiveLocationId, referenceMarkIssueLocations]);

  useLayoutEffect(() => {
    if (!editor) return;
    return commandBus.register(
      editorId,
      editor,
      addAsset,
      openFormulaEditor,
      openChemistryEditor,
      capabilities,
    );
  }, [
    addAsset,
    capabilities,
    commandBus,
    editor,
    editorId,
    openChemistryEditor,
    openFormulaEditor,
  ]);

  useEffect(() => {
    if (!editor) return;
    const sameConverter = echoConverter.current === toTiptap;
    echoConverter.current = toTiptap;
    const echo = documentEcho(document);
    if (
      sameConverter &&
      echo &&
      (echo === emittedFingerprint.current || localEchoFingerprints.current.includes(echo))
    )
      return;
    const nextContent = toTiptap(document);
    const nextFingerprint = fingerprintContent(nextContent);
    if (
      (emittedFingerprint.current && nextFingerprint.sameSerialized(emittedFingerprint.current)) ||
      localEchoFingerprints.current.some((entry) => entry.sameSerialized(nextFingerprint))
    )
      return;
    const currentContent = readEditorJson(editor.state.doc);
    const currentResult = fromTiptap(currentContent, baseDocument.current);
    const currentFingerprint = currentResult.ok
      ? fingerprintContent(toTiptap(currentResult.value))
      : fingerprintContent(currentContent);
    if (nextFingerprint.matches(currentFingerprint)) return;
    if (
      emittedFingerprint.current?.matches(nextFingerprint) ||
      localEchoFingerprints.current.some((entry) => entry.matches(nextFingerprint))
    )
      return;
    replaceContentPreservingSelection(editor, nextContent);
    updateCaretColor(editor);
    lastValidContent.current = nextContent;
    // 一次权威的外部替换（例如附图标记编号）会建立新的同步边界。
    // 此前缓存的本地回显此后可能正是撤销目标，继续保留会把合法撤销误判为旧回显。
    localEchoFingerprints.current = [];
    emittedFingerprint.current = nextFingerprint;
    publishCounts(editor);
  }, [
    document,
    editor,
    fromTiptap,
    publishCounts,
    toTiptap,
    updateCaretColor,
    readEditorJson,
    fingerprintContent,
  ]);

  const restoreFocusAfterDialogCancel = () => {
    requestAnimationFrame(() => {
      if (hasVisibleElement("[aria-modal='true'], [role='menu']")) return;
      const active = globalThis.document.activeElement;
      if (
        active instanceof HTMLElement &&
        isVisibleControl(active) &&
        active.closest("input, textarea, select, math-field, [contenteditable='true']")
      )
        return;
      const focusedId = commandBus.getFocusedEditor()?.editorId;
      const targetId =
        focusedId && editorBelongsToSession(focusedId, extensionSessionId ?? editorId)
          ? focusedId
          : editorId;
      const targetEditor = commandBus.getEditor(targetId);
      if (targetEditor && !targetEditor.isDestroyed && isVisibleControl(targetEditor.view.dom)) {
        commandBus.focus(targetId);
      }
    });
  };

  return (
    <>
      <EditorContent editor={editor} />
      {
        <MotionPresence>
          {pendingPaste && (
            <StandardDialog
              open
              portal
              title="部分内容无法粘贴"
              size="s"
              onCancel={() => setPendingPaste(null)}
              footer={
                <>
                  <button type="button" onClick={() => setPendingPaste(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => {
                      const pending = pendingPaste;
                      setPendingPaste(null);
                      pending.apply();
                    }}
                  >
                    继续粘贴
                  </button>
                </>
              }
            >
              <p>以下内容无法完整保留：</p>
              <ul>
                {pendingPaste.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
              <p>继续将仅粘贴可保留的内容，请与原文核对。</p>
            </StandardDialog>
          )}
        </MotionPresence>
      }

      <MotionPresence>
        {editor &&
        pasteFormatting &&
        (pasteFormatting.targets.length > 0 || pasteFormatting.simplifications.length > 0) ? (
          <PasteFormattingOptions
            session={pasteFormatting}
            editorElement={editor.view.dom}
            onClose={() => setPasteFormatting(null)}
            onSelect={(mode) => {
              setPasteFormatting(switchPasteFormatting(editor.view, pasteFormatting, mode));
              editor.view.focus();
            }}
          />
        ) : null}
      </MotionPresence>
      {editor ? (
        <EditorContextMenus
          editor={editor}
          editorId={editorId}
          commandBus={commandBus}
          {...(onFindModeChange ? { onFind: onFindModeChange } : {})}
          {...(onNumberSelection ? { onNumber: onNumberSelection } : {})}
          {...(onInsertDependentClaim ? { onDependentClaim: onInsertDependentClaim } : {})}
          onEditObject={(position) => {
            const node = editor.state.doc.nodeAt(position);
            if (!node) return;
            if (node.type.name === "chemicalStructure")
              openChemicalStructureEditor({
                nodeId: String(node.attrs.nodeId),
                ketSource: String(node.attrs.ketSource),
                position,
                editorMode:
                  node.attrs.editorMode === "macromolecule" ? "macromolecule" : "molecule",
              });
            else
              openFormulaEdit({
                position,
                latex: String(node.attrs.latex),
                mode: node.type.name === "inlineMath" ? "inline" : "block",
                kind: node.attrs.formulaKind === "chemistry" ? "chemistry" : "math",
              });
          }}
        />
      ) : null}
      {
        <MotionPresence>
          {editor && formulaRequest && capabilities.formulas ? (
            <FormulaDialog
              key={formulaRequest.generation ?? "new"}
              open={formulaDialogOpen}
              displayMode="modeless"
              positionKey={`${editorId}:formula`}
              initialLatex={formulaRequest.latex}
              initialMode={formulaRequest.mode}
              allowModeChange
              onCancel={() => {
                setFormulaDialogOpen(false);
                restoreFocusAfterDialogCancel();
              }}
              {...(onInsertFormulaDrawing
                ? {
                    onInsertToDrawings: (latex: string) =>
                      onInsertFormulaDrawing({ kind: "mathematical", latex }),
                    onReplaceToDrawings: (latex: string) =>
                      onInsertFormulaDrawing({ kind: "mathematical", latex, operation: "replace" }),
                  }
                : {})}
              onConfirm={({ latex, mode }) => {
                const target = formulaTarget.current;
                const position =
                  formulaRequest.position === undefined ? undefined : target?.position;
                if (
                  position === null ||
                  (formulaRequest.position !== undefined && position === undefined)
                )
                  return "原公式已被删除或修改，请关闭此窗口后重新选择公式。";
                const focusedCandidate =
                  position === undefined ? commandBus.getFocusedEditor() : null;
                const focused =
                  focusedCandidate &&
                  editorBelongsToSession(
                    focusedCandidate.editorId,
                    extensionSessionId ?? editorId,
                  ) &&
                  commandBus.getEditorCapabilities(focusedCandidate.editorId)?.formulas
                    ? focusedCandidate
                    : null;
                const targetEditor = (focused && commandBus.getEditor(focused.editorId)) || editor;
                const insertionFormat = commandBus.getFormatState(focused?.editorId ?? editorId);
                if (targetEditor.isDestroyed || !targetEditor.isEditable)
                  return "原文档已关闭或不可编辑，输入内容已保留。";
                if (position === undefined && focused) {
                  targetEditor.commands.setTextSelection(focused.bookmark);
                }
                if (
                  position === undefined &&
                  mode === "block" &&
                  isInsideStructuredContainer(targetEditor.state.selection.$from)
                ) {
                  return "表格或列表内请使用行内公式；独立公式请插入普通正文段落。";
                }
                const saved =
                  position === undefined
                    ? targetEditor
                        .chain()
                        .focus()
                        .insertContentAt(targetEditor.state.selection.from, {
                          type: mode === "inline" ? "inlineMath" : "blockMath",
                          attrs: {
                            latex,
                            fontSizePt: Math.min(72, Math.max(8, insertionFormat.fontSizePt ?? 14)),
                            ...(insertionFormat.color ? { color: insertionFormat.color } : {}),
                          },
                        })
                        .run()
                    : updateFormulaPosition(editor, position, mode, { latex });
                if (!saved) return "公式未能保存，输入内容已保留，请重试。";
                formulaTarget.current = null;
                setFormulaRequest(null);
                setFormulaDialogOpen(false);
              }}
            />
          ) : null}
        </MotionPresence>
      }
      {
        <MotionPresence>
          {editor && chemistryRequest && capabilities.chemistry ? (
            <ChemistryDialog
              open={chemistryDialogOpen}
              displayMode="modeless"
              positionKey={`${editorId}:chemistry`}
              sessionId={extensionSessionId ?? editorId}
              request={chemistryDialogRequest(chemistryRequest)}
              supportsStructures={supportsChemicalStructures}
              errorMessage={chemistryError}
              {...(saveState ? { saveState } : {})}
              {...(onRetrySave ? { onRetrySave } : {})}
              onKindChange={() => {
                const generation = nextChemistryRequestGeneration();
                setChemistryRequest((current) => (current ? { ...current, generation } : current));
              }}
              onCancel={() => {
                nextChemistryRequestGeneration();
                setChemistryError(null);
                setChemistryDialogOpen(false);
                restoreFocusAfterDialogCancel();
              }}
              {...(onInsertFormulaDrawing
                ? {
                    onInsertEquationToDrawings: (latex: string) =>
                      onInsertFormulaDrawing({ kind: "chemical-equation", latex }),
                    onReplaceEquationToDrawings: (latex: string) =>
                      onInsertFormulaDrawing({
                        kind: "chemical-equation",
                        latex,
                        operation: "replace",
                      }),
                    onReplaceStructureToDrawings: (drawing: ChemicalStructureDrawing) =>
                      onInsertFormulaDrawing({
                        kind: "chemical-structure",
                        ...drawing,
                        operation: "replace",
                      }),
                    onInsertStructureToDrawings: (drawing: ChemicalStructureDrawing) => {
                      return onInsertFormulaDrawing({
                        kind: "chemical-structure",
                        ...drawing,
                      });
                    },
                  }
                : {})}
              onConfirm={async (draft) => {
                const request = chemistryRequest;
                const isCurrent = () =>
                  mounted.current && chemicalRequestGeneration.current === request.generation;
                if (!isCurrent()) return;
                if (draft.kind === "equation") {
                  if (request.type === "structure") return;
                  const target = chemicalFormulaTarget.current;
                  if (request.type === "formula" && target?.position == null) {
                    setChemistryError(
                      "原化学方程式已被删除或修改，请关闭此窗口后重新选择。输入内容已保留。",
                    );
                    return;
                  }
                  const focusedCandidate =
                    request.type === "new" ? commandBus.getFocusedEditor() : null;
                  const focused =
                    focusedCandidate &&
                    editorBelongsToSession(
                      focusedCandidate.editorId,
                      extensionSessionId ?? editorId,
                    ) &&
                    commandBus.getEditorCapabilities(focusedCandidate.editorId)?.chemistry
                      ? focusedCandidate
                      : null;
                  const targetEditor =
                    (focused && commandBus.getEditor(focused.editorId)) || editor;
                  if (targetEditor.isDestroyed || !targetEditor.isEditable) {
                    setChemistryError("原文档已关闭或不可编辑，输入内容已保留。");
                    return;
                  }
                  const insertionFormat = commandBus.getFormatState(focused?.editorId ?? editorId);
                  if (focused) targetEditor.commands.setTextSelection(focused.bookmark);
                  if (
                    request.type === "new" &&
                    draft.mode === "block" &&
                    isInsideStructuredContainer(targetEditor.state.selection.$from)
                  ) {
                    setChemistryError(
                      "表格或列表内请使用行内方程式；独立方程式请插入普通正文段落。",
                    );
                    return;
                  }
                  const saved = insertChemicalEquation(
                    targetEditor,
                    draft,
                    request.type === "formula" && target?.position != null
                      ? { ...request.request, position: target.position }
                      : undefined,
                    {
                      fontSizePt: Math.min(72, Math.max(8, insertionFormat.fontSizePt ?? 14)),
                      ...(insertionFormat.color ? { color: insertionFormat.color } : {}),
                    },
                  );
                  if (!saved) {
                    setChemistryError("化学方程式未能保存，输入内容已保留，请重试。");
                    return;
                  }
                  if (!isCurrent()) return;
                  nextChemistryRequestGeneration();
                  setChemistryRequest(null);
                  setChemistryDialogOpen(false);
                  return;
                }
                if (!supportsChemicalStructures) {
                  setChemistryError(STRUCTURES_UNAVAILABLE_MESSAGE);
                  return;
                }
                const focusedCandidate =
                  request.type === "new" ? commandBus.getFocusedEditor() : null;
                const focused =
                  focusedCandidate &&
                  editorBelongsToSession(
                    focusedCandidate.editorId,
                    extensionSessionId ?? editorId,
                  ) &&
                  commandBus.getEditorCapabilities(focusedCandidate.editorId)?.chemicalStructures
                    ? focusedCandidate
                    : null;
                const targetEditor = (focused && commandBus.getEditor(focused.editorId)) || editor;
                if (focused) targetEditor.commands.setTextSelection(focused.bookmark);
                const targetAddAsset =
                  focused && focused.editorId !== editorId
                    ? (descriptor: AssetDescriptor) => {
                        commandBus.addAsset(focused.editorId, descriptor);
                      }
                    : addAsset;
                const result =
                  request.type === "structure"
                    ? await replaceChemicalStructureWithDraft({
                        editor: targetEditor,
                        request: request.request,
                        draft,
                        addAsset: targetAddAsset,
                        isCurrent,
                      })
                    : await insertChemicalStructureDraft({
                        editor: targetEditor,
                        draft,
                        addAsset: targetAddAsset,
                        isCurrent,
                      });
                if (!isCurrent()) return;
                if (!result.ok) {
                  showApplicationError(result.error);
                  throw new Error("structure import failed");
                }
                nextChemistryRequestGeneration();
                setChemistryError(null);
                setChemistryRequest(null);
                setChemistryDialogOpen(false);
              }}
            />
          ) : null}
        </MotionPresence>
      }
    </>
  );
}
