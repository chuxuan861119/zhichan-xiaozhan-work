import type { Editor, JSONContent } from "@tiptap/core";
import { closeHistory, isHistoryTransaction, redoDepth, undoDepth } from "@tiptap/pm/history";
import type { Fragment } from "@tiptap/pm/model";
import { AllSelection, NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import {
  defaultDocumentFont,
  defaultDocumentFontSizePt,
} from "../../../shared/document/font-policy";
import { effectiveParagraphFontSizePt } from "../../../shared/document/line-spacing";
import type { AssetDescriptor } from "../../../shared/document/model";
import { randomUuid } from "../../../shared/id";
import { type EditorCommand, runEditorCommand } from "../editor/commands";
import { canToggleFlatList } from "../editor/extensions/flat-list-commands";
import { isInsideStructuredContainer } from "../editor/extensions/patent-paragraph-rules";
import {
  EMPTY_FIGURE_SELECTION,
  type FigureSelectionSnapshot,
  inspectFigureSelection,
} from "../editor/nodes/figure-selection";
import { hasBracketTextSelection } from "../editor/number-brackets";
import { replaceDocumentContent } from "../editor/replace-document-content";
import type { RichTextEditorCapabilities } from "../editor/rich-text-editor-core";
import {
  insertPatentTable,
  runTableCommand as runTableEditorCommand,
  setSelectedCellAttribute,
  setSelectedCellBorders,
  setSelectedColumnWidth,
  setSelectedRowHeight,
  setTableAnnotation,
  setTableFormatting,
  splitSelectedTableCell,
  type TableBorderPreset,
  type TableCellAttribute,
  type TableCommand,
  type TableFormattingRequest,
  type TableInsertRequest,
  type TableRowHeightRequest,
} from "../editor/table/table-commands";
import {
  previewTableInsertion,
  type TableInsertionCommand,
} from "../editor/table/table-insertion-feedback";
import {
  EMPTY_TABLE_SELECTION,
  inspectTableSelection,
  type TableSelectionSnapshot,
} from "../editor/table/table-selection";
import type { TableSplitRequest } from "../editor/table/table-split";
import { preserveClickedLineEnd } from "../editor/visual-caret";
import {
  type ClaimEditorOperationResult,
  clearExtraFormatting,
  insertDependentClaimAtSelection,
} from "../patents/claims/claim-editor-operations";

const ALL_CAPABILITIES: RichTextEditorCapabilities = {
  headings: true,
  lists: true,
  tables: true,
  formulas: true,
  chemistry: true,
  images: true,
  pageBreaks: true,
};

export type EditorFormatState = {
  hasBracketTextSelection?: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  subscript: boolean;
  superscript: boolean;
  alignment: "left" | "center" | "right" | "justify";
  bulletList: boolean;
  orderedList: boolean;
  listToolsAvailable?: boolean;
  paragraphStyle: "paragraph" | 1 | 2 | 3;
  fontFamily?: string;
  fontSizePt?: number;
  mixedFontSize?: boolean;
  mixedFontFamily?: boolean;
  mixedParagraphStyle?: boolean;
  color?: string;
  highlightColor?: string;
};

export type EditorSelectionBookmark = {
  readonly from: number;
  readonly to: number;
};

export type EditorHistoryState = {
  canUndo: boolean;
  canRedo: boolean;
};

export type EditorFocusSnapshot = Readonly<{
  editorId: string;
  bookmark: EditorSelectionBookmark;
}>;

const DEFAULT_FORMAT_STATE: EditorFormatState = {
  bold: false,
  italic: false,
  underline: false,
  subscript: false,
  superscript: false,
  alignment: "left",
  bulletList: false,
  orderedList: false,
  paragraphStyle: "paragraph",
};

function formatStatesEqual(
  previous: EditorFormatState | undefined,
  next: EditorFormatState,
): boolean {
  return (
    previous !== undefined &&
    previous.hasBracketTextSelection === next.hasBracketTextSelection &&
    previous.bold === next.bold &&
    previous.italic === next.italic &&
    previous.underline === next.underline &&
    previous.subscript === next.subscript &&
    previous.superscript === next.superscript &&
    previous.alignment === next.alignment &&
    previous.bulletList === next.bulletList &&
    previous.orderedList === next.orderedList &&
    previous.listToolsAvailable === next.listToolsAvailable &&
    previous.paragraphStyle === next.paragraphStyle &&
    previous.fontFamily === next.fontFamily &&
    previous.fontSizePt === next.fontSizePt &&
    previous.mixedFontSize === next.mixedFontSize &&
    previous.mixedFontFamily === next.mixedFontFamily &&
    previous.mixedParagraphStyle === next.mixedParagraphStyle &&
    previous.color === next.color &&
    previous.highlightColor === next.highlightColor
  );
}

/** A font baseline changes only for whole paragraphs or empty insertion points. */
function setSelectedParagraphFont(
  tr: Transaction,
  attribute: "defaultFontFamily" | "defaultFontSizePt",
  value: string | number,
): void {
  const positions = new Set<number>();
  for (const range of tr.selection.ranges) {
    tr.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, position) => {
      if (
        (node.type.name === "paragraph" || node.type.name === "heading") &&
        range.$from.pos <= position + 1 &&
        range.$to.pos >= position + node.nodeSize - 1
      )
        positions.add(position);
    });
  }
  const { $from } = tr.selection;
  if (
    tr.selection.empty &&
    $from.parent.content.size === 0 &&
    ["paragraph", "heading"].includes($from.parent.type.name)
  )
    positions.add($from.before());
  for (const position of positions) {
    const node = tr.doc.nodeAt(position);
    if (node) tr.setNodeMarkup(position, undefined, { ...node.attrs, [attribute]: value });
  }
}

