import { HardDriveDownload, HelpCircle, Settings } from "lucide-react";
import {
  type CSSProperties,
  lazy,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { APPLICATION_NAME } from "../../../../shared/branding";
import { documentFontOptions } from "../../../../shared/document/font-policy";
import type { LegalDocument } from "../../../../shared/legal/policies";
import { OFFICIAL_WEBSITES, type OfficialWebsiteId } from "../../../../shared/official-websites";
import type { PatentBookKind } from "../../../../shared/patent/model";
import { isAgentCliAvailable, isNetworkAiAvailable } from "../../../../shared/platform";
import {
  type CustomDualViewPreset,
  customDualViewFullLabel,
  customDualViewShortcutId,
} from "../../../../shared/settings/custom-dual-view";
import { fixedShortcutsFor, shortcutTooltip } from "../../../../shared/settings/shortcuts";
import type { EditorFormatState } from "../../app/command-bus";
import { MotionPresence } from "../../app/motion-presence";
import { useConfiguredShortcut } from "../../app/shortcut-dispatcher";
import { LegalPolicyDialog } from "../../legal/legal-policy-dialog";
import { PatentSplitControls } from "../../patents/patent-split-controls";
import type { PatentWorkspacePair } from "../../patents/patent-workspace-layout";
import type {
  WorkspaceTabDragBindings,
  WorkspaceTabDragSource,
} from "../../patents/patent-workspace-tab-drag";
import { AboutDialog, ThirdPartyNoticesDialog } from "../../shared/about-dialog";
import { AiExperimentalEntry } from "../../shared/ai-experimental-notice";
import { showAppAlert } from "../../shared/app-dialog";
import { FeedbackDialog } from "../../shared/feedback-dialog";
import { isVisibleControl } from "../../shared/focusable-elements";
import { SpatialPresence } from "../../shared/spatial-presence";
import { UserGuideDialog } from "../../shared/user-guide-dialog";
import { openSoftwareUpdates } from "../../updates/use-software-updates";
import type { EditorCommand } from "../commands";
import type { RichTextEditorCapabilities } from "../rich-text-editor-core";
import type { TableInsertRequest } from "../table/table-commands";

const LegislationDialog = lazy(() =>
  import("../../legislation/legislation-dialog").then((module) => ({
    default: module.LegislationDialog,
  })),
);
type OpenMenu = "file" | "edit" | "insert" | "format" | "view" | "tools" | "help" | null;
type FormatSubmenu = "text" | "paragraph" | "page" | "websites" | null;

const DEFAULT_CAPABILITIES: RichTextEditorCapabilities = {
  headings: true,
  lists: true,
  tables: true,
  formulas: true,
  chemistry: true,
  images: true,
  pageBreaks: true,
};

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

const PATENT_BOOK_MENU_ITEMS: readonly { kind: PatentBookKind; label: string }[] = [
  { kind: "claims", label: "权利要求书" },
  { kind: "description", label: "说明书" },
  { kind: "abstract", label: "说明书摘要" },
  { kind: "description-drawings", label: "说明书附图" },
  { kind: "abstract-drawing", label: "摘要附图" },
];

const DEFAULT_TABLE_REQUEST: TableInsertRequest = {
  rows: 2,
  columns: 2,
  headerRowCount: 0,
  layoutMode: "fit-page",
};

function preserveEditorFocus(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  if (event.target.closest("input, textarea, select, [contenteditable='true']")) return;
  event.preventDefault();
}

type MenuItemProps = {
  label: string;
  onClick(): void;
  unavailableReason?: string | undefined;
  active?: boolean | undefined;
  shortcut?: string | null;
  prominent?: boolean;
};

function MenuItem({
  label,
  onClick,
  unavailableReason,
  active = false,
  shortcut,
  prominent,
}: MenuItemProps) {
  const unavailable = Boolean(unavailableReason);
  const fixedShortcuts = fixedShortcutsFor(label);
  const shortcutCapable = shortcut !== undefined || fixedShortcuts.length > 0;
  const shortcuts = shortcut === undefined ? fixedShortcuts : shortcut ? [shortcut] : [];
  return (
    <AiExperimentalEntry label={label}>
      <button
        type="button"
        role="menuitem"
        className={prominent ? "menu-item--feedback" : undefined}
        aria-label={label}
        aria-disabled={unavailable}
        title={
          shortcutCapable
            ? shortcutTooltip({
                label,
                shortcuts,
                visibleLabel: true,
                unavailableReason,
                binding: shortcut === undefined ? "fixed" : "custom",
              })
            : (unavailableReason ?? label)
        }
        data-active={active || undefined}
        onClick={() => {
          if (unavailable) {
            showAppAlert(unavailableReason ?? `${label}当前不可用。`);
            return;
          }
          onClick();
        }}
      >
        {prominent ? <span className="menu-item__animated-label">{label}</span> : label}
      </button>
    </AiExperimentalEntry>
  );
}

function MenuLabel({ children }: { children: ReactNode }) {
  return <span className="file-menu-label">{children}</span>;
}

function MenuSeparator() {
  return <div className="menu-separator" aria-hidden="true" />;
}

function MenuSubmenuTrigger({
  label,
  expanded,
  onClick,
  onPointerEnter,
  onPointerLeave,
}: {
  label: string;
  expanded: boolean;
  onClick(): void;
  onPointerEnter(): void;
  onPointerLeave(): void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="menu-submenu-trigger"
      aria-haspopup="menu"
      aria-expanded={expanded}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {label}
      <span aria-hidden="true">›</span>
    </button>
  );
}

type MenuBarProps = {
  tutorialMode?: boolean;
  libraryMode?: boolean;
  auxiliaryDocumentActive?: boolean;
  children?: ReactNode;

  drawingTab?:
    | Readonly<{
        active: boolean;
        patentId: string;
        onActivate(): void;
        onRequestClose(): void;
      }>
    | undefined;
  flowchartTab?:
    | Readonly<{
        active: boolean;
        patentId: string;
        onActivate(): void;
        onRequestClose(): void;
      }>
    | undefined;
  workspaceTabDrag?: WorkspaceTabDragBindings | undefined;
  editorAvailable?: boolean;
  historyAvailable?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  historyUnavailableReason?: string;
  showTextEditingTools?: boolean;
  capabilities?: RichTextEditorCapabilities;
  formatState?: EditorFormatState;
  activeBookKind?: PatentBookKind | null;
  availableBookKinds?: readonly PatentBookKind[];
  splitViewActive?: boolean;
  columnsActive?: boolean;
  onToggleColumns?(): void;
  onNewDocument(): void;
  onOpenDocument(): void;
  onImportDocx?(): void;
  onSaveDocument(): void;
  onSaveDocumentAs(): void;
  onExportDocx(): void;
  onExportPdf(): void;
  onPrint(): void;
  onFind(): void;
  onReplace(): void;
  onOpenPageMargins(): void;
  onOpenSettings?(): void;
  onOpenAgentCli?(): void;
  onCreateDesktopShortcut(): void;
  onOpenThirdPartyNotices?(): void;
  onOpenThirdPartyLicensesFolder?(): void;
  onOpenLibrary?(): void;
  onCloseCurrent?(): void;
  onOpenPatentSettings?(): void;
  onOpenSnapshotManager?(): void;
  onOpenBackupManager?(): void;
  onExitApplication?(): void;
  onInsertImage?(): void;
  onInsertDependentClaim?(): void;
  onCommand?(command: EditorCommand): void;
  onParagraphStyle?(style: "paragraph" | 1 | 2 | 3): void;
  onFontFamily?(fontFamily: string): void;
  onFontSize?(fontSizePt: number): void;
  onColor?(color: string): void;
  onHighlightColor?(color: string | null): void;
  onInsertTable?(request: TableInsertRequest): void;
  onInsertFormula?(): void;
  onInsertChemistry?(): void;
  onInsertChemicalStructure?(): void;
  onInsertPhysicsFormula?(): void;

  onInsertFlowchart?(): void;
  onOpenDrawingMarkup?(): void;
  onInsertCircuitDiagram?(): void;
  onActivateBook?(kind: PatentBookKind): void;
  onZoomIn?(): void;
  onZoomOut?(): void;
  onZoomReset?(): void;
  onCheckProblems?(): void;
  onAiCorrection?(): void;
  onTextPolish?(): void;
  onClearExtraFormatting?(): void;
  onToggleSplitView?(): void;
  onSelectSplitPair?(pair: PatentWorkspacePair): void;
  customDualViewPresets?: readonly CustomDualViewPreset[] | undefined;
  onOpenCustomDualView?: (() => void) | undefined;
  onSelectCustomDualViewPreset?: ((index: number) => void) | undefined;
};

export function MenuBar({
  tutorialMode = false,
  libraryMode = false,
  auxiliaryDocumentActive = false,
  children,

  flowchartTab,
  drawingTab,
  workspaceTabDrag,
  editorAvailable = true,
  historyAvailable = true,
  canUndo = true,
  canRedo = true,
  historyUnavailableReason = "当前页面不支持撤销和重做。",
  showTextEditingTools = true,
  capabilities = DEFAULT_CAPABILITIES,
  formatState = DEFAULT_FORMAT_STATE,
  activeBookKind = null,
  availableBookKinds = [],
  splitViewActive = false,
  columnsActive = false,
  onToggleColumns,
  onNewDocument,
  onOpenDocument,
  onImportDocx,
  onSaveDocument,
  onSaveDocumentAs,
  onExportDocx,
  onExportPdf,
  onPrint,
  onFind,
  onReplace,
  onOpenPageMargins,
  onOpenSettings = () => undefined,
  onOpenAgentCli,
  onCreateDesktopShortcut,
  onOpenThirdPartyNotices = () => undefined,
  onOpenThirdPartyLicensesFolder = () => undefined,
  onOpenLibrary = () => undefined,
  onCloseCurrent = () => undefined,
  onOpenPatentSettings = () => undefined,
  onOpenSnapshotManager = () => undefined,
  onOpenBackupManager = () => undefined,
  onExitApplication = () => undefined,
  onInsertImage = () => undefined,
  onInsertDependentClaim = () => undefined,
  onCommand = () => undefined,
  onParagraphStyle = () => undefined,
  onFontFamily = () => undefined,
  onFontSize = () => undefined,
  onColor = () => undefined,
  onHighlightColor = () => undefined,
  onInsertTable = () => undefined,
  onInsertFormula = () => undefined,
  onInsertChemistry = () => undefined,
  onInsertChemicalStructure = () => undefined,
  onInsertPhysicsFormula = () => undefined,

  onInsertFlowchart = () => undefined,
  onOpenDrawingMarkup = () => undefined,
  onInsertCircuitDiagram = () => undefined,
  onActivateBook = () => undefined,
  onZoomIn = () => undefined,
  onZoomOut = () => undefined,
  onZoomReset = () => undefined,
  onCheckProblems = () => undefined,
  onAiCorrection = () => undefined,
  onTextPolish = () => undefined,
  onClearExtraFormatting = () => undefined,
  onToggleSplitView,
  onSelectSplitPair,
  customDualViewPresets,
  onOpenCustomDualView,
  onSelectCustomDualViewPreset,
}: MenuBarProps) {
  const clearExtraFormattingShortcut = useConfiguredShortcut("clear-extra-formatting");
  const checkProblemsShortcut = useConfiguredShortcut("check-problems");
  const aiCorrectionShortcut = useConfiguredShortcut("ai-correction");
  const importDrawingImagesShortcut = useConfiguredShortcut("import-drawing-images");
  const dependentClaimShortcut = useConfiguredShortcut("insert-dependent-claim");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [legalDocument, setLegalDocument] = useState<LegalDocument | null>(null);
  const [legislationOpen, setLegislationOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [thirdPartyNoticesOpen, setThirdPartyNoticesOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const menuBarRef = useRef<HTMLElement>(null);
  const websiteMenuRef = useRef<HTMLDivElement>(null);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [openFormatSubmenu, setFormatSubmenu] = useState<FormatSubmenu>(null);
  const submenuHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelSubmenuHover = useCallback(() => {
    if (submenuHoverTimer.current !== null) clearTimeout(submenuHoverTimer.current);
    submenuHoverTimer.current = null;
  }, []);
  const setOpenFormatSubmenu = useCallback(
    (submenu: FormatSubmenu) => {
      cancelSubmenuHover();
      setFormatSubmenu(submenu);
    },
    [cancelSubmenuHover],
  );
  const hoverSubmenu = (submenu: FormatSubmenu) => {
    cancelSubmenuHover();
    if (submenu !== null && (!openFormatSubmenu || submenu === openFormatSubmenu)) {
      setOpenFormatSubmenu(submenu);
      return;
    }
    submenuHoverTimer.current = setTimeout(
      () => setOpenFormatSubmenu(submenu),
      submenu === null ? 350 : 250,
    );
  };
  useEffect(() => cancelSubmenuHover, [cancelSubmenuHover]);
  const textEditorReason = !showTextEditingTools
    ? "当前页面不是文本编辑页面，无法使用此功能。"
    : !editorAvailable
      ? "当前书册编辑器尚未准备好，请稍后重试。"
      : undefined;
  const textEditorUnavailable = (capability: keyof RichTextEditorCapabilities, message: string) =>
    textEditorReason ?? (capabilities[capability] ? undefined : message);
  const listUnavailableReason =
    textEditorUnavailable("lists", "当前书册不支持列表。") ??
    (formatState.listToolsAvailable === false ? "当前选区不支持列表。" : undefined);
  const specialWorkspaceActive = Boolean(flowchartTab?.active || drawingTab?.active);
  const drawingInsertionAvailable =
    !specialWorkspaceActive && activeBookKind === "description-drawings";
  const formulaUnavailable = (capability: keyof RichTextEditorCapabilities, message: string) =>
    drawingInsertionAvailable ? undefined : textEditorUnavailable(capability, message);
  const searchReason =
    textEditorReason ?? (specialWorkspaceActive ? "请先切换到文本书册。" : undefined);
  const splitReason =
    !activeBookKind || !onToggleSplitView || specialWorkspaceActive
      ? "请先切换到专利书册后使用同屏双显。"
      : undefined;
  const closeLabel = drawingTab?.active
    ? "关闭CAD标号"
    : flowchartTab?.active
      ? "关闭流程图"
      : "关闭当前专利";
  const historyReason = !editorAvailable
    ? "当前书册编辑器尚未准备好，请稍后重试。"
    : historyAvailable
      ? undefined
      : historyUnavailableReason;
  const undoReason = historyReason ?? (canUndo ? undefined : "当前没有可撤销的操作。");
  const redoReason = historyReason ?? (canRedo ? undefined : "当前没有可重做的操作。");
  const openWebsite = async (id: OfficialWebsiteId) => {
    try {
      const open = window.patentApi?.application.openOfficialWebsite;
      if (!open) throw new Error("unavailable");
      const result = await open(id);
      if (!result.ok) throw new Error(result.error.code);
    } catch {
      showAppAlert("无法打开官方网站，请检查系统默认浏览器设置后重试。");
    }
  };
  const run = (operation: () => void) => {
    setOpenMenu(null);
    setOpenFormatSubmenu(null);
    operation();
  };

  useEffect(() => {
    if (openMenu === null) return;
    const dismissOpenMenu = () => {
      setOpenMenu(null);
      setOpenFormatSubmenu(null);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const openMenuGroup = menuBarRef.current?.querySelector(`[data-menu-group="${openMenu}"]`);
      if (
        event.target instanceof Node &&
        (openMenuGroup?.contains(event.target) || websiteMenuRef.current?.contains(event.target))
      )
        return;
      const notice =
        event.target instanceof Element ? event.target.closest(".ai-experimental-popover") : null;
      if (
        notice &&
        [...(openMenuGroup?.querySelectorAll("[aria-controls]") ?? [])].some(
          (button) => button.getAttribute("aria-controls") === notice.id,
        )
      )
        return;
      dismissOpenMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      const root = menuBarRef.current;
      const group = root?.querySelector<HTMLElement>(`[data-menu-group="${openMenu}"]`);
      if (!root || !group) return;
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (focused?.closest('[role="dialog"], [role="alertdialog"]')) return;
      if (event.key === "Tab") {
        dismissOpenMenu();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (openFormatSubmenu) {
          setOpenFormatSubmenu(null);
          group.querySelector<HTMLElement>('[aria-expanded="true"][role="menuitem"]')?.focus();
        } else {
          dismissOpenMenu();
          group.querySelector<HTMLButtonElement>(":scope > button")?.focus();
        }
        return;
      }
      if (focused?.matches("input, textarea, select")) return;
      const menu =
        focused?.closest<HTMLElement>('[role="menu"]') ??
        group.querySelector<HTMLElement>('[role="menu"]');
      if (!menu) return;
      const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
        (item) => item.closest('[role="menu"]') === menu && isVisibleControl(item),
      );
      const index = focused ? items.indexOf(focused) : -1;
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length) {
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : index < 0
                ? event.key === "ArrowUp"
                  ? items.length - 1
                  : 0
                : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key === "Enter" && index >= 0) {
        event.preventDefault();
        focused?.click();
      } else if (event.key === "ArrowRight" && focused?.getAttribute("aria-haspopup") === "menu") {
        event.preventDefault();
        focused.click();
        requestAnimationFrame(() =>
          Array.from(
            group.dataset.menuGroup === "help" && websiteMenuRef.current
              ? websiteMenuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]')
              : group.querySelectorAll<HTMLElement>('.format-submenu [role="menuitem"]'),
          )
            .find(isVisibleControl)
            ?.focus(),
        );
      } else if (event.key === "ArrowLeft" && openFormatSubmenu) {
        event.preventDefault();
        setOpenFormatSubmenu(null);
        group.querySelector<HTMLElement>('[aria-expanded="true"][role="menuitem"]')?.focus();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const groups = [...root.querySelectorAll<HTMLElement>("[data-menu-group]")];
        const next =
          groups[
            (groups.indexOf(group) + (event.key === "ArrowLeft" ? -1 : 1) + groups.length) %
              groups.length
          ];
        setOpenFormatSubmenu(null);
        setOpenMenu(next?.dataset.menuGroup as OpenMenu);
        next?.querySelector<HTMLElement>(":scope > button")?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", dismissOpenMenu);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", dismissOpenMenu);
    };
  }, [openMenu, openFormatSubmenu, setOpenFormatSubmenu]);

  const toggleMenu = (menu: Exclude<OpenMenu, null>) => {
    setOpenFormatSubmenu(null);
    setOpenMenu((current) => (current === menu ? null : menu));
  };

  const nativeEdit = (command: "cut" | "copy" | "paste" | "selectAll") =>
    run(() => document.execCommand(command));

  const renderWebsitesMenu = (menu: ReactNode) =>
    libraryMode ? createPortal(menu, document.body) : menu;
  const helpDialogs = (
    <>
      <LegalPolicyDialog document={legalDocument} onClose={() => setLegalDocument(null)} />
      <MotionPresence>
        {aboutOpen ? (
          <AboutDialog
            onClose={() => setAboutOpen(false)}
            onOpen={(destination) => {
              setAboutOpen(false);
              if (destination === "terms" || destination === "privacy")
                setLegalDocument(destination);
              else if (destination === "feedback") setFeedbackOpen(true);
              else setThirdPartyNoticesOpen(true);
            }}
          />
        ) : null}
      </MotionPresence>
      <SpatialPresence>
        {feedbackOpen ? <FeedbackDialog onClose={() => setFeedbackOpen(false)} /> : null}
      </SpatialPresence>
      <MotionPresence>
        {legislationOpen ? (
          <Suspense fallback={<span role="status">正在加载法规阅读器…</span>}>
            <LegislationDialog onClose={() => setLegislationOpen(false)} />
          </Suspense>
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {guideOpen ? <UserGuideDialog onClose={() => setGuideOpen(false)} /> : null}
      </MotionPresence>
      <MotionPresence>
        {thirdPartyNoticesOpen ? (
          <ThirdPartyNoticesDialog
            onClose={() => setThirdPartyNoticesOpen(false)}
            onOpenNotices={onOpenThirdPartyNotices}
            onOpenLicensesFolder={onOpenThirdPartyLicensesFolder}
          />
        ) : null}
      </MotionPresence>
    </>
  );

  return (
    <nav
      ref={menuBarRef}
      className={libraryMode ? "menu-bar library-application-menu" : "menu-bar"}
      aria-label={libraryMode ? "专利库辅助功能" : "主菜单"}
      onPointerDown={preserveEditorFocus}
    >
      {!libraryMode && !tutorialMode ? (
        <>
          <div className="menu-bar__menu-group" data-menu-group="file">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "file"}
              onClick={() => toggleMenu("file")}
            >
              文件
            </button>
            {
              <SpatialPresence>
                {openMenu === "file" ? (
                  <div className="file-menu document-file-menu" role="menu" aria-label="文件">
                    <MenuItem label="新建专利" onClick={() => run(onNewDocument)} />
                    <MenuItem
                      label="导入 DOCX"
                      unavailableReason={onImportDocx ? undefined : "当前页面不支持导入 DOCX。"}
                      onClick={() => run(() => onImportDocx?.())}
                    />
                    <MenuItem label="导入 PATDOC" onClick={() => run(onOpenDocument)} />
                    <MenuItem label="打开专利库" onClick={() => run(onOpenLibrary)} />
                    <MenuSeparator />
                    <MenuItem label="保存" onClick={() => run(onSaveDocument)} />
                    <MenuItem label={closeLabel} onClick={() => run(onCloseCurrent)} />
                    <MenuItem
                      label="专利信息与设置"
                      unavailableReason={activeBookKind ? undefined : "请先打开或新建专利。"}
                      onClick={() => run(onOpenPatentSettings)}
                    />
                    <MenuSeparator />
                    <MenuItem
                      label={auxiliaryDocumentActive ? "导出整件专利（PATDOC）" : "导出 PATDOC"}
                      onClick={() => run(onSaveDocumentAs)}
                    />
                    <MenuItem
                      label={auxiliaryDocumentActive ? "导出当前文档（DOCX）" : "导出 DOCX"}
                      onClick={() => run(onExportDocx)}
                    />
                    <MenuItem
                      label={auxiliaryDocumentActive ? "导出当前文档（PDF）" : "导出 PDF"}
                      onClick={() => run(onExportPdf)}
                    />
                    <MenuSeparator />
                    <MenuItem
                      label="打印…"
                      shortcut={fixedShortcutsFor("打印")[0] ?? null}
                      onClick={() => run(onPrint)}
                    />
                    <MenuSeparator />
                    <MenuItem label="快照版本" onClick={() => run(onOpenSnapshotManager)} />
                    <MenuItem label="备份文件与恢复" onClick={() => run(onOpenBackupManager)} />
                    <MenuSeparator />
                    <MenuItem label="退出软件" onClick={() => run(onExitApplication)} />
                  </div>
                ) : null}
              </SpatialPresence>
            }
          </div>

          <div className="menu-bar__menu-group" data-menu-group="edit">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "edit"}
              onClick={() => toggleMenu("edit")}
            >
              编辑
            </button>
            {
              <SpatialPresence>
                {openMenu === "edit" ? (
                  <div className="file-menu edit-menu" role="menu" aria-label="编辑">
                    <MenuItem
                      label="撤销"
                      unavailableReason={undoReason}
                      onClick={() => run(() => onCommand("undo"))}
                    />
                    <MenuItem
                      label="重做"
                      unavailableReason={redoReason}
                      onClick={() => run(() => onCommand("redo"))}
                    />
                    <MenuSeparator />
                    <MenuItem label="剪切" onClick={() => nativeEdit("cut")} />
                    <MenuItem label="复制" onClick={() => nativeEdit("copy")} />
                    <MenuItem label="粘贴" onClick={() => nativeEdit("paste")} />
                    <MenuItem label="全选" onClick={() => nativeEdit("selectAll")} />
                    <MenuSeparator />
                    {(
                      [
                        ["数字加括号", "add-number-brackets"],
                        ["数字去括号", "remove-number-brackets"],
                      ] as const
                    ).map(([label, command]) => (
                      <MenuItem
                        key={command}
                        label={label}
                        unavailableReason={
                          textEditorReason ??
                          (!formatState.hasBracketTextSelection
                            ? "请先选择需要处理的文字。"
                            : undefined)
                        }
                        onClick={() => run(() => onCommand(command))}
                      />
                    ))}
                    <MenuSeparator />
                    <MenuItem
                      label="查找"
                      unavailableReason={searchReason}
                      onClick={() => run(onFind)}
                    />
                    <MenuItem
                      label="替换"
                      unavailableReason={searchReason}
                      onClick={() => run(onReplace)}
                    />
                  </div>
                ) : null}
              </SpatialPresence>
            }
          </div>

          <div className="menu-bar__menu-group" data-menu-group="insert">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "insert"}
              onClick={() => toggleMenu("insert")}
            >
              插入
            </button>
            {
              <SpatialPresence>
                {openMenu === "insert" ? (
                  <div className="file-menu insert-menu" role="menu" aria-label="插入">
                    <MenuLabel>文档内容</MenuLabel>
                    <MenuItem
                      label="从属权利要求"
                      shortcut={dependentClaimShortcut}
                      unavailableReason={
                        textEditorReason ??
                        (activeBookKind === "claims" ? undefined : "请先切换到权利要求书。")
                      }
                      onClick={() => run(onInsertDependentClaim)}
                    />
                    <MenuItem
                      label="插入表格"
                      unavailableReason={textEditorUnavailable("tables", "当前书册不支持表格。")}
                      onClick={() => run(() => onInsertTable(DEFAULT_TABLE_REQUEST))}
                    />
                    <MenuSeparator />
                    <MenuItem
                      label="分页符"
                      unavailableReason={textEditorUnavailable(
                        "pageBreaks",
                        "当前书册不支持手动分页。",
                      )}
                      onClick={() => run(() => onCommand("page-break"))}
                    />
                    <MenuSeparator />
                    <MenuLabel>公式</MenuLabel>
                    <MenuItem
                      label="插入数学公式"
                      unavailableReason={formulaUnavailable("formulas", "当前书册不支持数学公式。")}
                      onClick={() => run(onInsertFormula)}
                    />
                    <MenuItem
                      label="插入物理公式"
                      unavailableReason={formulaUnavailable("formulas", "当前书册不支持物理公式。")}
                      onClick={() => run(onInsertPhysicsFormula)}
                    />
                    <MenuItem
                      label="插入化学方程式"
                      unavailableReason={formulaUnavailable(
                        "chemistry",
                        "当前书册不支持化学方程式。",
                      )}
                      onClick={() => run(onInsertChemistry)}
                    />
                    <MenuItem
                      label="插入化学结构式"
                      unavailableReason={formulaUnavailable(
                        "chemicalStructures",
                        "当前书册不支持化学结构式。",
                      )}
                      onClick={() => run(onInsertChemicalStructure)}
                    />
                    <MenuSeparator />
                    <MenuLabel>图形与附图</MenuLabel>
                    <MenuItem
                      label={drawingInsertionAvailable ? "导入说明书附图" : "插入图片"}
                      shortcut={drawingInsertionAvailable ? importDrawingImagesShortcut : null}
                      unavailableReason={
                        drawingInsertionAvailable
                          ? undefined
                          : (textEditorReason ??
                            (activeBookKind === "claims" || activeBookKind === "description"
                              ? undefined
                              : "请切换到权利要求书、说明书或说明书附图。"))
                      }
                      onClick={() => run(onInsertImage)}
                    />
                    <MenuItem
                      label="插入流程图"
                      unavailableReason={
                        activeBookKind ? undefined : "请先打开或新建专利后再插入流程图。"
                      }
                      onClick={() => run(onInsertFlowchart)}
                    />
                    <MenuItem
                      label="CAD标号"
                      unavailableReason={activeBookKind ? undefined : "请先打开或新建专利。"}
                      onClick={() => run(onOpenDrawingMarkup)}
                    />
                    <MenuItem
                      label="插入电路图"
                      unavailableReason={
                        activeBookKind ? undefined : "请先打开或新建专利后再插入电路图。"
                      }
                      onClick={() => run(onInsertCircuitDiagram)}
                    />
                  </div>
                ) : null}
              </SpatialPresence>
            }
          </div>

          <div className="menu-bar__menu-group" data-menu-group="format">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "format"}
              onClick={() => toggleMenu("format")}
            >
              格式
            </button>
            {
              <SpatialPresence>
                {openMenu === "format" ? (
                  <div
                    className="file-menu format-menu"
                    role="menu"
                    aria-label="格式"
                    onPointerLeave={() => hoverSubmenu(null)}
                  >
                    <div
                      className="format-menu__branch"
                      data-expanded={openFormatSubmenu === "text"}
                      onPointerLeave={() => hoverSubmenu(null)}
                    >
                      <MenuSubmenuTrigger
                        label="文字"
                        expanded={openFormatSubmenu === "text"}
                        onClick={() => setOpenFormatSubmenu("text")}
                        onPointerEnter={() => hoverSubmenu("text")}
                        onPointerLeave={cancelSubmenuHover}
                      />

                      {
                        <SpatialPresence>
                          {openFormatSubmenu === "text" ? (
                            <div
                              className="file-menu format-submenu"
                              onPointerEnter={cancelSubmenuHover}
                              role="menu"
                              aria-label="文字格式"
                            >
                              <MenuLabel>字体与字号</MenuLabel>
                              {documentFontOptions().map((font) => (
                                <MenuItem
                                  key={font.value}
                                  label={font.label}
                                  unavailableReason={textEditorReason}
                                  onClick={() => run(() => onFontFamily(font.value))}
                                />
                              ))}
                              {(
                                [
                                  ["五号", 10.5],
                                  ["小四", 12],
                                  ["四号", 14],
                                ] as const
                              ).map(([label, size]) => (
                                <MenuItem
                                  key={label}
                                  label={label}
                                  active={formatState.fontSizePt === size}
                                  unavailableReason={textEditorReason}
                                  onClick={() => run(() => onFontSize(size))}
                                />
                              ))}
                              <MenuSeparator />
                              <MenuLabel>文字效果</MenuLabel>
                              {(
                                [
                                  ["粗体", "bold", formatState.bold],
                                  ["斜体", "italic", formatState.italic],
                                  ["下划线", "underline", formatState.underline],
                                  ["下标", "subscript", formatState.subscript],
                                  ["上标", "superscript", formatState.superscript],
                                ] as const
                              ).map(([label, command, active]) => (
                                <MenuItem
                                  key={label}
                                  label={label}
                                  active={active}
                                  unavailableReason={textEditorReason}
                                  onClick={() => run(() => onCommand(command))}
                                />
                              ))}
                              <label className="menu-color-picker">
                                文字颜色
                                <input
                                  type="color"
                                  aria-label="文字颜色"
                                  value={formatState.color ?? "#000000"}
                                  disabled={Boolean(textEditorReason)}
                                  onChange={(event) => onColor(event.target.value)}
                                />
                              </label>
                              <label className="menu-color-picker">
                                突出显示颜色
                                <input
                                  type="color"
                                  aria-label="突出显示颜色"
                                  value={formatState.highlightColor ?? "#FFFF00"}
                                  disabled={Boolean(textEditorReason)}
                                  onChange={(event) => onHighlightColor(event.target.value)}
                                />
                              </label>
                              <MenuSeparator />
                              <MenuItem
                                label="取消突出显示"
                                unavailableReason={textEditorReason}
                                onClick={() => run(() => onHighlightColor(null))}
                              />
                            </div>
                          ) : null}
                        </SpatialPresence>
                      }
                    </div>
                    <div
                      className="format-menu__branch"
                      data-expanded={openFormatSubmenu === "paragraph"}
                      onPointerLeave={() => hoverSubmenu(null)}
                    >
                      <MenuSubmenuTrigger
                        label="段落"
                        expanded={openFormatSubmenu === "paragraph"}
                        onClick={() => setOpenFormatSubmenu("paragraph")}
                        onPointerEnter={() => hoverSubmenu("paragraph")}
                        onPointerLeave={cancelSubmenuHover}
                      />
                      {
                        <SpatialPresence>
                          {openFormatSubmenu === "paragraph" ? (
                            <div
                              className="file-menu format-submenu"
                              onPointerEnter={cancelSubmenuHover}
                              role="menu"
                              aria-label="段落格式"
                            >
                              <MenuLabel>段落样式</MenuLabel>
                              {(
                                [
                                  ["正文", "paragraph"],
                                  ...(capabilities.headings
                                    ? ([
                                        ["章节标题", 1],
                                        ["标题 2", 2],
                                        ["标题 3", 3],
                                      ] as const)
                                    : []),
                                ] as const
                              ).map(([label, style]) => (
                                <MenuItem
                                  key={label}
                                  label={label}
                                  active={
                                    !formatState.mixedParagraphStyle &&
                                    formatState.paragraphStyle === style
                                  }
                                  unavailableReason={
                                    style === "paragraph"
                                      ? textEditorReason
                                      : textEditorUnavailable(
                                          "headings",
                                          "当前书册不支持标题样式。",
                                        )
                                  }
                                  onClick={() => run(() => onParagraphStyle(style))}
                                />
                              ))}
                              <MenuSeparator />
                              <MenuLabel>对齐与列表</MenuLabel>
                              {(
                                [
                                  ["左对齐", "align-left", "left"],
                                  ["居中", "align-center", "center"],
                                  ["右对齐", "align-right", "right"],
                                  ["两端对齐", "align-justify", "justify"],
                                ] as const
                              ).map(([label, command, alignment]) => (
                                <MenuItem
                                  key={label}
                                  label={label}
                                  active={formatState.alignment === alignment}
                                  unavailableReason={textEditorReason}
                                  onClick={() => run(() => onCommand(command))}
                                />
                              ))}
                              <MenuItem
                                label="项目符号"
                                active={formatState.bulletList}
                                unavailableReason={listUnavailableReason}
                                onClick={() => run(() => onCommand("bullet-list"))}
                              />
                              <MenuItem
                                label="编号"
                                active={formatState.orderedList}
                                unavailableReason={listUnavailableReason}
                                onClick={() => run(() => onCommand("ordered-list"))}
                              />
                            </div>
                          ) : null}
                        </SpatialPresence>
                      }
                    </div>
                    <div
                      className="format-menu__branch"
                      data-expanded={openFormatSubmenu === "page"}
                      onPointerLeave={() => hoverSubmenu(null)}
                    >
                      <MenuSubmenuTrigger
                        label="页面"
                        expanded={openFormatSubmenu === "page"}
                        onClick={() => setOpenFormatSubmenu("page")}
                        onPointerEnter={() => hoverSubmenu("page")}
                        onPointerLeave={cancelSubmenuHover}
                      />
                      {
                        <SpatialPresence>
                          {openFormatSubmenu === "page" ? (
                            <div
                              className="file-menu format-submenu"
                              onPointerEnter={cancelSubmenuHover}
                              role="menu"
                              aria-label="页面格式"
                            >
                              <MenuItem label="页边距设置" onClick={() => run(onOpenPageMargins)} />
                            </div>
                          ) : null}
                        </SpatialPresence>
                      }
                    </div>
                    <MenuSeparator />
                    <MenuItem
                      label="清除多余格式"
                      shortcut={clearExtraFormattingShortcut}
                      unavailableReason={textEditorReason}
                      onClick={() => run(onClearExtraFormatting)}
                    />
                  </div>
                ) : null}
              </SpatialPresence>
            }
          </div>

          <div className="menu-bar__menu-group" data-menu-group="view">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "view"}
              onClick={() => toggleMenu("view")}
            >
              视图
            </button>
            {
              <SpatialPresence>
                {openMenu === "view" ? (
                  <div className="file-menu view-menu" role="menu" aria-label="视图">
                    <MenuLabel>切换书册</MenuLabel>
                    {PATENT_BOOK_MENU_ITEMS.map(({ kind, label }) => (
                      <MenuItem
                        key={kind}
                        label={label}
                        active={activeBookKind === kind}
                        unavailableReason={
                          availableBookKinds.includes(kind)
                            ? undefined
                            : kind === "description-drawings" || kind === "abstract-drawing"
                              ? "当前专利未启用说明书附图和摘要附图。"
                              : "请先打开或新建专利。"
                        }
                        onClick={() => run(() => onActivateBook(kind))}
                      />
                    ))}
                    <MenuSeparator />
                    <MenuLabel>同屏双显</MenuLabel>
                    <MenuItem
                      label={splitViewActive ? "退出同屏双显" : "同屏双显"}
                      unavailableReason={splitReason}
                      onClick={() => run(() => onToggleSplitView?.())}
                    />
                    {(
                      [
                        ["claims-description", "权利要求书／说明书", false],
                        ["claims-drawings", "权利要求书／说明书附图", true],
                        ["drawings-description", "说明书附图／说明书", true],
                      ] as const
                    ).map(([pair, label, requiresDrawings]) => (
                      <MenuItem
                        key={pair}
                        label={label}
                        unavailableReason={
                          splitReason ??
                          (!onSelectSplitPair
                            ? "当前页面不支持双显。"
                            : requiresDrawings &&
                                !availableBookKinds.includes("description-drawings")
                              ? "当前专利未启用说明书附图。"
                              : undefined)
                        }
                        onClick={() => run(() => onSelectSplitPair?.(pair))}
                      />
                    ))}
                    <MenuItem
                      label="自定义双显搭配…"
                      unavailableReason={
                        splitReason ??
                        (!onOpenCustomDualView ? "当前页面不支持自定义双显。" : undefined)
                      }
                      onClick={() => run(() => onOpenCustomDualView?.())}
                    />
                    {customDualViewPresets?.map((preset, index) => (
                      <MenuItem
                        key={customDualViewShortcutId(index)}
                        label={customDualViewFullLabel(preset)}
                        unavailableReason={
                          splitReason ??
                          (!onSelectCustomDualViewPreset
                            ? "当前页面不支持自定义双显。"
                            : !availableBookKinds.includes("description-drawings") &&
                                (preset.leftBookKind === "description-drawings" ||
                                  preset.rightBookKind === "description-drawings")
                              ? "当前专利未启用说明书附图。"
                              : undefined)
                        }
                        onClick={() => run(() => onSelectCustomDualViewPreset?.(index))}
                      />
                    ))}
                    <MenuSeparator />
                    <MenuItem
                      label={columnsActive ? "退出双列显示" : "双列显示"}
                      active={columnsActive}
                      unavailableReason={
                        columnsActive && onToggleColumns
                          ? undefined
                          : !specialWorkspaceActive &&
                              onToggleColumns &&
                              (activeBookKind === "claims" || activeBookKind === "description") &&
                              !auxiliaryDocumentActive
                            ? undefined
                            : "双列显示仅支持权利要求书和说明书。"
                      }
                      onClick={() => run(() => onToggleColumns?.())}
                    />
                    <MenuSeparator />
                    <MenuItem label="放大" onClick={() => run(onZoomIn)} />
                    <MenuItem label="缩小" onClick={() => run(onZoomOut)} />
                    <MenuItem label="恢复为 100%" onClick={() => run(onZoomReset)} />
                  </div>
                ) : null}
              </SpatialPresence>
            }
          </div>

          <div className="menu-bar__menu-group" data-menu-group="tools">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "tools"}
              onClick={() => toggleMenu("tools")}
            >
              工具
            </button>
            {
              <SpatialPresence>
                {openMenu === "tools" ? (
                  <div className="file-menu tools-menu" role="menu" aria-label="工具">
                    <MenuLabel>专利撰写</MenuLabel>
                    <MenuItem
                      label="本地检查"
                      shortcut={checkProblemsShortcut}
                      onClick={() => run(onCheckProblems)}
                    />
                    {isNetworkAiAvailable() ? (
                      <>
                        <MenuItem
                          label="AI 纠错"
                          shortcut={aiCorrectionShortcut}
                          unavailableReason={
                            activeBookKind === "claims" ||
                            activeBookKind === "description" ||
                            activeBookKind === "abstract"
                              ? undefined
                              : "请先打开权利要求书、说明书或说明书摘要。"
                          }
                          onClick={() => run(onAiCorrection)}
                        />
                        <MenuItem
                          label="小栈AI助手"
                          unavailableReason={
                            activeBookKind === "claims" ||
                            activeBookKind === "description" ||
                            activeBookKind === "abstract"
                              ? undefined
                              : "请先打开权利要求书、说明书或说明书摘要。"
                          }
                          onClick={() => run(onTextPolish)}
                        />
                      </>
                    ) : null}
                    {isAgentCliAvailable() ? (
                      <>
                        <MenuSeparator />
                        <MenuItem
                          label="Agent CLI"
                          unavailableReason={
                            onOpenAgentCli ? undefined : "当前页面无法打开 Agent CLI 设置。"
                          }
                          onClick={() => run(() => onOpenAgentCli?.())}
                        />
                      </>
                    ) : null}
                    <MenuSeparator />
                    <MenuItem
                      label="创建桌面快捷方式"
                      onClick={() => run(onCreateDesktopShortcut)}
                    />
                  </div>
                ) : null}
              </SpatialPresence>
            }
          </div>
        </>
      ) : null}
      {libraryMode ? (
        <button type="button" onClick={() => run(onOpenBackupManager)}>
          <HardDriveDownload size={18} aria-hidden="true" />
          备份与恢复
        </button>
      ) : null}
      {!tutorialMode && (
        <>
          <button type="button" onClick={() => run(onOpenSettings)}>
            {libraryMode ? <Settings size={18} aria-hidden="true" /> : null}
            设置
          </button>

          <div className="menu-bar__menu-group" data-menu-group="help">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "help"}
              onClick={() => toggleMenu("help")}
            >
              {libraryMode ? <HelpCircle size={18} aria-hidden="true" /> : null}
              帮助
            </button>
            {
              <SpatialPresence>
                {openMenu === "help" ? (
                  <div className="file-menu help-menu" role="menu" aria-label="帮助">
                    <MenuItem label="使用手册" onClick={() => run(() => setGuideOpen(true))} />
                    <MenuItem
                      label="专利法律法规"
                      onClick={() => run(() => setLegislationOpen(true))}
                    />
                    <div
                      className="official-websites-group"
                      onPointerLeave={() => hoverSubmenu(null)}
                    >
                      <MenuSubmenuTrigger
                        label="常用官方网站"
                        expanded={openFormatSubmenu === "websites"}
                        onClick={() => setOpenFormatSubmenu("websites")}
                        onPointerEnter={() => hoverSubmenu("websites")}
                        onPointerLeave={cancelSubmenuHover}
                      />
                      {renderWebsitesMenu(
                        <SpatialPresence>
                          {openFormatSubmenu === "websites" ? (
                            <div
                              ref={websiteMenuRef}
                              className={`file-menu format-submenu official-websites-menu${libraryMode ? " library-official-websites-menu" : ""}`}
                              style={
                                libraryMode
                                  ? ({
                                      "--library-websites-left": `${Math.min(menuBarRef.current?.querySelector(".help-menu")?.getBoundingClientRect().right ?? 294, window.innerWidth - 296) + 10}px`,
                                    } as CSSProperties)
                                  : undefined
                              }
                              onPointerEnter={cancelSubmenuHover}
                              role="menu"
                              aria-label="常用官方网站"
                            >
                              {["国内业务", "检索与资料", "行业与国际"].map((group, index) => (
                                <fieldset key={group} aria-label={group}>
                                  {index > 0 ? <MenuSeparator /> : null}
                                  <MenuLabel>{group}</MenuLabel>
                                  {OFFICIAL_WEBSITES.filter((site) => site.group === group).map(
                                    (site) => (
                                      <MenuItem
                                        key={site.id}
                                        label={site.label}
                                        onClick={() =>
                                          run(() => {
                                            void openWebsite(site.id);
                                          })
                                        }
                                      />
                                    ),
                                  )}
                                </fieldset>
                              ))}
                            </div>
                          ) : null}
                        </SpatialPresence>,
                      )}
                    </div>
                    <MenuSeparator />
                    <MenuItem label="检查更新" onClick={() => run(() => openSoftwareUpdates())} />
                    <MenuItem
                      label="软件使用协议"
                      onClick={() => run(() => setLegalDocument("terms"))}
                    />
                    <MenuItem
                      label="隐私政策"
                      onClick={() => run(() => setLegalDocument("privacy"))}
                    />
                    <MenuItem
                      prominent
                      label="建议与反馈"
                      onClick={() => run(() => setFeedbackOpen(true))}
                    />
                    <MenuSeparator />
                    <MenuItem
                      label="开源许可证与第三方声明"
                      onClick={() => run(() => setThirdPartyNoticesOpen(true))}
                    />
                    <MenuItem
                      label={`关于${APPLICATION_NAME}`}
                      onClick={() => run(() => setAboutOpen(true))}
                    />
                  </div>
                ) : null}
              </SpatialPresence>
            }
          </div>
        </>
      )}
      {!libraryMode ? (
        <>
          {!tutorialMode && (
            <span className="menu-bar__book-navigation-separator" aria-hidden="true" />
          )}
          <div className="menu-bar__book-navigation">{children}</div>
          {!tutorialMode && onToggleSplitView && onSelectSplitPair ? (
            <PatentSplitControls
              active={splitViewActive}
              columnsActive={columnsActive}
              onToggleColumns={onToggleColumns}
              drawingsAvailable={availableBookKinds.includes("description-drawings")}
              onToggle={onToggleSplitView}
              onSelectPair={onSelectSplitPair}
              customPresets={customDualViewPresets}
              onOpenCustom={onOpenCustomDualView}
              onSelectCustomPreset={onSelectCustomDualViewPreset}
            />
          ) : null}

          {(
            [
              { tab: flowchartTab, label: "流程图", tool: "flowchart" },
              { tab: drawingTab, label: "CAD标号", tool: "drawing-markup" },
            ] as const
          ).map(({ tab, label, tool }) => {
            if (!tab) return null;
            const dragSource: WorkspaceTabDragSource = {
              key: `tool:${tab.patentId}:${tool}`,
              label,
              target: { patentId: tab.patentId, kind: "tool", tool },
            };
            return (
              <fieldset
                className="menu-bar__flowchart-tab-group"
                key={label}
                aria-label={`${label}标签`}
              >
                <span className="menu-bar__flowchart-tab-separator" aria-hidden="true" />
                <div className={`menu-bar__flowchart-tab-shell ${tab.active ? "is-active" : ""}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab.active}
                    className="menu-bar__flowchart-tab"
                    onPointerDown={(event) =>
                      workspaceTabDrag?.start({
                        source: dragSource,
                        sourceElement: event.currentTarget,
                        pointerId: event.pointerId,
                        button: event.button,
                        clientX: event.clientX,
                        clientY: event.clientY,
                      })
                    }
                    onClick={() => {
                      if (workspaceTabDrag?.consumeClick(dragSource.key)) return;
                      tab.onActivate();
                    }}
                  >
                    {label}
                  </button>
                  <button
                    type="button"
                    className="menu-bar__flowchart-tab-close dialog-close-button"
                    aria-label={`关闭${label}`}
                    title={`关闭${label}`}
                    onClick={tab.onRequestClose}
                  >
                    ×
                  </button>
                </div>
              </fieldset>
            );
          })}
        </>
      ) : null}
      {libraryMode ? createPortal(helpDialogs, document.body) : helpDialogs}
    </nav>
  );
}
