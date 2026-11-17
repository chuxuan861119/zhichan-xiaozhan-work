import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowRightLeft,
  Atom,
  Bold,
  ChevronDown,
  CircuitBoard,
  DraftingCompass,
  FileDown,
  FilePlus2,
  FlaskConical,
  FolderOpen,
  ImagePlus,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  MoreHorizontal,
  Printer,
  Redo2,
  Save,
  Search,
  Sigma,
  SpellCheck,
  Subscript,
  Superscript,
  Table2,
  Underline,
  Undo2,
  Workflow,
} from "lucide-react";
import {
  Children,
  isValidElement,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { isNetworkAiAvailable } from "../../../../shared/platform";
import {
  defaultDocumentFontSizePt,
  displayDocumentFont,
  documentFontOptions,
} from "../../../../shared/document/font-policy";
import type { FlowchartEditorMode } from "../../../../shared/flowcharts/bridge";
import type { PatentWorkspaceTool } from "../../../../shared/patent/document-target";
import { fixedShortcutsFor, shortcutTooltip } from "../../../../shared/settings/shortcuts";
import type { EditorFormatState } from "../../app/command-bus";
import type { WorkspaceTabDragBindings } from "../../patents/patent-workspace-tab-drag";
import { showAppAlert } from "../../shared/app-dialog";
import { SpatialPresence } from "../../shared/spatial-presence";
import type { EditorCommand } from "../commands";
import type { RichTextEditorCapabilities } from "../rich-text-editor-core";
import { InsertTablePopover } from "../table/insert-table-popover";
import type { TableInsertRequest } from "../table/table-commands";
import { AlignmentPicker } from "./alignment-picker";
import { ColorPicker } from "./color-picker";
import { NumberBracketButton } from "./number-bracket-buttons";
import { ParagraphStylePicker } from "./paragraph-style-picker";
import { ToolbarSelectButton } from "./toolbar-select-button";
import { useToolbarOverflow } from "./use-toolbar-overflow";
import "./toolbar-dropdowns.css";

const FULL_CAPABILITIES: RichTextEditorCapabilities = {
  headings: true,
  lists: true,
  tables: true,
  formulas: true,
  chemistry: true,
  images: true,
  pageBreaks: true,
};

const FONT_SIZES = [10.5, 12, 14];
const NO_TEXT_EDITOR_MESSAGE = "当前页面不是文本编辑页面，无法使用此功能。";

function showUnavailableAction(message: string): void {
  showAppAlert(message);
}

function namedButtonShortcutTitle(label: string, unavailableReason?: string): string {
  return shortcutTooltip({
    label,
    shortcuts: fixedShortcutsFor(label),
    visibleLabel: true,
    unavailableReason,
  });
}

function preserveEditorFocus(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  if (event.target.closest("input, textarea, select, [contenteditable='true']")) return;
  event.preventDefault();
}

function ToolButton({
  label,
  shortcuts = [],
  children,
  onClick,
  disabled = false,
  disabledReason,
  pressed,
  className,
  onPointerDown,
}: {
  label: string;
  shortcuts?: readonly string[];
  children: ReactNode;
  onClick?(): void;
  disabled?: boolean;
  disabledReason?: string;
  pressed?: boolean;
  className?: string;
  onPointerDown?(event: ReactPointerEvent<HTMLButtonElement>): void;
}) {
  if (!isNetworkAiAvailable() && ["AI 纠错", "小栈AI助手"].includes(label)) return null;
  return (
    <button
      type="button"
      className={`tool-button${pressed ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled}
      onPointerDown={disabled ? undefined : onPointerDown}
      title={
        !disabled && ["本地检查", "AI 纠错", "小栈AI助手"].includes(label)
          ? undefined
          : shortcuts.length > 0
            ? shortcutTooltip({
                label,
                shortcuts,
                visibleLabel: false,
                unavailableReason: disabled
                  ? (disabledReason ?? `${label}当前不可用。`)
                  : undefined,
              })
            : disabled
              ? (disabledReason ?? label)
              : label
      }
      onClick={() => {
        if (disabled) {
          showUnavailableAction(disabledReason ?? `${label}当前不可用。`);
          return;
        }
        onClick?.();
      }}
    >
      {children}
    </button>
  );
}

function ToolbarImportMenu({
  onImportDocx,
  onImportPatdoc,
}: {
  onImportDocx(): void;
  onImportPatdoc(): void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target))
        setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <div className="toolbar-import-picker" ref={containerRef}>
      <button
        type="button"
        className="tool-button"
        aria-label="导入文件"
        title="导入文件"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <FolderOpen size={18} aria-hidden="true" />
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <SpatialPresence>
        {open ? (
          <div className="toolbar-import-menu" role="menu" aria-label="选择导入格式">
            <button type="button" role="menuitem" onClick={() => run(onImportDocx)}>
              导入 DOCX
            </button>
            <button type="button" role="menuitem" onClick={() => run(onImportPatdoc)}>
              导入 PATDOC
            </button>
          </div>
        ) : null}
      </SpatialPresence>
    </div>
  );
}

type ToolBarProps = {
  workspaceToolDrag?: { patentId: string; bindings: WorkspaceTabDragBindings } | undefined;
  auxiliaryDocumentActive?: boolean;
  libraryMode?: boolean;
  tutorialMode?: boolean;
  editorAvailable?: boolean;
  historyAvailable?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  historyUnavailableReason?: string;
  showTextEditingTools?: boolean;
  /**
   * 说明书附图这类没有正文排版的文档：文字工具不再整组隐藏，
   * 而是照样占位、统一置灰且点不动，让工具栏图标位置保持稳定。
   */
  textEditingToolsDisabled?: boolean;
  showDrawingInsertionTools?: boolean;
  /** 图片入口始终显示；此值仅控制当前书册是否允许插入。 */
  imageInsertionAvailable?: boolean;
  showNewDocumentButton?: boolean;
  onNewDocument(): void;
  onOpenDocument(): void;
  onImportDocx(): void;
  onSaveDocument(): void;
  onExportDocx(): void;
  onExportPdf(): void;
  onExportPatdoc?(): void;
  onPrint(): void;

  onInsertFlowchart(): void;
  onOpenDrawingMarkup?(): void;
  onInsertCircuitDiagram(): void;
  onCommand(command: EditorCommand): void;
  onParagraphStyle(style: "paragraph" | 1 | 2 | 3): void;
  onFontFamily(fontFamily: string): void;
  onFontSize(fontSizePt: number): void;
  onColor(color: string, preserveSelection?: boolean, focusEditor?: boolean): void;
  onHighlightColor?(color: string | null, preserveSelection?: boolean, focusEditor?: boolean): void;
  onInsertTable(request: TableInsertRequest): void;
  onInsertFormula(): void;
  onInsertImage?(): void;
  onInsertChemistry?(): void;
  onInsertChemicalStructure?(): void;
  onInsertPhysicsFormula?(): void;
  onFind(): void;
  findMode?: "find" | "replace" | null;
  activeAssistantPanel?: "本地检查" | "AI 纠错" | "小栈AI助手" | null;
  onReplace?(): void;
  onCheckProblems?(): void;
  onAiCorrection?(): void;
  onTextPolish?(): void;
  formatState: EditorFormatState;
  capabilities?: RichTextEditorCapabilities;
};

export function ToolBar({
  workspaceToolDrag,
  tutorialMode = false,
  auxiliaryDocumentActive = false,
  libraryMode = false,
  editorAvailable = true,
  historyAvailable = true,
  canUndo = true,
  canRedo = true,
  historyUnavailableReason = NO_TEXT_EDITOR_MESSAGE,
  showTextEditingTools = true,
  textEditingToolsDisabled = false,
  showDrawingInsertionTools = false,
  imageInsertionAvailable = false,
  showNewDocumentButton = true,
  onNewDocument,
  onOpenDocument,
  onImportDocx,
  onSaveDocument,
  onExportDocx,
  onExportPdf,
  onExportPatdoc = () => undefined,
  onPrint,

  onInsertFlowchart,
  onOpenDrawingMarkup = () => undefined,
  onInsertCircuitDiagram,
  onCommand,
  onParagraphStyle,
  onFontFamily,
  onFontSize,
  onColor,
  onHighlightColor = () => undefined,
  onInsertTable,
  onInsertFormula,
  onInsertImage = () => undefined,
  onInsertChemistry = () => undefined,
  onInsertChemicalStructure = () => undefined,
  onInsertPhysicsFormula = () => undefined,
  onFind,
  findMode = null,
  activeAssistantPanel = null,
  onReplace = () => undefined,
  onCheckProblems = () => undefined,
  onAiCorrection = () => undefined,
  onTextPolish = () => undefined,
  formatState,
  capabilities = FULL_CAPABILITIES,
}: ToolBarProps) {
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
  const toolEntryBindings = (
    label: string,
    tool: PatentWorkspaceTool,
    action: () => void,
    editorMode?: FlowchartEditorMode,
  ) => {
    const key = `toolbar-tool:${workspaceToolDrag?.patentId}:${editorMode ?? tool}`;
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (!workspaceToolDrag) return;
        workspaceToolDrag.bindings.start({
          source: {
            key,
            label,
            target: { patentId: workspaceToolDrag.patentId, kind: "tool", tool },
            toolLaunch: editorMode ? { editorMode } : {},
          },
          sourceElement: event.currentTarget,
          pointerId: event.pointerId,
          button: event.button,
          clientX: event.clientX,
          clientY: event.clientY,
        });
      },
      onClick: () => {
        if (workspaceToolDrag?.bindings.consumeClick(key)) {
          setMoreToolsOpen(false);
          return;
        }
        setMoreToolsOpen(false);
        action();
      },
    };
  };
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportPickerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // 文字工具是否占位显示：正常文本书册显示可用，附图类文档显示为置灰。
  const textToolsVisible = showTextEditingTools || textEditingToolsDisabled;
  const textToolsLocked = textEditingToolsDisabled || !editorAvailable;
  const listsLocked =
    textToolsLocked || !capabilities.lists || formatState.listToolsAvailable === false;
  const listsUnavailableReason = textToolsLocked
    ? NO_TEXT_EDITOR_MESSAGE
    : !capabilities.lists
      ? "当前书册不支持列表。"
      : "当前选区不支持列表。";
  const overflowLabels = useToolbarOverflow(toolbarRef, !libraryMode && textToolsVisible);
  const moreToolsButtonRef = useRef<HTMLButtonElement>(null);
  const moreToolsMenuRef = useRef<HTMLDivElement>(null);
  const [tablePopoverOpen, setTablePopoverOpen] = useState(false);
  const tablePopoverAnchorRef = useRef<HTMLElement | null>(null);
  const fonts = documentFontOptions();
  const fontFamily = formatState.mixedFontFamily ? "" : displayDocumentFont(formatState.fontFamily);
  const fontSize = formatState.mixedFontSize
    ? ""
    : String(formatState.fontSizePt ?? defaultDocumentFontSizePt());
  const imageInsertionLocked = !imageInsertionAvailable || !editorAvailable;
  const imageInsertionUnavailableReason = !editorAvailable
    ? NO_TEXT_EDITOR_MESSAGE
    : "当前书册不支持插入图片。";

  const runOverflowCommand = (command: EditorCommand) => {
    if (textToolsLocked) {
      showUnavailableAction(NO_TEXT_EDITOR_MESSAGE);
      return;
    }
    if ((command === "bullet-list" || command === "ordered-list") && listsLocked) {
      showUnavailableAction(listsUnavailableReason);
      return;
    }
    if (command === "page-break" && !capabilities.pageBreaks) {
      showUnavailableAction("当前书册不支持分页符。");
      return;
    }
    onCommand(command);
    setMoreToolsOpen(false);
  };

  const runSupportedAction = (supported: boolean, message: string, action: () => void) => {
    if (textToolsLocked) {
      showUnavailableAction(NO_TEXT_EDITOR_MESSAGE);
      return;
    }
    if (!supported) {
      showUnavailableAction(message);
      return;
    }
    action();
  };

  const runFormulaInsertionAction = (supported: boolean, message: string, action: () => void) => {
    if (showDrawingInsertionTools) action();
    else runSupportedAction(supported, message, action);
  };

  /**
   * 更多工具菜单里的一条动作是否不可用。
   * `textTool` 是纯文字排版动作（附图类文档里置灰）；其他动作按自身能力置灰。
   * 「插入图片」按书册分发（说明书附图里是导入附图），不能跟随文字工具置灰。
   */
  const overflowItemUnavailable = (item: { disabled?: boolean; textTool?: boolean }) =>
    item.textTool === true ? textToolsLocked : Boolean(item.disabled);

  useEffect(() => {
    if (!moreToolsOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node) {
        if (moreToolsButtonRef.current?.contains(target)) return;
        if (moreToolsMenuRef.current?.contains(target)) return;
      }
      setMoreToolsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"], [role="alertdialog"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setMoreToolsOpen(false);
      moreToolsButtonRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [moreToolsOpen]);

  useEffect(() => {
    if (!moreToolsOpen) return;
    const element = toolbarRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let previousWidth: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined) return;
      // The first callback fires on observe() with the current width. Only a later
      // change (e.g. the window being widened so the full toolbar fits) closes it.
      if (previousWidth !== null && width !== previousWidth) setMoreToolsOpen(false);
      previousWidth = width;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [moreToolsOpen]);

  const runExport = (exportAction: () => void) => {
    setExportMenuOpen(false);
    exportAction();
  };

  useEffect(() => {
    if (!exportMenuOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && exportPickerRef.current?.contains(event.target)) return;
      setExportMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
  }, [exportMenuOpen]);

  useEffect(() => {
    if (textToolsVisible) return;
    setMoreToolsOpen(false);
    setTablePopoverOpen(false);
  }, [textToolsVisible]);

  if (libraryMode) {
    return (
      <div
        className="tool-bar"
        ref={toolbarRef}
        role="toolbar"
        aria-label="常用工具"
        onPointerDown={preserveEditorFocus}
      >
        <div className="tool-group">
          {showNewDocumentButton && (
            <ToolButton label="新建" onClick={onNewDocument}>
              <FilePlus2 size={18} />
            </ToolButton>
          )}
          <ToolbarImportMenu onImportDocx={onImportDocx} onImportPatdoc={onOpenDocument} />
        </div>
        <div className="tool-separator" aria-hidden="true" />
        <div className="tool-group">
          <div className="toolbar-export-picker" ref={exportPickerRef}>
            <button
              type="button"
              className="tool-button"
              aria-label="导出"
              title="导出"
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              onClick={() => setExportMenuOpen((open) => !open)}
            >
              <FileDown size={18} />
            </button>
            <SpatialPresence>
              {exportMenuOpen ? (
                <div className="toolbar-export-menu" role="menu" aria-label="选择导出格式">
                  <button type="button" role="menuitem" onClick={() => runExport(onExportDocx)}>
                    {auxiliaryDocumentActive ? "导出当前文档（DOCX）" : "导出 DOCX"}
                  </button>
                  <button type="button" role="menuitem" onClick={() => runExport(onExportPdf)}>
                    {auxiliaryDocumentActive ? "导出当前文档（PDF）" : "导出 PDF"}
                  </button>
                  <button type="button" role="menuitem" onClick={() => runExport(onExportPatdoc)}>
                    {auxiliaryDocumentActive ? "导出整件专利（PATDOC）" : "导出 PATDOC"}
                  </button>
                </div>
              ) : null}
            </SpatialPresence>
          </div>
        </div>
      </div>
    );
  }

  const imageInsertionButton = (
    <ToolButton
      label="插入图片"
      disabled={imageInsertionLocked}
      disabledReason={imageInsertionUnavailableReason}
      onClick={onInsertImage}
    >
      <ImagePlus size={18} />
    </ToolButton>
  );

  return (
    <div
      className="tool-bar"
      data-compact={overflowLabels.length > 0}
      ref={toolbarRef}
      role="toolbar"
      aria-label="常用工具"
      onPointerDown={preserveEditorFocus}
    >
      {!tutorialMode && (
        <>
          <div className="tool-group">
            {showNewDocumentButton && (
              <ToolButton label="新建" onClick={onNewDocument}>
                <FilePlus2 size={18} />
              </ToolButton>
            )}
            <ToolbarImportMenu onImportDocx={onImportDocx} onImportPatdoc={onOpenDocument} />
            <ToolButton label="保存" onClick={onSaveDocument}>
              <Save size={18} />
            </ToolButton>
          </div>
          <div className="tool-separator" aria-hidden="true" />
          <div className="tool-group">
            <div className="toolbar-export-picker" ref={exportPickerRef}>
              <button
                type="button"
                className="tool-button"
                aria-label="导出"
                title="导出"
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
                onClick={() => setExportMenuOpen((open) => !open)}
              >
                <FileDown size={18} />
              </button>
              <SpatialPresence>
                {exportMenuOpen ? (
                  <div className="toolbar-export-menu" role="menu" aria-label="选择导出格式">
                    <button type="button" role="menuitem" onClick={() => runExport(onExportDocx)}>
                      {auxiliaryDocumentActive ? "导出当前文档（DOCX）" : "导出 DOCX"}
                    </button>
                    <button type="button" role="menuitem" onClick={() => runExport(onExportPdf)}>
                      {auxiliaryDocumentActive ? "导出当前文档（PDF）" : "导出 PDF"}
                    </button>
                    <button type="button" role="menuitem" onClick={() => runExport(onExportPatdoc)}>
                      {auxiliaryDocumentActive ? "导出整件专利（PATDOC）" : "导出 PATDOC"}
                    </button>
                  </div>
                ) : null}
              </SpatialPresence>
            </div>
            <ToolButton label="打印" onClick={onPrint}>
              <Printer size={18} />
            </ToolButton>
          </div>
          <div className="tool-separator" aria-hidden="true" />
        </>
      )}
      <div className="tool-group">
        <ToolButton
          label="撤销"
          shortcuts={fixedShortcutsFor("撤销")}
          disabled={!historyAvailable || !canUndo}
          disabledReason={!historyAvailable ? historyUnavailableReason : "当前没有可撤销的操作。"}
          onClick={() => onCommand("undo")}
        >
          <Undo2 size={18} />
        </ToolButton>
        <ToolButton
          label="重做"
          shortcuts={fixedShortcutsFor("重做")}
          disabled={!historyAvailable || !canRedo}
          disabledReason={!historyAvailable ? historyUnavailableReason : "当前没有可重做的操作。"}
          onClick={() => onCommand("redo")}
        >
          <Redo2 size={18} />
        </ToolButton>
      </div>
      <div className="tool-separator" aria-hidden="true" hidden={!textToolsVisible} />
      <div className="tool-group" hidden={!textToolsVisible}>
        <ParagraphStylePicker
          formatState={formatState}
          headings={capabilities.headings}
          disabled={textToolsLocked}
          onChange={onParagraphStyle}
        />
        <select
          className="font-select"
          aria-label="字体"
          aria-disabled={textToolsLocked}
          value={fontFamily}
          onChange={(event) =>
            runSupportedAction(true, NO_TEXT_EDITOR_MESSAGE, () => onFontFamily(event.target.value))
          }
        >
          <ToolbarSelectButton />
          {formatState.mixedFontFamily ? (
            <option value="" disabled hidden aria-label="混合字体" />
          ) : null}
          {fonts.map((font) => (
            <option key={font.value} value={font.value}>
              {font.label}
            </option>
          ))}
        </select>
        <select
          className="size-select"
          aria-label="字号"
          aria-disabled={textToolsLocked}
          value={fontSize}
          onChange={(event) =>
            runSupportedAction(true, NO_TEXT_EDITOR_MESSAGE, () =>
              onFontSize(Number(event.target.value)),
            )
          }
        >
          <ToolbarSelectButton />
          {formatState.mixedFontSize ? (
            <option value="" disabled hidden aria-label="混合字号" />
          ) : null}
          <option value="10.5">五号</option>
          <option value="12">小四</option>
          <option value="14">四号</option>
          {fontSize && !FONT_SIZES.includes(Number(fontSize)) ? (
            <option value={fontSize}>{fontSize} 磅</option>
          ) : null}
        </select>
      </div>
      <div className="tool-separator" aria-hidden="true" hidden={!textToolsVisible} />
      <div className="tool-group" hidden={!textToolsVisible}>
        <ToolButton
          label="粗体"
          shortcuts={fixedShortcutsFor("粗体")}
          disabled={textToolsLocked}
          disabledReason={NO_TEXT_EDITOR_MESSAGE}
          pressed={formatState.bold}
          onClick={() => onCommand("bold")}
        >
          <Bold size={18} />
        </ToolButton>
        <ToolButton
          label="斜体"
          shortcuts={fixedShortcutsFor("斜体")}
          disabled={textToolsLocked}
          disabledReason={NO_TEXT_EDITOR_MESSAGE}
          pressed={formatState.italic}
          onClick={() => onCommand("italic")}
        >
          <Italic size={18} />
        </ToolButton>
        <ToolButton
          label="下划线"
          shortcuts={fixedShortcutsFor("下划线")}
          disabled={textToolsLocked}
          disabledReason={NO_TEXT_EDITOR_MESSAGE}
          pressed={formatState.underline}
          onClick={() => onCommand("underline")}
        >
          <Underline size={18} />
        </ToolButton>
        <ColorPicker
          disabled={textToolsLocked}
          onUnavailable={() => showUnavailableAction(NO_TEXT_EDITOR_MESSAGE)}
          onSelect={onColor}
        />
        <ColorPicker
          kind="highlight"
          disabled={textToolsLocked}
          onUnavailable={() => showUnavailableAction(NO_TEXT_EDITOR_MESSAGE)}
          onSelect={onHighlightColor}
        />
      </div>
      <div
        className="tool-separator optional-tools"
        aria-hidden="true"
        hidden={!textToolsVisible}
      />
      <div className="tool-group optional-tools" hidden={!textToolsVisible}>
        <NumberBracketButton
          add
          enabled={!textToolsLocked && !!formatState.hasBracketTextSelection}
          onCommand={onCommand}
        />
        <NumberBracketButton
          add={false}
          enabled={!textToolsLocked && !!formatState.hasBracketTextSelection}
          onCommand={onCommand}
        />
        <ToolButton
          label="下标"
          shortcuts={fixedShortcutsFor("下标")}
          disabled={textToolsLocked}
          disabledReason={NO_TEXT_EDITOR_MESSAGE}
          pressed={formatState.subscript}
          onClick={() => onCommand("subscript")}
        >
          <Subscript size={18} />
        </ToolButton>
        <ToolButton
          label="上标"
          shortcuts={fixedShortcutsFor("上标")}
          disabled={textToolsLocked}
          disabledReason={NO_TEXT_EDITOR_MESSAGE}
          pressed={formatState.superscript}
          onClick={() => onCommand("superscript")}
        >
          <Superscript size={18} />
        </ToolButton>
        <AlignmentPicker
          alignment={formatState.alignment}
          disabled={textToolsLocked}
          onCommand={onCommand}
        />
        <ToolButton
          label="项目符号"
          shortcuts={fixedShortcutsFor("项目符号")}
          disabled={listsLocked}
          disabledReason={listsUnavailableReason}
          pressed={formatState.bulletList}
          onClick={() => onCommand("bullet-list")}
        >
          <List size={18} />
        </ToolButton>
        <ToolButton
          label="编号"
          shortcuts={fixedShortcutsFor("编号")}
          disabled={listsLocked}
          disabledReason={listsUnavailableReason}
          pressed={formatState.orderedList}
          onClick={() => onCommand("ordered-list")}
        >
          <ListOrdered size={18} />
        </ToolButton>
        <div className="tool-separator" aria-hidden="true" />
        <ToolButton
          label="插入表格"
          disabled={textToolsLocked || !capabilities.tables}
          disabledReason={textToolsLocked ? NO_TEXT_EDITOR_MESSAGE : "当前书册不支持表格。"}
          onClick={() => {
            tablePopoverAnchorRef.current =
              toolbarRef.current?.querySelector<HTMLElement>('button[aria-label="插入表格"]') ??
              null;
            setTablePopoverOpen((open) => !open);
          }}
        >
          <Table2 size={18} />
        </ToolButton>
        {textToolsVisible ? imageInsertionButton : null}
        <ToolButton
          label="查找"
          pressed={findMode === "find"}
          shortcuts={fixedShortcutsFor("查找")}
          disabled={textToolsLocked}
          disabledReason={NO_TEXT_EDITOR_MESSAGE}
          onClick={onFind}
        >
          <Search size={18} />
        </ToolButton>
        <ToolButton
          label="替换"
          pressed={findMode === "replace"}
          shortcuts={fixedShortcutsFor("替换")}
          disabled={textToolsLocked}
          disabledReason={NO_TEXT_EDITOR_MESSAGE}
          onClick={onReplace}
        >
          <ArrowRightLeft size={18} />
        </ToolButton>
        <div className="tool-separator" aria-hidden="true" />
        <ToolButton
          label="本地检查"
          pressed={activeAssistantPanel === "本地检查"}
          disabled={textToolsLocked}
          disabledReason={NO_TEXT_EDITOR_MESSAGE}
          onClick={onCheckProblems}
        >
          <ListChecks aria-hidden="true" className="quick-check-tool-icon" size={18} />
        </ToolButton>
        <ToolButton
          label="AI 纠错"
          pressed={activeAssistantPanel === "AI 纠错"}
          disabled={textToolsLocked}
          disabledReason={NO_TEXT_EDITOR_MESSAGE}
          onClick={onAiCorrection}
        >
          <SpellCheck aria-hidden="true" className="ai-correction-tool-icon" size={18} />
        </ToolButton>
        <ToolButton
          label="小栈AI助手"
          pressed={activeAssistantPanel === "小栈AI助手"}
          disabled={textToolsLocked}
          disabledReason={NO_TEXT_EDITOR_MESSAGE}
          onClick={onTextPolish}
        >
          <span aria-hidden="true" className="xiaozhan-ai-tool-icon">
            AI
          </span>
        </ToolButton>
      </div>
      <div className="tool-separator" aria-hidden="true" />
      <div className="diagram-entry-group">
        <ToolButton
          label="CAD标号"
          {...toolEntryBindings("CAD标号", "drawing-markup", onOpenDrawingMarkup)}
        >
          <DraftingCompass size={18} />
        </ToolButton>
        {!textToolsVisible ? imageInsertionButton : null}
        <ToolButton
          label="插入流程图"
          className="flowchart-tool-button"
          {...toolEntryBindings("插入流程图", "flowchart", onInsertFlowchart, "flowchart")}
        >
          <Workflow size={18} />
        </ToolButton>
        <ToolButton
          label="电路图"
          className="flowchart-tool-button circuit-tool-button"
          {...toolEntryBindings("电路图", "flowchart", onInsertCircuitDiagram, "circuit")}
        >
          <CircuitBoard size={18} />
        </ToolButton>
      </div>
      {/* 五书复用同一组入口，保持顺序和节点稳定，只切换可用状态及插入目标。 */}
      <div
        className="tool-separator optional-tools"
        aria-hidden="true"
        hidden={!textToolsVisible}
      />
      <div className="tool-group optional-tools" hidden={!textToolsVisible}>
        <ToolButton
          label="插入数学公式"
          disabled={!showDrawingInsertionTools && (textToolsLocked || !capabilities.formulas)}
          disabledReason={textToolsLocked ? NO_TEXT_EDITOR_MESSAGE : "当前书册不支持数学公式。"}
          onClick={onInsertFormula}
        >
          <Sigma size={18} />
        </ToolButton>
        <ToolButton
          label="插入化学方程式"
          disabled={!showDrawingInsertionTools && (textToolsLocked || !capabilities.chemistry)}
          disabledReason={textToolsLocked ? NO_TEXT_EDITOR_MESSAGE : "当前书册不支持化学方程式。"}
          onClick={onInsertChemistry}
        >
          <FlaskConical size={18} />
        </ToolButton>
        <ToolButton
          label="插入化学结构式"
          disabled={
            !showDrawingInsertionTools &&
            (textToolsLocked || capabilities.chemicalStructures === false)
          }
          disabledReason={textToolsLocked ? NO_TEXT_EDITOR_MESSAGE : "当前书册不支持化学结构式。"}
          onClick={onInsertChemicalStructure}
        >
          <span aria-hidden="true" className="chemical-structure-tool-icon">
            ⬡
          </span>
        </ToolButton>
        <ToolButton
          label="插入物理公式"
          disabled={!showDrawingInsertionTools && (textToolsLocked || !capabilities.formulas)}
          disabledReason={textToolsLocked ? NO_TEXT_EDITOR_MESSAGE : "当前书册不支持物理公式。"}
          onClick={onInsertPhysicsFormula}
        >
          <Atom size={18} />
        </ToolButton>
      </div>
      <button
        type="button"
        ref={moreToolsButtonRef}
        className="tool-button more-tools"
        hidden={!textToolsVisible}
        aria-label="更多工具"
        title="更多工具"
        aria-haspopup="menu"
        aria-expanded={moreToolsOpen}
        onClick={() => setMoreToolsOpen((open) => !open)}
      >
        <MoreHorizontal size={18} />
      </button>
      <SpatialPresence>
        {textToolsVisible && moreToolsOpen && overflowLabels.length > 0 ? (
          <div
            className="toolbar-overflow-menu"
            ref={moreToolsMenuRef}
            role="menu"
            aria-label="更多编辑工具"
          >
            <OverflowMenuItems
              labels={overflowLabels.flatMap((label) =>
                label === "段落对齐" ? ["左对齐", "居中", "右对齐", "两端对齐"] : [label],
              )}
            >
              <NumberBracketButton
                aria-label="数字加括号"
                add
                menu
                enabled={!textToolsLocked && !!formatState.hasBracketTextSelection}
                onCommand={runOverflowCommand}
              />
              <NumberBracketButton
                aria-label="数字去括号"
                add={false}
                menu
                enabled={!textToolsLocked && !!formatState.hasBracketTextSelection}
                onCommand={runOverflowCommand}
              />
              {[
                { label: "查找", action: onFind, icon: <Search size={17} />, textTool: true },
                {
                  label: "替换",
                  action: onReplace,
                  icon: <ArrowRightLeft size={17} />,
                  textTool: true,
                },
                {
                  label: "本地检查",
                  action: onCheckProblems,
                  icon: <ListChecks size={17} />,
                  textTool: true,
                },
                {
                  label: "AI 纠错",
                  action: onAiCorrection,
                  icon: <SpellCheck size={17} />,
                  textTool: true,
                },
                {
                  label: "小栈AI助手",
                  action: onTextPolish,
                  icon: (
                    <span aria-hidden="true" className="xiaozhan-ai-tool-icon">
                      AI
                    </span>
                  ),
                  textTool: true,
                },
                {
                  label: "插入图片",
                  action: onInsertImage,
                  icon: <ImagePlus size={17} />,
                  disabled: imageInsertionLocked,
                  disabledReason: imageInsertionUnavailableReason,
                },
              ]
                .filter(
                  (item) =>
                    isNetworkAiAvailable() || !["AI 纠错", "小栈AI助手"].includes(item.label),
                )
                .map((item) => (
                  <button
                    type="button"
                    key={item.label}
                    {...(item.label === "查找" || item.label === "替换"
                      ? {
                          role: "menuitemcheckbox",
                          "aria-checked": findMode === (item.label === "查找" ? "find" : "replace"),
                        }
                      : ["本地检查", "AI 纠错", "小栈AI助手"].includes(item.label)
                        ? {
                            role: "menuitemcheckbox",
                            "aria-checked": activeAssistantPanel === item.label,
                          }
                        : { role: "menuitem" })}
                    className={
                      (item.label === "查找" && findMode === "find") ||
                      (item.label === "替换" && findMode === "replace") ||
                      activeAssistantPanel === item.label
                        ? "is-active"
                        : undefined
                    }
                    aria-label={item.label}
                    aria-disabled={overflowItemUnavailable(item)}
                    onClick={() => {
                      if (overflowItemUnavailable(item)) {
                        showUnavailableAction(item.disabledReason ?? NO_TEXT_EDITOR_MESSAGE);
                        return;
                      }
                      setMoreToolsOpen(false);
                      item.action();
                    }}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-label="下标"
                className={formatState.subscript ? "is-active" : undefined}
                aria-checked={formatState.subscript}
                aria-disabled={textToolsLocked}
                title={namedButtonShortcutTitle(
                  "下标",
                  textToolsLocked ? NO_TEXT_EDITOR_MESSAGE : undefined,
                )}
                onClick={() => runOverflowCommand("subscript")}
              >
                <Subscript size={17} /> 下标
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-label="上标"
                className={formatState.superscript ? "is-active" : undefined}
                aria-checked={formatState.superscript}
                aria-disabled={textToolsLocked}
                title={namedButtonShortcutTitle(
                  "上标",
                  textToolsLocked ? NO_TEXT_EDITOR_MESSAGE : undefined,
                )}
                onClick={() => runOverflowCommand("superscript")}
              >
                <Superscript size={17} /> 上标
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-label="左对齐"
                className={formatState.alignment === "left" ? "is-active" : undefined}
                aria-checked={formatState.alignment === "left"}
                aria-disabled={textToolsLocked}
                title={namedButtonShortcutTitle(
                  "左对齐",
                  textToolsLocked ? NO_TEXT_EDITOR_MESSAGE : undefined,
                )}
                onClick={() => runOverflowCommand("align-left")}
              >
                <AlignLeft size={17} /> 左对齐
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-label="居中"
                className={formatState.alignment === "center" ? "is-active" : undefined}
                aria-checked={formatState.alignment === "center"}
                aria-disabled={textToolsLocked}
                title={namedButtonShortcutTitle(
                  "居中",
                  textToolsLocked ? NO_TEXT_EDITOR_MESSAGE : undefined,
                )}
                onClick={() => runOverflowCommand("align-center")}
              >
                <AlignCenter size={17} /> 居中
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-label="右对齐"
                className={formatState.alignment === "right" ? "is-active" : undefined}
                aria-checked={formatState.alignment === "right"}
                aria-disabled={textToolsLocked}
                title={namedButtonShortcutTitle(
                  "右对齐",
                  textToolsLocked ? NO_TEXT_EDITOR_MESSAGE : undefined,
                )}
                onClick={() => runOverflowCommand("align-right")}
              >
                <AlignRight size={17} /> 右对齐
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-label="两端对齐"
                className={formatState.alignment === "justify" ? "is-active" : undefined}
                aria-checked={formatState.alignment === "justify"}
                aria-disabled={textToolsLocked}
                title={namedButtonShortcutTitle(
                  "两端对齐",
                  textToolsLocked ? NO_TEXT_EDITOR_MESSAGE : undefined,
                )}
                onClick={() => runOverflowCommand("align-justify")}
              >
                <AlignJustify size={17} /> 两端对齐
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-label="项目符号"
                className={formatState.bulletList ? "is-active" : undefined}
                aria-checked={formatState.bulletList}
                aria-disabled={listsLocked}
                title={namedButtonShortcutTitle(
                  "项目符号",
                  listsLocked ? listsUnavailableReason : undefined,
                )}
                onClick={() => runOverflowCommand("bullet-list")}
              >
                <List size={17} /> 项目符号
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-label="编号"
                className={formatState.orderedList ? "is-active" : undefined}
                aria-checked={formatState.orderedList}
                aria-disabled={listsLocked}
                title={namedButtonShortcutTitle(
                  "编号",
                  listsLocked ? listsUnavailableReason : undefined,
                )}
                onClick={() => runOverflowCommand("ordered-list")}
              >
                <ListOrdered size={17} /> 编号
              </button>
              <button
                type="button"
                role="menuitem"
                aria-label="插入表格"
                aria-disabled={textToolsLocked || !capabilities.tables}
                title={capabilities.tables ? "插入表格" : "当前书册不支持表格。"}
                onClick={() =>
                  runSupportedAction(capabilities.tables, "当前书册不支持表格。", () => {
                    tablePopoverAnchorRef.current = moreToolsButtonRef.current;
                    setMoreToolsOpen(false);
                    setTablePopoverOpen(true);
                  })
                }
              >
                <Table2 size={17} /> 插入表格
              </button>
              <button
                type="button"
                role="menuitem"
                aria-label="插入数学公式"
                aria-disabled={
                  !showDrawingInsertionTools && (textToolsLocked || !capabilities.formulas)
                }
                title={
                  showDrawingInsertionTools || capabilities.formulas
                    ? "插入数学公式"
                    : "当前书册不支持数学公式。"
                }
                onClick={() =>
                  runFormulaInsertionAction(
                    capabilities.formulas,
                    "当前书册不支持数学公式。",
                    () => {
                      onInsertFormula();
                      setMoreToolsOpen(false);
                    },
                  )
                }
              >
                <Sigma size={17} /> 插入数学公式
              </button>
              <button
                type="button"
                role="menuitem"
                aria-label="插入化学方程式"
                aria-disabled={
                  !showDrawingInsertionTools && (textToolsLocked || !capabilities.chemistry)
                }
                title={
                  showDrawingInsertionTools || capabilities.chemistry
                    ? "插入化学方程式"
                    : "当前书册不支持化学方程式。"
                }
                onClick={() =>
                  runFormulaInsertionAction(
                    capabilities.chemistry,
                    "当前书册不支持化学方程式。",
                    () => {
                      onInsertChemistry();
                      setMoreToolsOpen(false);
                    },
                  )
                }
              >
                <FlaskConical size={17} /> 插入化学方程式
              </button>
              <button
                type="button"
                role="menuitem"
                aria-label="插入化学结构式"
                aria-disabled={
                  !showDrawingInsertionTools &&
                  (textToolsLocked || capabilities.chemicalStructures === false)
                }
                title={
                  showDrawingInsertionTools || capabilities.chemicalStructures !== false
                    ? "插入化学结构式"
                    : "当前书册不支持化学结构式。"
                }
                onClick={() =>
                  runFormulaInsertionAction(
                    capabilities.chemicalStructures !== false,
                    "当前书册不支持化学结构式。",
                    () => {
                      onInsertChemicalStructure();
                      setMoreToolsOpen(false);
                    },
                  )
                }
              >
                <span aria-hidden="true" className="chemical-structure-tool-icon">
                  ⬡
                </span>{" "}
                插入化学结构式
              </button>
              <button
                type="button"
                role="menuitem"
                aria-label="插入物理公式"
                aria-disabled={
                  !showDrawingInsertionTools && (textToolsLocked || !capabilities.formulas)
                }
                title={
                  showDrawingInsertionTools || capabilities.formulas
                    ? "插入物理公式"
                    : "当前书册不支持物理公式。"
                }
                onClick={() =>
                  runFormulaInsertionAction(
                    capabilities.formulas,
                    "当前书册不支持物理公式。",
                    () => {
                      onInsertPhysicsFormula();
                      setMoreToolsOpen(false);
                    },
                  )
                }
              >
                <Atom size={17} /> 插入物理公式
              </button>
              {[
                {
                  label: "插入流程图",
                  icon: <Workflow size={17} />,
                  bindings: toolEntryBindings(
                    "插入流程图",
                    "flowchart",
                    onInsertFlowchart,
                    "flowchart",
                  ),
                },
                {
                  label: "CAD标号",
                  icon: <DraftingCompass size={17} />,
                  bindings: toolEntryBindings("CAD标号", "drawing-markup", onOpenDrawingMarkup),
                },
                {
                  label: "电路图",
                  icon: <CircuitBoard size={17} />,
                  bindings: toolEntryBindings(
                    "电路图",
                    "flowchart",
                    onInsertCircuitDiagram,
                    "circuit",
                  ),
                },
              ]
                .filter(
                  (item) =>
                    isNetworkAiAvailable() || !["AI 纠错", "小栈AI助手"].includes(item.label),
                )
                .map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    aria-label={item.label}
                    {...item.bindings}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
            </OverflowMenuItems>
          </div>
        ) : null}
      </SpatialPresence>
      <InsertTablePopover
        open={textToolsVisible && tablePopoverOpen}
        anchor={tablePopoverAnchorRef.current}
        onClose={() => setTablePopoverOpen(false)}
        onConfirm={(request) => {
          onInsertTable(request);
          setTablePopoverOpen(false);
        }}
      />
    </div>
  );
}

function OverflowMenuItems({ labels, children }: { labels: string[]; children: ReactNode }) {
  const items = Children.toArray(children).filter(
    isValidElement<{ "aria-label"?: string; label?: string }>,
  );
  return labels.map((label) =>
    items.find((item) => (item.props["aria-label"] ?? item.props.label) === label),
  );
}