function selectedTextFormats(editor: Editor): Partial<EditorFormatState> {
  const { selection, doc } = editor.state;
  if (selection.empty || !selection.ranges?.length) return {};
  if (
    selection instanceof NodeSelection &&
    !["inlineMath", "blockMath"].includes(selection.node.type.name)
  )
    return {};
  const sizes = new Set<number>();
  const fonts = new Set<string>();
  const styles = new Set<string>();
  const addTextStyle = (
    attributes: Record<string, unknown>,
    blockAttributes: Record<string, unknown>,
  ) => {
    sizes.add(
      typeof attributes.fontSizePt === "number"
        ? attributes.fontSizePt
        : typeof blockAttributes.defaultFontSizePt === "number"
          ? blockAttributes.defaultFontSizePt
          : defaultDocumentFontSizePt(),
    );
    fonts.add(
      typeof attributes.fontFamily === "string"
        ? attributes.fontFamily
        : typeof blockAttributes.defaultFontFamily === "string"
          ? blockAttributes.defaultFontFamily
          : defaultDocumentFont(),
    );
  };
  for (const range of selection.ranges) {
    doc.nodesBetween(range.$from.pos, range.$to.pos, (node, _position, parent) => {
      if (node.isTextblock) {
        styles.add(node.type.name === "heading" ? `heading:${node.attrs.level}` : node.type.name);
        if (node.content.size === 0) addTextStyle({}, node.attrs);
      }
      if (node.isText)
        addTextStyle(
          node.marks.find((mark) => mark.type.name === "textStyle")?.attrs ?? {},
          parent?.attrs ?? {},
        );
      if (node.type.name === "inlineMath" || node.type.name === "blockMath") {
        const defaultSize = parent?.attrs.defaultFontSizePt ?? defaultDocumentFontSizePt();
        const textSizes: number[] = [];
        parent?.forEach((child) => {
          if (child.isText)
            textSizes.push(
              child.marks.find((mark) => mark.type.name === "textStyle")?.attrs.fontSizePt ??
                defaultSize,
            );
        });
        addTextStyle(
          node.attrs,
          node.type.name === "inlineMath"
            ? {
                ...parent?.attrs,
                defaultFontSizePt: effectiveParagraphFontSizePt(defaultSize, textSizes),
              }
            : {},
        );
      }
    });
  }
  return {
    ...(sizes.size > 1
      ? { mixedFontSize: true }
      : sizes.size === 1
        ? { fontSizePt: sizes.values().next().value as number }
        : {}),
    ...(fonts.size > 1
      ? { mixedFontFamily: true }
      : fonts.size === 1
        ? { fontFamily: fonts.values().next().value as string }
        : {}),
    ...(styles.size > 1 ? { mixedParagraphStyle: true } : {}),
  };
}

type RegisteredEditor = {
  editor: Editor;
  addAsset(descriptor: AssetDescriptor): void;
  openFormulaEditor(): void;
  openChemistryEditor(initialKind?: "equation" | "structure"): void;
  capabilities: RichTextEditorCapabilities;
};

type FormatStateSubscription = {
  sessionId: string;
  listener(state: EditorFormatState): void;
  editor: Editor | undefined;
  notify: (() => void) | undefined;
  lastPublishedState: EditorFormatState | undefined;
};

type TableSelectionSubscription = {
  sessionId: string;
  listener(state: TableSelectionSnapshot): void;
  editor: Editor | undefined;
  notify: (() => void) | undefined;
  lastPublished?: string;
};

type FigureSelectionSubscription = {
  sessionId: string;
  listener(state: FigureSelectionSnapshot): void;
  editor: Editor | undefined;
  notify: (() => void) | undefined;
  lastPublished?: string;
};

type HistoryStateSubscription = {
  sessionId: string;
  listener(state: EditorHistoryState): void;
  editor: Editor | undefined;
  notify: (() => void) | undefined;
  lastPublishedState: EditorHistoryState | undefined;
};

type EditorFocusBinding = {
  editor: Editor;
  listener: () => void;
};

type RetainedEditorSelection = Readonly<{
  documentJson: string;
  kind: "text" | "all";
  anchor: number;
  head: number;
}>;

type PatentHistoryAdapter = {
  execute(editorId: string, command: "undo" | "redo"): boolean | null;
  canExecute(editorId: string, command: "undo" | "redo"): boolean;
  onEdit(editorId: string): void;
};

export class EditorCommandBus {
  #patentHistoryAdapter: PatentHistoryAdapter | undefined;

  setPatentHistoryAdapter(adapter: PatentHistoryAdapter): () => void {
    this.#patentHistoryAdapter = adapter;
    this.publishHistoryState();
    return () => {
      if (this.#patentHistoryAdapter === adapter) this.#patentHistoryAdapter = undefined;
    };
  }

  publishHistoryState(): void {
    for (const subscriptions of this.#historySubscriptions.values()) {
      for (const subscription of subscriptions) this.#publishHistoryState(subscription);
    }
  }
  readonly #editors = new Map<string, RegisteredEditor>();
  readonly #editorListeners = new Set<(editorId: string, editor: Editor | null) => void>();
  readonly #focusListeners = new Set<(snapshot: EditorFocusSnapshot | null) => void>();
  readonly #formatSubscriptions = new Map<string, Set<FormatStateSubscription>>();
  readonly #figureSubscriptions = new Map<string, Set<FigureSelectionSubscription>>();
  readonly #tableSubscriptions = new Map<string, Set<TableSelectionSubscription>>();
  readonly #historySubscriptions = new Map<string, Set<HistoryStateSubscription>>();
  readonly #retainedSelections = new Map<string, RetainedEditorSelection>();
  readonly #retainedEditors = new Map<string, Editor>();
  readonly #focusBindings = new Map<string, EditorFocusBinding>();
  #focusedEditor: EditorFocusSnapshot | null = null;

  retainEditor(sessionId: string, create: () => Editor): Editor {
    const retained = this.#retainedEditors.get(sessionId);
    if (retained && !retained.isDestroyed) return retained;
    const editor = create();
    this.#retainedEditors.set(sessionId, editor);
    return editor;
  }

  disposeRetainedEditorsExcept(sessionIds: ReadonlySet<string>): number {
    let disposed = 0;
    for (const [sessionId, editor] of this.#retainedEditors) {
      if (sessionIds.has(sessionId)) continue;
      this.#retainedEditors.delete(sessionId);
      const registration = this.#editors.get(sessionId);
      if (registration?.editor === editor) {
        this.#detachFormatSubscriptions(sessionId);
        this.#detachFigureSubscriptions(sessionId);
        this.#detachTableSubscriptions(sessionId);
        this.#detachHistorySubscriptions(sessionId);
        this.#detachEditorFocus(sessionId);
        this.#editors.delete(sessionId);
        if (this.#focusedEditor?.editorId === sessionId) this.#setFocusedEditor(null);
        for (const listener of this.#editorListeners) listener(sessionId, null);
      }
      if (!editor.isDestroyed) editor.destroy();
      this.#retainedSelections.delete(sessionId);
      disposed += 1;
    }
    return disposed;
  }

  register(
    sessionId: string,
    editor: Editor,
    addAsset: (descriptor: AssetDescriptor) => void = () => undefined,
    openFormulaEditor: () => void = () => undefined,
    openChemistryEditor: (initialKind?: "equation" | "structure") => void = () => undefined,
    capabilities: RichTextEditorCapabilities = ALL_CAPABILITIES,
  ): () => void {
    const registration: RegisteredEditor = {
      editor,
      addAsset,
      openFormulaEditor,
      openChemistryEditor,
      capabilities,
    };
    this.#editors.set(sessionId, registration);
    const onUserEdit = ({ transaction }: { transaction: Transaction }) => {
      if (
        transaction?.docChanged &&
        !isHistoryTransaction(transaction) &&
        transaction.getMeta("addToHistory") !== false &&
        !transaction.getMeta("preventUpdate")
      ) {
        this.#patentHistoryAdapter?.onEdit(sessionId);
      }
    };
    editor.on("update", onUserEdit);
    const retainedSelection = this.#retainedSelections.get(sessionId);
    this.#retainedSelections.delete(sessionId);
    if (
      retainedSelection &&
      retainedSelection.documentJson === JSON.stringify(editor.state.doc.toJSON())
    ) {
      const selection =
        retainedSelection.kind === "all"
          ? new AllSelection(editor.state.doc)
          : TextSelection.create(
              editor.state.doc,
              retainedSelection.anchor,
              retainedSelection.head,
            );
      editor.view.dispatch(editor.state.tr.setSelection(selection));
    }
    for (const listener of this.#editorListeners) listener(sessionId, editor);
    this.#rebindFormatSubscriptions(sessionId, editor);
    this.#rebindFigureSubscriptions(sessionId, editor);
    this.#rebindTableSubscriptions(sessionId, editor);
    this.#rebindHistorySubscriptions(sessionId, editor);
    this.#bindEditorFocus(sessionId, editor);
    return () => {
      if (this.#editors.get(sessionId) !== registration) return;
      editor.off("update", onUserEdit);
      this.#detachFormatSubscriptions(sessionId);
      this.#detachFigureSubscriptions(sessionId);
      this.#detachTableSubscriptions(sessionId);
      this.#detachHistorySubscriptions(sessionId);
      this.#detachEditorFocus(sessionId);
      this.#editors.delete(sessionId);
      if (this.#focusedEditor?.editorId === sessionId) this.#setFocusedEditor(null);
      for (const listener of this.#editorListeners) listener(sessionId, null);
    };
  }

  retainSelectionForNextRegistration(sessionId: string): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed) return false;
    const { selection } = editor.state;
    if (
      selection.empty ||
      !(selection instanceof TextSelection || selection instanceof AllSelection)
    ) {
      this.#retainedSelections.delete(sessionId);
      return false;
    }
    this.#retainedSelections.set(sessionId, {
      documentJson: JSON.stringify(editor.state.doc.toJSON()),
      kind: selection instanceof AllSelection ? "all" : "text",
      anchor: selection.anchor,
      head: selection.head,
    });
    return true;
  }

  retainRegisteredSelectionsForNextRegistration(): number {
    let retainedCount = 0;
    for (const sessionId of this.#editors.keys()) {
      if (this.retainSelectionForNextRegistration(sessionId)) retainedCount += 1;
    }
    return retainedCount;
  }

  execute(sessionId: string, command: EditorCommand): boolean {
    if (command === "undo" || command === "redo") {
      const handled = this.#patentHistoryAdapter?.execute(sessionId, command);
      if (handled !== null && handled !== undefined) return handled;
    }
    const registration = this.#editors.get(sessionId);
    if (!registration) return false;
    if (
      ((command === "bullet-list" || command === "ordered-list") &&
        !registration.capabilities.lists) ||
      (command === "page-break" && !registration.capabilities.pageBreaks)
    ) {
      return false;
    }
    return runEditorCommand(registration.editor, command);
  }

  replaceDocumentWithHistory(sessionId: string, content: JSONContent): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed) return false;
    const nextDocument = editor.schema.nodeFromJSON(content);
    const transaction = replaceDocumentContent(editor.state.tr, nextDocument);
    if (!transaction.docChanged) return true;
    const previous = editor.state.doc;
    editor.view.dispatch(transaction);
    return !editor.state.doc.eq(previous);
  }

  focus(sessionId: string, options: { collapseSelection?: boolean } = {}): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed) return false;
    if (options.collapseSelection && !editor.state.selection.empty)
      editor.commands.setTextSelection(editor.state.selection.head);
    return editor.commands.focus(undefined, { scrollIntoView: false });
  }

  setSelectionFromCoordinates(
    sessionId: string,
    anchor: { x: number; y: number },
    head: { x: number; y: number },
  ): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed) return false;
    const bounds = editor.view.dom.getBoundingClientRect();
    const positionAt = ({ x, y }: { x: number; y: number }) =>
      editor.view.posAtCoords({
        left: Math.min(bounds.right - 1, Math.max(bounds.left + 1, x)),
        top: Math.min(bounds.bottom - 1, Math.max(bounds.top + 1, y)),
      })?.pos;
    const anchorPosition = positionAt(anchor);
    const headPosition = positionAt(head);
    if (anchorPosition === undefined || headPosition === undefined) return false;
    if (
      !editor.commands.setTextSelection({
        from: anchorPosition,
        to: headPosition,
      })
    )
      return false;
    // Resolve the native focus synchronously before restoring visual caret affinity.
    // A later focus command can otherwise put the same offset on the next line.
    editor.view.focus();
    if (anchorPosition === headPosition) preserveClickedLineEnd(editor.view, headPosition, head);
    return true;
  }

  selectVisualLinesFromCoordinates(sessionId: string, anchorY: number, headY: number): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed) return false;
    const bounds = editor.view.dom.getBoundingClientRect();
    const top = Math.min(anchorY, headY);
    const bottom = Math.max(anchorY, headY);
    const from = editor.view.posAtCoords({ left: bounds.left + 1, top })?.pos;
    const to = editor.view.posAtCoords({ left: bounds.right - 1, top: bottom })?.pos;
    if (from === undefined || to === undefined) return false;
    if (
      !editor.commands.setTextSelection({
        from: Math.min(from, to),
        to: Math.max(from, to),
      })
    )
      return false;
    return editor.commands.focus(undefined, { scrollIntoView: false });
  }

  selectParagraphFromCoordinates(sessionId: string, point: { x: number; y: number }): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed) return false;
    const bounds = editor.view.dom.getBoundingClientRect();
    const position = editor.view.posAtCoords({
      left: Math.min(bounds.right - 1, Math.max(bounds.left + 1, point.x)),
      top: Math.min(bounds.bottom - 1, Math.max(bounds.top + 1, point.y)),
    })?.pos;
    if (position === undefined) return false;
    const resolved = editor.state.doc.resolve(position);
    let depth = resolved.depth;
    while (depth > 0 && !resolved.node(depth).isTextblock) depth -= 1;
    if (!resolved.node(depth).isTextblock) return false;
    if (
      !editor.commands.setTextSelection({
        from: resolved.start(depth),
        to: resolved.end(depth),
      })
    )
      return false;
    return editor.commands.focus(undefined, { scrollIntoView: false });
  }

  selectAll(sessionId: string): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed || !editor.commands.selectAll()) return false;
    return editor.commands.focus(undefined, { scrollIntoView: false });
  }

  selectSentenceFromCoordinates(sessionId: string, point: { x: number; y: number }): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed) return false;
    const position = editor.view.posAtCoords({ left: point.x, top: point.y })?.pos;
    return position === undefined ? false : this.selectSentenceAtPosition(sessionId, position);
  }

  selectSentenceAtPosition(sessionId: string, position: number): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed) return false;
    const resolved = editor.state.doc.resolve(position);
    let depth = resolved.depth;
    while (depth > 0 && !resolved.node(depth).isTextblock) depth -= 1;
    const textblock = resolved.node(depth);
    if (!textblock.isTextblock) return false;
    const blockStart = resolved.start(depth);
    const offset = position - blockStart;
    const text = textblock.textBetween(0, textblock.content.size, "", "\uFFFC");
    const isSentenceEnd = (index: number) => {
      const character = text[index] ?? "";
      if (character !== ".") return "。！？!?".includes(character);
      return !/\d/u.test(text[index - 1] ?? "") || !/\d/u.test(text[index + 1] ?? "");
    };
    let fromOffset = 0;
    for (let index = Math.min(offset - 1, text.length - 1); index >= 0; index -= 1) {
      if (!isSentenceEnd(index)) continue;
      fromOffset = index + 1;
      break;
    }
    while (/\s/u.test(text[fromOffset] ?? "")) fromOffset += 1;
    let toOffset = text.length;
    for (let index = Math.max(0, offset); index < text.length; index += 1) {
      if (!isSentenceEnd(index)) continue;
      toOffset = index + 1;
      while (/[”’」』】）》）]/u.test(text[toOffset] ?? "")) toOffset += 1;
      break;
    }
    if (
      !editor.commands.setTextSelection({
        from: blockStart + fromOffset,
        to: blockStart + toOffset,
      })
    )
      return false;
    return editor.commands.focus(undefined, { scrollIntoView: false });
  }

  captureSelection(sessionId: string): EditorSelectionBookmark | null {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed) return null;
    const { from, to } = editor.state.selection;
    return { from, to };
  }

  publishEditorFocus(sessionId: string): boolean {
    const selection = this.captureSelection(sessionId);
    if (!selection) return false;
    this.#setFocusedEditor({ editorId: sessionId, bookmark: selection });
    return true;
  }

  setEditorFocus(sessionId: string): boolean {
    return this.publishEditorFocus(sessionId);
  }

  getFocusedEditor(): EditorFocusSnapshot | null {
    return this.#focusedEditor;
  }

  getEditorFocusSnapshot(): EditorFocusSnapshot | null {
    return this.#focusedEditor;
  }

  subscribeEditorFocus(listener: (snapshot: EditorFocusSnapshot | null) => void): () => void {
    this.#focusListeners.add(listener);
    listener(this.#focusedEditor);
    return () => this.#focusListeners.delete(listener);
  }

  restoreSelection(sessionId: string, bookmark: EditorSelectionBookmark | null): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed || !bookmark) return false;
    const maximum = editor.state.doc.content.size;
    const from = Math.min(maximum, Math.max(1, bookmark.from));
    const to = Math.min(maximum, Math.max(from, bookmark.to));
    if (!editor.commands.setTextSelection({ from, to })) return false;
    return editor.commands.focus(undefined, { scrollIntoView: false });
  }

  has(sessionId: string): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    return Boolean(editor && !editor.isDestroyed);
  }

  hasNonEmptyTextSelection(sessionId: string): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed) return false;
    const { selection } = editor.state;
    return (
      (selection instanceof TextSelection || selection instanceof AllSelection) && !selection.empty
    );
  }

  getFormatState(sessionId: string): EditorFormatState {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed) return { ...DEFAULT_FORMAT_STATE };

    const textStyle = editor.getAttributes("textStyle");
    const hasTextSelection = !editor.state.selection.empty;
    const paragraphStyle = ([1, 2, 3] as const).find((level) =>
      editor.isActive("heading", { level }),
    );
    // textAlign 是 TextAlign 扩展的全局属性而非 node/mark 类型，isActive 必须不带
    // type 名调用（isNodeActive(null, attrs) 匹配任意带该属性的块节点）。
    const alignment = ((): EditorFormatState["alignment"] => {
      const { selection } = editor.state;
      if (selection instanceof NodeSelection && selection.node.type.name === "blockMath") {
        const value = selection.node.attrs.alignment as unknown;
        return value === "center" || value === "right" ? value : "left";
      }
      const explicit = (["left", "center", "right", "justify"] as const).find((value) =>
        editor.isActive({ textAlign: value }),
      );
      // isActive inspects only from/to, which can represent just the head cell.
      if (explicit && (selection.ranges?.length ?? 0) <= 1) return explicit;
      // A paragraph without its own alignment inherits the cell's alignment.
      // Resolve each selected range separately so neighboring cells do not vote.
      const values = new Set<EditorFormatState["alignment"]>();
      for (const range of selection.ranges ?? []) {
        editor.state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, _pos, parent) => {
          if (!["paragraph", "heading"].includes(node.type.name)) return;
          const cellAlignment = parent?.attrs.horizontalAlignment;
          const inheritedAlignment =
            cellAlignment === "center" || cellAlignment === "right"
              ? cellAlignment
              : parent?.type.name === "tableHeader"
                ? "center"
                : "left";
          const value = node.attrs.textAlign ?? inheritedAlignment;
          values.add(
            value === "center" || value === "right" || value === "justify" ? value : "left",
          );
        });
      }
      return values.size === 1 ? ([...values][0] ?? "left") : "left";
    })();

    // 当文字没有显式字号标记时，回退到段落/标题的 defaultFontSizePt
    const paragraphAttrs = editor.getAttributes("paragraph");
    const headingAttrs = editor.getAttributes("heading");
    const selectedFormats = selectedTextFormats(editor);
    const blockDefaultFontSize =
      typeof paragraphAttrs.defaultFontSizePt === "number"
        ? paragraphAttrs.defaultFontSizePt
        : typeof headingAttrs.defaultFontSizePt === "number"
          ? headingAttrs.defaultFontSizePt
          : defaultDocumentFontSizePt();

    return {
      bold: hasTextSelection && editor.isActive("bold"),
      hasBracketTextSelection: editor.isEditable && hasBracketTextSelection(editor.state),
      italic: hasTextSelection && editor.isActive("italic"),
      underline: hasTextSelection && editor.isActive("underline"),
      subscript: editor.isActive("subscript"),
      superscript: editor.isActive("superscript"),
      alignment: alignment ?? "left",
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
      ...(editor.state.doc
        ? { listToolsAvailable: editor.isEditable && canToggleFlatList(editor.state) }
        : {}),
      paragraphStyle: paragraphStyle ?? "paragraph",
      ...(selectedFormats.mixedFontFamily
        ? {}
        : typeof textStyle.fontFamily === "string"
          ? { fontFamily: textStyle.fontFamily }
          : typeof paragraphAttrs.defaultFontFamily === "string"
            ? { fontFamily: paragraphAttrs.defaultFontFamily }
            : typeof headingAttrs.defaultFontFamily === "string"
              ? { fontFamily: headingAttrs.defaultFontFamily }
              : {}),
      ...(selectedFormats.mixedFontSize
        ? {}
        : typeof textStyle.fontSizePt === "number"
          ? { fontSizePt: textStyle.fontSizePt }
          : { fontSizePt: blockDefaultFontSize }),
      ...(editor.state.selection instanceof NodeSelection && editor.state.selection.node.attrs.color
        ? { color: editor.state.selection.node.attrs.color as string }
        : typeof textStyle.color === "string"
          ? { color: textStyle.color }
          : {}),
      ...(typeof textStyle.backgroundColor === "string"
        ? { highlightColor: textStyle.backgroundColor }
        : {}),
      ...selectedFormats,
    };
  }

  getPlainTextSelection(sessionId: string):
    | { ok: true; text: string }
    | {
        ok: false;
        code: "EDITOR_NOT_READY" | "EMPTY_SELECTION" | "INVALID_SELECTION";
        message: string;
      } {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor || editor.isDestroyed)
      return { ok: false, code: "EDITOR_NOT_READY", message: "编辑器尚未准备好。" };
    const { empty } = editor.state.selection;
    if (empty) return { ok: false, code: "EMPTY_SELECTION", message: "请先选择需要编号的关键词。" };
    // 遍历所选内容而非 textBetween：原子节点（公式、硬换行等）会被 textBetween
    // 当成空文本拼接，导致后续生成错误关键词；这里逐一检查并拒绝。
    // 三击整段等 TextSelection 覆盖整个段落节点边界时 openStart/openEnd 为 0，
    // 不能据此拒绝；只有块级原子对象的 NodeSelection 才应拒绝。
    if (editor.state.selection instanceof NodeSelection) {
      return {
        ok: false,
        code: "INVALID_SELECTION",
        message: "选择只能包含同一段内的连续普通文字。",
      };
    }
    const slice = editor.state.selection.content();
    let topLevelBlocks = 0;
    slice.content.forEach((node) => {
      if (node.isBlock) topLevelBlocks += 1;
    });
    if (topLevelBlocks > 1) {
      return {
        ok: false,
        code: "INVALID_SELECTION",
        message: "选择只能包含同一段内的连续普通文字。",
      };
    }
    let text = "";
    let invalidMessage: string | null = null;
    const visit = (fragment: Fragment) => {
      fragment.forEach((node) => {
        if (invalidMessage !== null) return;
        if (node.isText) {
          text += node.text ?? "";
          return;
        }
        if (node.type.name === "hardBreak") {
          invalidMessage = "选择不能包含硬换行。";
          return;
        }
        if (node.type.name === "inlineMath" || node.type.name === "blockMath") {
          invalidMessage = "选择不能跨越公式。";
          return;
        }
        if (node.isAtom) {
          invalidMessage = "选择只能包含同一段内的连续普通文字。";
          return;
        }
        visit(node.content);
      });
    };
    visit(slice.content);
    if (invalidMessage !== null)
      return { ok: false, code: "INVALID_SELECTION", message: invalidMessage };
    const trimmed = text.trim();
    if (!trimmed || trimmed.includes("\n"))
      return { ok: false, code: "INVALID_SELECTION", message: "关键词必须是同一段内的连续文字。" };
    return { ok: true, text: trimmed };
  }

  subscribeFormatState(
    sessionId: string,
    listener: (state: EditorFormatState) => void,
  ): () => void {
    const editor = this.#editors.get(sessionId)?.editor;
    const subscription: FormatStateSubscription = {
      sessionId,
      listener,
      editor: undefined,
      notify: undefined,
      lastPublishedState: undefined,
    };
    const subscriptions = this.#formatSubscriptions.get(sessionId) ?? new Set();
    subscriptions.add(subscription);
    this.#formatSubscriptions.set(sessionId, subscriptions);
    if (editor && !editor.isDestroyed) this.#bindFormatSubscription(subscription, editor);
    const unsubscribe = () => {
      this.#detachFormatSubscription(subscription);
      subscriptions.delete(subscription);
      if (subscriptions.size === 0 && this.#formatSubscriptions.get(sessionId) === subscriptions) {
        this.#formatSubscriptions.delete(sessionId);
      }
    };
    return unsubscribe;
  }

  getHistoryState(sessionId: string): EditorHistoryState {
    const editor = this.#editors.get(sessionId)?.editor;
    const native =
      editor && !editor.isDestroyed
        ? { canUndo: undoDepth(editor.state) > 0, canRedo: redoDepth(editor.state) > 0 }
        : { canUndo: false, canRedo: false };
    return {
      canUndo: native.canUndo || Boolean(this.#patentHistoryAdapter?.canExecute(sessionId, "undo")),
      canRedo: native.canRedo || Boolean(this.#patentHistoryAdapter?.canExecute(sessionId, "redo")),
    };
  }

  subscribeHistoryState(
    sessionId: string,
    listener: (state: EditorHistoryState) => void,
  ): () => void {
    const subscription: HistoryStateSubscription = {
      sessionId,
      listener,
      editor: undefined,
      notify: undefined,
      lastPublishedState: undefined,
    };
    const subscriptions = this.#historySubscriptions.get(sessionId) ?? new Set();
    subscriptions.add(subscription);
    this.#historySubscriptions.set(sessionId, subscriptions);
    const editor = this.#editors.get(sessionId)?.editor;
    if (editor && !editor.isDestroyed) this.#bindHistorySubscription(subscription, editor);
    return () => {
      this.#detachHistorySubscription(subscription);
      subscriptions.delete(subscription);
      if (subscriptions.size === 0 && this.#historySubscriptions.get(sessionId) === subscriptions) {
        this.#historySubscriptions.delete(sessionId);
      }
    };
  }

  setParagraphStyle(sessionId: string, style: "paragraph" | 1 | 2 | 3): boolean {
    const registration = this.#editors.get(sessionId);
    if (!registration || (style !== "paragraph" && !registration.capabilities.headings)) {
      return false;
    }
    const { editor } = registration;
    return style === "paragraph"
      ? editor.chain().focus().setParagraph().run()
      : editor.chain().focus().setHeading({ level: style }).run();
  }

  setFontFamily(sessionId: string, fontFamily: string): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor) return false;
    const applied = editor
      .chain()
      .focus()
      .command(({ tr }) => {
        closeHistory(tr);
        setSelectedParagraphFont(tr, "defaultFontFamily", fontFamily);
        return true;
      })
      .command(({ commands, tr }) => commands.setFontFamily(fontFamily) || tr.docChanged)
      .run();
    if (applied) editor.view.dispatch(closeHistory(editor.state.tr));
    return applied;
  }

  setFontSizePt(sessionId: string, fontSizePt: number): boolean {
    if (!Number.isFinite(fontSizePt) || fontSizePt < 8 || fontSizePt > 72) return false;
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor) return false;
    const formulaSelected =
      editor.state.selection instanceof NodeSelection &&
      ["inlineMath", "blockMath"].includes(editor.state.selection.node.type.name);
    const applied = editor
      .chain()
      .focus()
      .command(({ tr }) => {
        closeHistory(tr);
        const formulaPosition = formulaSelected ? tr.selection.from : null;
        for (const range of tr.selection.ranges) {
          tr.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, position) => {
            if (node.type.name === "inlineMath" || node.type.name === "blockMath")
              tr.setNodeMarkup(position, undefined, { ...node.attrs, fontSizePt });
          });
        }
        // Keep the paragraph strut in step with whole-paragraph formatting. Partial
        // selections retain the surrounding text's baseline and paragraph spacing.
        setSelectedParagraphFont(tr, "defaultFontSizePt", fontSizePt);
        if (formulaPosition != null) tr.setSelection(NodeSelection.create(tr.doc, formulaPosition));
        return true;
      })
      .command(
        ({ commands, tr }) =>
          formulaSelected || commands.setMark("textStyle", { fontSizePt }) || tr.docChanged,
      )
      .run();
    if (applied) editor.view.dispatch(closeHistory(editor.state.tr));
    return applied;
  }

  setColor(
    sessionId: string,
    color: string,
    preserveSelection = true,
    focusEditor = true,
  ): boolean {
    if (!/^#[0-9A-F]{6}$/u.test(color.toUpperCase())) return false;
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor) return false;
    const { head } = editor.state.selection;
    const chain = editor.chain();
    if (focusEditor) chain.focus();
    const formulaSelected =
      editor.state.selection instanceof NodeSelection &&
      ["inlineMath", "blockMath"].includes(editor.state.selection.node.type.name);
    chain.command(({ tr }) => {
      const position = formulaSelected ? tr.selection.from : null;
      for (const range of tr.selection.ranges) {
        tr.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
          if (node.type.name === "inlineMath" || node.type.name === "blockMath") {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, color: color.toUpperCase() });
          }
        });
      }
      if (position != null) tr.setSelection(NodeSelection.create(tr.doc, position));
      return true;
    });
    if (!formulaSelected) chain.setColor(color.toUpperCase());
    return (preserveSelection ? chain : chain.setTextSelection(head)).run();
  }

  setHighlightColor(
    sessionId: string,
    color: string | null,
    preserveSelection = false,
    focusEditor = true,
  ): boolean {
    const editor = this.#editors.get(sessionId)?.editor;
    if (!editor) return false;
    const { head } = editor.state.selection;
    if (color === null) {
      const chain = editor.chain();
      if (focusEditor) chain.focus();
      chain.unsetBackgroundColor();
      return (preserveSelection ? chain : chain.setTextSelection(head)).run();
    }
    if (!/^#[0-9A-F]{6}$/u.test(color.toUpperCase())) return false;
    const chain = editor.chain();
    if (focusEditor) chain.focus();
    chain.setBackgroundColor(color.toUpperCase());
    return (preserveSelection ? chain : chain.setTextSelection(head)).run();
  }

  insertFigure(sessionId: string, descriptor: AssetDescriptor): boolean {
    return this.insertFigures(sessionId, [descriptor]);
  }

  insertFigures(sessionId: string, descriptors: readonly AssetDescriptor[], widthMm = 80): boolean {
    const registration = this.#editors.get(sessionId);
    if (!registration?.capabilities.images || descriptors.length === 0) return false;
    const insertionPosition = registration.editor.state.selection.to;
    const inline = isInsideStructuredContainer(
      registration.editor.state.doc.resolve(insertionPosition),
    );
    const content: JSONContent[] = descriptors.map((descriptor) => ({
      type: inline ? "inlineFigure" : "figure",
      attrs: {
        nodeId: randomUuid(),
        assetId: descriptor.assetId,
        widthMm,
        alignment: "center",
        rotationDeg: 0,
        sourceAspectRatio: descriptor.widthPx / descriptor.heightPx,
        semanticRole: null,
      },
    }));
    if (
      !registration.editor
        .can()
        .chain()
        .setTextSelection(insertionPosition)
        .insertContent(content)
        .run()
    )
      return false;
    for (const descriptor of descriptors) registration.addAsset(descriptor);
    return registration.editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setTextSelection(insertionPosition)
      .insertContent(content)
      .run();
  }

  insertTable(sessionId: string, request: TableInsertRequest): boolean {
    const registration = this.#editors.get(sessionId);
    return registration?.capabilities.tables
      ? insertPatentTable(registration.editor, request)
      : false;
  }

  getTableSelection(sessionId: string): TableSelectionSnapshot {
    const editor = this.#editors.get(sessionId)?.editor;
    return editor && !editor.isDestroyed ? inspectTableSelection(editor) : EMPTY_TABLE_SELECTION;
  }

  getFigureSelection(sessionId: string): FigureSelectionSnapshot {
    const editor = this.#editors.get(sessionId)?.editor;
    return editor && !editor.isDestroyed ? inspectFigureSelection(editor) : EMPTY_FIGURE_SELECTION;
  }

  subscribeFigureSelection(
    sessionId: string,
    listener: (state: FigureSelectionSnapshot) => void,
  ): () => void {
    const subscription: FigureSelectionSubscription = {
      sessionId,
      listener,
      editor: undefined,
      notify: undefined,
    };
    const subscriptions = this.#figureSubscriptions.get(sessionId) ?? new Set();
    subscriptions.add(subscription);
    this.#figureSubscriptions.set(sessionId, subscriptions);
    const editor = this.#editors.get(sessionId)?.editor;
    if (editor && !editor.isDestroyed) this.#bindFigureSubscription(subscription, editor);
    return () => {
      this.#detachFigureSubscription(subscription);
      subscriptions.delete(subscription);
      if (subscriptions.size === 0 && this.#figureSubscriptions.get(sessionId) === subscriptions) {
        this.#figureSubscriptions.delete(sessionId);
      }
    };
  }

  subscribeTableSelection(
    sessionId: string,
    listener: (state: TableSelectionSnapshot) => void,
  ): () => void {
    const subscription: TableSelectionSubscription = {
      sessionId,
      listener,
      editor: undefined,
      notify: undefined,
    };
    const subscriptions = this.#tableSubscriptions.get(sessionId) ?? new Set();
    subscriptions.add(subscription);
    this.#tableSubscriptions.set(sessionId, subscriptions);
    const editor = this.#editors.get(sessionId)?.editor;
    if (editor && !editor.isDestroyed) this.#bindTableSubscription(subscription, editor);
    return () => {
      this.#detachTableSubscription(subscription);
      subscriptions.delete(subscription);
      if (subscriptions.size === 0 && this.#tableSubscriptions.get(sessionId) === subscriptions) {
        this.#tableSubscriptions.delete(sessionId);
      }
    };
  }

  previewTableInsertion(sessionId: string, command: TableInsertionCommand | null): void {
    const registration = this.#editors.get(sessionId);
    if (registration?.capabilities.tables) previewTableInsertion(registration.editor, command);
  }

  runTableCommand(sessionId: string, command: TableCommand): boolean {
    const registration = this.#editors.get(sessionId);
    return registration?.capabilities.tables
      ? runTableEditorCommand(registration.editor, command)
      : false;
  }

  setTableRowHeight(sessionId: string, request: TableRowHeightRequest): boolean {
    const registration = this.#editors.get(sessionId);
    return registration?.capabilities.tables && !registration.editor.isDestroyed
      ? setSelectedRowHeight(registration.editor, request)
      : false;
  }

  setTableFormatting(sessionId: string, request: TableFormattingRequest): boolean {
    const registration = this.#editors.get(sessionId);
    return registration?.capabilities.tables && !registration.editor.isDestroyed
      ? setTableFormatting(registration.editor, request)
      : false;
  }

  setTableAnnotation(
    sessionId: string,
    update: import("../../../shared/document/table-annotations").TableAnnotationUpdate,
  ): boolean {
    const registration = this.#editors.get(sessionId);
    return registration?.capabilities.tables && !registration.editor.isDestroyed
      ? setTableAnnotation(registration.editor, update)
      : false;
  }

  splitTableCell(sessionId: string, request: TableSplitRequest): boolean {
    const registration = this.#editors.get(sessionId);
    return registration?.capabilities.tables && !registration.editor.isDestroyed
      ? splitSelectedTableCell(registration.editor, request)
      : false;
  }

  setTableColumnWidth(sessionId: string, widthMm: number): boolean {
    const registration = this.#editors.get(sessionId);
    return registration?.capabilities.tables && !registration.editor.isDestroyed
      ? setSelectedColumnWidth(registration.editor, widthMm)
      : false;
  }

  setTableCellAttribute(sessionId: string, name: TableCellAttribute, value: string): boolean {
    const registration = this.#editors.get(sessionId);
    return registration?.capabilities.tables
      ? setSelectedCellAttribute(registration.editor, name, value)
      : false;
  }

  setTableCellBorders(
    sessionId: string,
    preset: TableBorderPreset,
    style: "single" | "double",
  ): boolean {
    const registration = this.#editors.get(sessionId);
    return registration?.capabilities.tables
      ? setSelectedCellBorders(registration.editor, preset, style)
      : false;
  }

  openFormulaEditor(sessionId: string): boolean {
    const registration = this.#editors.get(sessionId);
    if (!registration?.capabilities.formulas) return false;
    registration.openFormulaEditor();
    return true;
  }

  openChemistryEditor(
    sessionId: string,
    initialKind: "equation" | "structure" = "equation",
  ): boolean {
    const registration = this.#editors.get(sessionId);
    if (!registration?.capabilities.chemistry) return false;
    registration.openChemistryEditor(initialKind);
    return true;
  }

  getEditor(sessionId: string | null | undefined): Editor | null {
    return sessionId ? (this.#editors.get(sessionId)?.editor ?? null) : null;
  }

  addAsset(sessionId: string, descriptor: AssetDescriptor): boolean {
    const registration = this.#editors.get(sessionId);
    if (!registration) return false;
    registration.addAsset(descriptor);
    return true;
  }

  getEditorCapabilities(sessionId: string | null | undefined): RichTextEditorCapabilities | null {
    return sessionId ? (this.#editors.get(sessionId)?.capabilities ?? null) : null;
  }

  subscribeEditors(listener: (editorId: string, editor: Editor | null) => void): () => void {
    this.#editorListeners.add(listener);
    return () => this.#editorListeners.delete(listener);
  }

  #setFocusedEditor(snapshot: EditorFocusSnapshot | null): void {
    if (
      this.#focusedEditor?.editorId === snapshot?.editorId &&
      this.#focusedEditor?.bookmark.from === snapshot?.bookmark.from &&
      this.#focusedEditor?.bookmark.to === snapshot?.bookmark.to
    )
      return;
    this.#focusedEditor = snapshot;
    for (const listener of this.#focusListeners) listener(snapshot);
  }

  #bindEditorFocus(sessionId: string, editor: Editor): void {
    this.#detachEditorFocus(sessionId);
    if (typeof editor.on !== "function") return;
    const listener = () => this.publishEditorFocus(sessionId);
    editor.on("focus", listener);
    editor.on("selectionUpdate", listener);
    editor.on("transaction", listener);
    this.#focusBindings.set(sessionId, { editor, listener });
  }

  #detachEditorFocus(sessionId: string): void {
    const binding = this.#focusBindings.get(sessionId);
    if (!binding) return;
    if (typeof binding.editor.off !== "function") {
      this.#focusBindings.delete(sessionId);
      return;
    }
    binding.editor.off("focus", binding.listener);
    binding.editor.off("selectionUpdate", binding.listener);
    binding.editor.off("transaction", binding.listener);
    this.#focusBindings.delete(sessionId);
  }

  insertDependentClaim(sessionId: string): ClaimEditorOperationResult {
    const editor = this.#editors.get(sessionId)?.editor;
    return editor
      ? insertDependentClaimAtSelection(editor)
      : { ok: false, message: "权利要求编辑器尚未就绪，请稍后重试。" };
  }

  clearExtraFormatting(sessionId: string): ClaimEditorOperationResult {
    const editor = this.#editors.get(sessionId)?.editor;
    return editor
      ? clearExtraFormatting(editor)
      : { ok: false, message: "当前书册编辑器尚未就绪，请稍后重试。" };
  }

  #rebindFormatSubscriptions(sessionId: string, editor: Editor): void {
    for (const subscription of this.#formatSubscriptions.get(sessionId) ?? []) {
      this.#bindFormatSubscription(subscription, editor);
      this.#publishFormatState(subscription);
    }
  }

  #bindFormatSubscription(subscription: FormatStateSubscription, editor: Editor): void {
    this.#detachFormatSubscription(subscription);
    const notify = () => this.#publishFormatState(subscription);
    editor.on("selectionUpdate", notify);
    editor.on("transaction", notify);
    subscription.editor = editor;
    subscription.notify = notify;
  }

  #publishFormatState(subscription: FormatStateSubscription): void {
    const nextState = this.getFormatState(subscription.sessionId);
    if (formatStatesEqual(subscription.lastPublishedState, nextState)) return;
    subscription.lastPublishedState = nextState;
    subscription.listener(nextState);
  }

  #detachFormatSubscription(subscription: FormatStateSubscription): void {
    if (!subscription.editor || !subscription.notify) return;
    subscription.editor.off("selectionUpdate", subscription.notify);
    subscription.editor.off("transaction", subscription.notify);
    subscription.editor = undefined;
    subscription.notify = undefined;
  }

  #detachFormatSubscriptions(sessionId: string): void {
    for (const subscription of this.#formatSubscriptions.get(sessionId) ?? [])
      this.#detachFormatSubscription(subscription);
  }

  #rebindHistorySubscriptions(sessionId: string, editor: Editor): void {
    for (const subscription of this.#historySubscriptions.get(sessionId) ?? []) {
      this.#bindHistorySubscription(subscription, editor);
      this.#publishHistoryState(subscription);
    }
  }

  #bindHistorySubscription(subscription: HistoryStateSubscription, editor: Editor): void {
    this.#detachHistorySubscription(subscription);
    const notify = () => this.#publishHistoryState(subscription);
    editor.on("transaction", notify);
    subscription.editor = editor;
    subscription.notify = notify;
  }

  #publishHistoryState(subscription: HistoryStateSubscription): void {
    const nextState = this.getHistoryState(subscription.sessionId);
    const previous = subscription.lastPublishedState;
    if (
      previous &&
      previous.canUndo === nextState.canUndo &&
      previous.canRedo === nextState.canRedo
    ) {
      return;
    }
    subscription.lastPublishedState = nextState;
    subscription.listener(nextState);
  }

  #detachHistorySubscription(subscription: HistoryStateSubscription): void {
    if (!subscription.editor || !subscription.notify) return;
    subscription.editor.off("transaction", subscription.notify);
    subscription.editor = undefined;
    subscription.notify = undefined;
  }

  #detachHistorySubscriptions(sessionId: string): void {
    for (const subscription of this.#historySubscriptions.get(sessionId) ?? []) {
      this.#detachHistorySubscription(subscription);
    }
  }

  #rebindTableSubscriptions(sessionId: string, editor: Editor): void {
    for (const subscription of this.#tableSubscriptions.get(sessionId) ?? []) {
      this.#bindTableSubscription(subscription, editor);
      subscription.listener(this.getTableSelection(sessionId));
    }
  }

  #rebindFigureSubscriptions(sessionId: string, editor: Editor): void {
    for (const subscription of this.#figureSubscriptions.get(sessionId) ?? []) {
      this.#bindFigureSubscription(subscription, editor);
      subscription.listener(this.getFigureSelection(sessionId));
    }
  }

  #bindFigureSubscription(subscription: FigureSelectionSubscription, editor: Editor): void {
    this.#detachFigureSubscription(subscription);
    const notify = () => {
      const state = this.getFigureSelection(subscription.sessionId);
      const serialized = JSON.stringify(state);
      if (subscription.lastPublished === serialized) return;
      subscription.lastPublished = serialized;
      subscription.listener(state);
    };
    editor.on("selectionUpdate", notify);
    editor.on("transaction", notify);
    subscription.editor = editor;
    subscription.notify = notify;
  }

  #detachFigureSubscription(subscription: FigureSelectionSubscription): void {
    if (!subscription.editor || !subscription.notify) return;
    subscription.editor.off("selectionUpdate", subscription.notify);
    subscription.editor.off("transaction", subscription.notify);
    subscription.editor = undefined;
    subscription.notify = undefined;
  }

  #detachFigureSubscriptions(sessionId: string): void {
    for (const subscription of this.#figureSubscriptions.get(sessionId) ?? []) {
      this.#detachFigureSubscription(subscription);
    }
  }

  #bindTableSubscription(subscription: TableSelectionSubscription, editor: Editor): void {
    this.#detachTableSubscription(subscription);
    const notify = () => {
      const state = this.getTableSelection(subscription.sessionId);
      const serialized = JSON.stringify(state);
      if (subscription.lastPublished === serialized) return;
      subscription.lastPublished = serialized;
      subscription.listener(state);
    };
    editor.on("selectionUpdate", notify);
    editor.on("transaction", notify);
    subscription.editor = editor;
    subscription.notify = notify;
  }

  #detachTableSubscription(subscription: TableSelectionSubscription): void {
    if (!subscription.editor || !subscription.notify) return;
    subscription.editor.off("selectionUpdate", subscription.notify);
    subscription.editor.off("transaction", subscription.notify);
    subscription.editor = undefined;
    subscription.notify = undefined;
  }

  #detachTableSubscriptions(sessionId: string): void {
    for (const subscription of this.#tableSubscriptions.get(sessionId) ?? [])
      this.#detachTableSubscription(subscription);
  }
}
