import { useExclusiveEditorRuntime } from "../shared/use-exclusive-editor-runtime";
import { ActiveEditorSessionContext, EditorSessionScope, editorBelongsToSession } from "../shared/editor-session-scope";
import { useSessionState } from "../shared/use-session-state";
import type { Editor } from "@tiptap/core";
import { fitDocumentTables } from "../../../shared/document/table-page-fit";
import { RecoveryCenter } from "../recovery/recovery-center";
import { AutomationAuthorizationDialog } from "../settings/automation-authorization-dialog";
import { applyEditorColors } from "../settings/editor-colors-display";
import {
  installMotionPreference,
  prefersReducedMotion as isMotionReduced,
} from "../shared/motion-preference";
import {
  FIXED_MOTION_DURATIONS,
  SPATIAL_MOTION_TIMING,
  spatialMotionTiming,
} from "../shared/spatial-motion";
import { SpatialPresence } from "../shared/spatial-presence";
import { SoftwareUpdates } from "../updates/software-updates";
import { dispatchNativeEditCommand } from "./native-history-command";
import { useWorkspaceZoomInput } from "./use-workspace-zoom-input";
import {
  beginWorkspaceLayoutTransition,
  type WorkspaceLayoutTransition,
  type WorkspaceLayoutTransitionDirection,
} from "./workspace-layout-transition";
import "../settings/editor-colors-display.css";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type {
  AiCorrectionBookKind,
  AiCorrectionIssue,
} from "../../../shared/ai-correction/contract";
import { activeAiModel } from "../../../shared/ai-correction/model";
import { createDocxSuggestedName } from "../../../shared/exports/docx-filename";
import type { ExportReport } from "../../../shared/exports/report";
import type { FlowchartEditorMode } from "../../../shared/flowcharts/bridge";
import { randomUuid } from "../../../shared/id";
import type {
  DocxImportCommitRequest,
  DocxImportPreview,
  DocxImportUpdateRequest,
  ExportRequest,
  ImportedAsset,
  PatentCreateRequest,
} from "../../../shared/ipc/contract";
import type { AppError } from "../../../shared/ipc/result";
import type { LibraryDocumentSummary, LibraryPatentSummary } from "../../../shared/library/model";
import { type PatdocWorkspace, readPatdocWorkspace } from "../../../shared/patent/continuation";
import { collectPatentStructureIssues } from "../../../shared/patent/document-structure-ruler";
import {
  PATENT_WORKSPACE_TOOL_LABELS,
  type PatentDocumentTarget,
  type PatentWorkspaceTool,
  patentDocumentTargetKey,
  patentDocumentTargetsEqual,
} from "../../../shared/patent/document-target";
import {
  availablePatentBookKinds,
  MAX_PATENT_FIGURE_WIDTH_MM,
  MIN_PATENT_FIGURE_WIDTH_MM,
  type PatentBook,
  type PatentBookKind,
} from "../../../shared/patent/model";
import type { InspectionIssue } from "../../../shared/patent-inspection/types";
import { ignoreApplicationKeyEvent, isNetworkAiAvailable } from "../../../shared/platform";
import { createPatentPrintSnapshot } from "../../../shared/printing/patent-print-snapshot";
import type { StartupRecoveryReport } from "../../../shared/recovery/startup-recovery";
import {
  type CustomDualViewPreset,
  customDualViewShortcutId,
  isCustomDualViewPresetAvailable,
} from "../../../shared/settings/custom-dual-view";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import type { PageMargins } from "../../../shared/settings/page-margins";
import { DesignPatentWorkbench } from "../design-patent/design-patent-workbench";
import { DocumentProvider, useDocuments } from "../documents/document-context";
import { CloseDecisionDialog, DocumentTabs } from "../documents/document-tabs";
import { EditorWorkspace } from "../documents/editor-workspace";
import { useDrawingFileDrop } from "../drawing-markup/drawing-file-drop";
import { planDrawingReplacement } from "../drawing-markup/drawing-replacement";
import { DrawingWorkspace, type DrawingWorkspaceHandle } from "../drawing-markup/drawing-workspace";
import { CadcraftClient } from "../drawing-markup/cadcraft-client";
import { PatentFolderDialog } from "../library/patent-folder-dialog";
import type { FolderFormat, PatentFolderEntry } from "../../../shared/patent/folder";
import {
  type ChemicalStructureDraft,
  ChemistryDialog,
  type ChemistryDialogRequest,
} from "../editor/chemistry-dialog";
import {
  type FormulaDrawingReplacement,
  renderFormulaDrawingReplacement,
} from "../editor/formula-drawing-replacement";
import {
  type FormulaDrawingRequest,
  formulaDrawingFigureWidthMm,
  formulaDrawingRequestedWidthMm,
} from "../editor/formula-drawing-request";
import {
  FormulaCollectionDialog,
  FormulaDialog,
  PHYSICS_FORMULA_GROUPS,
} from "../editor/ui/formula-dialog";
import { MenuBar } from "../editor/ui/menu-bar";
import { StatusBar } from "../editor/ui/status-bar";
import { ToolBar } from "../editor/ui/tool-bar";
import { ExportReportDialog } from "../exports/export-report-dialog";
import { FileOperationStatus } from "../exports/file-operation-status";
import { PrintCenter } from "../exports/print-center";
import {
  FlowchartWorkspace,
  type FlowchartWorkspaceHandle,
} from "../flowcharts/flowchart-workspace";
import {
  resolveContentSearchMatch,
  selectContentSearchAnnotation,
} from "../library/content-search-location";
import {
  DocumentLibrary,
  type PatentLibraryFocusRequest,
  type PatentLibraryNavigationState,
} from "../library/document-library";
import { useImportNotice } from "../library/import-notice";
import { LegacyMigrationDialog } from "../library/legacy-migration-dialog";
import { LibraryProvider, useLibrary } from "../library/library-context";
import { TrashDialog } from "../library/trash-dialog";
import { AiCorrectionPanel } from "../patents/ai-correction/ai-correction-panel";
import {
  applyCorrectionIssues,
  selectCorrectionAnchor,
} from "../patents/ai-correction/correction-anchor";
import { applyTextPolish } from "../patents/ai-correction/text-polish-anchor";
import { TextPolishPanel } from "../patents/ai-correction/text-polish-panel";
import { useAiCorrection } from "../patents/ai-correction/use-ai-correction";
import { useModelReadiness } from "../patents/ai-correction/use-model-readiness";
import { useTextPolish } from "../patents/ai-correction/use-text-polish";
import {
  AuxiliaryDocumentEditor,
  auxiliaryDocumentEditorId,
} from "../patents/auxiliary-document-editor";
import { CreatePatentDialog } from "../patents/create-patent-dialog";
import { CustomDualViewDialog } from "../patents/custom-dual-view-dialog";
import { DocxImportDialog } from "../patents/docx-import-dialog";
import { supportsDualColumns } from "../patents/dual-column-eligibility";
import { DUAL_COLUMN_REFIT, DualColumnSurface } from "../patents/dual-column-surface";
import {
  type DualDocumentPaneView,
  DualDocumentWorkspace,
} from "../patents/dual-document-workspace";
import { useDualPaneZoomLimit } from "../patents/dual-pane-zoom-limit";
import {
  BookEditor,
  type FindRailSession,
  type ReferenceMarkIssueNavigation,
} from "../patents/editors/book-editor";
import { readDrawingImageFiles } from "../patents/editors/drawing-image-import";
import { appendImportedFigures, reorderFigures } from "../patents/editors/drawing-sync-controller";
import type { DrawingImageImport } from "../patents/editors/drawings-editor";
import {
  FormulaFigureInsertDialog,
  type FormulaFigureTarget,
} from "../patents/editors/formula-figure-insert-dialog";
import { patentBookEditorId } from "../patents/editors/patent-book-rich-text-editor";
import { PersistentBookWorkspace } from "../patents/editors/persistent-book-workspace";
import { PatentFunctionRailScope } from "../patents/function-rail/function-rail-context";
import { PatentBookPicker, PatentBookSwitcher } from "../patents/patent-book-picker";
import { PatentBookTabs } from "../patents/patent-book-tabs";
import {
  PatentBookViewportProvider,
  PatentBookViewportStore,
  usePatentBookViewportRegistration,
} from "../patents/patent-book-viewport";
import { waitForPatentCheckEditor } from "../patents/patent-check-editor-wait";
import { centerPatentIssue, selectPatentIssueInEditor } from "../patents/patent-check-locate";
import { PatentCheckPanel, type PatentCheckPhase } from "../patents/patent-check-panel";
import { PatentProvider, usePatents } from "../patents/patent-context";
import {
  LibraryPatentExportDialog,
  PatentExportDialog,
  type PatentExportFormat,
  type PatentExportMode,
} from "../patents/patent-export-dialog";
import { PatentLibraryPickerDialog } from "../patents/patent-library-picker-dialog";
import type { PatentSession } from "../patents/patent-reducer";
import { PatentSettingsDialog } from "../patents/patent-settings-dialog";
import { PatentTabs } from "../patents/patent-tabs";
import {
  type PatentTextCountsByTarget,
  patentTextCountsKey,
  selectPatentTextCounts,
} from "../patents/patent-text-counts";
import {
  capabilitiesForPatentBook,
  ORDINARY_DOCUMENT_CAPABILITIES,
} from "../patents/patent-toolbar-capabilities";
import {
  activateWorkspacePane,
  applyWorkspaceCustomDualViewPreset,
  applyWorkspacePair,
  closeDualWorkspacePane,
  createSingleWorkspace,
  dropTargetIntoWorkspace,
  enterDualWorkspace,
  exitDualWorkspace,
  type PaneWorkspaceState,
  type PatentBookTarget,
  type PatentDocumentTargetInput,
  type PatentWorkspaceLayoutState,
  type PatentWorkspacePair,
  reconcileWorkspaceTargets,
  selectPaneTarget,
  setWorkspacePaneZoom,
  swapWorkspacePanes,
  type WorkspacePane,
} from "../patents/patent-workspace-layout";
import type {
  WorkspaceTabDragSource,
  WorkspaceTabDropEffect,
} from "../patents/patent-workspace-tab-drag";
import { PatentWorkspaceTabDragLayer } from "../patents/patent-workspace-tab-drag-layer";
import { PersistentWorkspace } from "../patents/persistent-workspace";
import { useBackgroundPatentInspection } from "../patents/use-background-patent-inspection";
import { useFitPatentOnOpen } from "../patents/use-fit-patent-on-open";
import {
  historyCommandFromKeyboardEvent,
  isTextPatentBook,
  shouldRoutePatentHistoryShortcut,
  usePatentEditorFocus,
} from "../patents/use-patent-editor-focus";
import { usePatentWorkspaceTabDrag } from "../patents/use-patent-workspace-tab-drag";
import { useSmoothDocumentZoom } from "../patents/use-smooth-document-zoom";
import { useWindowLayout } from "../patents/use-window-layout";
import {
  StartupRecoveryNotice,
  shouldShowStartupRecoveryNotice,
} from "../recovery/startup-recovery-notice";
import { confirmAppAction, promptAppText, showAppAlert } from "../shared/app-dialog";
import { useAssistantPanelBounds } from "../shared/use-assistant-panel-bounds";
import {
  openToolTutorial,
  ToolTutorial,
  ToolTutorialLibraryEntry,
} from "../writing-guidance/tool-tutorial";
import { WritingGuidance } from "../writing-guidance/writing-guidance";

type PatentCheckRequest = Readonly<{
  patentId: string;
  pane: "single" | WorkspacePane;
  nonce: number;
}>;

function isSuccessfulDataImportRecovery(report: StartupRecoveryReport | null): boolean {
  return (
    report?.dataImportRecovery === "recovered" &&
    report.mode === "read-write" &&
    report.quarantinedPatentCount === 0
  );
}

import { ApplicationSettingsDialog } from "../settings/application-settings-dialog";
import type { SettingsRoute } from "../settings/application-settings-workspace";
import {
  DATA_SAFETY_GUIDE_SNOOZED_KEY,
  DataSafetyGuide,
  shouldOfferDataSafetyGuide,
} from "../settings/data-safety-guide";
import { InventionContentSettingsDialog } from "../settings/invention-content-settings-dialog";
import { PageMarginDialog } from "../settings/page-margin-dialog";
import { ErrorDialog, onApplicationError } from "../shared/error-dialog";
import { hasVisibleElement } from "../shared/focusable-elements";
import { type OperationFeedback, OperationFeedbackOverlay } from "../shared/operation-feedback";
import { ToolActionTooltips } from "../shared/tool-action-tooltips";
import {
  ApplicationCloseProvider,
  useApplicationPersistence,
} from "./application-close-coordinator";
import { requestApplicationExit } from "./application-exit.js";
import {
  EditorCommandBus,
  type EditorFocusSnapshot,
  type EditorFormatState,
  type EditorHistoryState,
} from "./command-bus";
import { MotionPresence } from "./motion-presence";
import { useGlobalSelectAllGuard } from "./select-all-guard";
import { ShortcutProvider, useShortcutAction } from "./shortcut-dispatcher";
import { useEmptyEditorLibraryFallback } from "./use-empty-editor-library-fallback";
import "./app.css";
import "../patents/compact-tool-actions.css";
import "../patents/function-rail/function-rail-appearance.css";
import "../patents/function-rail/function-rail-select.css";
import "../patents/function-rail/drawing-rail-appearance.css";
import "../shared/standard-dialog.css";
import "../shared/dropdown-motion.css";

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

type ActiveExportRequest = ExportRequest & {
  sessionTargetId: string;
  documents?: ExportRequest["document"][];
  figureLabels?: Record<string, string>;
  combinedSuggestedName?: string;
};

function createPatentDrawingId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type MainViewKey =
  | "library"
  | "trash"
  | "editor-single"
  | "editor-dual"
  | "flowchart"
  | "drawing-markup";

const LIBRARY_EDITOR_MOTION_TIMING = {
  duration: FIXED_MOTION_DURATIONS.libraryEditor,
  easing: "ease-in-out",
} as const;

function AnimatedMainView({
  viewKey,
  onStageRef,
  children,
}: Readonly<{
  viewKey: MainViewKey;
  onStageRef?: ((node: HTMLDivElement | null) => void) | undefined;
  children: ReactNode;
}>) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const previousViewKeyRef = useRef(viewKey);
  const attachStageRef = useCallback(
    (node: HTMLDivElement | null) => {
      stageRef.current = node;
      onStageRef?.(node);
    },
    [onStageRef],
  );

  useLayoutEffect(() => {
    const previousViewKey = previousViewKeyRef.current;
    previousViewKeyRef.current = viewKey;
    const stage = stageRef.current;
    if (
      !stage ||
      previousViewKey === viewKey ||
      typeof stage.animate !== "function" ||
      isMotionReduced()
    ) {
      return undefined;
    }

    const switchingWorkspaceLayout =
      previousViewKey.startsWith("editor-") && viewKey.startsWith("editor-");
    const switchingLibraryAndEditor =
      (previousViewKey === "library" && viewKey !== "trash") ||
      (previousViewKey !== "trash" && viewKey === "library");
    const switchingLibraryAndTrash =
      (previousViewKey === "library" && viewKey === "trash") ||
      (previousViewKey === "trash" && viewKey === "library");
    if (
      (switchingLibraryAndEditor &&
        document.documentElement.classList.contains("library-editor-view-transition")) ||
      (switchingWorkspaceLayout &&
        document.documentElement.classList.contains("workspace-layout-view-transition")) ||
      (switchingLibraryAndTrash &&
        document.documentElement.classList.contains("library-trash-view-transition"))
    ) {
      return undefined;
    }
    const keyframes = switchingLibraryAndEditor
      ? [{ opacity: 0 }, { opacity: 1 }]
      : switchingWorkspaceLayout
        ? [
            {
              opacity: viewKey === "editor-dual" ? 0.72 : 0.8,
            },
            { opacity: 1 },
          ]
        : [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "translateY(0)" },
          ];
    const animation = stage.animate(
      keyframes,
      switchingLibraryAndEditor
        ? LIBRARY_EDITOR_MOTION_TIMING
        : switchingWorkspaceLayout
          ? SPATIAL_MOTION_TIMING
          : spatialMotionTiming(6),
    );
    return () => animation.cancel();
  }, [viewKey]);

  return (
    <div ref={attachStageRef} className="app-view-transition-stage" data-view-key={viewKey}>
      {children}
    </div>
  );
}

function clampZoom(value: number, rounded = true): number {
  return Math.min(200, Math.max(50, rounded ? Math.round(value) : value));
}

function patentTarget(session: PatentSession | null): PatentDocumentTarget | null {
  if (!session || session.patent.patentType === "design") return null;
  return { patentId: session.patentId, kind: "book", bookKind: session.activeBookKind };
}

function samePatentTarget(
  left: PatentDocumentTarget | PatentBookTarget | null,
  right: PatentDocumentTarget | PatentBookTarget | null,
): boolean {
  if (!left || !right) return false;
  const normalizedLeft: PatentDocumentTarget = "kind" in left ? left : { ...left, kind: "book" };
  const normalizedRight: PatentDocumentTarget =
    "kind" in right ? right : { ...right, kind: "book" };
  return patentDocumentTargetsEqual(normalizedLeft, normalizedRight);
}

function targetForPane(
  layout: PatentWorkspaceLayoutState,
  pane: WorkspacePane,
): PatentDocumentTarget | null {
  const state = layout[pane];
  return state.kind === "document" ? state.target : null;
}

function sessionForDocumentTarget(
  sessions: readonly PatentSession[],
  target: PatentDocumentTarget | PatentBookTarget,
): PatentSession | null {
  const session = sessions.find((candidate) => candidate.patentId === target.patentId);
  if (!session) return null;
  if ("kind" in target && target.kind === "auxiliary") {
    return session.patent.auxiliaryDocuments.some(
      (document) => document.auxiliaryDocumentId === target.auxiliaryDocumentId,
    )
      ? { ...session, activeAuxiliaryDocumentId: target.auxiliaryDocumentId }
      : null;
  }
  if ("kind" in target && target.kind === "tool") return session;
  const bookKind = target.bookKind;
  if (!availablePatentBookKinds(session.patent).includes(bookKind)) return null;
  return {
    ...session,
    activeAuxiliaryDocumentId: null,
    activeBookKind: bookKind,
    patent: { ...session.patent, activeBookKind: bookKind },
  };
}

function useActiveEditorFormatState(
  commandBus: EditorCommandBus,
  activeEditorId: string | null | undefined,
): EditorFormatState {
  const [formatState, setFormatState] = useState<EditorFormatState>(DEFAULT_FORMAT_STATE);

  useEffect(() => {
    if (!activeEditorId) {
      setFormatState(DEFAULT_FORMAT_STATE);
      return undefined;
    }
    setFormatState(commandBus.getFormatState(activeEditorId));
    return commandBus.subscribeFormatState(activeEditorId, setFormatState);
  }, [activeEditorId, commandBus]);

  return formatState;
}

function useActiveEditorHistoryState(
  commandBus: EditorCommandBus,
  activeEditorId: string | null | undefined,
): EditorHistoryState {
  const [historyState, setHistoryState] = useState<EditorHistoryState>({
    canUndo: false,
    canRedo: false,
  });

  useEffect(() => {
    if (!activeEditorId) {
      setHistoryState({ canUndo: false, canRedo: false });
      return undefined;
    }
    setHistoryState(commandBus.getHistoryState(activeEditorId));
    return commandBus.subscribeHistoryState(activeEditorId, setHistoryState);
  }, [activeEditorId, commandBus]);

  return historyState;
}

export async function resolveCorrectionEditor({
  commandBus,
  patentId,
  sessionId,
  activeBookKind,
  targetBookKind,
  activateBook,
}: {
  commandBus: EditorCommandBus;
  patentId: string;
  sessionId: string;
  activeBookKind: PatentBookKind;
  targetBookKind: AiCorrectionBookKind;
  activateBook(patentId: string, bookKind: PatentBookKind): void;
}): Promise<Editor> {
  if (activeBookKind !== targetBookKind) activateBook(patentId, targetBookKind);
  const editorId = patentBookEditorId(sessionId, targetBookKind);
  const existing = commandBus.getEditor(editorId);
  if (existing) return existing;
  return await new Promise<Editor>((resolve) => {
    const unsubscribe = commandBus.subscribeEditors((registeredId, editor) => {
      if (registeredId !== editorId || !editor) return;
      unsubscribe();
      resolve(editor);
    });
  });
}

export async function resolvePatentCheckEditor({
  commandBus,
  sessionId,
  targetBookKind,
  switchToBook,
}: {
  commandBus: EditorCommandBus;
  sessionId: string;
  targetBookKind: PatentBookKind;
  switchToBook(): void;
}): Promise<Editor | null> {
  switchToBook();
  if (!isTextPatentBook(targetBookKind)) return null;
  const editorId = patentBookEditorId(sessionId, targetBookKind);
  const editor = await waitForPatentCheckEditor(commandBus, editorId);
  if (!editor) return null;
  // Let the new page mount and restore its saved viewport before explicit navigation.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  return editor.isDestroyed ? null : editor;
}

const POST_IMPORT_REMINDER_KEY = "patent-workbench:post-import-safety-reminder:v1";
const POST_IMPORT_REMINDER_DEFERRED_KEY =
  "patent-workbench:post-import-safety-reminder-deferred:v1";

function clearPostImportReminder() {
  try {
    window.localStorage.removeItem(POST_IMPORT_REMINDER_KEY);
  } catch {
    // The reminder still closes for this session when storage is unavailable.
  }
}

function WorkbenchWindow() {
  const nativeMenuCommand = useRef<
    (command: import("../../../shared/ipc/contract").MenuCommand) => void
  >(() => {});
  useEffect(
    () => window.patentApi.menu?.onCommand((command) => nativeMenuCommand.current(command)),
    [],
  );
  const applicationPersistence = useApplicationPersistence();
  const documents = useDocuments();
  useEffect(
    () => applyEditorColors(document.documentElement, documents.settings.editorColors),
    [documents.settings.editorColors],
  );
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--settings-ui-scale",
      String(documents.settings.uiScalePercent / 100),
    );
    document.documentElement.dataset.reducedMotion = String(documents.settings.reducedMotion);
    return () => {
      document.documentElement.style.removeProperty("--settings-ui-scale");
      delete document.documentElement.dataset.reducedMotion;
    };
  }, [documents.settings.uiScalePercent, documents.settings.reducedMotion]);
  useEffect(() => installMotionPreference(), []);
  const patents = usePatents();
  const chemicalSessionsRef = useRef(patents.state.sessions);
  chemicalSessionsRef.current = patents.state.sessions;
  const isToolTutorial = window.patentApi?.tutorial?.isSession ?? false;

  const library = useLibrary();
  const closeNavigationRef = useRef({
    view: library.view,
    activePatentId: patents.state.activePatentId,
  });
  closeNavigationRef.current = { view: library.view, activePatentId: patents.state.activePatentId };
  const pendingUiCloses = useRef(new Map<string, Promise<void>>());
  useGlobalSelectAllGuard();
  const commandBus = useMemo(() => new EditorCommandBus(), []);
  const patentBookViewportStore = useMemo(() => new PatentBookViewportStore(), []);
  const activeSessionId = documents.state.activeSessionId;
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [printCenterRequest, setPrintCenterRequest] = useState<ActiveExportRequest | null>(null);
  const [appError, setAppError] = useState<AppError | null>(null);
  const [operationFeedback, setOperationFeedback] = useState<OperationFeedback | null>(null);
  const [activeReferenceMarksByPatent, setActiveReferenceMarksByPatent] = useState<
    Record<string, string>
  >({});
  const [recentReferenceMarksByPatent, setRecentReferenceMarksByPatent] = useState<
    Record<string, string>
  >({});
  const [referenceMarkIssueNavigationByPatent, setReferenceMarkIssueNavigationByPatent] = useState<
    Record<string, ReferenceMarkIssueNavigation>
  >({});
  const [createPatentOpen, setCreatePatentOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  useEffect(() => {
    if (library.view !== "library") setTrashOpen(false);
  }, [library.view]);
  const [createPatentBusy, setCreatePatentBusy] = useState(false);
  const [docxImportPreview, setDocxImportPreview] = useState<DocxImportPreview | null>(null);
  const [docxImportBusy, setDocxImportBusy] = useState(false);
  const [fileOperationMessage, setFileOperationMessage] = useState<string | null>(null);
  const importNotice = useImportNotice();
  const fileOperationRunning = useRef(false);
  const batchTrashRunning = useRef(false);
  const [batchTrashBusy, setBatchTrashBusy] = useState(false);
  const [startupRecoveryReport, setStartupRecoveryReport] = useState<StartupRecoveryReport | null>(
    null,
  );
  const [postImportReminder, setPostImportReminder] = useState(() => {
    try {
      return (
        window.localStorage.getItem(POST_IMPORT_REMINDER_KEY) === "pending" &&
        window.sessionStorage.getItem(POST_IMPORT_REMINDER_DEFERRED_KEY) !== "true"
      );
    } catch {
      return false;
    }
  });
  const welcomeCompletionRequested = useRef(false);
  const [dataSafetyGuideDismissed, setDataSafetyGuideDismissed] = useState(() => {
    try {
      return window.sessionStorage.getItem(DATA_SAFETY_GUIDE_SNOOZED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [pageMarginOpen, setPageMarginOpen] = useState(false);
  const [patentLibraryFocusRequest, setPatentLibraryFocusRequest] =
    useState<PatentLibraryFocusRequest | null>(null);
  const patentLibraryFocusRequestKeyRef = useRef(0);
  const patentLibraryNavigationRef = useRef<PatentLibraryNavigationState | null>(null);
  useEffect(() => {
    const navigation = patentLibraryNavigationRef.current;
    const snapshot = navigation?.contentSearchSnapshot;
    if (!snapshot) return;
    const active = new Set(library.activePatents.map((patent) => patent.patentId));
    const hits = snapshot.state.hits?.filter((hit) => active.has(hit.patentId));
    const details = Object.fromEntries(
      Object.entries(snapshot.details).filter(([id]) => active.has(id)),
    );
    if (
      hits?.length === snapshot.state.hits?.length &&
      Object.keys(details).length === Object.keys(snapshot.details).length
    )
      return;
    patentLibraryNavigationRef.current = {
      ...navigation,
      contentSearchSnapshot: {
        ...snapshot,
        state: { ...snapshot.state, ...(hits ? { hits } : {}) },
        details,
      },
    };
  }, [library.activePatents]);
  const [applicationSettingsOpen, setApplicationSettingsOpen] = useState(false);
  const [applicationSettingsInitialRoute, setApplicationSettingsInitialRoute] =
    useState<SettingsRoute>("templates");
  const [aiCorrectionOpen, setAiCorrectionOpen] = useState(false);
  const [textPolishOpen, setTextPolishOpen] = useState(false);
  const [textPolishActionErrors, setTextPolishActionErrors] = useState<
    Record<string, string | null>
  >({});
  const [customDualViewOpen, setCustomDualViewOpen] = useState(false);
  const [pendingDrawingImport, setPendingDrawingImport] = useState<{
    id: string;
    patentId: string;
    files: File[];
  } | null>(null);
  const drawingDropInFlight = useRef(false);
  const consumedDrawingDrop = useRef("");
  const drawingWorkspaceRef = useRef<DrawingWorkspaceHandle | null>(null);
  const drawingCloseOperation = useRef<Promise<boolean> | null>(null);
  const [inventionContentSettingsOpen, setInventionContentSettingsOpen] = useState(false);

  const flowchartWorkspaceRef = useRef<FlowchartWorkspaceHandle | null>(null);
  // Ctrl+Tab 连按队列：每次按键只入队一个方向，由消费者串行执行——连按两次切换两个文档，不吞按键也不竞争状态。
  const cycleQueueRef = useRef<Array<1 | -1>>([]);
  const cycleRunningRef = useRef(false);
  const cycleLiveStateRef = useRef<{
    target: PatentDocumentTarget | null;
    flowchartActive: boolean;
    drawingActive: boolean;
    flowchartWorkspace: { patentId: string } | null;
    drawingMarkupPatentId: string | null;
    sessions: readonly PatentSession[];
    workspaceLayout: PatentWorkspaceLayoutState;
  } | null>(null);
  const [settingsPatent, setSettingsPatent] = useState<LibraryPatentSummary | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const patentExportRequestId = useRef(0);
  const [patentExport, setPatentExport] = useState<{
    requestId: number;
    format: PatentExportFormat;
    bookKind: PatentBookKind;
    suggestedName: string;
  } | null>(null);
  const [recoveryCenter, setRecoveryCenter] = useState<{
    initialTab: "snapshots" | "backups";
    patentId?: string;
  } | null>(null);
  const [patentFolder, setPatentFolder] = useState<import("../../../shared/patent/model").CanonicalPatent | null>(null);
  const [patentFolderBusy, setPatentFolderBusy] = useState(false);
  const [patentFolderExportNotice, setPatentFolderExportNotice] = useState<string | null>(null);
  const patentFolderOperation = useRef(false);
  const [folderDrawingTargets, setFolderDrawingTargets] = useState<Record<string, {projectId: string; key: number}>>({});
  const [libraryPatentExport, setLibraryPatentExport] = useState<LibraryPatentSummary[] | null>(
    null,
  );
  const patentsAvailable = Boolean(
    (window.patentApi as typeof window.patentApi & { patents?: typeof window.patentApi.patents })
      .patents,
  );
  useEffect(() => {
    let active = true;
    const request = window.patentApi.application.getStartupRecoveryReport?.();
    if (!request) {
      return undefined;
    }
    void request
      .then((result) => {
        if (
          active &&
          result.ok &&
          (shouldShowStartupRecoveryNotice(result.value) ||
            result.value.dataImportRecovery === "recovered" ||
            result.value.dataImportRecovery === "manual-safe-recovery")
        ) {
          setStartupRecoveryReport(result.value);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (
      !isSuccessfulDataImportRecovery(startupRecoveryReport) ||
      !documents.settingsReady ||
      welcomeCompletionRequested.current
    ) {
      return;
    }
    welcomeCompletionRequested.current = true;
    void documents.completeWelcome().then((saved) => {
      if (!saved) welcomeCompletionRequested.current = false;
    });
  }, [documents.completeWelcome, documents.settingsReady, startupRecoveryReport]);

  useEffect(() => {
    if (
      library.view !== "editor" ||
      !documents.settingsReady ||
      documents.settings.welcomeCompleted ||
      welcomeCompletionRequested.current
    ) {
      return;
    }
    welcomeCompletionRequested.current = true;
    void documents.completeWelcome().then((saved) => {
      if (!saved) welcomeCompletionRequested.current = false;
    });
  }, [
    documents.completeWelcome,
    documents.settings.welcomeCompleted,
    documents.settingsReady,
    library.view,
  ]);
  const [workspaceLayout, setWorkspaceLayout] = useState<PatentWorkspaceLayoutState>(() =>
    createSingleWorkspace(null),
  );
  const [columnsRequested, setColumnsRequested] = useState(false);
  const workspaceLayoutSwitchPending = useRef<{
    direction: WorkspaceLayoutTransitionDirection;
    intentKey: string | undefined;
    transition: WorkspaceLayoutTransition;
    retainedLayout: PatentWorkspaceLayoutState | undefined;
  } | null>(null);
  const runWorkspaceLayoutSwitch = useCallback(
    async <T,>(
      direction: WorkspaceLayoutTransitionDirection,
      operation: (transition: WorkspaceLayoutTransition) => Promise<T>,
      retainedLayout?: PatentWorkspaceLayoutState,
      intentKey?: string,
    ): Promise<T | undefined> => {
      if (
        workspaceLayoutSwitchPending.current?.direction === direction &&
        (!intentKey || workspaceLayoutSwitchPending.current.intentKey === intentKey)
      ) return undefined;
      const transition = beginWorkspaceLayoutTransition(direction);
      const request = { direction, intentKey, transition, retainedLayout };
      workspaceLayoutSwitchPending.current = request;
      try {
        const result = await operation(transition);
        return transition.cancelled ? undefined : result;
      } catch (error) {
        if (transition.cancelled) return undefined;
        transition.cancel();
        throw error;
      } finally {
        if (workspaceLayoutSwitchPending.current === request) {
          workspaceLayoutSwitchPending.current = null;
        }
      }
    },
    [],
  );
  useEffect(() => () => workspaceLayoutSwitchPending.current?.transition.cancel(), []);
  const [windowRestoreFit, setWindowRestoreFit] = useState(0);
  const [columnZoomPercent, setColumnZoomPercent] = useState(100);
  const [zoomLimits, setZoomLimits] = useState({
    single: 200,
    columns: 150,
    left: 200,
    right: 200,
  });
  // Each pane owns a range based on its compact controls and current usable width.
  const reportZoomLimit = useCallback(
    (scope: "single" | "columns" | WorkspacePane, max: number) => {
      setZoomLimits((current) => (current[scope] === max ? current : { ...current, [scope]: max }));
      if (scope === "columns") setColumnZoomPercent((current) => Math.min(current, max));
      if (scope === "left" || scope === "right")
        setWorkspaceLayout((current) => {
          const pane = current[scope];
          return current.mode !== "dual" || pane.kind !== "document" || pane.dualZoomPercent <= max
            ? current
            : setWorkspacePaneZoom(current, scope, max, Boolean(pane.dualZoomManual));
        });
    },
    [],
  );
  const fitPaneAutomatically = (pane: WorkspacePane, zoom: number) => {
    setWorkspaceLayout((current) =>
      current[pane].kind !== "document" || current[pane].dualZoomManual
        ? current
        : setWorkspacePaneZoom(current, pane, zoom),
    );
  };

  const standardWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const mainViewStageNodeRef = useRef<HTMLDivElement | null>(null);
  const setMainViewStageNode = useCallback((node: HTMLDivElement | null) => {
    mainViewStageNodeRef.current = node;
  }, []);
  const [patentTextCounts, setPatentTextCounts] = useState<PatentTextCountsByTarget>({});
  const [libraryPickerRequest, setLibraryPickerRequest] = useState<Readonly<{
    pane: WorkspacePane;
    origin: "body-picker" | "header-switcher";
  }> | null>(null);
  const [paneSwitcherPatentRequest, setPaneSwitcherPatentRequest] = useState<Readonly<{
    pane: WorkspacePane;
    patentId: string;
  }> | null>(null);
  const windowLayout = useWindowLayout();
  const activeWorkspaceTarget =
    workspaceLayout.mode === "dual" && patents.activeSession?.patent.patentType !== "design"
      ? targetForPane(workspaceLayout, workspaceLayout.activePane)
      : patentTarget(patents.activeSession);
  const activePatentSession = activeWorkspaceTarget
    ? sessionForDocumentTarget(patents.state.sessions, activeWorkspaceTarget)
    : patents.activeSession;
  const openToolSessionIds = useMemo(() => patents.state.sessions.map(session => session.sessionId), [patents.state.sessions]);
  const paneToolOwner = (tool: "drawing-markup" | "flowchart") => {
    if (workspaceLayout.mode === "dual") {
      for (const pane of [workspaceLayout.activePane, workspaceLayout.activePane === "left" ? "right" : "left"] as const) {
        const state = workspaceLayout[pane];
        if (state.kind === "document" && state.target.kind === "tool" && state.target.tool === tool)
          return patents.state.sessions.find(session => session.patentId === state.target.patentId);
      }
    }
    return activePatentSession;
  };
  const drawingOwner = paneToolOwner("drawing-markup");
  const flowchartOwner = paneToolOwner("flowchart");
  const [drawingMarkupShown, setDrawingMarkupShown, , setDrawingShownForSession] = useSessionState(drawingOwner?.sessionId, false, openToolSessionIds);
  const [drawingMarkupPatentId, setDrawingMarkupPatentId, drawingSessions, setDrawingForSession] = useSessionState<string | null>(drawingOwner?.sessionId, null, openToolSessionIds);
  const [flowchartWorkspace, setFlowchartWorkspace, flowchartSessions, setFlowchartForSession] = useSessionState<{
    patentId: string;
    patentRevision: number;
    active: boolean;
    initialProjectId: string | null;
    defaultReplaceFigureId: string | null;
    editorMode: FlowchartEditorMode;
  } | null>(flowchartOwner?.sessionId, null, openToolSessionIds);
  const drawingHandles = useRef(new Map<string, DrawingWorkspaceHandle>());
  const flowchartHandles = useRef(new Map<string, FlowchartWorkspaceHandle>());
  drawingWorkspaceRef.current = drawingOwner ? drawingHandles.current.get(drawingOwner.sessionId) ?? null : null;
  flowchartWorkspaceRef.current = flowchartOwner ? flowchartHandles.current.get(flowchartOwner.sessionId) ?? null : null;
  const drawingRuntime = useExclusiveEditorRuntime(drawingMarkupPatentId ? drawingOwner?.sessionId ?? null : null, openToolSessionIds,
    async owner => {
      const handle = drawingHandles.current.get(owner);
      return (await (handle?.suspend?.() ?? handle?.flush())) ?? true;
    });
  const flowchartRuntime = useExclusiveEditorRuntime(flowchartWorkspace ? flowchartOwner?.sessionId ?? null : null, openToolSessionIds,
    async owner => {
      const handle = flowchartHandles.current.get(owner);
      return (await (handle?.suspend?.() ?? handle?.flush())) ?? true;
    });
  const activeDocumentKey = activeWorkspaceTarget
    ? patentDocumentTargetKey(activeWorkspaceTarget)
    : null;
  const previousActiveDocumentKey = useRef(activeDocumentKey);
  useEffect(() => {
    const previous = previousActiveDocumentKey.current;
    previousActiveDocumentKey.current = activeDocumentKey;
    if (previous === activeDocumentKey) return;
    setRecentReferenceMarksByPatent({});
  }, [activeDocumentKey]);
  useEffect(() => {
    const validReferenceMarkIds = new Map(
      patents.state.sessions.map((session) => [
        session.patentId,
        new Set(session.patent.referenceMarks.map((mark) => mark.referenceMarkId)),
      ]),
    );
    const removeStaleEntries = (current: Record<string, string>) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([patentId, referenceMarkId]) =>
          validReferenceMarkIds.get(patentId)?.has(referenceMarkId),
        ),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    };
    setActiveReferenceMarksByPatent(removeStaleEntries);
    setRecentReferenceMarksByPatent(removeStaleEntries);
    setReferenceMarkIssueNavigationByPatent((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([patentId, navigation]) =>
          validReferenceMarkIds.get(patentId)?.has(navigation.referenceMarkId),
        ),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [patents.state.sessions]);
  useEffect(() => {
    const patentId = activePatentSession?.patentId;
    if (!patentId || !activeReferenceMarksByPatent[patentId]) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest(".drawing-workspace")) return;
      if (hasVisibleElement("[role='dialog']")) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveReferenceMarksByPatent((current) => {
        if (!current[patentId]) return current;
        const next = { ...current };
        delete next[patentId];
        return next;
      });
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [activePatentSession?.patentId, activeReferenceMarksByPatent]);
  const activePatentStructureIssues = useMemo(
    () => (activePatentSession ? collectPatentStructureIssues(activePatentSession.patent) : []),
    [activePatentSession],
  );
  const activePatentTextCounts = selectPatentTextCounts(
    patentTextCounts,
    activeWorkspaceTarget?.kind === "book" ? activeWorkspaceTarget : null,
  );
  const toolPane = (tool: "flowchart" | "drawing-markup", patentId: string | undefined | null) =>
    workspaceLayout.mode === "dual"
      ? ((["left", "right"] as const).find((pane) => {
          const state = workspaceLayout[pane];
          return (
            state.kind === "document" &&
            state.target.kind === "tool" &&
            state.target.tool === tool &&
            state.target.patentId === patentId
          );
        }) ?? null)
      : null;
  const flowchartPane = toolPane("flowchart", flowchartWorkspace?.patentId);
  const drawingPane = toolPane("drawing-markup", drawingMarkupPatentId);
  const flowchartActive =
    library.view === "editor" &&
    Boolean(
      flowchartPane ||
        (flowchartWorkspace?.active &&
          flowchartWorkspace.patentId === activePatentSession?.patentId &&
          library.view === "editor" &&
          workspaceLayout.mode === "single"),
    );

  const drawingPatentSession = patents.state.sessions.find(
    (s) => s.patentId === drawingMarkupPatentId,
  );
  const drawingActive =
    library.view === "editor" &&
    Boolean(
      drawingPane ||
        (drawingMarkupShown &&
          drawingPatentSession &&
          drawingMarkupPatentId === activePatentSession?.patentId &&
          library.view === "editor" &&
          !flowchartActive &&
          workspaceLayout.mode === "single"),
    );
  // 队列消费者每步执行前从这里读取最新状态（React 提交后即刷新），保证连按时逐步前进。
  cycleLiveStateRef.current = {
    target: activeWorkspaceTarget,
    flowchartActive,
    drawingActive,
    flowchartWorkspace,
    drawingMarkupPatentId,
    sessions: patents.state.sessions,
    workspaceLayout,
  };
  const embeddedEditorActive =
    workspaceLayout.mode === "dual"
      ? activeWorkspaceTarget?.kind === "tool"
      : flowchartActive || drawingActive;

  // 单屏内嵌 CAD标号/流程图 时，屏幕上真正显示的是工具而不是单屏记录的书册。
  const displayedSingleTarget: PatentDocumentTarget | null =
    workspaceLayout.mode !== "single" || !embeddedEditorActive
      ? null
      : drawingActive && drawingMarkupPatentId
        ? { patentId: drawingMarkupPatentId, kind: "tool", tool: "drawing-markup" }
        : flowchartActive && flowchartWorkspace
          ? { patentId: flowchartWorkspace.patentId, kind: "tool", tool: "flowchart" }
          : null;

  const previousWorkspaceMode = useRef(workspaceLayout.mode);
  useEffect(() => {
    const wasDual = previousWorkspaceMode.current === "dual";
    previousWorkspaceMode.current = workspaceLayout.mode;
    if (!wasDual || workspaceLayout.mode !== "single") return;
    const target = workspaceLayout.singleTarget;
    setDrawingMarkupShown(target?.kind === "tool" && target.tool === "drawing-markup");
    setFlowchartWorkspace((current) =>
      current
        ? { ...current, active: target?.kind === "tool" && target.tool === "flowchart" }
        : current,
    );
  }, [workspaceLayout.mode, workspaceLayout.singleTarget, setDrawingMarkupShown, setFlowchartWorkspace]);

  const activeEditorId =
    patentsAvailable && activePatentSession
      ? activeWorkspaceTarget?.kind === "auxiliary"
        ? auxiliaryDocumentEditorId(
            activePatentSession.sessionId,
            activeWorkspaceTarget.auxiliaryDocumentId,
          )
        : patentBookEditorId(activePatentSession.sessionId, activePatentSession.activeBookKind)
      : activeSessionId;
  useEmptyEditorLibraryFallback(
    library.view,
    patentsAvailable ? Boolean(patents.activeSession) : Boolean(documents.activeSession),
    library.setView,
  );
  const [focusedEditor, setFocusedEditor] = useState<EditorFocusSnapshot | null>(null);
  useEffect(() => commandBus.subscribeEditorFocus(setFocusedEditor), [commandBus]);
  const focusedPatentEditorId = useMemo(() => {
    const snapshot = focusedEditor;
    if (!snapshot) return null;
    for (const session of patents.state.sessions) {
      const prefix = `${session.sessionId}:`;
      if (!snapshot.editorId.startsWith(prefix)) continue;
      const bookKind = snapshot.editorId.slice(prefix.length);
      if (bookKind === "claims" || bookKind === "description" || bookKind === "abstract") {
        return snapshot.editorId;
      }
    }
    return null;
  }, [focusedEditor, patents.state.sessions]);
  const retainedEditorIds = useMemo(() => {
    const ids = new Set(documents.state.sessions.map((session) => session.sessionId));
    for (const session of patents.state.sessions) {
      for (const bookKind of ["claims", "description", "abstract"] as const) {
        if (!session.patent.books.some((book) => book.kind === bookKind)) continue;
        ids.add(patentBookEditorId(session.sessionId, bookKind));
      }
    }
    return ids;
  }, [documents.state.sessions, patents.state.sessions]);
  useEffect(() => {
    commandBus.disposeRetainedEditorsExcept(retainedEditorIds);
  }, [commandBus, retainedEditorIds]);
  const retainSelectionsForLayoutChange = useCallback(() => {
    commandBus.retainRegisteredSelectionsForNextRegistration();
  }, [commandBus]);
  const activeAiBookKind =
    activePatentSession &&
    (activePatentSession.activeBookKind === "claims" ||
      activePatentSession.activeBookKind === "description" ||
      activePatentSession.activeBookKind === "abstract")
      ? activePatentSession.activeBookKind
      : "description";
  const openAiCorrectionSessionIds = useMemo(
    () => patents.state.sessions.map((session) => session.sessionId),
    [patents.state.sessions],
  );
  const activeAiCorrectionProfile = activeAiModel(documents.settings.aiCorrection);
  const correctionModelReady = useModelReadiness(
    activeAiCorrectionProfile?.profileId,
    activeAiCorrectionProfile?.providerId === "ollama",
    isNetworkAiAvailable() && documents.settings.aiConnectionsEnabled,
    applicationSettingsOpen || !aiCorrectionOpen,
  );
  const aiCorrection = useAiCorrection({
    patentId: activePatentSession?.patentId ?? null,
    sessionId: activePatentSession?.sessionId ?? null,
    openSessionIds: openAiCorrectionSessionIds,
    bookKind: activeAiBookKind,
    editor: activeEditorId ? commandBus.getEditor(activeEditorId) : null,
    thinkingEnabled: true,
    modelName: activeAiCorrectionProfile?.displayName,
    prepare: patents.prepareActiveAiCorrection,
  });
  const textPolish = useTextPolish({
    patentId: activePatentSession?.patentId ?? null,
    sessionId: activePatentSession?.sessionId ?? null,
    openSessionIds: openAiCorrectionSessionIds,
    bookKind: activeAiBookKind,
    editor:
      activeEditorId &&
      activeWorkspaceTarget?.kind === "book" &&
      isTextPatentBook(activeWorkspaceTarget.bookKind)
        ? commandBus.getEditor(activeEditorId)
        : null,
    keepSelectionHighlight: textPolishOpen,
    prepare: patents.prepareActiveAiCorrection,
  });
  const textPolishActionKey = `${activePatentSession?.sessionId ?? "draft"}:${textPolish.conversationId ?? "new"}`;
  useEffect(
    () =>
      applicationPersistence.register(
        "text-polish-input-drafts",
        textPolish.flushInputDrafts,
        "editor",
      ),
    [applicationPersistence, textPolish.flushInputDrafts],
  );
  const textPolishActionError = textPolishActionErrors[textPolishActionKey] ?? null;
  const setTextPolishActionError = useCallback(
    (message: string | null) => {
      setTextPolishActionErrors((current) =>
        (current[textPolishActionKey] ?? null) === message
          ? current
          : { ...current, [textPolishActionKey]: message },
      );
    },
    [textPolishActionKey],
  );
  const aiCorrectionHidden =
    library.view !== "editor" ||
    embeddedEditorActive ||
    !activeWorkspaceTarget ||
    !activePatentSession ||
    activeWorkspaceTarget.kind !== "book" ||
    !isTextPatentBook(activeWorkspaceTarget.bookKind);
  const editorForAiBook = useCallback(
    async (targetBookKind: AiCorrectionBookKind): Promise<Editor | null> => {
      if (!activePatentSession) return null;
      return await resolveCorrectionEditor({
        commandBus,
        patentId: activePatentSession.patentId,
        sessionId: activePatentSession.sessionId,
        activeBookKind: activePatentSession.activeBookKind,
        targetBookKind,
        activateBook: patents.activateBook,
      });
    },
    [activePatentSession, commandBus, patents.activateBook],
  );
  const editorForCorrectionIssue = useCallback(
    async (issue: AiCorrectionIssue): Promise<Editor | null> =>
      await editorForAiBook(issue.anchor.bookKind),
    [editorForAiBook],
  );

  const applyAiCorrectionIssues = useCallback(
    async (issues: readonly AiCorrectionIssue[]) => {
      const appliedIssueIds: string[] = [];
      const skippedIssueIds: string[] = [];
      const skippedReasons: string[] = [];
      const byBook = new Map<AiCorrectionBookKind, AiCorrectionIssue[]>();
      for (const issue of issues) {
        const group = byBook.get(issue.anchor.bookKind) ?? [];
        group.push(issue);
        byBook.set(issue.anchor.bookKind, group);
      }
      for (const group of byBook.values()) {
        const first = group[0];
        if (!first) continue;
        const editor = await editorForCorrectionIssue(first);
        if (!editor) {
          skippedIssueIds.push(...group.map(({ issueId }) => issueId));
          skippedReasons.push("文档编辑器尚未就绪，请稍后重试。");
          continue;
        }
        const result = applyCorrectionIssues(editor, group);
        appliedIssueIds.push(...result.appliedIssueIds);
        skippedIssueIds.push(...result.skippedIssueIds);
        skippedReasons.push(...result.skippedReasons);
      }
      aiCorrection.removeIssues(appliedIssueIds);
      return { appliedIssueIds, skippedIssueIds, skippedReasons: [...new Set(skippedReasons)] };
    },
    [aiCorrection.removeIssues, editorForCorrectionIssue],
  );
  const [findSession, setFindSession] = useState<FindRailSession | null>(null);
  const [findQuery, setFindQuery] = useState("");
  // Page zoom belongs to this software session; startup always uses 100%.
  const [zoomPercent, setZoomPercent] = useState(DEFAULT_APP_SETTINGS.zoomPercent);
  const [physicsFormulaTarget, setPhysicsFormulaTarget, physicsFormulaTargetSessions, setPhysicsFormulaTargetForSession] = useSessionState<
    string | { drawingsOnly: true; patentId: string; sessionId: string } | null
  >(activePatentSession?.sessionId, null, openAiCorrectionSessionIds);
  const [, setDrawingFormulaEditor, drawingFormulaEditorSessions, setDrawingFormulaEditorForSession] = useSessionState<{
    patentId: string;
    sessionId: string;
    kind: "mathematical";
  } | null>(activePatentSession?.sessionId, null, openAiCorrectionSessionIds);
  const [, setDrawingFormulaEditorOpen, drawingFormulaEditorOpenSessions, setDrawingFormulaEditorOpenForSession] = useSessionState(activePatentSession?.sessionId, false, openAiCorrectionSessionIds);
  const [drawingChemistryEditor, setDrawingChemistryEditor, drawingChemistryEditorSessions, setDrawingChemistryEditorForSession] = useSessionState<{
    patentId: string;
    sessionId: string;
    kind: "equation" | "structure";
    request?: ChemistryDialogRequest;
    editTarget?: { figureId: string; assetId: string };
  } | null>(activePatentSession?.sessionId, null, openAiCorrectionSessionIds);
  const [, setDrawingChemistryEditorOpen, drawingChemistryEditorOpenSessions, setDrawingChemistryEditorOpenForSession] = useSessionState(activePatentSession?.sessionId, false, openAiCorrectionSessionIds);
  const formulaDrawingGeneration = useRef(new Map<string, number>());
  const [formulaDrawing, , formulaDrawingSessions, setFormulaDrawingForSession] = useSessionState<{
    patentId: string;
    sessionId: string;
    request: FormulaDrawingRequest;
    sourceEditor?: "drawing-formula" | "drawing-chemistry";
    png: Uint8Array;
    widthPx: number;
    heightPx: number;
    previewUrl: string;
  } | null>(activePatentSession?.sessionId, null, openAiCorrectionSessionIds);
  const [patentCheckRequest, setPatentCheckRequest] = useState<PatentCheckRequest | null>(null);
  const patentCheckRunGeneration = useRef(0);
  const [patentCheckRunToken, setPatentCheckRunToken] = useState<number | null>(null);
  const patentCheckLocateGeneration = useRef(0);
  const [patentCheckInitialRunning, setPatentCheckInitialRunning] = useState(false);
  const [findReplacement, setFindReplacement] = useState("");
  const [findOptions, setFindOptions] = useState<{
    interpretSpecialCodes?: boolean;
    caseSensitive: boolean;
    wholeWord: boolean;
    searchMode: "literal" | "wildcard" | "regex";
    useRegex: boolean;
  }>({
    caseSensitive: false,
    wholeWord: false,
    searchMode: "literal",
    useRegex: false,
  });
  const updateFindQuery = useCallback((query: string) => {
    setFindQuery(query);
    setFindOptions((current) => ({ ...current, interpretSpecialCodes: true }));
  }, []);
  const visibleFindSession =
    findSession?.scope === "single"
      ? workspaceLayout.mode === "single" &&
        activeWorkspaceTarget?.patentId === findSession.target.patentId &&
        (activeWorkspaceTarget.kind === "auxiliary" ||
          (activeWorkspaceTarget.kind === "book" &&
            isTextPatentBook(activeWorkspaceTarget.bookKind))) &&
        activeEditorId
        ? {
            ...findSession,
            target: activeWorkspaceTarget,
            editorId: activeEditorId,
          }
        : null
      : findSession;

  const closeFindRail = useCallback(() => {
    if (!findSession) return;
    const closingSession = findSession;
    setFindSession(null);
    setFindQuery("");
    setFindReplacement("");
    setFindOptions({
      caseSensitive: false,
      wholeWord: false,
      searchMode: "literal",
      useRegex: false,
    });
    requestAnimationFrame(() => {
      const targetStillOpen = Boolean(
        sessionForDocumentTarget(patents.state.sessions, closingSession.target),
      );
      if (targetStillOpen && commandBus.getEditor(closingSession.editorId)) {
        commandBus.restoreSelection(closingSession.editorId, closingSession.bookmark);
      }
    });
  }, [commandBus, findSession, patents.state.sessions]);

  const openFindRail = useCallback(
    (mode: "find" | "replace", selectedText?: string) => {
      const editor = activeEditorId ? commandBus.getEditor(activeEditorId) : null;
      if (
        !activeWorkspaceTarget ||
        !activePatentSession ||
        !activeEditorId ||
        activeWorkspaceTarget.kind === "tool" ||
        (activeWorkspaceTarget.kind === "book" &&
          !isTextPatentBook(activeWorkspaceTarget.bookKind)) ||
        !editor
      )
        return;
      if (visibleFindSession?.editorId === activeEditorId && visibleFindSession.mode === mode) {
        closeFindRail();
        return;
      }
      const { from, to } = editor.state.selection;
      setFindOptions((current) => ({ ...current, interpretSpecialCodes: true }));
      const nextQuery =
        selectedText ?? (from === to ? undefined : editor.state.doc.textBetween(from, to, "\n"));
      setFindSession({
        mode,
        scope: workspaceLayout.mode === "dual" ? workspaceLayout.activePane : "single",
        target: activeWorkspaceTarget,
        editorId: activeEditorId,
        bookmark: commandBus.captureSelection(activeEditorId),
      });
      if (nextQuery) setFindQuery(nextQuery);
    },
    [
      activeEditorId,
      activePatentSession,
      activeWorkspaceTarget,
      closeFindRail,
      commandBus,
      visibleFindSession,
      workspaceLayout.activePane,
      workspaceLayout.mode,
    ],
  );
  const [contentSearchNavigation, setContentSearchNavigation] = useState<
    (import("../library/content-search-results").ContentSearchTarget & { patentId: string }) | null
  >(null);
  const [contentSearchOrigin, setContentSearchOrigin] = useState<string | null>(null);
  const contentSearchWorkspaceTargetRef = useRef(activeWorkspaceTarget);
  contentSearchWorkspaceTargetRef.current = activeWorkspaceTarget;
  useEffect(() => {
    const target = contentSearchNavigation;
    const workspaceTarget = contentSearchWorkspaceTargetRef.current;
    if (
      !target ||
      library.view !== "editor" ||
      workspaceTarget?.patentId !== target.patentId ||
      workspaceTarget.kind !== "book" ||
      workspaceTarget.bookKind !== target.kind
    )
      return;
    if (!isTextPatentBook(target.kind)) {
      setContentSearchNavigation(null);
      return;
    }
    let cancelled = false;
    let frame = 0;
    const attempt = () => {
      if (cancelled) return;
      const editor = activeEditorId ? commandBus.getEditor(activeEditorId) : null;
      if (!editor?.view.dom.isConnected) return;
      const viewport = editor.view.dom.closest<HTMLElement>(".patent-editor-workspace");
      if (!viewport || viewport.clientHeight === 0) return;
      clearInterval(timer);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (cancelled) return;
          const match = resolveContentSearchMatch(
            editor.state.doc,
            target.query,
            target.snippet,
            target.location,
          );
          flushSync(() => {
            if (!match || match.annotation) {
              setFindSession(null);
              setFindQuery("");
              return;
            }
            setFindOptions({
              interpretSpecialCodes: false,
              caseSensitive: false,
              wholeWord: false,
              searchMode: "literal",
              useRegex: false,
            });
            setFindSession({
              mode: "find",
              scope: workspaceLayout.mode === "dual" ? workspaceLayout.activePane : "single",
              target: workspaceTarget,
              editorId: activeEditorId,
              bookmark: commandBus.captureSelection(activeEditorId),
            });
            setFindQuery(target.query);
          });
          if (match) {
            if (match.annotation) {
              // Finish the editor's queued focus restoration before focusing an attribute editor.
              requestAnimationFrame(() => {
                if (
                  !editor.isDestroyed &&
                  editor.view.dom.isConnected &&
                  viewport.clientHeight > 0 &&
                  !selectContentSearchAnnotation(editor, match)
                )
                  showAppAlert("文档已打开，该表格文字已变化，请更新搜索索引后重试。");
              });
            } else {
              editor.chain().setTextSelection(match).run();
              requestAnimationFrame(() => {
                if (!editor.isDestroyed && editor.view.dom.isConnected)
                  centerPatentIssue(editor, match.from, match.to, "smooth");
              });
            }
          } else
            showAppAlert(
              "文档已打开，但无法可靠定位原搜索片段，内容可能已变化。请更新搜索索引后重试。",
            );
          setContentSearchNavigation(null);
        });
      });
    };
    const timer = setInterval(attempt, 100);
    attempt();
    return () => {
      cancelled = true;
      clearInterval(timer);
      cancelAnimationFrame(frame);
    };
  }, [
    contentSearchNavigation,
    activeEditorId,
    commandBus,
    library.view,
    workspaceLayout.mode,
    workspaceLayout.activePane,
  ]);

  const changeFindSessionMode = useCallback(
    (mode: "find" | "replace" | null) => {
      if (!mode) {
        closeFindRail();
        return;
      }
      setFindSession((current) => (current ? { ...current, mode } : current));
    },
    [closeFindRail],
  );

  useEffect(() => {
    if (findSession && !sessionForDocumentTarget(patents.state.sessions, findSession.target)) {
      closeFindRail();
    }
  }, [closeFindRail, findSession, patents.state.sessions]);

  const activeAutomationReadOnly = Boolean(
    activePatentSession && patents.isAutomationReadOnly(activePatentSession.patentId),
  );
  const activeEditorCapabilities =
    patentsAvailable && activePatentSession && activeWorkspaceTarget?.kind === "book"
      ? capabilitiesForPatentBook(activePatentSession.activeBookKind)
      : ORDINARY_DOCUMENT_CAPABILITIES;
  const showTextEditingTools =
    !embeddedEditorActive &&
    (!patentsAvailable ||
      !activePatentSession ||
      activeWorkspaceTarget?.kind === "auxiliary" ||
      isTextPatentBook(activePatentSession.activeBookKind));
  // 说明书附图 / 摘要附图这类没有正文排版的文档：工具栏里的文字工具不再整组消失，
  // 而是照样占位并整组置灰，避免图标位置随书册跳变。由上面 showTextEditingTools 的定义可知，
  // 非内嵌工作区时它为 false 当且仅当当前是这类附图书册。
  const textEditingToolsDisabled = !embeddedEditorActive && !showTextEditingTools;
  const showDrawingInsertionTools =
    !embeddedEditorActive &&
    activeWorkspaceTarget?.kind === "book" &&
    activePatentSession?.activeBookKind === "description-drawings";
  const imageInsertionAvailable =
    !embeddedEditorActive &&
    (activePatentSession?.activeBookKind === "claims" ||
      activePatentSession?.activeBookKind === "description" ||
      activePatentSession?.activeBookKind === "description-drawings");
  const historyAvailable = !embeddedEditorActive;
  const historyUnavailableReason = drawingActive
    ? "CAD标号请使用编辑区内的撤销和重做按钮。"
    : "流程图请使用编辑器内的撤销和重做按钮。";
  const formatState = useActiveEditorFormatState(commandBus, activeEditorId);
  const editorHistoryState = useActiveEditorHistoryState(commandBus, activeEditorId);
  const drawingHistoryActive =
    activePatentSession?.activeBookKind === "description-drawings" ||
    activePatentSession?.activeBookKind === "abstract-drawing";
  const referenceHistoryBookKind =
    activePatentSession && isTextPatentBook(activePatentSession.activeBookKind)
      ? (activePatentSession.activeBookKind as "claims" | "description" | "abstract")
      : null;
  const canUndo = Boolean(
    historyAvailable &&
      (drawingHistoryActive && activePatentSession
        ? patents.canUndoDescriptionDrawing(activePatentSession.patentId)
        : referenceHistoryBookKind && activePatentSession
          ? patents.canUndoReferenceMarkOperation(
              activePatentSession.patentId,
              referenceHistoryBookKind,
            ) || editorHistoryState.canUndo
          : editorHistoryState.canUndo),
  );
  const canRedo = Boolean(
    historyAvailable &&
      (drawingHistoryActive && activePatentSession
        ? patents.canRedoDescriptionDrawing(activePatentSession.patentId)
        : referenceHistoryBookKind && activePatentSession
          ? patents.canRedoReferenceMarkOperation(
              activePatentSession.patentId,
              referenceHistoryBookKind,
            ) || editorHistoryState.canRedo
          : editorHistoryState.canRedo),
  );
  const executeSpecialPatentHistoryCommand = useCallback(
    (command: "undo" | "redo"): boolean | null => {
      const session = activePatentSession;
      if (!session) return null;
      if (activeWorkspaceTarget?.kind === "auxiliary") return null;
      const { patentId, activeBookKind } = session;
      if (activeBookKind === "description-drawings" || activeBookKind === "abstract-drawing") {
        return command === "undo"
          ? patents.undoDescriptionDrawing(patentId)
          : patents.redoDescriptionDrawing(patentId);
      }
      if (!isTextPatentBook(activeBookKind)) return null;
      const ownerBookKind = activeBookKind as "claims" | "description" | "abstract";
      if (command === "undo" && patents.canUndoReferenceMarkOperation(patentId, ownerBookKind)) {
        return patents.undoReferenceMarkOperation(patentId, ownerBookKind);
      }
      if (command === "redo" && patents.canRedoReferenceMarkOperation(patentId, ownerBookKind)) {
        return patents.redoReferenceMarkOperation(patentId, ownerBookKind);
      }
      return null;
    },
    [activePatentSession, activeWorkspaceTarget, patents],
  );
  const executeEditorCommand = useCallback(
    (command: Parameters<EditorCommandBus["execute"]>[1]) => {
      if (embeddedEditorActive || activeAutomationReadOnly) return false;
      if (command === "undo" || command === "redo") {
        const handled = executeSpecialPatentHistoryCommand(command);
        if (handled !== null) return handled;
      }
      return commandBus.execute(activeEditorId, command);
    },
    [
      activeEditorId,
      commandBus,
      executeSpecialPatentHistoryCommand,
      embeddedEditorActive,
      activeAutomationReadOnly,
    ],
  );
  useEffect(
    () =>
      commandBus.setPatentHistoryAdapter({
        canExecute(editorId, command) {
          for (const session of patents.state.sessions) {
            const book = session.patent.books.find(
              (candidate) => patentBookEditorId(session.sessionId, candidate.kind) === editorId,
            );
            if (!book) continue;
            return command === "undo"
              ? patents.canUndoReferenceMarkOperation(session.patentId, book.kind)
              : patents.canRedoReferenceMarkOperation(session.patentId, book.kind);
          }
          return false;
        },
        execute(editorId, command) {
          for (const session of patents.state.sessions) {
            const book = session.patent.books.find(
              (candidate) => patentBookEditorId(session.sessionId, candidate.kind) === editorId,
            );
            if (!book) continue;
            if (
              command === "undo" &&
              patents.canUndoReferenceMarkOperation(session.patentId, book.kind)
            ) {
              return patents.undoReferenceMarkOperation(session.patentId, book.kind);
            }
            if (
              command === "redo" &&
              patents.canRedoReferenceMarkOperation(session.patentId, book.kind)
            ) {
              return patents.redoReferenceMarkOperation(session.patentId, book.kind);
            }
          }
          return null;
        },
        onEdit(editorId) {
          for (const session of patents.state.sessions) {
            const book = session.patent.books.find(
              (candidate) => patentBookEditorId(session.sessionId, candidate.kind) === editorId,
            );
            if (book) patents.discardReferenceMarkRedo(session.patentId, book.kind);
          }
          commandBus.publishHistoryState();
        },
      }),
    [commandBus, patents],
  );
  useEffect(() => {
    const routePatentHistory = (event: KeyboardEvent) => {
      if (embeddedEditorActive) return;
      const command = historyCommandFromKeyboardEvent(event);
      if (!command) return;
      const session = activePatentSession;
      if (!session) return;
      if (activeWorkspaceTarget?.kind === "auxiliary") return;
      if (
        !shouldRoutePatentHistoryShortcut({
          activeBookKind: session.activeBookKind,
          modalOpen: hasVisibleElement("[role='dialog'], [aria-modal='true']"),
          target: event.target,
        })
      )
        return;
      const handled = executeSpecialPatentHistoryCommand(command);
      if (
        handled ||
        session.activeBookKind === "description-drawings" ||
        session.activeBookKind === "abstract-drawing"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", routePatentHistory, true);
    return () => window.removeEventListener("keydown", routePatentHistory, true);
  }, [
    activePatentSession,
    activeWorkspaceTarget,
    executeSpecialPatentHistoryCommand,
    embeddedEditorActive,
  ]);
  const preservePatentSelectionForPointer = usePatentEditorFocus({
    activeEditorId,
    enabled:
      patentsAvailable &&
      !embeddedEditorActive &&
      library.view === "editor" &&
      Boolean(activePatentSession) &&
      (activeWorkspaceTarget?.kind === "auxiliary" ||
        isTextPatentBook(activePatentSession?.activeBookKind)) &&
      !createPatentOpen &&
      !settingsPatent &&
      !patentExport &&
      !exportReport &&
      !printCenterRequest &&
      !physicsFormulaTarget &&
      !applicationSettingsOpen &&
      !customDualViewOpen &&
      !inventionContentSettingsOpen &&
      !appError,
    commandBus,
  });
  const patentCheckSession = patentCheckRequest
    ? (patents.state.sessions.find((session) => session.patentId === patentCheckRequest.patentId) ??
      null)
    : null;
  const activePatentInspection = useBackgroundPatentInspection(
    patentsAvailable ? (activePatentSession?.patent ?? null) : null,
    activePatentSession?.sessionId ?? null,
  );
  const requestedPatentInspection = useBackgroundPatentInspection(
    patentCheckSession && patentCheckSession.patentId !== activePatentSession?.patentId
      ? patentCheckSession.patent
      : null,
    patentCheckSession?.sessionId ?? null,
  );
  const patentCheckUsesActive =
    patentCheckSession !== null && patentCheckSession.patentId === activePatentSession?.patentId;
  const patentCheckInspection = patentCheckUsesActive
    ? activePatentInspection
    : requestedPatentInspection;
  const patentCheckReport = patentCheckInspection.fullReport ?? patentCheckInspection.report;
  const cancelPatentCheckInspection = patentCheckInspection.cancel;
  const patentCheckStale = patentCheckInspection.fullReport
    ? patentCheckInspection.fullReportStale
    : patentCheckInspection.stale;
  const patentCheckPhase: PatentCheckPhase =
    patentCheckRunToken === null
      ? "ready"
      : patentCheckInitialRunning || patentCheckReport === null
        ? "running"
        : "result";

  useEffect(() => {
    if (!patentCheckRequest || patentCheckSession) return;
    patentCheckRunGeneration.current++;
    cancelPatentCheckInspection();
    setPatentCheckRequest(null);
    setPatentCheckRunToken(null);
    setPatentCheckInitialRunning(false);
  }, [patentCheckRequest, patentCheckSession, cancelPatentCheckInspection]);

  useEffect(() => {
    if (!patentCheckRequest) return;
    return () => {
      patentCheckLocateGeneration.current++;
    };
  }, [patentCheckRequest]);

  useEffect(() => {
    if (patentCheckRequest?.pane !== "single") return;
    if (activePatentSession?.patentId === patentCheckRequest.patentId) return;
    cancelPatentCheckInspection();
    setPatentCheckRequest(null);
    setPatentCheckRunToken(null);
    setPatentCheckInitialRunning(false);
  }, [activePatentSession?.patentId, cancelPatentCheckInspection, patentCheckRequest]);

  useEffect(() => {
    if (library.view === "editor" || !patentCheckRequest) return;
    cancelPatentCheckInspection();
    setPatentCheckRequest(null);
    setPatentCheckRunToken(null);
    setPatentCheckInitialRunning(false);
  }, [library.view, cancelPatentCheckInspection, patentCheckRequest]);

  const patentCheckContextRef = useRef({
    request: patentCheckRequest,
    session: patentCheckSession,
  });
  patentCheckContextRef.current = { request: patentCheckRequest, session: patentCheckSession };
  const runPatentCheck = (initial: boolean) => {
    if (!patentCheckRequest || !patentCheckSession) return;
    const request = patentCheckRequest;
    const generation = ++patentCheckRunGeneration.current;
    const alive = () =>
      generation === patentCheckRunGeneration.current &&
      patentCheckContextRef.current.request === request &&
      patentCheckContextRef.current.session?.patentId === request.patentId;
    if (initial) {
      setPatentCheckRunToken(Date.now());
      setPatentCheckInitialRunning(true);
    }
    void (async () => {
      const prepared = await patents.preparePatentExport(request.patentId);
      if (!alive()) return;
      if (!prepared) {
        showAppAlert("当前正文尚未保存完成，请稍后重试。");
        if (initial) setPatentCheckRunToken(null);
        return;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (alive()) await patentCheckInspection.recheck();
    })()
      .catch(() => {
        if (alive()) showAppAlert("检查未完成，请稍后重试。");
      })
      .finally(() => {
        if (alive()) setPatentCheckInitialRunning(false);
      });
  };

  const workspaceAvailabilities = useMemo(
    () =>
      patents.state.sessions.map((session) => ({
        patentId: session.patentId,
        availableBookKinds: availablePatentBookKinds(session.patent),
        auxiliaryDocumentIds: [],
      })),
    [patents.state.sessions],
  );

  useEffect(() => {
    if (!patentsAvailable || workspaceLayout.mode === "dual") return;
    const target = patentTarget(patents.activeSession);
    if (samePatentTarget(workspaceLayout.singleTarget, target)) return;
    setWorkspaceLayout(createSingleWorkspace(target));
  }, [patents.activeSession, patentsAvailable, workspaceLayout.mode, workspaceLayout.singleTarget]);

  useEffect(() => {
    if (workspaceLayout.mode !== "dual") return;
    setWorkspaceLayout((current) => reconcileWorkspaceTargets(current, workspaceAvailabilities));
  }, [workspaceAvailabilities, workspaceLayout.mode]);

  useEffect(() => {
    if (workspaceLayout.mode !== "dual" || !windowLayout.fit || windowLayout.fit.allowed) return;
    retainSelectionsForLayoutChange();
    setLibraryPickerRequest(null);
    setWorkspaceLayout((current) => exitDualWorkspace(current));
    setWindowRestoreFit((request) => request + 1);
  }, [retainSelectionsForLayoutChange, windowLayout.fit, workspaceLayout]);

  useEffect(() => {
    if (workspaceLayout.mode !== "dual" || !activeWorkspaceTarget) return;
    const current = patents.activeSession;
    if (current?.patentId !== activeWorkspaceTarget.patentId) {
      patents.activatePatent(activeWorkspaceTarget.patentId);
    }
    if (activeWorkspaceTarget.kind === "tool") return;
    if (
      current?.patentId !== activeWorkspaceTarget.patentId ||
      (activeWorkspaceTarget.kind === "book"
        ? current.activeBookKind !== activeWorkspaceTarget.bookKind ||
          current.activeAuxiliaryDocumentId !== null
        : current.activeAuxiliaryDocumentId !== activeWorkspaceTarget.auxiliaryDocumentId)
    ) {
      if (activeWorkspaceTarget.kind === "book") {
        patents.activateBook(activeWorkspaceTarget.patentId, activeWorkspaceTarget.bookKind);
      } else {
        patents.activateAuxiliaryDocument(
          activeWorkspaceTarget.patentId,
          activeWorkspaceTarget.auxiliaryDocumentId,
        );
      }
    }
  }, [activeWorkspaceTarget, patents, workspaceLayout.mode]);

  const activatePane = useCallback((pane: WorkspacePane) => {
    setWorkspaceLayout((current) => activateWorkspacePane(current, pane));
  }, []);

  const selectTargetInPane = useCallback(
    async (pane: WorkspacePane, target: PatentDocumentTarget | PatentBookTarget) => {
      if ("kind" in target && target.kind === "tool") {
        const owner = patents.state.sessions.find(
          (session) => session.patentId === target.patentId,
        );
        if (!owner) return;
        if (target.tool === "drawing-markup") {
          if (drawingCloseOperation.current && !(await drawingCloseOperation.current)) return;
          if (drawingWorkspaceRef.current && !(await drawingWorkspaceRef.current.flush())) return;
          setDrawingForSession(owner.sessionId, owner.patentId);
          setDrawingShownForSession(owner.sessionId, true);
        } else {
          if (flowchartWorkspaceRef.current && !(await flowchartWorkspaceRef.current.flush()))
            return;
          setFlowchartForSession(owner.sessionId, (current) =>
            current?.patentId === owner.patentId
              ? { ...current, active: true }
              : {
                  patentId: owner.patentId,
                  patentRevision: owner.persistedRevision,
                  active: true,
                  initialProjectId: null,
                  defaultReplaceFigureId: null,
                  editorMode: "flowchart",
                },
          );
        }
      }
      setWorkspaceLayout((current) => {
        const other = pane === "left" ? "right" : "left";
        const otherState = current[other];
        const base =
          "kind" in target &&
          target.kind === "tool" &&
          otherState.kind === "document" &&
          otherState.target.kind === "tool" &&
          otherState.target.tool === target.tool &&
          otherState.target.patentId !== target.patentId
            ? {
                ...current,
                [other]: {
                  kind: "selection" as const,
                  selectedPatentId: otherState.target.patentId,
                },
              }
            : current;
        const selected = selectPaneTarget(base, pane, target);
        if (selected.revealedPane) return selected.state;
        return setWorkspacePaneZoom(selected.state, pane, windowLayout.fit?.fitZoomPercent ?? 100);
      });
    },
    [windowLayout.fit?.fitZoomPercent, patents.state.sessions, setDrawingForSession, setDrawingShownForSession, setFlowchartForSession],
  );

  useEffect(() => {
    const buildCycleTabs = (
      session: PatentSession,
      liveFlowchartWorkspace: { patentId: string } | null,
      liveDrawingMarkupPatentId: string | null,
    ) => {
      // Ctrl+Tab 循环序列：五书标签 + 已打开的流程图/CAD 标号工作区标签（标签存在才参与切换）。
      const tabs: Array<
        { kind: "book"; bookKind: PatentBookKind } | { kind: "tool"; tool: PatentWorkspaceTool }
      > = availablePatentBookKinds(session.patent).map((bookKind) => ({
        kind: "book" as const,
        bookKind,
      }));
      if (liveFlowchartWorkspace?.patentId === session.patentId) {
        tabs.push({ kind: "tool", tool: "flowchart" });
      }
      if (liveDrawingMarkupPatentId === session.patentId) {
        tabs.push({ kind: "tool", tool: "drawing-markup" });
      }
      return tabs;
    };

    const performCycleStep = async (offset: 1 | -1): Promise<void> => {
      const live = cycleLiveStateRef.current;
      if (!live) return;
      const target = live.target;
      if (!target) return;
      const session = live.sessions.find((candidate) => candidate.patentId === target.patentId);
      if (!session) return;
      const tabs = buildCycleTabs(session, live.flowchartWorkspace, live.drawingMarkupPatentId);
      if (tabs.length < 2) return;
      const currentIndex =
        live.workspaceLayout.mode === "dual"
          ? tabs.findIndex(
              (tab) =>
                tab.kind === target.kind &&
                (tab.kind === "tool" && target.kind === "tool"
                  ? tab.tool === target.tool
                  : tab.kind === "book" &&
                    target.kind === "book" &&
                    tab.bookKind === target.bookKind),
            )
          : live.flowchartActive
            ? tabs.findIndex((tab) => tab.kind === "tool" && tab.tool === "flowchart")
            : live.drawingActive
              ? tabs.findIndex((tab) => tab.kind === "tool" && tab.tool === "drawing-markup")
              : target.kind === "book"
                ? tabs.findIndex((tab) => tab.kind === "book" && tab.bookKind === target.bookKind)
                : -1;
      if (currentIndex < 0) return;
      const next = tabs[(currentIndex + offset + tabs.length) % tabs.length];
      if (!next) return;

      if (live.workspaceLayout.mode === "dual") {
        await selectTargetInPane(live.workspaceLayout.activePane, {
          patentId: target.patentId,
          ...next,
        });
        return;
      }

      if (next.kind === "tool" && next.tool === "flowchart") {
        // 与"流程图"标签点击行为一致。
        setDrawingMarkupShown(false);
        setFlowchartWorkspace((current) => (current ? { ...current, active: true } : current));
      } else if (next.kind === "tool" && next.tool === "drawing-markup") {
        // 与"CAD标号"标签点击行为一致。
        setFlowchartWorkspace((current) => (current ? { ...current, active: false } : current));
        setDrawingMarkupShown(true);
      } else if (next.kind === "book") {
        // 与五书标签点击行为一致。
        setDrawingMarkupShown(false);
        setFlowchartWorkspace((current) => (current ? { ...current, active: false } : current));
        patents.activateBook(target.patentId, next.bookKind);
      }
    };

    const runCycleQueue = async () => {
      if (cycleRunningRef.current) return;
      cycleRunningRef.current = true;
      try {
        while (cycleQueueRef.current.length > 0) {
          const offset = cycleQueueRef.current.shift();
          if (offset === undefined) break;
          await performCycleStep(offset);
          // 等待 React 提交切换后的状态，让下一步基于最新激活位置计算。
          await new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 0);
          });
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
      } finally {
        cycleRunningRef.current = false;
      }
    };

    const cyclePatentBook = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key !== "Tab" ||
        !event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        !patentsAvailable ||
        library.view !== "editor" ||
        hasVisibleElement("[role='dialog'], [aria-modal='true']")
      )
        return;
      const target = activeWorkspaceTarget;
      if (!target) return;
      const session = patents.state.sessions.find(
        (candidate) => candidate.patentId === target.patentId,
      );
      if (!session) return;
      if (buildCycleTabs(session, flowchartWorkspace, drawingMarkupPatentId).length < 2) {
        return;
      }
      // 同步吞掉按键（连按不触发 Tab 焦点移动），方向入队由消费者逐步切换。
      event.preventDefault();
      event.stopImmediatePropagation();
      cycleQueueRef.current.push(event.shiftKey ? -1 : 1);
      void runCycleQueue();
    };
    window.addEventListener("keydown", cyclePatentBook, true);
    return () => window.removeEventListener("keydown", cyclePatentBook, true);
  }, [
    activeWorkspaceTarget,
    drawingMarkupPatentId,
    flowchartWorkspace,
    library.view,
    patents.activateBook,
    patents.state.sessions,
    patentsAvailable,
    selectTargetInPane,
    setDrawingMarkupShown,
    setFlowchartWorkspace,
  ]);

  const openPickerInPane = useCallback((pane: WorkspacePane) => {
    setWorkspaceLayout((current) => {
      if (current.mode !== "dual") return current;
      const currentTarget = targetForPane(current, pane);
      const otherTarget = targetForPane(current, pane === "left" ? "right" : "left");
      const selection: PaneWorkspaceState = {
        kind: "selection",
        selectedPatentId: currentTarget?.patentId ?? otherTarget?.patentId ?? null,
      };
      return { ...current, activePane: pane, [pane]: selection };
    });
  }, []);

  const selectPickerPatent = useCallback((pane: WorkspacePane, patentId: string) => {
    setWorkspaceLayout((current) => {
      if (current.mode !== "dual") return current;
      return {
        ...current,
        activePane: pane,
        [pane]: { kind: "selection", selectedPatentId: patentId },
      };
    });
  }, []);

  const closePane = useCallback(
    (pane: WorkspacePane) => {
      const nextLayout = closeDualWorkspacePane(workspaceLayout, pane);
      const retainedTarget = nextLayout.singleTarget;
      void runWorkspaceLayoutSwitch("exit-dual", async (transition) => {
        retainSelectionsForLayoutChange();
        await transition.commit(() => {
          flushSync(() => {
            setLibraryPickerRequest(null);
            setWorkspaceLayout(nextLayout);
            if (!retainedTarget) return;
            patents.activatePatent(retainedTarget.patentId);
            if (retainedTarget.kind === "book") {
              patents.activateBook(retainedTarget.patentId, retainedTarget.bookKind);
            } else if (retainedTarget.kind === "auxiliary") {
              patents.activateAuxiliaryDocument(
                retainedTarget.patentId,
                retainedTarget.auxiliaryDocumentId,
              );
            }
          });
        });
      }).catch(() => showAppAlert("无法切换页面布局，请重试。"));
    },
    [patents, retainSelectionsForLayoutChange, runWorkspaceLayoutSwitch, workspaceLayout],
  );

  const openPaneAsSingle = useCallback(
    (pane: WorkspacePane) => {
      const paneState = workspaceLayout[pane];
      if (paneState.kind !== "document") return;
      const target = paneState.target;
      void runWorkspaceLayoutSwitch("exit-dual", async (transition) => {
        retainSelectionsForLayoutChange();
        await transition.commit(() => {
          flushSync(() => {
            setLibraryPickerRequest(null);
            setWorkspaceLayout((current) => exitDualWorkspace(current, target));
            patents.activatePatent(target.patentId);
            if (target.kind === "book") patents.activateBook(target.patentId, target.bookKind);
          });
        });
      }).catch(() => showAppAlert("无法切换页面布局，请重试。"));
    },
    [patents, retainSelectionsForLayoutChange, runWorkspaceLayoutSwitch, workspaceLayout],
  );

  const selectPatentInActivePane = useCallback(
    (patentId: string) => {
      if (workspaceLayout.mode !== "dual") {
        patents.activatePatent(patentId);
        return;
      }
      const session = patents.state.sessions.find((candidate) => candidate.patentId === patentId);
      if (!session) return;
      const pane = workspaceLayout.activePane;
      const opposite = targetForPane(workspaceLayout, pane === "left" ? "right" : "left");
      const available = availablePatentBookKinds(session.patent);
      const preferred = available.includes(session.activeBookKind)
        ? session.activeBookKind
        : available[0];
      const kind =
        preferred && !samePatentTarget({ patentId, bookKind: preferred }, opposite)
          ? preferred
          : available.find(
              (candidate) => !samePatentTarget({ patentId, bookKind: candidate }, opposite),
            );
      if (!kind) {
        selectPickerPatent(pane, patentId);
        return;
      }
      selectTargetInPane(pane, { patentId, bookKind: kind });
    },
    [patents, selectPickerPatent, selectTargetInPane, workspaceLayout],
  );

  const requestDualLayout = useCallback(
    async (transition?: WorkspaceLayoutTransition) => {
      // All entry points (quick pairs, presets and tab drops) leave column mode.
      if (columnsRequested) {
        const restored = await window.patentApi.application.setDualColumnWindow({
          enabled: false,
          pageWidth: 820,
        });
        if (transition?.cancelled) return null;
        if (!restored.ok) {
          showAppAlert("无法恢复窗口大小，请重试。");
          return null;
        }
      }
      const result = await windowLayout.requestDualView();
      if (transition?.cancelled) return null;
      if (!result.ok) {
        showAppAlert(result.reason);
        return null;
      }
      return result.fit;
    },
    [columnsRequested, windowLayout],
  );

  const commitWorkspaceTabDrop = useCallback(
    async (
      target: PatentDocumentTargetInput,
      pane: WorkspacePane,
      _effect: WorkspaceTabDropEffect,
      source: WorkspaceTabDragSource,
    ): Promise<boolean> => {
      const session = sessionForDocumentTarget(patents.state.sessions, target);
      if (!session) return false;
      const toolTarget =
        source.toolLaunch && "kind" in target && target.kind === "tool" ? target : null;
      const prepareTool = async () => {
        if (!toolTarget) return true;
        if (toolTarget.tool === "drawing-markup" && drawingCloseOperation.current &&
          !(await drawingCloseOperation.current)) return false;
        const workspace =
          toolTarget.tool === "drawing-markup"
            ? drawingWorkspaceRef.current
            : flowchartWorkspaceRef.current;
        // Keep the previous patent's tool draft safe before transferring its single host.
        try {
          return !workspace || (await workspace.flush());
        } catch {
          showAppAlert("工具草稿保存失败，请重试后再拖入。");
          return false;
        }
      };
      const commitTool = () => {
        if (!toolTarget) return;
        if (toolTarget.tool === "drawing-markup") {
          setDrawingForSession(session.sessionId, session.patentId);
          setDrawingShownForSession(session.sessionId, true);
        } else {
          setFlowchartForSession(session.sessionId, (current) =>
            current?.patentId === session.patentId
              ? {
                  ...current,
                  active: true,
                  editorMode: source.toolLaunch?.editorMode ?? current.editorMode,
                }
              : {
                  patentId: session.patentId,
                  patentRevision: session.persistedRevision,
                  active: true,
                  initialProjectId: null,
                  defaultReplaceFigureId: null,
                  editorMode: source.toolLaunch?.editorMode ?? "flowchart",
                },
          );
        }
      };
      const drop = (current: PatentWorkspaceLayoutState) => {
        const other = pane === "left" ? "right" : "left";
        const otherState = current[other];
        // Each tool has one persistent host, just as with the pane picker.
        const base =
          toolTarget &&
          current.mode === "dual" &&
          otherState.kind === "document" &&
          otherState.target.kind === "tool" &&
          otherState.target.tool === toolTarget.tool &&
          otherState.target.patentId !== toolTarget.patentId
            ? {
                ...current,
                [other]: {
                  kind: "selection" as const,
                  selectedPatentId: otherState.target.patentId,
                },
              }
            : current;
        return dropTargetIntoWorkspace(base, pane, target, displayedSingleTarget);
      };
      if (workspaceLayout.mode === "dual") {
        const fit = windowLayout.fit;
        if (!fit) return false;
        if (!(await prepareTool())) return false;
        retainSelectionsForLayoutChange();
        flushSync(() => {
          commitTool();
          setLibraryPickerRequest(null);
          setPaneSwitcherPatentRequest(null);
          setWorkspaceLayout(drop);
        });
        return true;
      }
      return (
        (await runWorkspaceLayoutSwitch("enter-dual", async (transition) => {
          const fit = await requestDualLayout(transition);
          if (!fit) {
            transition.cancel();
            return false;
          }
          if (!(await prepareTool()) || transition.cancelled) {
            transition.cancel();
            return false;
          }
          retainSelectionsForLayoutChange();
          await transition.commit(() => {
            flushSync(() => {
              commitTool();
              setLibraryPickerRequest(null);
              setPaneSwitcherPatentRequest(null);
              setColumnsRequested(false);
              setWorkspaceLayout((current) => {
                const next = drop(current);
                return setWorkspacePaneZoom(
                  setWorkspacePaneZoom(next, "left", fit.fitZoomPercent),
                  "right",
                  fit.fitZoomPercent,
                );
              });
            });
          });
          return true;
        })) ?? false
      );
    },
    [
      patents.state.sessions,
      requestDualLayout,
      retainSelectionsForLayoutChange,
      runWorkspaceLayoutSwitch,
      windowLayout.fit,
      workspaceLayout.mode,
      displayedSingleTarget,
      setDrawingForSession,
      setDrawingShownForSession,
      setFlowchartForSession,
    ],
  );

  const workspaceTabDragEnabled =
    patentsAvailable && library.view === "editor" && Boolean(activePatentSession);
  const workspaceTabDrag = usePatentWorkspaceTabDrag({
    enabled: workspaceTabDragEnabled,
    layout: workspaceLayout,
    singleCurrentTarget: displayedSingleTarget,
    getWorkspaceRect: () => {
      // 内嵌 CAD标号/流程图 独占单屏时标准工作区被隐藏（rect 归零），改测主视图容器。
      const region =
        embeddedEditorActive && workspaceLayout.mode === "single"
          ? mainViewStageNodeRef.current
          : standardWorkspaceRef.current;
      const element = region ?? mainViewStageNodeRef.current ?? standardWorkspaceRef.current;
      return element?.getBoundingClientRect() ?? null;
    },
    onDrop: commitWorkspaceTabDrop,
  });
  const workspaceTabDragPreview =
    workspaceTabDrag.session?.status === "dragging" ? workspaceTabDrag.session : null;

  const toggleDualView = useCallback(async () => {
    const pendingRequest = workspaceLayoutSwitchPending.current;
    const pendingDirection = pendingRequest?.direction;
    const retainedLayout =
      pendingDirection === "exit-dual" ? pendingRequest?.retainedLayout : undefined;
    const dualRequested = pendingDirection
      ? pendingDirection === "enter-dual"
      : workspaceLayout.mode === "dual";
    if (dualRequested) {
      await runWorkspaceLayoutSwitch(
        "exit-dual",
        async (transition) => {
          retainSelectionsForLayoutChange();
          await transition.commit(
            () => {
              flushSync(() => setWorkspaceLayout((current) => exitDualWorkspace(current)));
            },
            { retainLayout: workspaceLayout.mode === "single" },
          );
        },
        workspaceLayout.mode === "dual" ? workspaceLayout : undefined,
      );
      return;
    }
    if (workspaceLayout.mode !== "dual" && !workspaceLayout.singleTarget) {
      showAppAlert("请先打开或新建专利后再使用同屏双显。");
      return;
    }
    await runWorkspaceLayoutSwitch("enter-dual", async (transition) => {
      // An inverse click during exit retains the two documents and their positions.
      if (workspaceLayout.mode === "dual") {
        await transition.commit(() => {}, { retainLayout: true });
        return;
      }
      const fit = await requestDualLayout(transition);
      if (transition.cancelled) return;
      if (!fit) {
        transition.cancel();
        return;
      }
      retainSelectionsForLayoutChange();
      await transition.commit(() => {
        flushSync(() => {
          setColumnsRequested(false);
          setWorkspaceLayout(
            (current) =>
              retainedLayout ??
              setWorkspacePaneZoom(
                enterDualWorkspace(
                  drawingActive && drawingMarkupPatentId
                    ? createSingleWorkspace({
                        patentId: drawingMarkupPatentId,
                        kind: "tool",
                        tool: "drawing-markup",
                      })
                    : flowchartActive && flowchartWorkspace
                      ? createSingleWorkspace({
                          patentId: flowchartWorkspace.patentId,
                          kind: "tool",
                          tool: "flowchart",
                        })
                      : current,
                ),
                "left",
                fit.fitZoomPercent,
              ),
          );
        });
      });
    });
  }, [
    requestDualLayout,
    retainSelectionsForLayoutChange,
    runWorkspaceLayoutSwitch,
    workspaceLayout,
    drawingActive,
    drawingMarkupPatentId,
    flowchartActive,
    flowchartWorkspace,
  ]);

  const selectQuickPair = useCallback(
    async (pair: PatentWorkspacePair) => {
      const target = activeWorkspaceTarget ?? patentTarget(patents.activeSession);
      if (!target) return;
      const session = patents.state.sessions.find(
        (candidate) => candidate.patentId === target.patentId,
      );
      if (!session) return;
      await runWorkspaceLayoutSwitch("enter-dual", async (transition) => {
        const fit = await requestDualLayout(transition);
        if (!fit) {
          transition.cancel();
          return;
        }
        retainSelectionsForLayoutChange();
        await transition.commit(() => {
          flushSync(() => {
            setColumnsRequested(false);
            setWorkspaceLayout((current) => {
              const paired = applyWorkspacePair(
                current,
                session.patentId,
                pair,
                availablePatentBookKinds(session.patent),
              );
              return setWorkspacePaneZoom(
                setWorkspacePaneZoom(paired, "left", fit.fitZoomPercent),
                "right",
                fit.fitZoomPercent,
              );
            });
          });
        });
      });
    },
    [
      activeWorkspaceTarget,
      patents.activeSession,
      patents.state.sessions,
      requestDualLayout,
      retainSelectionsForLayoutChange,
      runWorkspaceLayoutSwitch,
    ],
  );

  const selectCustomDualViewPreset = useCallback(
    async (index: number) => {
      const preset = documents.settings.customDualViewPresets[index];
      if (!preset) return;
      const target = activeWorkspaceTarget ?? patentTarget(patents.activeSession);
      if (!target) {
        showAppAlert("请先打开或新建专利后再使用同屏双显。");
        return;
      }
      const session = patents.state.sessions.find(
        (candidate) => candidate.patentId === target.patentId,
      );
      if (!session) return;
      const availableBookKinds = availablePatentBookKinds(session.patent);
      if (!isCustomDualViewPresetAvailable(preset, availableBookKinds)) {
        showAppAlert("当前专利未启用说明书附图");
        return;
      }
      const kinds = [preset.leftBookKind, preset.rightBookKind];
      const usesDrawing = kinds.includes("drawing-markup");
      const usesFlowchart = kinds.includes("flowchart");
      await runWorkspaceLayoutSwitch("enter-dual", async (transition) => {
        const fit = await requestDualLayout(transition);
        if (!fit) {
          transition.cancel();
          return;
        }
        try {
          if (
            (usesDrawing && drawingCloseOperation.current && !(await drawingCloseOperation.current)) ||
            (usesDrawing &&
              drawingWorkspaceRef.current &&
              !(await drawingWorkspaceRef.current.flush())) ||
            (usesFlowchart &&
              flowchartWorkspaceRef.current &&
              !(await flowchartWorkspaceRef.current.flush()))
          ) {
            showAppAlert("工具草稿保存失败，请重试后再打开预设。");
            transition.cancel();
            return;
          }
        } catch {
          showAppAlert("工具草稿保存失败，请重试后再打开预设。");
          transition.cancel();
          return;
        }
        if (transition.cancelled) return;
        retainSelectionsForLayoutChange();
        await transition.commit(() => {
          flushSync(() => {
            if (usesDrawing) {
              setDrawingForSession(session.sessionId, session.patentId);
              setDrawingShownForSession(session.sessionId, true);
            }
            if (usesFlowchart) {
              setFlowchartForSession(session.sessionId, (current) =>
                current?.patentId === session.patentId
                  ? { ...current, active: true }
                  : {
                      patentId: session.patentId,
                      patentRevision: session.persistedRevision,
                      active: true,
                      initialProjectId: null,
                      defaultReplaceFigureId: null,
                      editorMode: "flowchart",
                    },
              );
            }
            setColumnsRequested(false);
            setWorkspaceLayout((current) => {
              const paired = applyWorkspaceCustomDualViewPreset(
                current,
                session.patentId,
                preset,
                availableBookKinds,
              );
              return setWorkspacePaneZoom(
                setWorkspacePaneZoom(paired, "left", fit.fitZoomPercent),
                "right",
                fit.fitZoomPercent,
              );
            });
          });
        });
      }, undefined, `${session.patentId}:${preset.leftBookKind}:${preset.rightBookKind}`);
    },
    [
      activeWorkspaceTarget,
      documents.settings.customDualViewPresets,
      patents.activeSession,
      patents.state.sessions,
      requestDualLayout,
      retainSelectionsForLayoutChange,
      runWorkspaceLayoutSwitch,
      setDrawingForSession,
      setDrawingShownForSession,
      setFlowchartForSession,
    ],
  );

  useEffect(() => onApplicationError(setAppError), []);

  // ── 编辑器缩放 ──
  const columnsActive =
    columnsRequested &&
    workspaceLayout.mode === "single" &&
    Boolean(
      activePatentSession &&
        supportsDualColumns(activePatentSession.activeBookKind) &&
        !activePatentSession.activeAuxiliaryDocumentId,
    );
  const exitColumns = useCallback(
    async (preserveBounds = false) => {
      await runWorkspaceLayoutSwitch("exit-columns", async (transition) => {
        const restored = await window.patentApi.application.setDualColumnWindow({
          enabled: false,
          pageWidth: 820,
          preserveBounds,
        });
        if (transition.cancelled) return;
        if (!restored.ok) {
          transition.cancel();
          showAppAlert("无法退出双列显示，请重试。");
          return;
        }
        await transition.commit(() => {
          flushSync(() => {
            setColumnsRequested(false);
            if (preserveBounds) setWindowRestoreFit((request) => request + 1);
          });
        });
      });
    },
    [runWorkspaceLayoutSwitch],
  );
  const previousWindowMaximized = useRef(windowLayout.layout?.isMaximized);
  useEffect(() => {
    const maximized = windowLayout.layout?.isMaximized;
    const restored = previousWindowMaximized.current === true && maximized === false;
    previousWindowMaximized.current = maximized;
    if (restored && columnsRequested)
      void exitColumns(true).catch(() => showAppAlert("无法恢复单列显示，请重试。"));
  }, [windowLayout.layout?.isMaximized, columnsRequested, exitColumns]);
  const handleZoom = useCallback(
    (delta: number, multiplicative = false, hoveredPane?: WorkspacePane) => {
      const decreasing = multiplicative ? delta < 1 : delta < 0;
      const apply = (from: number) =>
        clampZoom(multiplicative ? from * delta : from + delta, !multiplicative);
      if (columnsActive) {
        setColumnZoomPercent((current) => Math.min(zoomLimits.columns, apply(current)));
        return;
      }
      setWorkspaceLayout((current) => {
        if (current.mode !== "dual") return current;
        const side = hoveredPane ?? current.activePane;
        const pane = current[side];
        if (pane.kind !== "document") return current;
        const from = pane.dualZoomPercent;
        return setWorkspacePaneZoom(current, side, Math.min(zoomLimits[side], apply(from)), true);
      });
      if (workspaceLayout.mode !== "dual") {
        // Zoom out from the visible scale; zoom in retains the remembered preference.
        setZoomPercent((current) =>
          apply(decreasing ? Math.min(current, zoomLimits.single) : current),
        );
      }
    },
    [workspaceLayout.mode, columnsActive, zoomLimits],
  );

  const resetZoom = useCallback(() => {
    if (columnsActive) {
      window.dispatchEvent(new Event(DUAL_COLUMN_REFIT));
      setColumnZoomPercent(100);
      return;
    }
    if (workspaceLayout.mode === "dual") {
      setWorkspaceLayout((current) =>
        setWorkspacePaneZoom(
          current,
          current.activePane,
          Math.min(100, zoomLimits[current.activePane]),
          true,
        ),
      );
      return;
    }
    setZoomPercent(100);
  }, [workspaceLayout.mode, columnsActive, zoomLimits]);

  const activePaneState = workspaceLayout[workspaceLayout.activePane];
  const activeZoomPercent = columnsActive
    ? columnZoomPercent
    : workspaceLayout.mode === "dual" && activePaneState.kind === "document"
      ? activePaneState.dualZoomPercent
      : zoomPercent;
  const activeZoomLimit = columnsActive
    ? zoomLimits.columns
    : workspaceLayout.mode === "dual"
      ? zoomLimits[workspaceLayout.activePane]
      : activePatentSession && library.view === "editor"
        ? zoomLimits.single
        : 200;
  // The status bar describes the same bounded scale that is rendered in the active pane.
  const effectiveZoomPercent = Math.min(activeZoomPercent, activeZoomLimit);

  useFitPatentOnOpen(
    patentsAvailable && library.view === "editor" && activePatentSession
      ? `${activePatentSession.sessionId}:${activePatentSession.activeBookKind}:${activePatentSession.activeAuxiliaryDocumentId ?? ""}:${windowRestoreFit}`
      : null,
    workspaceLayout.mode === "single" && !columnsRequested,
    (max) => reportZoomLimit("single", max),
    zoomPercent,
  );

  useWorkspaceZoomInput(handleZoom, resetZoom);

  const showError = (error: AppError) => {
    if (error.code !== "CANCELLED") setAppError(error);
  };

  const showInternalError = () => {
    setAppError({ code: "INTERNAL", message: "Local operation failed" });
  };

  const runSafely = (operation: Promise<unknown>) => {
    void operation.catch(() => showInternalError());
  };

  const runFileOperation = async <T,>(message: string, operation: () => Promise<T>) => {
    if (fileOperationRunning.current) return undefined;
    fileOperationRunning.current = true;
    setFileOperationMessage(message);
    try {
      return await operation();
    } finally {
      fileOperationRunning.current = false;
      setFileOperationMessage(null);
    }
  };

  const activeExportRequest = (): ExportRequest | null => {
    if (patentsAvailable && activePatentSession) {
      const session = activePatentSession;
      if (session.patent.patentType === "design") return null;
      const patentName = session.patent.name ?? "未命名专利";
      if (activeWorkspaceTarget?.kind === "auxiliary") {
        const auxiliary = session.patent.auxiliaryDocuments.find(
          (document) => document.auxiliaryDocumentId === activeWorkspaceTarget.auxiliaryDocumentId,
        );
        if (!auxiliary) return null;
        return {
          sessionId: session.sessionId,
          document: {
            ...auxiliary.document,
            title: auxiliary.title,
            patentType: session.patent.patentType,
            assets: session.patent.assets,
          },
          suggestedName: createDocxSuggestedName(`${patentName}-${auxiliary.title}`),
        };
      }
      const activeBook = session.patent.books.find((book) => book.kind === session.activeBookKind);
      if (!activeBook) return null;
      return {
        sessionId: session.sessionId,
        document: {
          ...activeBook.document,
          patentType: session.patent.patentType,
          assets: session.patent.assets,
        },
        suggestedName: createDocxSuggestedName(`${patentName}-${activeBook.document.title}`),
      };
    }
    const session = documents.activeSession;
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      document: session.model,
      suggestedName: createDocxSuggestedName(session.model.title),
    };
  };

  const exportPatentDocx = async (
    mode: PatentExportMode,
    bookKind: PatentBookKind,
    suggestedName?: string,
  ) => {
    await runFileOperation("正在生成并保存 DOCX…", async () => {
      const prepared = await patents.prepareActivePatentExport();
      if (!prepared) return;
      const request = { ...prepared, suggestedName: suggestedName ?? prepared.suggestedName };
      try {
        const result = await window.patentApi.exports.patentDocx(
          mode === "combined"
            ? { ...request, mode: "combined" }
            : { ...request, mode: "single", bookKind },
        );
        if (!result.ok) {
          if (result.error.outputPath && result.error.issues?.length) {
            setExportReport({
              format: "docx",
              outputPath: result.error.outputPath,
              issues: result.error.issues,
            });
            return;
          }
          showError(result.error);
          return;
        }
        if (result.value) setExportReport(result.value);
      } catch {
        showInternalError();
      }
    });
  };

  const exportDocx = async (request: ExportRequest | null = activeExportRequest()) => {
    if (patentsAvailable && activePatentSession && request === null) {
      await exportPatentDocx("combined", activePatentSession.activeBookKind);
      return;
    }
    if (!request) return;
    await runFileOperation("正在生成并保存 DOCX…", async () => {
      try {
        const result = await window.patentApi.exports.docx(request);
        if (!result.ok) {
          if (result.error.outputPath && result.error.issues?.length) {
            setExportReport({
              format: "docx",
              outputPath: result.error.outputPath,
              issues: result.error.issues,
            });
            return;
          }
          showError(result.error);
          return;
        }
        if (result.value) setExportReport(result.value);
      } catch {
        showInternalError();
      }
    });
  };

  const exportPatentPdf = async (
    mode: PatentExportMode,
    bookKind: PatentBookKind,
    suggestedName?: string,
  ) => {
    await runFileOperation("正在生成并保存 PDF…", async () => {
      const prepared = await patents.prepareActivePatentExport();
      if (!prepared) return;
      const request = { ...prepared, suggestedName: suggestedName ?? prepared.suggestedName };
      try {
        const result = await window.patentApi.exports.patentPdf(
          mode === "combined"
            ? { ...request, mode: "combined" }
            : { ...request, mode: "single", bookKind },
        );
        if (!result.ok) {
          showError(result.error);
          return;
        }
        if (result.value) setExportReport(result.value);
      } catch {
        showInternalError();
      }
    });
  };

  const exportPdf = async (request: ExportRequest | null = activeExportRequest()) => {
    if (patentsAvailable && activePatentSession && request === null) {
      await exportPatentPdf("combined", activePatentSession.activeBookKind);
      return;
    }
    if (!request) return;
    await runFileOperation("正在生成并保存 PDF…", async () => {
      try {
        const result = await window.patentApi.exports.pdf(request);
        if (!result.ok) {
          showError(result.error);
          return;
        }
        if (result.value) setExportReport(result.value);
      } catch {
        showInternalError();
      }
    });
  };

  const openPrintCenter = async () => {
    const request = activeExportRequest();
    const sessionTargetId =
      patentsAvailable && activePatentSession
        ? activePatentSession.patentId
        : documents.activeSession?.model.documentId;
    if (!request || !sessionTargetId) return;
    const snapshot =
      patentsAvailable && activePatentSession
        ? createPatentPrintSnapshot(activePatentSession.patent, activePatentSession.activeBookKind)
        : null;
    setPrintCenterRequest({
      ...request,
      sessionTargetId,
      ...(snapshot
        ? {
            document:
              activeWorkspaceTarget?.kind === "auxiliary" ? request.document : snapshot.current,
            documents: snapshot.documents,
            figureLabels: snapshot.figureLabels,
            combinedSuggestedName: createDocxSuggestedName(
              `${activePatentSession?.patent.name ?? "未命名专利"}-全部五书`,
            ),
          }
        : {}),
    });
  };

  const requestPatentExport = (format: PatentExportFormat) => {
    const session = activePatentSession;
    if (!patentsAvailable || !session) {
      if (format === "patdoc") runSafely(documents.saveActiveDocumentAs());
      else runSafely(format === "docx" ? exportDocx() : exportPdf());
      return;
    }
    if (activeWorkspaceTarget?.kind === "auxiliary") {
      const auxiliary = session.patent.auxiliaryDocuments.find(
        (document) => document.auxiliaryDocumentId === activeWorkspaceTarget.auxiliaryDocumentId,
      );
      if (!auxiliary) return;
      runSafely(
        runFileOperation(`正在生成并保存 ${format === "docx" ? "DOCX" : "PDF"}…`, async () => {
          const prepared = await patents.prepareActivePatentExport();
          if (!prepared) return;
          const request = {
            ...prepared,
            auxiliaryDocumentId: auxiliary.auxiliaryDocumentId,
            suggestedName: createDocxSuggestedName(
              `${session.patent.name ?? "未命名专利"}-${auxiliary.title}`,
            ),
          };
          const result =
            format === "docx"
              ? await window.patentApi.exports.auxiliaryDocx(request)
              : await window.patentApi.exports.auxiliaryPdf(request);
          if (!result.ok) {
            if (result.error.outputPath && result.error.issues?.length) {
              setExportReport({
                format,
                outputPath: result.error.outputPath,
                issues: result.error.issues,
              });
              return;
            }
            showError(result.error);
            return;
          }
          if (result.value) setExportReport(result.value);
        }),
      );
      return;
    }
    const patentTypeName = session.patent.patentType === "invention" ? "发明" : "新型";
    setPatentExport({
      requestId: ++patentExportRequestId.current,
      format,
      bookKind: session.activeBookKind,
      suggestedName: createDocxSuggestedName(
        `${session.patent.name ?? "未命名专利"}（${patentTypeName}）`,
      ),
    });
  };

  const confirmPatentExport = async (
    format: PatentExportFormat,
    mode: PatentExportMode,
    suggestedName: string,
  ) => {
    const request = patentExport;
    if (!request) return;
    setPatentExport(null);
    const safeSuggestedName = createDocxSuggestedName(suggestedName);
    if (format === "patdoc") await exportCurrentPatdoc(safeSuggestedName);
    else if (format === "docx") await exportPatentDocx(mode, request.bookKind, safeSuggestedName);
    else await exportPatentPdf(mode, request.bookKind, safeSuggestedName);
  };

  const printDocument = async () => {
    await openPrintCenter();
  };

  const restoredPatdocSessions = useRef(new Set<string>());
  const pendingPatdocSelections = useRef(new Map<string, { from: number; to: number }>());
  useEffect(
    () =>
      commandBus.subscribeEditors((editorId, editor) => {
        const selection = pendingPatdocSelections.current.get(editorId);
        if (!editor || !selection) return;
        const size = editor.state.doc.content.size;
        editor.commands.setTextSelection({
          from: Math.min(size, selection.from),
          to: Math.min(size, selection.to),
        });
        pendingPatdocSelections.current.delete(editorId);
      }),
    [commandBus],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore the imported view once from the initial session snapshot.
  useEffect(() => {
    const session = activePatentSession;
    if (!session || restoredPatdocSessions.current.has(session.sessionId)) return;
    restoredPatdocSessions.current.add(session.sessionId);
    const saved = readPatdocWorkspace(session.patent);
    if (!saved) return;
    let active = true;
    setZoomPercent(clampZoom(saved.zoomPercent));
    setColumnZoomPercent(saved.columnZoomPercent);
    setColumnsRequested(saved.columns && supportsDualColumns(saved.activeBookKind));
    setAiCorrectionOpen(isNetworkAiAvailable() && saved.aiCorrectionOpen);
    setTextPolishOpen(isNetworkAiAvailable() && saved.assistantOpen);
    for (const book of saved.books)
      patentBookViewportStore.write(`${session.patentId}:${book.bookKind}`, book.scrollTop);
    const available = availablePatentBookKinds(session.patent);
    if (
      saved.dual &&
      available.includes(saved.dual.left.bookKind) &&
      available.includes(saved.dual.right.bookKind)
    ) {
      const pane = (value: NonNullable<PatdocWorkspace["dual"]>["left"]) => ({
        kind: "document" as const,
        target: { kind: "book" as const, patentId: session.patentId, bookKind: value.bookKind },
        dualZoomPercent: value.zoomPercent,
        dualZoomManual: true,
      });
      const dual = saved.dual;
      // Saved dual layouts use the same native-window preparation as toolbar entry.
      // Committing before that preparation would immediately exit a restored dual view.
      void requestDualLayout()
        .then((fit) => {
          if (!active || !fit) return;
          setColumnsRequested(false);
          setWorkspaceLayout({
            mode: "dual",
            activePane: dual.activePane,
            singleTarget: {
              kind: "book",
              patentId: session.patentId,
              bookKind: saved.activeBookKind,
            },
            left: pane(dual.left),
            right: pane(dual.right),
          });
        })
        .catch(() => {
          if (active) showAppAlert("无法恢复文档的同屏双显布局，请重试。");
        });
    }
    for (const book of saved.books) {
      if (book.selection) {
        const editorId = patentBookEditorId(session.sessionId, book.bookKind);
        const editor = commandBus.getEditor(patentBookEditorId(session.sessionId, book.bookKind));
        if (editor) {
          const size = editor.state.doc.content.size;
          editor.commands.setTextSelection({
            from: Math.min(size, book.selection.from),
            to: Math.min(size, book.selection.to),
          });
        } else pendingPatdocSelections.current.set(editorId, book.selection);
      }
    }
    return () => {
      active = false;
    };
  }, [activePatentSession?.sessionId, commandBus, patentBookViewportStore]);

  const exportCurrentPatdoc = async (suggestedName?: string) => {
    const session = activePatentSession;
    const pane = (value: PaneWorkspaceState) =>
      value.kind === "document" &&
      value.target.kind === "book" &&
      value.target.patentId === session?.patentId
        ? { bookKind: value.target.bookKind, zoomPercent: value.dualZoomPercent }
        : null;
    const left = pane(workspaceLayout.left);
    const right = pane(workspaceLayout.right);
    const workspace: PatdocWorkspace | undefined = session
      ? {
          version: 1,
          activeBookKind: session.activeBookKind,
          zoomPercent,
          columns: columnsRequested,
          columnZoomPercent,
          ...(workspaceLayout.mode === "dual" && left && right
            ? { dual: { left, right, activePane: workspaceLayout.activePane } }
            : {}),
          books: session.patent.books.map((book) => {
            const editorId = patentBookEditorId(session.sessionId, book.kind);
            const editor = commandBus.getEditor(editorId);
            const selection =
              editor?.state.selection ?? pendingPatdocSelections.current.get(editorId);
            return {
              bookKind: book.kind,
              scrollTop: patentBookViewportStore.read(`${session.patentId}:${book.kind}`),
              ...(selection
                ? {
                    selection: { from: selection.from, to: selection.to },
                  }
                : {}),
            };
          }),
          aiCorrectionOpen,
          assistantOpen: textPolishOpen,
        }
      : undefined;
    const saved = await runFileOperation("正在生成并保存 PATDOC…", async () => {
      const flushed = await applicationPersistence.flushAll("full-data-transfer");
      if (!flushed.ok) return null;
      return patentsAvailable
        ? patents.exportActivePatdoc(suggestedName, workspace)
        : documents.saveActiveDocumentAs();
    });
    if (saved) {
      setExportReport({ format: "patdoc", outputPath: saved.path, issues: [] });
    }
  };

  const appendImportedPatentFigures = (
    session: NonNullable<typeof patents.activeSession>,
    importedAssets: ImportedAsset[],
    historyLabel: "导入附图" | "粘贴附图",
  ) => {
    if (importedAssets.length === 0) return;
    const drawingPage = (
      session.patent.books.find((book) => book.kind === "description-drawings") as PatentBook
    ).document.page;
    const maximumWidthMm = Math.min(
      MAX_PATENT_FIGURE_WIDTH_MM,
      drawingPage.widthMm - drawingPage.marginLeftMm - drawingPage.marginRightMm,
    );
    const maximumPortraitHeightMm = Math.min(
      200,
      drawingPage.heightMm - drawingPage.marginTopMm - drawingPage.marginBottomMm - 25,
    );
    const nextFigures = importedAssets.map((imported) => {
      const aspectRatio = imported.descriptor.heightPx / imported.descriptor.widthPx;
      const widthMm =
        aspectRatio > 1
          ? Math.min(maximumWidthMm, maximumPortraitHeightMm / aspectRatio)
          : maximumWidthMm;
      return {
        figureId: createPatentDrawingId(),
        assetId: imported.descriptor.assetId,
        widthMm: Math.round(Math.max(MIN_PATENT_FIGURE_WIDTH_MM, widthMm) * 100) / 100,
      };
    });
    patents.appendImportedPatentFigures(
      session.patentId,
      nextFigures,
      importedAssets.map((imported) => imported.descriptor),
      historyLabel,
    );
  };

  const formulaPreviewUrls = useRef(new Set<string>());
  useEffect(() => {
    const next = new Set(Object.values(formulaDrawingSessions).flatMap(value => value ? [value.previewUrl] : []));
    for (const url of formulaPreviewUrls.current) if (!next.has(url)) URL.revokeObjectURL(url);
    formulaPreviewUrls.current = next;
  }, [formulaDrawingSessions]);
  useEffect(() => () => {
    for (const url of formulaPreviewUrls.current) URL.revokeObjectURL(url);
  }, []);

  const openFormulaDrawingInsert = async (
    request: FormulaDrawingRequest,
    target?: { patentId: string; sessionId: string },
    sourceEditor?: "drawing-formula" | "drawing-chemistry",
  ): Promise<void> => {

    const session = target
      ? (patents.state.sessions.find(
          (candidate) =>
            candidate.patentId === target.patentId && candidate.sessionId === target.sessionId,
        ) ?? null)
      : activePatentSession;
    if (!session) {
      showAppAlert("请先打开或新建专利后再插入附图。");
      return;
    }
    const generation = (formulaDrawingGeneration.current.get(session.sessionId) ?? 0) + 1;
    formulaDrawingGeneration.current.set(session.sessionId, generation);
    const restoreSource = () => {
      if (sourceEditor === "drawing-formula") setDrawingFormulaEditorOpenForSession(session.sessionId, true);
      if (sourceEditor === "drawing-chemistry") setDrawingChemistryEditorOpenForSession(session.sessionId, true);
    };
    if (!availablePatentBookKinds(session.patent).includes("description-drawings")) {
      showAppAlert("当前专利未启用说明书附图。");
      restoreSource();
      return;
    }
    if (request.operation === "replace" && session.patent.figures.length === 0) {
      showAppAlert("暂无可替换的附图，请先插入附图。");
      restoreSource();
      return;
    }
    try {
      let png: Uint8Array;
      let widthPx: number;
      let heightPx: number;
      if (request.kind === "chemical-structure") {
        png = Uint8Array.from(request.png);
        widthPx = request.descriptor.widthPx;
        heightPx = request.descriptor.heightPx;
      } else {
        const rendered = await window.patentApi.formulaDrawings.render({
          sessionId: session.sessionId,
          latex: request.latex,
        });
        if (!rendered.ok) {
          showError(rendered.error);
          restoreSource();
          return;
        }
        png = Uint8Array.from(rendered.value.png);
        widthPx = rendered.value.widthPx;
        heightPx = rendered.value.heightPx;
      }
      if (generation !== formulaDrawingGeneration.current.get(session.sessionId)) return;
      if (
        !chemicalSessionsRef.current.some(
          (candidate) =>
            candidate.patentId === session.patentId && candidate.sessionId === session.sessionId,
        )
      ) {
        showAppAlert("原专利已关闭，无法插入或替换附图。");
        return;
      }
      setFormulaDrawingForSession(session.sessionId, (current) => {
        if (current) URL.revokeObjectURL(current.previewUrl);
        return {
          patentId: session.patentId,
          sessionId: session.sessionId,
          request,
          ...(sourceEditor ? { sourceEditor } : {}),
          png,
          widthPx,
          heightPx,
          previewUrl: URL.createObjectURL(
            new Blob([Uint8Array.from(png).buffer], { type: "image/png" }),
          ),
        };
      });
    } catch {
      showInternalError();
      restoreSource();
    }
  };

  const closeFormulaDrawingInsert = (restoreSourceEditor = true, current = formulaDrawing) => {
    if (!current) return;
    const owner = current.sessionId;
    formulaDrawingGeneration.current.set(owner, (formulaDrawingGeneration.current.get(owner) ?? 0) + 1);
    setFormulaDrawingForSession(owner, null);
    if (!restoreSourceEditor || !current.sourceEditor) return;
    if (current.sourceEditor === "drawing-formula") setDrawingFormulaEditorOpenForSession(owner, true);
    else setDrawingChemistryEditorOpenForSession(owner, true);
  };

  const openChemicalFigureEditor = async (
    owner: { patentId: string; sessionId: string },
    figureId: string,
    assetId: string,
  ) => {
    if (
      drawingChemistryEditor?.sessionId === owner.sessionId &&
      drawingChemistryEditor.editTarget?.figureId === figureId &&
      drawingChemistryEditor.editTarget.assetId === assetId
    ) {
      setDrawingChemistryEditorOpenForSession(owner.sessionId, true);
      return;
    }
    try {
      const result = await window.patentApi.chemistry.readStructureSource({
        sessionId: owner.sessionId,
        assetId,
      });
      if (!result.ok) throw new Error(result.error.message);
      const session = chemicalSessionsRef.current.find(
        (item) => item.sessionId === owner.sessionId && item.patentId === owner.patentId,
      );
      if (
        !session?.patent.figures.some(
          (figure) => figure.figureId === figureId && figure.assetId === assetId,
        )
      )
        throw new Error("原专利或附图已发生变化，请重新打开。");
      if (!result.value)
        throw new Error(
          "这张旧附图未保存结构源数据，仍可调整尺寸或导出图片；如需修改化学结构，请重新绘制。",
        );
      setDrawingChemistryEditorForSession(owner.sessionId, {
        ...owner,
        kind: "structure",
        editTarget: { figureId, assetId },
        request: {
          type: "edit",
          kind: "structure",
          ...result.value,
          editorMode: result.value.editorMode ?? "molecule",
          targetKey: figureId,
        },
      });
      setDrawingChemistryEditorOpenForSession(owner.sessionId, true);
    } catch (error) {
      showAppAlert(error instanceof Error ? error.message : "未能打开结构源数据，请重试。");
    }
  };

  const saveChemicalFigure = (draft: ChemicalStructureDraft, owner = drawingChemistryEditor) => {
    if (!owner?.editTarget) return;
    const session = chemicalSessionsRef.current.find(
      (item) => item.sessionId === owner.sessionId && item.patentId === owner.patentId,
    );
    const target = owner.editTarget;
    if (
      !session?.patent.figures.some(
        (figure) => figure.figureId === target.figureId && figure.assetId === target.assetId,
      )
    )
      throw new Error("原专利或附图已发生变化，草稿已保留，请重新选择目标。");
    patents.updatePatentFigures(
      session.patentId,
      session.patent.figures.map((figure) =>
        figure.figureId === target.figureId ? { ...figure, assetId: draft.previewAssetId } : figure,
      ),
      session.patent.abstractDrawingFigureId,
      [...session.patent.assets, draft.previewDescriptor],
      { ownerBookKind: "description-drawings", label: "编辑化学结构式" },
    );
    setDrawingChemistryEditorOpenForSession(owner.sessionId, false);
    setDrawingChemistryEditorForSession(owner.sessionId, null);
  };

  const insertFormulaDrawing = async (
    target: FormulaFigureTarget,
    renderedReplacement?: FormulaDrawingReplacement,
    formulaDrawing = formulaDrawingSessions[activePatentSession?.sessionId ?? ""],
  ): Promise<void> => {
    if (!formulaDrawing) return;
    let session = chemicalSessionsRef.current.find(
      (candidate) => candidate.patentId === formulaDrawing.patentId,
    );
    if (!session || session.sessionId !== formulaDrawing.sessionId) {
      throw new Error("原专利已关闭，无法插入或替换附图。");
    }
    try {
      const replacement =
        target.kind === "replace"
          ? session.patent.figures.find(
              (figure) => figure.figureId === target.figureId && figure.assetId === target.assetId,
            )
          : undefined;
      if (target.kind === "replace" && !replacement)
        throw new Error("目标附图已发生变化，请重新选择。");
      if (renderedReplacement && renderedReplacement.outputWidthMm !== replacement?.widthMm)
        throw new Error("目标附图宽度已发生变化，请重新生成预览。");
      const imported =
        formulaDrawing.request.kind === "chemical-structure"
          ? { descriptor: renderedReplacement?.descriptor ?? formulaDrawing.request.descriptor }
          : await window.patentApi.assets
              .importBytes({
                sessionId: session.sessionId,
                originalName:
                  formulaDrawing.request.kind === "physics"
                    ? "物理公式.png"
                    : formulaDrawing.request.kind === "chemical-equation"
                      ? "化学方程式.png"
                      : "数学公式.png",
                declaredMediaType: "image/png",
                bytes: Uint8Array.from(renderedReplacement?.png ?? formulaDrawing.png),
              })
              .then((result) => {
                if (!result.ok) throw new Error(result.error.message);
                return result.value;
              });
      const latest = chemicalSessionsRef.current.find(
        (candidate) =>
          candidate.patentId === formulaDrawing.patentId &&
          candidate.sessionId === formulaDrawing.sessionId,
      );
      if (!latest) throw new Error("原专利已关闭，无法插入或替换附图。");
      session = latest;
      const widthMm = formulaDrawingFigureWidthMm(
        session.patent,
        formulaDrawing.request,
        formulaDrawing,
      );
      if (target.kind === "replace") {
        if (!replacement) throw new Error("目标附图已发生变化，请重新选择。");
        patents.updatePatentFigures(
          session.patentId,
          planDrawingReplacement(session.patent.figures, replacement, imported.descriptor.assetId),
          session.patent.abstractDrawingFigureId,
          [...session.patent.assets, imported.descriptor],
          { ownerBookKind: "description-drawings", label: "替换公式附图" },
          undefined,
          undefined,
          true,
        );
      } else {
        const figureId = createPatentDrawingId();
        const appended = appendImportedFigures({
          figures: session.patent.figures,
          assets: session.patent.assets,
          importedFigures: [{ figureId, assetId: imported.descriptor.assetId, widthMm }],
          importedAssets: [imported.descriptor],
          abstractDrawingFigureId: session.patent.abstractDrawingFigureId,
        });
        const orderedFigures = [...appended.figures];
        const appendedIndex = orderedFigures.findIndex((figure) => figure.figureId === figureId);
        const [inserted] = appendedIndex < 0 ? [] : orderedFigures.splice(appendedIndex, 1);
        if (inserted) orderedFigures.splice(target.insertIndex, 0, inserted);
        const edit = reorderFigures({
          assets: appended.assets,
          abstractDrawingFigureId: appended.abstractDrawingFigureId,
          orderedFigures,
        });
        patents.updatePatentFigures(
          session.patentId,
          edit.figures,
          edit.abstractDrawingFigureId,
          edit.assets,
          { ownerBookKind: "description-drawings", label: "插入公式附图" },
          undefined,
          undefined,
          false,
          [figureId],
        );
      }
      if (formulaDrawing.sourceEditor === "drawing-formula") {
        setDrawingFormulaEditorForSession(formulaDrawing.sessionId, null);
        setDrawingFormulaEditorOpenForSession(formulaDrawing.sessionId, false);
      } else if (formulaDrawing.sourceEditor === "drawing-chemistry") {
        setDrawingChemistryEditorForSession(formulaDrawing.sessionId, null);
        setDrawingChemistryEditorOpenForSession(formulaDrawing.sessionId, false);
      }
      closeFormulaDrawingInsert(false, formulaDrawing);
    } catch (error) {
      throw error instanceof Error ? error : new Error("附图操作失败，请重试。");
    }
  };

  const importPatentDrawingImages = async () => {
    const session = activePatentSession;
    if (!session) return;
    try {
      const result = await window.patentApi.assets.chooseAndImportMany(session.sessionId);
      if (!result.ok) {
        showError(result.error);
        return;
      }
      appendImportedPatentFigures(session, result.value, "导入附图");
    } catch {
      showInternalError();
    }
  };

  const importPatentBookImages = async () => {
    const session = activePatentSession;
    if (
      !session ||
      !activeEditorId ||
      (session.activeBookKind !== "claims" && session.activeBookKind !== "description")
    )
      return;
    try {
      const result = await window.patentApi.assets.chooseAndImportMany(session.sessionId);
      if (!result.ok) {
        showError(result.error);
        return;
      }
      if (result.value.length === 0) return;
      if (
        !commandBus.insertFigures(
          activeEditorId,
          result.value.map(({ descriptor }) => descriptor),
        )
      ) {
        showInternalError();
      }
    } catch {
      showInternalError();
    }
  };

  const importPastedPatentDrawingImages = async (images: DrawingImageImport[]) => {
    const session = activePatentSession;
    if (!session || images.length === 0) return;
    try {
      const result = await window.patentApi.assets.importMany({
        sessionId: session.sessionId,
        operationId: randomUuid(),
        images: images.map((image) => ({
          ...image,
          bytes: Uint8Array.from(image.bytes),
        })),
      });
      if (!result.ok) {
        showError(result.error);
        return;
      }
      appendImportedPatentFigures(session, result.value, "粘贴附图");
    } catch {
      showInternalError();
    }
  };

  const importDroppedPatentDrawingFiles = async (
    patentId: string,
    files: File[],
  ): Promise<boolean> => {
    const session = patents.state.sessions.find((candidate) => candidate.patentId === patentId);
    if (!session) return false;
    try {
      const images = await readDrawingImageFiles(files);
      if (images.length === 0) return false;
      const result = await window.patentApi.assets.importMany({
        sessionId: session.sessionId,
        operationId: randomUuid(),
        images: images.map((image) => ({
          ...image,
          bytes: Uint8Array.from(image.bytes),
        })),
      });
      if (!result.ok) {
        showError(result.error);
        return false;
      }
      appendImportedPatentFigures(session, result.value, "导入附图");
      return true;
    } catch (error) {
      setAppError({
        code: "IMAGE_IMPORT_LIMIT",
        message: error instanceof Error ? error.message : "读取图片失败，请重试。",
      });
      return false;
    }
  };

  const createDesktopShortcut = async () => {
    try {
      const result = await window.patentApi.application.createDesktopShortcut();
      if (!result.ok) {
        showError(result.error);
        return false;
      }
      return true;
    } catch {
      showInternalError();
      return false;
    }
  };

  const openThirdPartyNotices = async () => {
    try {
      const operation = window.patentApi.application.openThirdPartyNotices;
      if (!operation) throw new Error("第三方声明功能暂不可用。");
      const result = await operation();
      if (!result.ok) showError(result.error);
    } catch {
      showInternalError();
    }
  };

  const openThirdPartyLicensesFolder = async () => {
    try {
      const operation = window.patentApi.application.openThirdPartyLicensesFolder;
      if (!operation) throw new Error("许可证目录功能暂不可用。");
      const result = await operation();
      if (!result.ok) showError(result.error);
    } catch {
      showInternalError();
    }
  };

  const activePageForMargins = (() => {
    if (patentsAvailable && activePatentSession) {
      const activeBook = activePatentSession.patent.books.find(
        (book) => book.kind === activePatentSession.activeBookKind,
      );
      if (activeBook) return activeBook.document.page;
    }
    return documents.activeSession?.model.page ?? null;
  })();
  const hasEditablePageForMargins =
    library.view === "editor" &&
    !embeddedEditorActive &&
    activePageForMargins !== null &&
    (patentsAvailable ? activePatentSession !== null : documents.activeSession !== null);

  const validateTablePageMargins = (margins: PageMargins): string | null => {
    const opened = [
      ...documents.state.sessions.map((session) => session.model),
      ...patents.state.sessions.flatMap((session) =>
        session.patent.books.map((book) => book.document),
      ),
    ];
    return opened.some((document) => !fitDocumentTables(document, { ...document.page, ...margins }))
      ? "这些页边距无法容纳已打开文档中的表格。请减小左右页边距，或先减少表格列数。"
      : null;
  };
  const handlePageMarginsSaved = (margins: PageMargins) => {
    documents.applyPageMargins(margins);
    patents.applyPageMargins(margins);
    void documents.refreshSettings();
  };

  const createNewDocument = async () => {
    if (patentsAvailable) {
      setCreatePatentOpen(true);
      return;
    }
    const session = await documents.newDocument();
    if (!session) return;
    await library.refreshActive();
    library.setView("editor");
  };

  const createNewPatent = async (request: PatentCreateRequest) => {
    setCreatePatentBusy(true);
    try {
      const session = await patents.newPatent(request);
      if (!session) return;
      library.setView("editor");
      setCreatePatentOpen(false);
      void library.refreshActive();
    } finally {
      setCreatePatentBusy(false);
    }
  };

  const activateDocumentTab = (sessionId: string) => {
    documents.activateDocument(sessionId);
    library.setView("editor");
  };

  const importPatdoc = async () => {
    if (fileOperationRunning.current || !(await importNotice.request("patdoc"))) return;
    if (patentsAvailable) {
      const session = await patents.importPatdoc();
      if (!session) return;
      await library.refreshActive();
      library.setView("editor");
      return;
    }
    const session = await documents.openDocument();
    if (!session) return;
    await library.refreshActive();
    library.setView("editor");
  };

  const startDocxImport = async () => {
    const prepare = window.patentApi.patents.prepareDocxImport;
    if (!prepare) return;
    if (fileOperationRunning.current || !(await importNotice.request("docx"))) return;
    await runFileOperation("正在读取并识别 DOCX…", async () => {
      const result = await prepare();
      if (!result.ok) {
        setAppError(result.error);
        return;
      }
      setDocxImportPreview(result.value);
    });
  };

  const updateDocxImport = async (request: DocxImportUpdateRequest) => {
    const update = window.patentApi.patents.updateDocxImport;
    if (!update) return;
    const result = await update(request);
    if (!result.ok) {
      setAppError(result.error);
      return;
    }
    setDocxImportPreview(result.value);
  };

  const cancelDocxImport = async () => {
    const preview = docxImportPreview;
    setDocxImportPreview(null);
    if (!preview) return;
    const cancel = window.patentApi.patents.cancelDocxImport;
    if (!cancel) return;
    const result = await cancel({ sessionId: preview.sessionId });
    if (!result.ok) setAppError(result.error);
  };

  const commitDocxImport = async (request: DocxImportCommitRequest) => {
    setDocxImportBusy(true);
    try {
      const session = await patents.commitDocxImport(request);
      if (!session) return;
      setDocxImportPreview(null);
      await library.refreshActive();
      library.setView("editor");
    } finally {
      setDocxImportBusy(false);
    }
  };

  const openLibraryPatent = async (
    patent: LibraryPatentSummary,
    target?: import("../library/content-search-results").ContentSearchTarget,
    resultKey?: string,
  ) => {
    await pendingUiCloses.current.get(patent.patentId);
    const session = await patents.openPatent(patent.patentId);
    if (session) {
      if (resultKey) {
        setContentSearchOrigin(patent.patentId);
      }
      if (target) {
        setFindSession(null);
        // A search result is an explicit document destination. Keep tool drafts
        // mounted, but do not let the previously active CAD/flowchart cover it.
        setDrawingShownForSession(session.sessionId, false);
        setFlowchartForSession(session.sessionId, (current) =>
          current ? { ...current, active: false } : current,
        );
        patents.activateBook(patent.patentId, target.kind);
        setWorkspaceLayout((current) =>
          exitDualWorkspace(current, {
            kind: "book",
            patentId: patent.patentId,
            bookKind: target.kind,
          }),
        );
        setContentSearchNavigation({ patentId: patent.patentId, ...target });
      }
      library.setView("editor");
    }
  };

  const openPatentFolder = async (summary: LibraryPatentSummary) => {
    if (patentFolderOperation.current) return;
    patentFolderOperation.current = true;
    try {
      await runFileOperation("正在打开专利文件夹…", async () => {
        if (!(await applicationPersistence.flushAll("full-data-transfer")).ok) return;
        const session = await patents.openPatent(summary.patentId);
        if (!session) return;
        const prepared = await patents.preparePatentExport(summary.patentId);
        if (!prepared) return;
        setPatentFolderExportNotice(null);
        setPatentFolder(patents.getReferenceMarkPatentSnapshot(summary.patentId) ?? session.patent);
      });
    } finally { patentFolderOperation.current = false; }
  };

  const openFolderEntry = async (entry: PatentFolderEntry) => {
    if (!patentFolder || patentFolderOperation.current) return;
    const session = await patents.openPatent(patentFolder.patentId);
    if (!session) return;
    const patentId = session.patentId;
    let target: import("../../../shared/patent/document-target").PatentDocumentTarget;
    if (entry.kind === "book") {
      const bookKind = entry.id as import("../../../shared/patent/model").PatentBookKind;
      patents.activateBook(patentId, bookKind);
      target = {kind: "book", patentId, bookKind};
    } else if (entry.kind === "auxiliary") {
      patents.activateAuxiliaryDocument(patentId, entry.id);
      target = {kind: "auxiliary", patentId, auxiliaryDocumentId: entry.id};
    } else {
      target = {kind: "tool", patentId, tool: entry.kind === "drawing" ? "drawing-markup" : "flowchart"};
    }
    setWorkspaceLayout(current => exitDualWorkspace(current, target));
    if (entry.kind === "drawing") {
      setFlowchartForSession(session.sessionId, current => current ? {...current, active: false} : current);
      setDrawingForSession(session.sessionId, patentId);
      setDrawingShownForSession(session.sessionId, true);
      setFolderDrawingTargets(current => ({...current, [patentId]: {projectId: entry.id, key: Date.now()}}));
    } else if (entry.kind === "flowchart") {
      setDrawingShownForSession(session.sessionId, false);
      setFlowchartForSession(session.sessionId, {patentId, patentRevision: session.persistedRevision, active: true, initialProjectId: entry.id, defaultReplaceFigureId: null, editorMode: "flowchart"});
    } else {
      setDrawingShownForSession(session.sessionId, false);
      setFlowchartForSession(session.sessionId, current => current ? {...current, active: false} : current);
    }
    setPatentFolder(null);
    library.setView("editor");
  };

  const exportFolderEntries = async (items: {key: string; format: FolderFormat}[]) => {
    if (!patentFolder || patentFolderOperation.current) return;
    patentFolderOperation.current = true;
    setPatentFolderBusy(true);
    setPatentFolderExportNotice(null);
    let client: CadcraftClient | undefined;
    try {
      if (!(await applicationPersistence.flushAll("full-data-transfer")).ok) return;
      const prepared = await patents.preparePatentExport(patentFolder.patentId);
      if (!prepared) return;
      const snapshot = patents.getReferenceMarkPatentSnapshot(patentFolder.patentId);
      if (!snapshot) throw new Error("专利已关闭，请重新打开文件夹。");
      const cad: import("../../../shared/patent/folder").PatentFolderExportRequest["cad"] = [];
      for (const item of items) {
        const project = snapshot.drawingProjects.find(p => `drawing:${p.projectId}` === item.key);
        if (!project?.cad) continue;
        client ??= new CadcraftClient();
        const ids = new Set([project.cad.assetId, ...(project.detailViews ?? []).flatMap(d => d.cadSource ? [d.cadSource.assetId] : [])]);
        const sources = [];
        for (const id of ids) {
          const source = await window.patentApi.assets.readDrawingSource(prepared.sessionId, id);
          if (!source.ok) throw new Error(source.error.message);
          sources.push([id, source.value] as const);
        }
        const compiled = await client.request<{bytes: Uint8Array; warnings: string[]}>("compose", project, sources);
        if (compiled.warnings.length) throw new Error(`CAD 导出需要处理：${compiled.warnings.join("；")}`);
        cad.push({projectId: project.projectId, bytes: Uint8Array.from(compiled.bytes)});
      }
      if (!window.patentApi.patents.exportFolder) throw new Error("请重新启动此分支实例以加载文件夹导出功能。");
      const result = await window.patentApi.patents.exportFolder({patentId: prepared.patentId, sessionId: prepared.sessionId, expectedRevision: prepared.expectedRevision, items, cad});
      if (!result.ok) { showError(result.error); return; }
      if (result.value) {
        setPatentFolderExportNotice(items.length > 1 ? `✓ 已成功导出 ${items.length} 个文件（ZIP）` : "✓ 文件已成功导出");
        setOperationFeedback({tone: "success", title: "所选文件已成功导出"});
      }
    } finally { client?.close(); setPatentFolderBusy(false); patentFolderOperation.current = false; }
  };

  const openLibraryDocument = async (document: LibraryDocumentSummary) => {
    const session = await documents.openLibraryDocument(document.libraryDocumentId);
    if (session) library.setView("editor");
  };

  const renameLibraryDocument = async (document: LibraryDocumentSummary) => {
    const title = await promptAppText("请输入新的文档名称", document.title);
    if (title === null || title.trim().length === 0 || title.trim() === document.title) return;
    await library.renameDocument(document, title.trim());
  };

  const exportLibraryPatdoc = async (document: LibraryDocumentSummary) => {
    await runFileOperation("正在生成并保存 PATDOC…", async () => {
      try {
        const result = await window.patentApi.library.exportPatdoc({
          libraryDocumentId: document.libraryDocumentId,
          expectedRevision: document.revision,
        });
        if (!result.ok) {
          showError(result.error);
          return;
        }
        if (result.value) {
          setExportReport({ format: "patdoc", outputPath: result.value.path, issues: [] });
        }
      } catch {
        showInternalError();
      }
    });
  };

  const confirmLibraryPatentExport = async (format: "patdoc" | "docx" | "pdf") => {
    const selected = libraryPatentExport;
    if (!selected?.length) return;
    setLibraryPatentExport(null);
    await runFileOperation(`正在导出 ${selected.length} 项专利，请稍候…`, async () => {
      const flushed = await applicationPersistence.flushAll("full-data-transfer");
      if (!flushed.ok) return;
      const requests = [];
      for (const patent of selected) {
        const prepared = patents.state.sessions.some(
          (session) => session.patentId === patent.patentId,
        )
          ? await patents.preparePatentExport(patent.patentId)
          : { expectedRevision: patent.revision };
        if (!prepared) return;
        requests.push({ patentId: patent.patentId, expectedRevision: prepared.expectedRevision });
      }
      if (!window.patentApi.patents.exportBundle) throw new Error("请重启软件以加载文档包功能。");
      const result = await window.patentApi.patents.exportBundle({ format, patents: requests });
      if (!result.ok) {
        showError(result.error);
        return;
      }
      if (result.value?.path)
        setExportReport({
          format,
          outputPath: result.value.path,
          issues: result.value.issues ?? [],
        });
    });
  };

  const importLibraryBundle = async () => {
    if (fileOperationRunning.current || !(await importNotice.request("zip"))) return;
    await runFileOperation("正在校验并导入专利压缩包，请稍候…", async () => {
      if (!window.patentApi.patents.importBundle) throw new Error("请重启软件以加载文档包功能。");
      const result = await window.patentApi.patents.importBundle();
      if (!result.ok) {
        showError(result.error);
        return;
      }
      if (!result.value) return;
      await library.refreshActive();
      library.setView("library");
      setOperationFeedback({ tone: "success", title: `已成功导入 ${result.value.count} 项专利。` });
    });
  };

  const exportLibraryDocument = async (
    document: LibraryDocumentSummary,
    format: "docx" | "pdf",
  ) => {
    let sessionId: string | null = null;
    try {
      const opened = await window.patentApi.library.open(document.libraryDocumentId);
      if (!opened.ok) {
        showError(opened.error);
        return;
      }
      sessionId = opened.value.sessionId;
      const request = {
        sessionId: opened.value.sessionId,
        document: opened.value.document,
        suggestedName: createDocxSuggestedName(opened.value.document.title),
      };
      if (format === "docx") await exportDocx(request);
      else await exportPdf(request);
    } catch {
      showInternalError();
    } finally {
      if (sessionId) {
        void window.patentApi.library.release(sessionId).catch(() => showInternalError());
      }
    }
  };

  const moveLibraryDocumentToTrash = async (document: LibraryDocumentSummary) => {
    if (!(await confirmAppAction(`确定要把“${document.title}”移入回收站吗？`))) return;
    if (!(await library.moveToTrash(document))) return;
    await documents.closeLibraryDocument(document.libraryDocumentId);
  };

  const trashLibraryPatent = async (patent: LibraryPatentSummary): Promise<boolean> => {
    const wasOpen = patents.state.sessions.some((session) => session.patentId === patent.patentId);
    if (!(await closePatentWithEmbeddedEditors(patent.patentId))) return false;
    if (await library.movePatentToTrash(patent)) return true;
    if (wasOpen && (await patents.openPatent(patent.patentId))) library.setView("editor");
    return false;
  };

  const moveLibraryPatentToTrash = async (patent: LibraryPatentSummary) => {
    if (batchTrashRunning.current) return;
    batchTrashRunning.current = true;
    setBatchTrashBusy(true);
    try {
      const title = patent.name ?? "未命名专利";
      if (!(await confirmAppAction(`确定要把“${title}”移入回收站吗？`))) return;
      await trashLibraryPatent(patent);
    } finally {
      batchTrashRunning.current = false;
      setBatchTrashBusy(false);
    }
  };

  const moveLibraryPatentsToTrash = async (selected: LibraryPatentSummary[]): Promise<boolean> => {
    if (batchTrashRunning.current || !selected.length) return false;
    batchTrashRunning.current = true;
    setBatchTrashBusy(true);
    let completed = 0;
    try {
      if (
        !(await confirmAppAction(
          `确定将所选的 ${selected.length} 项专利移入回收站吗？可在回收站恢复。`,
        ))
      )
        return false;
      for (const patent of selected) {
        if (!(await trashLibraryPatent(patent))) {
          showAppAlert(
            `批量删除已停止。已移入回收站 ${completed} 项，其余 ${selected.length - completed} 项未删除。`,
          );
          return false;
        }
        completed += 1;
      }
      showAppAlert(`已将 ${completed} 项专利移入回收站，可在回收站恢复。`);
      return true;
    } catch {
      showAppAlert(
        `批量删除中断。已确认移入回收站 ${completed} 项，请刷新专利库和回收站后核对其余项目。`,
      );
      return false;
    } finally {
      batchTrashRunning.current = false;
      setBatchTrashBusy(false);
    }
  };

  const savePatentSettings = async (request: {
    name?: string | null;
    customer?: string | null;
    patentType: LibraryPatentSummary["patentType"];
    terminologyReplacementRequested: boolean;
  }) => {
    if (!settingsPatent) return;
    setSettingsBusy(true);
    try {
      const saved = await patents.updatePatentSettings(settingsPatent.patentId, {
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.customer !== undefined ? { customer: request.customer } : {}),
        patentType: request.patentType,
        terminologyReplacementRequested: request.terminologyReplacementRequested,
        closeIfOpened: true,
      });
      if (!saved) return;
      await library.refreshActive();
      setSettingsPatent(null);
    } catch {
      showInternalError();
    } finally {
      setSettingsBusy(false);
    }
  };

  const importLegacyDraft = async (draftId: string) => {
    const opened = await library.importLegacyDraft(draftId);
    if (!opened) return false;
    await documents.adoptOpenedLibraryDocument(opened);
    library.setView("editor");
    return true;
  };

  const closeToolPane = async (
    tool: "flowchart" | "drawing-markup",
    afterClose: () => void,
  ): Promise<boolean> => {
    if (workspaceLayout.mode !== "dual") {
      afterClose();
      return true;
    }
    const pane = (["left", "right"] as const).find((side) => {
      const state = workspaceLayout[side];
      return (
        state.kind === "document" && state.target.kind === "tool" && state.target.tool === tool
      );
    });
    if (!pane) {
      afterClose();
      return true;
    }
    const closed = await runWorkspaceLayoutSwitch("exit-dual", async (transition) => {
      retainSelectionsForLayoutChange();
      await transition.commit(() => {
        flushSync(() => {
          setWorkspaceLayout((current) => closeDualWorkspacePane(current, pane));
          afterClose();
        });
      });
      return true;
    });
    return closed ?? false;
  };
  const closeFlowchartWorkspace = async (): Promise<boolean> => {
    if (!flowchartWorkspace) return true;
    const canClose = (await flowchartWorkspaceRef.current?.requestClose()) ?? true;
    if (!canClose) return false;
    return await closeToolPane("flowchart", () => setFlowchartWorkspace(null));
  };

  const closeDrawingWorkspace = (): Promise<boolean> => {
    if (drawingCloseOperation.current) return drawingCloseOperation.current;
    if (!drawingMarkupPatentId) return Promise.resolve(true);
    const operation = (async () => {
      if (!(await drawingWorkspaceRef.current?.requestClose())) return false;
      return await closeToolPane("drawing-markup", () => {
        setDrawingMarkupShown(false);
        setDrawingMarkupPatentId(null);
      });
    })();
    drawingCloseOperation.current = operation;
    const release = () => {
      if (drawingCloseOperation.current === operation) drawingCloseOperation.current = null;
    };
    void operation.then(release, release);
    return operation;
  };

  const closePatentWithEmbeddedEditors = async (patentId: string): Promise<boolean> => {
    if (!(await textPolish.flushPatentDrafts(patentId))) {
      showAppAlert("输入草稿保存失败，请重试或先复制保留后再关闭专利。");
      return false;
    }
    // Closing an owning patent must flush its tools without first navigating back
    // to a book. Keep the current workspace mounted until save/release succeeds.
    if (
      !((await flowchartHandles.current.get(patents.state.sessions.find(session => session.patentId === patentId)?.sessionId ?? "")?.requestClose()) ?? true)
    ) {
      return false;
    }

    if (!((await drawingHandles.current.get(patents.state.sessions.find(session => session.patentId === patentId)?.sessionId ?? "")?.requestClose()) ?? true))
      return false;
    const closed = await patents.closePatent(patentId, {
      allowDiscardOnSaveFailure: workspaceLayout.mode !== "dual",
    });
    if (closed) {
      patentBookViewportStore.removePatent(patentId);
      setFlowchartWorkspace((current) => (current?.patentId === patentId ? null : current));
      setDrawingMarkupPatentId((current) => (current === patentId ? null : current));
    }
    return closed;
  };

  const openFlowchartWorkspace = async (
    initialProjectId: string | null = null,
    defaultReplaceFigureId: string | null = null,
    editorMode: FlowchartEditorMode = "flowchart",
  ): Promise<void> => {
    const session = activePatentSession;
    if (!session) {
      showAppAlert("请先打开或新建专利后再使用流程图编辑器。");
      return;
    }

    if (workspaceLayout.mode === "dual")
      void selectTargetInPane(workspaceLayout.activePane, {
        patentId: session.patentId,
        kind: "tool",
        tool: "flowchart",
      });
    setDrawingShownForSession(session.sessionId, false);
    setFlowchartForSession(session.sessionId, (current) =>
      current?.patentId === session.patentId
        ? { ...current, active: true, initialProjectId, defaultReplaceFigureId, editorMode }
        : {
            patentId: session.patentId,
            patentRevision: session.persistedRevision,
            active: true,
            initialProjectId,
            defaultReplaceFigureId,
            editorMode,
          },
    );
  };

  const performClosePatent = async (patentId: string): Promise<void> => {
    if (isToolTutorial) {
      const result = await window.patentApi.application.requestQuit?.();
      if (result && !result.ok) showError(result.error);
      return;
    }
    const closesLastPatent = patents.state.sessions.length === 1;
    const returnToLibrary = closesLastPatent && library.view === "editor";
    if (returnToLibrary) library.setView("library");
    let closed = false;
    try {
      closed = await closePatentWithEmbeddedEditors(patentId);
      if (closed) await library.refreshActive();
    } finally {
      // Keep the live editor mounted during persistence. Restore it on cancellation,
      // but never steal navigation from another patent opened in the meantime.
      if (
        !closed && returnToLibrary && closeNavigationRef.current.view === "library" &&
        closeNavigationRef.current.activePatentId === patentId
      ) {
        library.setView("editor");
      }
    }
  };

  const requestClosePatent = (patentId: string): Promise<void> => {
    const pending = pendingUiCloses.current.get(patentId);
    if (pending) return pending;
    const operation = performClosePatent(patentId).finally(() => {
      if (pendingUiCloses.current.get(patentId) === operation) pendingUiCloses.current.delete(patentId);
    });
    pendingUiCloses.current.set(patentId, operation);
    return operation;
  };

  const renderPatentBook = (
    bookSession: PatentSession,
    bookZoomPercent = Math.min(zoomPercent, zoomLimits.single),
    inspectionPane: "single" | WorkspacePane = "single",
  ) => (
    <EditorSessionScope sessionId={bookSession.sessionId}>
    <PatentEditorViewport
      key={patents.automationEditorEpoch(bookSession.patentId)}
      automationReadOnly={patents.isAutomationReadOnly(bookSession.patentId)}
      session={bookSession}
      displayWidthMm={windowLayout.layout?.displayWidthMm}
      zoomPercent={Math.min(bookZoomPercent, zoomLimits[inspectionPane])}
      animateZoom={
        inspectionPane === "single" ||
        Boolean(
          workspaceLayout[inspectionPane].kind === "document" &&
            workspaceLayout[inspectionPane].dualZoomManual,
        )
      }
      onAutoFit={
        inspectionPane === "single" ||
        workspaceLayout[inspectionPane].kind !== "document" ||
        workspaceLayout[inspectionPane].dualZoomManual
          ? undefined
          : (zoom) => fitPaneAutomatically(inspectionPane, zoom)
      }
      onZoomLimit={
        inspectionPane === "single" ? undefined : (max) => reportZoomLimit(inspectionPane, max)
      }
    >
      <div className="patent-drafting-shell">
        <DualColumnSurface
          enabled={
            columnsRequested &&
            workspaceLayout.mode === "single" &&
            bookSession.patentId === activePatentSession?.patentId &&
            bookSession.activeBookKind === activePatentSession?.activeBookKind &&
            supportsDualColumns(bookSession.activeBookKind)
          }
          commandBus={commandBus}
          editorId={patentBookEditorId(bookSession.sessionId, bookSession.activeBookKind)}
          zoomPercent={columnZoomPercent}
          flowSettings={documents.settings.dualColumnFlow}
          onZoomLimit={(max) => reportZoomLimit("columns", max)}
        >
          <BookEditor
            session={bookSession}
            commandBus={commandBus}
            inactiveSelectionVisible={
              workspaceLayout.mode === "dual" &&
              inspectionPane !== "single" &&
              inspectionPane !== workspaceLayout.activePane
            }
            onBookDocumentChange={(bookKind, document, editorState, assets) =>
              patents.updateBookDocument(
                bookSession.patentId,
                bookKind,
                document,
                editorState,
                assets,
              )
            }
            onTextCounts={(bookKind, counts) => {
              if (!isTextPatentBook(bookKind)) return;
              const key = patentTextCountsKey({ patentId: bookSession.patentId, bookKind });
              setPatentTextCounts((current) => ({ ...current, [key]: counts }));
            }}
            onPatentFiguresChange={(figures, abstractDrawingFigureId, assets, history) =>
              patents.updatePatentFigures(
                bookSession.patentId,
                figures,
                abstractDrawingFigureId,
                assets,
                history,
              )
            }
            onImportDrawingImages={() => runSafely(importPatentDrawingImages())}
            onOpenDrawingMarkup={() => void launchDrawing()}
            onOpenFlowchartEditor={(projectId, figureId) =>
              void openFlowchartWorkspace(projectId ?? null, figureId ?? null)
            }
            onPasteDrawingImages={(images) => runSafely(importPastedPatentDrawingImages(images))}
            onRetrySave={() => runSafely(patents.persistActivePatent())}
            onInsertFormulaDrawing={(request) => openFormulaDrawingInsert(request, bookSession)}
            onOpenDrawingFormula={(kind) => {
              if (kind === "physics") {
                setPhysicsFormulaTargetForSession(bookSession.sessionId, {
                  drawingsOnly: true,
                  patentId: bookSession.patentId,
                  sessionId: bookSession.sessionId,
                });
              } else {
                setDrawingFormulaEditorForSession(bookSession.sessionId, (current) =>
                  current?.patentId === bookSession.patentId &&
                  current.sessionId === bookSession.sessionId &&
                  current.kind === kind
                    ? current
                    : {
                        patentId: bookSession.patentId,
                        sessionId: bookSession.sessionId,
                        kind,
                      },
                );
                setDrawingFormulaEditorOpenForSession(bookSession.sessionId, true);
              }
            }}
            onOpenDrawingChemistry={(kind) => {
              setDrawingChemistryEditorForSession(bookSession.sessionId, (current) =>
                current?.patentId === bookSession.patentId &&
                current.sessionId === bookSession.sessionId &&
                current.kind === kind &&
                !current.editTarget
                  ? current
                  : {
                      patentId: bookSession.patentId,
                      sessionId: bookSession.sessionId,
                      kind,
                    },
              );
              setDrawingChemistryEditorOpenForSession(bookSession.sessionId, true);
            }}
            onEditChemicalFigure={(figureId, assetId) =>
              void openChemicalFigureEditor(bookSession, figureId, assetId)
            }
            findSession={visibleFindSession}
            findQuery={findQuery}
            findReplacement={findReplacement}
            findOptions={findOptions}
            onFindOptionsChange={(options) =>
              setFindOptions((current) => ({ ...current, ...options }))
            }
            onOpenFindRail={openFindRail}
            onFindModeChange={changeFindSessionMode}
            onFindQueryChange={updateFindQuery}
            onFindReplacementChange={setFindReplacement}
            zoomPercent={bookZoomPercent}
            onApplyReferenceMarkPlan={(plan) => {
              const ownerBookKind =
                plan.after.referenceMarkSettings.pendingReview?.ownerBookKind ??
                plan.before.referenceMarkSettings.pendingReview?.ownerBookKind ??
                (isTextPatentBook(bookSession.activeBookKind)
                  ? (bookSession.activeBookKind as "claims" | "description" | "abstract")
                  : "description-drawings");
              return patents.applyReferenceMarkPlan(bookSession.patentId, ownerBookKind, plan);
            }}
            getReferenceMarkPatentSnapshot={() =>
              patents.getReferenceMarkPatentSnapshot(bookSession.patentId)
            }
            canUndoReferenceMarkPlan={(ownerBookKind) =>
              patents.canUndoReferenceMarkOperation(bookSession.patentId, ownerBookKind)
            }
            onUndoReferenceMarkPlan={(ownerBookKind) =>
              patents.undoReferenceMarkOperation(bookSession.patentId, ownerBookKind)
            }
            referenceMarkLocatorEnabled={documents.settings.referenceMarkLocatorEnabled}
            inventionContentPrefix={documents.settings.inventionContentPrefix}
            onOpenInventionContentSettings={() => setInventionContentSettingsOpen(true)}
            activeReferenceMarkId={activeReferenceMarksByPatent[bookSession.patentId] ?? null}
            recentReferenceMarkId={recentReferenceMarksByPatent[bookSession.patentId] ?? null}
            onReferenceMarkActivate={(referenceMarkId) => {
              setRecentReferenceMarksByPatent((current) => {
                if (!current[bookSession.patentId]) return current;
                const next = { ...current };
                delete next[bookSession.patentId];
                return next;
              });
              setActiveReferenceMarksByPatent((current) => {
                if (referenceMarkId) {
                  return { ...current, [bookSession.patentId]: referenceMarkId };
                }
                if (!current[bookSession.patentId]) return current;
                const next = { ...current };
                delete next[bookSession.patentId];
                return next;
              });
            }}
            onCancelReferenceMarkLocator={() =>
              setActiveReferenceMarksByPatent((current) => {
                if (!current[bookSession.patentId]) return current;
                const next = { ...current };
                delete next[bookSession.patentId];
                return next;
              })
            }
            onReferenceMarkLocatorEnabledChange={(enabled) => {
              void documents
                .updateAppSettings({ referenceMarkLocatorEnabled: enabled })
                .then((saved) => {
                  if (!saved || enabled) return;
                  setActiveReferenceMarksByPatent({});
                  setRecentReferenceMarksByPatent({});
                });
            }}
            onRecentReferenceMarkChange={(referenceMarkId) =>
              setRecentReferenceMarksByPatent((current) => {
                if (referenceMarkId) {
                  return { ...current, [bookSession.patentId]: referenceMarkId };
                }
                if (!current[bookSession.patentId]) return current;
                const next = { ...current };
                delete next[bookSession.patentId];
                return next;
              })
            }
            referenceMarkIssueNavigation={
              referenceMarkIssueNavigationByPatent[bookSession.patentId] ?? null
            }
            onReferenceMarkIssueNavigationChange={(navigation) =>
              setReferenceMarkIssueNavigationByPatent((current) => {
                if (navigation) {
                  return { ...current, [bookSession.patentId]: navigation };
                }
                if (!current[bookSession.patentId]) return current;
                const next = { ...current };
                delete next[bookSession.patentId];
                return next;
              })
            }
            referenceMarkIntroDismissed={documents.settings.referenceMarkSyncIntroDismissed}
            onDismissReferenceMarkIntro={() =>
              documents.updateAppSettings({ referenceMarkSyncIntroDismissed: true })
            }
            onRequestReferenceMarkRepair={() =>
              patents.activateBook(bookSession.patentId, "description")
            }
            onActivateBook={(bookKind) => patents.activateBook(bookSession.patentId, bookKind)}
            onOperationFeedback={setOperationFeedback}
            onCheckProblems={() => {
              setAiCorrectionOpen(false);
              setTextPolishOpen(false);
              setPatentCheckRunToken(null);
              setPatentCheckRequest({
                patentId: bookSession.patentId,
                pane: inspectionPane,
                nonce: Date.now(),
              });
            }}
            onAiCorrection={() => {
              if (!isNetworkAiAvailable()) return;
              setPatentCheckRequest(null);
              setTextPolishOpen(false);
              setAiCorrectionOpen(true);
            }}
            onTextPolish={() => {
              if (!isNetworkAiAvailable()) return;
              setPatentCheckRequest(null);
              setAiCorrectionOpen(false);
              setTextPolishActionError(null);
              setTextPolishOpen(true);
            }}
          />
        </DualColumnSurface>
      </div>
    </PatentEditorViewport>
    </EditorSessionScope>
  );

  const renderAuxiliaryDocument = (
    session: PatentSession,
    auxiliaryDocumentId: string,
    documentZoomPercent = Math.min(zoomPercent, zoomLimits.single),
    pane: "single" | WorkspacePane = "single",
  ) => (
    <EditorSessionScope sessionId={session.sessionId}>
    <PatentEditorViewport
      displayWidthMm={windowLayout.layout?.displayWidthMm}
      key={patents.automationEditorEpoch(session.patentId)}
      automationReadOnly={patents.isAutomationReadOnly(session.patentId)}
      session={{ ...session, activeAuxiliaryDocumentId: auxiliaryDocumentId }}
      zoomPercent={Math.min(documentZoomPercent, zoomLimits[pane])}
      animateZoom={
        pane === "single" ||
        Boolean(workspaceLayout[pane].kind === "document" && workspaceLayout[pane].dualZoomManual)
      }
      onAutoFit={
        pane === "single" ||
        workspaceLayout[pane].kind !== "document" ||
        workspaceLayout[pane].dualZoomManual
          ? undefined
          : (zoom) => fitPaneAutomatically(pane, zoom)
      }
      onZoomLimit={pane === "single" ? undefined : (max) => reportZoomLimit(pane, max)}
    >
      <div className="patent-drafting-shell">
        <div className="patent-drafting-workspace">
          <div
            data-patent-text-projection={auxiliaryDocumentEditorId(
              session.sessionId,
              auxiliaryDocumentId,
            )}
          >
            <AuxiliaryDocumentEditor
              session={session}
              auxiliaryDocumentId={auxiliaryDocumentId}
              commandBus={commandBus}
              zoomPercent={documentZoomPercent}
              findSession={visibleFindSession}
              findQuery={findQuery}
              findReplacement={findReplacement}
              findOptions={findOptions}
              onFindOptionsChange={(options) =>
                setFindOptions((current) => ({ ...current, ...options }))
              }
              onOpenFindRail={openFindRail}
              onFindModeChange={changeFindSessionMode}
              onFindQueryChange={updateFindQuery}
              onFindReplacementChange={setFindReplacement}
              inactiveSelectionVisible={
                workspaceLayout.mode === "dual" &&
                pane !== "single" &&
                pane !== workspaceLayout.activePane
              }
              onDocumentChange={(id, document, editorState, assets) =>
                patents.updateAuxiliaryDocument(session.patentId, id, document, editorState, assets)
              }
              onRetrySave={() => runSafely(patents.persistActivePatent())}
            />
          </div>
        </div>
      </div>
    </PatentEditorViewport>
    </EditorSessionScope>
  );

  const renderPanePicker = (pane: WorkspacePane, paneState: PaneWorkspaceState) => {
    const other = pane === "left" ? "right" : "left";
    return (
      <PatentBookPicker
        sessions={patents.state.sessions}
        selectedPatentId={
          paneState.kind === "selection" ? paneState.selectedPatentId : paneState.target.patentId
        }
        excludedTarget={targetForPane(workspaceLayout, other)}
        onSelectPatent={(patentId) => selectPickerPatent(pane, patentId)}
        onSelectTarget={(target) => selectTargetInPane(pane, target)}
        onRevealExistingPane={() => activatePane(other)}
        onOpenOtherPatent={() => setLibraryPickerRequest({ pane, origin: "body-picker" })}
      />
    );
  };

  const renderPaneSwitcher = (pane: WorkspacePane) => {
    const currentTarget = targetForPane(workspaceLayout, pane);
    if (!currentTarget) return renderPanePicker(pane, workspaceLayout[pane]);
    const other = pane === "left" ? "right" : "left";
    const otherTarget = targetForPane(workspaceLayout, other);
    return (
      <PatentBookSwitcher
        sessions={patents.state.sessions}
        currentTarget={currentTarget}
        excludedTarget={otherTarget}
        excludedTargets={otherTarget ? [currentTarget, otherTarget] : [currentTarget]}
        requestedPatentId={
          paneSwitcherPatentRequest?.pane === pane ? paneSwitcherPatentRequest.patentId : null
        }
        onRequestedPatentApplied={() =>
          setPaneSwitcherPatentRequest((current) => (current?.pane === pane ? null : current))
        }
        onSelectTarget={(target) => selectTargetInPane(pane, target)}
        onRevealExistingPane={() => activatePane(other)}
        onOpenOtherPatent={() => setLibraryPickerRequest({ pane, origin: "header-switcher" })}
      />
    );
  };

  const paneView = (pane: WorkspacePane): DualDocumentPaneView => {
    const paneState = workspaceLayout[pane];
    if (paneState.kind === "selection") {
      return { kind: "selection", picker: renderPanePicker(pane, paneState) };
    }
    const session = sessionForDocumentTarget(patents.state.sessions, paneState.target);
    if (!session) {
      return { kind: "selection", picker: renderPanePicker(pane, paneState) };
    }
    if (paneState.target.kind === "tool") {
      const key = patentDocumentTargetKey(paneState.target);
      return {
        kind: "document",
        targetKey: key,
        patentName: session.patent.name,
        documentLabel: PATENT_WORKSPACE_TOOL_LABELS[paneState.target.tool],
        zoomPercent: 100,
        content: <div className="workspace-tool-host" data-workspace-tool-host={key} />,
      };
    }
    if (paneState.target.kind === "auxiliary") {
      const auxiliaryDocumentId = paneState.target.auxiliaryDocumentId;
      const auxiliary = session.patent.auxiliaryDocuments.find(
        (document) => document.auxiliaryDocumentId === auxiliaryDocumentId,
      );
      if (!auxiliary) {
        return { kind: "selection", picker: renderPanePicker(pane, paneState) };
      }
      return {
        kind: "document",
        targetKey: `${paneState.target.patentId}:auxiliary:${auxiliary.auxiliaryDocumentId}`,
        patentName: session.patent.name,
        documentLabel: auxiliary.title,
        editorId: auxiliaryDocumentEditorId(session.sessionId, auxiliary.auxiliaryDocumentId),
        zoomPercent: paneState.dualZoomPercent,
        content: renderAuxiliaryDocument(
          session,
          auxiliary.auxiliaryDocumentId,
          paneState.dualZoomPercent,
          pane,
        ),
      };
    }
    return {
      kind: "document",
      targetKey: `${paneState.target.patentId}:${paneState.target.bookKind}`,
      patentName: session.patent.name,
      bookKind: paneState.target.bookKind,
      ...(isTextPatentBook(paneState.target.bookKind)
        ? { editorId: patentBookEditorId(session.sessionId, paneState.target.bookKind) }
        : {}),
      zoomPercent: paneState.dualZoomPercent,
      content: renderPatentBook(session, paneState.dualZoomPercent, pane),
    };
  };

  const mainViewKey: MainViewKey =
    workspaceLayout.mode === "dual" && library.view === "editor"
      ? "editor-dual"
      : drawingActive
        ? "drawing-markup"
        : flowchartActive
          ? "flowchart"
          : library.view === "library"
            ? "library"
            : library.view === "trash"
              ? "trash"
              : patentsAvailable && workspaceLayout.mode === "dual"
                ? "editor-dual"
                : "editor-single";
  const dataSafetyGuideVisible =
    !isToolTutorial &&
    !startupRecoveryReport &&
    !applicationSettingsOpen &&
    shouldOfferDataSafetyGuide({
      hasOpenPatent: patents.state.sessions.length > 0,
      dismissed: dataSafetyGuideDismissed,
      backupEnabled: documents.settings.backup.enabled,
      snapshotEnabled: documents.settings.snapshot.enabled,
      suppressedByHigherPriorityOverlay: importNotice.isOpen || postImportReminder,
    });

  const saveCurrentWorkspace = useCallback(async () => {
    // Capture both handles before awaiting: a tab switch can reassign the live refs.
    const drawing = drawingWorkspaceRef.current;
    const flowchart = flowchartWorkspaceRef.current;
    if (drawingActive && !(await drawing?.flush())) return false;
    if (flowchartActive && !(await flowchart?.flush())) return false;
    return patentsAvailable ? patents.saveActivePatent() : documents.saveActiveDocument();
  }, [
    documents.saveActiveDocument,
    flowchartActive,
    drawingActive,
    patents.saveActivePatent,
    patentsAvailable,
  ]);

  const dismissDataSafetyGuide = () => {
    setDataSafetyGuideDismissed(true);
    try {
      window.sessionStorage.setItem(DATA_SAFETY_GUIDE_SNOOZED_KEY, "true");
    } catch {
      // The reminder remains dismissible for this session when storage is unavailable.
    }
  };

  const openApplicationSettings = (initialRoute: SettingsRoute = "templates") => {
    if (isToolTutorial) return;
    setApplicationSettingsInitialRoute(initialRoute);
    setApplicationSettingsOpen(true);
  };
  useEffect(
    () =>
      window.patentApi.application.onTraySettings?.(() => {
        setApplicationSettingsInitialRoute("startup");
        setApplicationSettingsOpen(true);
      }),
    [],
  );

  const handleWorkspaceInsertImage = () =>
    runSafely(
      activePatentSession?.activeBookKind === "description-drawings"
        ? importPatentDrawingImages()
        : importPatentBookImages(),
    );

  const handleWorkspaceInsertFormula = () => {
    if (activePatentSession?.activeBookKind === "description-drawings") {
      setDrawingFormulaEditor((current) =>
        current?.patentId === activePatentSession.patentId &&
        current.sessionId === activePatentSession.sessionId
          ? current
          : {
              patentId: activePatentSession.patentId,
              sessionId: activePatentSession.sessionId,
              kind: "mathematical",
            },
      );
      setDrawingFormulaEditorOpen(true);
      return;
    }
    commandBus.openFormulaEditor(activeEditorId);
  };

  const handleWorkspaceInsertChemistry = () => {
    if (activePatentSession?.activeBookKind === "description-drawings") {
      setDrawingChemistryEditor((current) =>
        current?.patentId === activePatentSession.patentId &&
        current.sessionId === activePatentSession.sessionId &&
        current.kind === "equation"
          ? current
          : {
              patentId: activePatentSession.patentId,
              sessionId: activePatentSession.sessionId,
              kind: "equation",
            },
      );
      setDrawingChemistryEditorOpen(true);
      return;
    }
    commandBus.openChemistryEditor(activeEditorId, "equation");
  };

  const handleWorkspaceInsertChemicalStructure = () => {
    if (activePatentSession?.activeBookKind === "description-drawings") {
      setDrawingChemistryEditor((current) =>
        current?.patentId === activePatentSession.patentId &&
        current.sessionId === activePatentSession.sessionId &&
        current.kind === "structure"
          ? current
          : {
              patentId: activePatentSession.patentId,
              sessionId: activePatentSession.sessionId,
              kind: "structure",
            },
      );
      setDrawingChemistryEditorOpen(true);
      return;
    }
    commandBus.openChemistryEditor(activeEditorId, "structure");
  };

  const handleWorkspaceInsertPhysicsFormula = () => {
    if (activePatentSession?.activeBookKind === "description-drawings") {
      setPhysicsFormulaTarget({
        drawingsOnly: true,
        patentId: activePatentSession.patentId,
        sessionId: activePatentSession.sessionId,
      });
      return;
    }
    if (activeEditorId) setPhysicsFormulaTarget(activeEditorId);
  };

  const closeApplicationSettings = () => {
    setApplicationSettingsOpen(false);
    setApplicationSettingsInitialRoute("templates");
  };

  useEffect(() => {
    const saveWithKeyboard = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        ignoreApplicationKeyEvent(event) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      void saveCurrentWorkspace();
    };
    window.addEventListener("keydown", saveWithKeyboard, true);
    return () => window.removeEventListener("keydown", saveWithKeyboard, true);
  }, [saveCurrentWorkspace]);

  nativeMenuCommand.current = (command) => {
    if (isToolTutorial && !["undo", "redo", "cut", "copy", "paste", "select-all"].includes(command))
      return;
    if (
      (command === "undo" || command === "redo") &&
      flowchartWorkspaceRef.current?.dispatchNativeHistory(command)
    )
      return;
    if (["undo", "redo", "cut", "copy", "paste", "select-all"].includes(command)) {
      dispatchNativeEditCommand(
        command as import("./native-history-command").NativeEditCommand,
        (value) => {
          if (value === "paste")
            runSafely(
              window.patentApi.clipboard.paste().then((result) => {
                if (!result.ok) showError(result.error);
              }),
            );
          else document.execCommand(value === "select-all" ? "selectAll" : value);
        },
      );
      return;
    }
    // Native commands share the in-app save/export flows and modal protections.
    if (hasVisibleElement('[role="dialog"][aria-modal="true"]')) return;
    if (command === "open-settings") openApplicationSettings("display");
    else if (command === "new-document") runSafely(createNewDocument());
    else if (command === "open-document") runSafely(importPatdoc());
    else if (command === "save-document") runSafely(saveCurrentWorkspace());
    else if (command === "save-document-as") requestPatentExport("patdoc");
    else if (command === "export-docx") requestPatentExport("docx");
    else if (command === "export-pdf") requestPatentExport("pdf");
    else if (command === "print") runSafely(printDocument());
  };

  const assistantPanelBoundsRef = useAssistantPanelBounds(workspaceLayout.mode === "dual");
  const launchDrawing = async () => {
    const owner = activePatentSession;
    if (!owner) return false;
    // Finish the previous save/close before reopening. Its delayed completion
    // must never remove the workspace that the user has just opened again.
    if (drawingCloseOperation.current && !(await drawingCloseOperation.current)) return false;
    setFlowchartForSession(owner.sessionId, (current) => (current ? { ...current, active: false } : current));
    setDrawingShownForSession(owner.sessionId, true);
    library.setView("editor");
    setDrawingForSession(owner.sessionId, owner.patentId);
    if (workspaceLayout.mode === "dual")
      await selectTargetInPane(workspaceLayout.activePane, {
        patentId: owner.patentId,
        kind: "tool",
        tool: "drawing-markup",
      });
    return true;
  };

  const drawingDrop = useDrawingFileDrop({
    enabled: patentsAvailable && library.view === "editor" && Boolean(activePatentSession),
    cadActive: drawingActive,
    onError: (message) => setOperationFeedback({ tone: "error", title: "未导入图纸", message }),
    onFiles: (files) => {
      if (!activePatentSession) return;
      if (drawingDropInFlight.current) {
        setOperationFeedback({
          tone: "error",
          title: "正在导入图纸",
          message: "请等待本批图纸导入完成后再拖入。",
        });
        return;
      }
      const patentId = activePatentSession.patentId;
      drawingDropInFlight.current = true;
      void (async () => {
        try {
          if (!(await launchDrawing())) {
            drawingDropInFlight.current = false;
            return;
          }
          setPendingDrawingImport({ id: randomUuid(), patentId, files });
        } catch (error) {
          drawingDropInFlight.current = false;
          setOperationFeedback({
            tone: "error",
            title: "未导入图纸",
            message: error instanceof Error ? error.message : "无法打开 CAD标号，请重试。",
          });
        }
      })();
    },
  });
  useEffect(() => {
    if (!pendingDrawingImport || consumedDrawingDrop.current === pendingDrawingImport.id) return;
    if (pendingDrawingImport.patentId !== activePatentSession?.patentId) {
      setPendingDrawingImport(null);
      drawingDropInFlight.current = false;
      return;
    }
    if (!drawingActive || !drawingWorkspaceRef.current) return;
    consumedDrawingDrop.current = pendingDrawingImport.id;
    setPendingDrawingImport(null);
    void drawingWorkspaceRef.current
      .importFiles(pendingDrawingImport.files)
      .catch((error) =>
        setOperationFeedback({
          tone: "error",
          title: "导入图纸失败",
          message: error instanceof Error ? error.message : "请重新拖入图纸。",
        }),
      )
      .finally(() => {
        drawingDropInFlight.current = false;
      });
  }, [pendingDrawingImport, drawingActive, activePatentSession?.patentId]);

  const applicationMenu = (
    <MenuBar
      tutorialMode={isToolTutorial}
      libraryMode={patentsAvailable && library.view === "library"}
      onOpenDrawingMarkup={() => launchDrawing()}
      workspaceTabDrag={workspaceTabDrag.bindings}
      auxiliaryDocumentActive={activeWorkspaceTarget?.kind === "auxiliary"}
      editorAvailable={
        !embeddedEditorActive && Boolean(activeEditorId) && !activeAutomationReadOnly
      }
      historyAvailable={historyAvailable && !activeAutomationReadOnly}
      canUndo={canUndo}
      canRedo={canRedo}
      historyUnavailableReason={historyUnavailableReason}
      showTextEditingTools={showTextEditingTools}
      capabilities={activeEditorCapabilities}
      formatState={formatState}
      activeBookKind={activePatentSession?.activeBookKind ?? null}
      availableBookKinds={
        activePatentSession ? availablePatentBookKinds(activePatentSession.patent) : []
      }
      onNewDocument={() =>
        runSafely(
          (async () => {
            await createNewDocument();
          })(),
        )
      }
      onOpenDocument={() =>
        runSafely(
          (async () => {
            await importPatdoc();
          })(),
        )
      }
      onImportDocx={() => runSafely(startDocxImport())}
      onSaveDocument={() => runSafely(saveCurrentWorkspace())}
      onSaveDocumentAs={() => {
        if (patentsAvailable) requestPatentExport("patdoc");
        else runSafely(documents.saveActiveDocumentAs());
      }}
      onExportDocx={() => requestPatentExport("docx")}
      onExportPdf={() => requestPatentExport("pdf")}
      onPrint={() => runSafely(printDocument())}
      onFind={() => openFindRail("find")}
      onReplace={() => openFindRail("replace")}
      onOpenPageMargins={() => setPageMarginOpen(true)}
      onOpenSettings={() => openApplicationSettings("templates")}
      onOpenAgentCli={() => openApplicationSettings("automation")}
      onOpenSnapshotManager={() => openApplicationSettings("snapshots")}
      onOpenBackupManager={() => openApplicationSettings("backups")}
      onExitApplication={() =>
        runSafely(
          requestApplicationExit(window.patentApi.application, () => window.close()).then(
            (result) => {
              if (!result.ok) showError(result.error);
            },
          ),
        )
      }
      onInsertDependentClaim={() => {
        if (!activeEditorId || activePatentSession?.activeBookKind !== "claims") return;
        const result = commandBus.insertDependentClaim(activeEditorId);
        setOperationFeedback({
          tone: result.ok ? "success" : "error",
          title: result.ok ? "插入成功" : "无法插入",
          message: result.message,
        });
      }}
      onCreateDesktopShortcut={() => runSafely(createDesktopShortcut())}
      onOpenThirdPartyNotices={() => runSafely(openThirdPartyNotices())}
      onOpenThirdPartyLicensesFolder={() => runSafely(openThirdPartyLicensesFolder())}
      onOpenLibrary={() => {
        runSafely(
          (async () => {
            patentCheckInspection.cancel();
            setPatentCheckRequest(null);
            setPatentCheckRunToken(null);
            setPatentCheckInitialRunning(false);
            library.setView("library");
          })(),
        );
      }}
      onOpenPatentSettings={() => {
        const activePatent = activePatentSession;
        if (!activePatent) {
          showAppAlert("请先打开或新建专利后再修改专利设置。");
          return;
        }
        const summary = library.activePatents.find(
          (candidate) => candidate.patentId === activePatent.patentId,
        );
        if (!summary) {
          showAppAlert("当前专利信息尚未加载完成，请稍后重试。");
          return;
        }
        setSettingsPatent(summary);
      }}
      onCloseCurrent={() => {
        if (
          drawingActive &&
          (workspaceLayout.mode === "single" || drawingPane === workspaceLayout.activePane)
        ) {
          runSafely(closeDrawingWorkspace());
          return;
        }
        if (
          flowchartActive &&
          (workspaceLayout.mode === "single" || flowchartPane === workspaceLayout.activePane)
        ) {
          runSafely(closeFlowchartWorkspace());
          return;
        }
        if (patentsAvailable && activePatentSession) {
          runSafely(requestClosePatent(activePatentSession.patentId));
          return;
        }
        if (activeSessionId) documents.requestClose(activeSessionId);
      }}
      onCommand={executeEditorCommand}
      onParagraphStyle={(style) => commandBus.setParagraphStyle(activeEditorId, style)}
      onFontFamily={(fontFamily) => commandBus.setFontFamily(activeEditorId, fontFamily)}
      onFontSize={(fontSizePt) => commandBus.setFontSizePt(activeEditorId, fontSizePt)}
      onColor={(color) => commandBus.setColor(activeEditorId, color)}
      onHighlightColor={(color) => commandBus.setHighlightColor(activeEditorId, color)}
      onInsertTable={(request) => commandBus.insertTable(activeEditorId, request)}
      onInsertFormula={handleWorkspaceInsertFormula}
      onInsertChemistry={handleWorkspaceInsertChemistry}
      onInsertChemicalStructure={handleWorkspaceInsertChemicalStructure}
      onInsertPhysicsFormula={handleWorkspaceInsertPhysicsFormula}
      onInsertFlowchart={() => openFlowchartWorkspace(null, null, "flowchart")}
      onInsertCircuitDiagram={() => openFlowchartWorkspace(null, null, "circuit")}
      onInsertImage={handleWorkspaceInsertImage}
      onActivateBook={(bookKind) => {
        if (!activePatentSession) return;
        runSafely(
          (async () => {
            if (workspaceLayout.mode === "dual") {
              selectTargetInPane(workspaceLayout.activePane, {
                patentId: activePatentSession.patentId,
                bookKind,
              });
              return;
            }
            patents.activateBook(activePatentSession.patentId, bookKind);
          })(),
        );
      }}
      onZoomIn={() => handleZoom(10)}
      onZoomOut={() => handleZoom(-10)}
      onZoomReset={resetZoom}
      onCheckProblems={() => {
        if (!activePatentSession) {
          showAppAlert("请先打开或新建专利后再进行本地检查。");
          return;
        }
        setAiCorrectionOpen(false);
        setTextPolishOpen(false);
        setPatentCheckRunToken(null);
        setPatentCheckRequest({
          patentId: activePatentSession.patentId,
          pane: workspaceLayout.mode === "dual" ? workspaceLayout.activePane : "single",
          nonce: Date.now(),
        });
      }}
      onAiCorrection={() => {
              if (!isNetworkAiAvailable()) return;
        if (!activePatentSession || !isTextPatentBook(activePatentSession.activeBookKind)) {
          showAppAlert("请先打开权利要求书、说明书或说明书摘要。");
          return;
        }
        setPatentCheckRequest(null);
        setTextPolishOpen(false);
        setAiCorrectionOpen(true);
      }}
      onTextPolish={() => {
              if (!isNetworkAiAvailable()) return;
        if (!activePatentSession || !isTextPatentBook(activePatentSession.activeBookKind)) {
          showAppAlert("请先打开权利要求书、说明书或说明书摘要。");
          return;
        }
        setPatentCheckRequest(null);
        setAiCorrectionOpen(false);
        setTextPolishActionError(null);
        setTextPolishOpen(true);
      }}
      onClearExtraFormatting={() => {
        const result = commandBus.clearExtraFormatting(activeEditorId);
        setOperationFeedback({
          tone: result.ok ? "success" : "error",
          title: result.ok ? "格式清理完成" : "无法清理格式",
          message: result.message,
        });
      }}
      {...(patentsAvailable && library.view === "editor" && activePatentSession
        ? {
            splitViewActive: workspaceLayout.mode === "dual",
            columnsActive,
            onToggleColumns: () => {
              runSafely(
                (async () => {
                  if (columnsRequested && workspaceLayout.mode === "single") {
                    await exitColumns();
                    return;
                  }
                  if (
                    !supportsDualColumns(activePatentSession.activeBookKind) ||
                    activePatentSession.activeAuxiliaryDocumentId
                  ) {
                    showAppAlert("双列显示仅支持权利要求书和说明书。");
                    return;
                  }
                  await runWorkspaceLayoutSwitch("enter-columns", async (transition) => {
                    const pageWidth =
                      document.querySelector<HTMLElement>(".patent-page-zoom-frame")?.offsetWidth ||
                      820;
                    const result = await window.patentApi.application.setDualColumnWindow({
                      enabled: true,
                      pageWidth,
                    });
                    if (transition.cancelled) return;
                    if (!result.ok) {
                      transition.cancel();
                      showAppAlert("无法调整双列窗口，请重试。");
                      return;
                    }
                    retainSelectionsForLayoutChange();
                    await transition.commit(() => {
                      flushSync(() => {
                        setDrawingMarkupShown(false);
                        setFlowchartWorkspace((current) =>
                          current ? { ...current, active: false } : current,
                        );
                        setWorkspaceLayout((current) => exitDualWorkspace(current));
                        setColumnZoomPercent(100);
                        setColumnsRequested(true);
                      });
                    });
                  });
                })(),
              );
            },
            onToggleSplitView: () => runSafely(toggleDualView()),
            onSelectSplitPair: (pair: PatentWorkspacePair) => {
              runSafely(
                (async () => {
                  setDrawingMarkupShown(false);
                  setFlowchartWorkspace((current) =>
                    current ? { ...current, active: false } : current,
                  );
                  await selectQuickPair(pair);
                })(),
              );
            },
            customDualViewPresets: documents.settings.customDualViewPresets,
            onOpenCustomDualView: () => {
              runSafely(
                (async () => {
                  setDrawingMarkupShown(false);
                  setFlowchartWorkspace((current) =>
                    current ? { ...current, active: false } : current,
                  );
                  setCustomDualViewOpen(true);
                })(),
              );
            },
            onSelectCustomDualViewPreset: (index: number) =>
              runSafely(
                (async () => {
                  setDrawingMarkupShown(false);
                  setFlowchartWorkspace((current) =>
                    current ? { ...current, active: false } : current,
                  );
                  await selectCustomDualViewPreset(index);
                })(),
              ),
          }
        : {})}
      {...(library.view === "editor" &&
      drawingPatentSession &&
      drawingMarkupPatentId === activePatentSession?.patentId
        ? {
            drawingTab: {
              active: drawingActive,
              patentId: drawingMarkupPatentId,
              onActivate: () => {
                if (workspaceLayout.mode === "dual") {
                  runSafely(
                    selectTargetInPane(drawingPane ?? workspaceLayout.activePane, {
                      patentId: drawingMarkupPatentId,
                      kind: "tool",
                      tool: "drawing-markup",
                    }),
                  );
                  return;
                }
                setFlowchartWorkspace((current) =>
                  current ? { ...current, active: false } : current,
                );
                setDrawingMarkupShown(true);
              },
              onRequestClose: () => runSafely(closeDrawingWorkspace()),
            },
          }
        : {})}
      {...(library.view === "editor" &&
      flowchartWorkspace &&
      flowchartWorkspace.patentId === activePatentSession?.patentId
        ? {
            flowchartTab: {
              active: flowchartActive,
              patentId: flowchartWorkspace.patentId,
              onActivate: () => {
                if (workspaceLayout.mode === "dual") {
                  runSafely(
                    selectTargetInPane(flowchartPane ?? workspaceLayout.activePane, {
                      patentId: flowchartWorkspace.patentId,
                      kind: "tool",
                      tool: "flowchart",
                    }),
                  );
                  return;
                }
                setDrawingMarkupShown(false);
                runSafely(
                  (async () => {
                    setFlowchartWorkspace((current) =>
                      current ? { ...current, active: true } : current,
                    );
                  })(),
                );
              },
              onRequestClose: () => runSafely(closeFlowchartWorkspace()),
            },
          }
        : {})}
    >
      {patentsAvailable && library.view === "editor" && activePatentSession && activePatentSession.patent.patentType !== "design" ? (
        <PatentBookTabs
          session={activePatentSession}
          inactive={embeddedEditorActive}
          workspaceTabDrag={workspaceTabDrag.bindings}
          onActivateBook={(patentId, bookKind) => {
            runSafely(
              (async () => {
                setDrawingMarkupShown(false);
                setFlowchartWorkspace((current) =>
                  current ? { ...current, active: false } : current,
                );
                if (workspaceLayout.mode === "dual") {
                  selectTargetInPane(workspaceLayout.activePane, { patentId, bookKind });
                  return;
                }
                patents.activateBook(patentId, bookKind);
              })(),
            );
          }}
          onSetDrawingBooksEnabled={patents.setDrawingBooksEnabled}
          onDropDrawingFiles={importDroppedPatentDrawingFiles}
        />
      ) : null}
    </MenuBar>
  );

  return (
    <ActiveEditorSessionContext.Provider value={library.view === "editor" ? activePatentSession?.sessionId ?? null : null}>
    <ShortcutProvider settings={documents.settings.shortcuts}>
      {!isToolTutorial && <SoftwareUpdates />}
      <ToolTutorial
        patent={activePatentSession?.patent ?? null}
        onOpen={async (patentId, bookKind) => {
          const session = await patents.openPatent(patentId);
          if (!session) throw new Error("示例专利打开失败，请重试。");
          setDrawingMarkupShown(false);
          setFlowchartWorkspace((current) => (current ? { ...current, active: false } : current));
          patents.activateBook(patentId, bookKind);
          library.setView("editor");
        }}
        onClose={async (patentId) => {
          if (!patents.state.sessions.some((session) => session.patentId === patentId)) return true;
          return closePatentWithEmbeddedEditors(patentId);
        }}
        onNavigate={async (bookKind) => {
          if (!activePatentSession) throw new Error("请先打开本课示例。");
          setDrawingMarkupShown(false);
          setFlowchartWorkspace((current) => (current ? { ...current, active: false } : current));
          patents.activateBook(activePatentSession.patentId, bookKind);
        }}
      />
      <ToolActionTooltips settings={documents.settings.shortcuts} />
      <div
        className={`window-shell ${library.view !== "editor" ? "is-library-active" : ""} ${embeddedEditorActive && workspaceLayout.mode === "single" ? "is-flowchart-active" : ""}`}
        {...drawingDrop.handlers}
        data-testid="app-shell"
        data-tool-tutorial={isToolTutorial ? "true" : undefined}
        ref={assistantPanelBoundsRef}
      >
        {drawingDrop.hint && (
          <div className="cad-file-drop-hint" role="status">
            {drawingDrop.hint}
          </div>
        )}
        {patentsAvailable ? (
          <PatentTabs
            tutorialMode={isToolTutorial}
            guidance={
              <WritingGuidance
                onOpenPractice={openToolTutorial}
                readSelection={() => {
                  if (!activeEditorId) return "";
                  const selection = commandBus.getPlainTextSelection(activeEditorId);
                  return selection.ok ? selection.text : "";
                }}
                introductionSeen={documents.settings.editorIntroductionSeen}
                onIntroductionSeen={() => {
                  void documents.updateAppSettings({ editorIntroductionSeen: true });
                }}
                enabled={
                  !isToolTutorial && library.view === "editor" && Boolean(activePatentSession)
                }
                ownerKey={`${activePatentSession?.patentId ?? ""}:${workspaceLayout.mode === "dual" ? workspaceLayout.activePane : "single"}`}
                book={
                  activeWorkspaceTarget?.kind === "book" &&
                  !(workspaceLayout.mode === "single" && (drawingActive || flowchartActive))
                    ? activeWorkspaceTarget.bookKind
                    : null
                }
                scope={workspaceLayout.mode === "dual" ? workspaceLayout.activePane : "single"}
                onNavigate={async (bookKind) => {
                  if (!activePatentSession) throw new Error("请先打开专利。");
                  if (workspaceLayout.mode === "dual") {
                    await selectTargetInPane(workspaceLayout.activePane, {
                      patentId: activePatentSession.patentId,
                      bookKind,
                    });
                  } else {
                    setDrawingMarkupShown(false);
                    setFlowchartWorkspace((current) =>
                      current ? { ...current, active: false } : current,
                    );
                    patents.activateBook(activePatentSession.patentId, bookKind);
                  }
                }}
              />
            }
            sessions={patents.state.sessions}
            onNewPatent={() => runSafely(createNewDocument())}
            activePatentId={patents.state.activePatentId}
            libraryActive={library.view === "library"}
            workspaceTabDrag={workspaceTabDrag.bindings}
            onActivatePatent={(patentId) => {
              runSafely(
                (async () => {
                  const pendingClose = pendingUiCloses.current.get(patentId);
                  if (pendingClose) {
                    await pendingClose;
                    if (!(await patents.openPatent(patentId))) return;
                  }
                  selectPatentInActivePane(patentId);
                  library.setView("editor");
                })(),
              );
            }}
            onRequestClose={(patentId) => {
              const operation = requestClosePatent(patentId);
              runSafely(operation);
              return operation.catch(() => undefined);
            }}
            onOpenLibrary={() => {
              runSafely(
                (async () => {
                  library.setView("library");
                })(),
              );
            }}
          />
        ) : (
          <DocumentTabs
            sessions={documents.state.sessions}
            activeSessionId={documents.state.activeSessionId}
            libraryActive={library.view === "library"}
            onActivate={activateDocumentTab}
            onRequestClose={documents.requestClose}
            onReorder={documents.reorderDocuments}
            onNewDocument={() => runSafely(createNewDocument())}
            onOpenLibrary={() => library.setView("library")}
          />
        )}
        {patentsAvailable && library.view === "library" ? null : applicationMenu}
        {activePatentSession?.patent.patentType !== "design" && (!embeddedEditorActive || workspaceLayout.mode === "dual") && library.view === "editor" ? (
          <ToolBar
            tutorialMode={isToolTutorial}
            showNewDocumentButton={!patentsAvailable}
            workspaceToolDrag={
              workspaceTabDragEnabled && activePatentSession
                ? { patentId: activePatentSession.patentId, bindings: workspaceTabDrag.bindings }
                : undefined
            }
            onOpenDrawingMarkup={() => launchDrawing()}
            auxiliaryDocumentActive={activeWorkspaceTarget?.kind === "auxiliary"}
            editorAvailable={Boolean(activeEditorId) && !activeAutomationReadOnly}
            historyAvailable={historyAvailable && !activeAutomationReadOnly}
            canUndo={canUndo}
            canRedo={canRedo}
            historyUnavailableReason={historyUnavailableReason}
            showTextEditingTools={showTextEditingTools}
            textEditingToolsDisabled={textEditingToolsDisabled || activeAutomationReadOnly}
            showDrawingInsertionTools={showDrawingInsertionTools && !activeAutomationReadOnly}
            imageInsertionAvailable={imageInsertionAvailable && !activeAutomationReadOnly}
            onNewDocument={() => runSafely(createNewDocument())}
            onOpenDocument={() => runSafely(importPatdoc())}
            onImportDocx={() => runSafely(startDocxImport())}
            onSaveDocument={() => runSafely(saveCurrentWorkspace())}
            onExportDocx={() => requestPatentExport("docx")}
            onExportPdf={() => requestPatentExport("pdf")}
            onExportPatdoc={() => requestPatentExport("patdoc")}
            onPrint={() => runSafely(printDocument())}
            onInsertFlowchart={() => openFlowchartWorkspace(null, null, "flowchart")}
            onInsertCircuitDiagram={() => openFlowchartWorkspace(null, null, "circuit")}
            onCommand={executeEditorCommand}
            onParagraphStyle={(style) => commandBus.setParagraphStyle(activeEditorId, style)}
            onFontFamily={(fontFamily) => commandBus.setFontFamily(activeEditorId, fontFamily)}
            onFontSize={(fontSizePt) => commandBus.setFontSizePt(activeEditorId, fontSizePt)}
            onColor={(color, preserveSelection, focusEditor) =>
              commandBus.setColor(activeEditorId, color, preserveSelection, focusEditor)
            }
            onHighlightColor={(color, preserveSelection, focusEditor) =>
              commandBus.setHighlightColor(activeEditorId, color, preserveSelection, focusEditor)
            }
            onInsertTable={(request) => commandBus.insertTable(activeEditorId, request)}
            onInsertImage={handleWorkspaceInsertImage}
            onInsertFormula={handleWorkspaceInsertFormula}
            onInsertChemistry={handleWorkspaceInsertChemistry}
            onInsertChemicalStructure={handleWorkspaceInsertChemicalStructure}
            onInsertPhysicsFormula={handleWorkspaceInsertPhysicsFormula}
            onFind={() => openFindRail("find")}
            findMode={visibleFindSession?.mode ?? null}
            activeAssistantPanel={
              patentCheckRequest && patentCheckSession
                ? "本地检查"
                : aiCorrectionOpen
                  ? "AI 纠错"
                  : textPolishOpen
                    ? "小栈AI助手"
                    : null
            }
            onReplace={() => openFindRail("replace")}
            onCheckProblems={() => {
              if (patentCheckRequest) {
                patentCheckInspection.cancel();
                setPatentCheckRequest(null);
                setPatentCheckRunToken(null);
                setPatentCheckInitialRunning(false);
                return;
              }
              if (!activePatentSession) return;
              setAiCorrectionOpen(false);
              setTextPolishOpen(false);
              setPatentCheckRunToken(null);
              setPatentCheckRequest({
                patentId: activePatentSession.patentId,
                pane: workspaceLayout.mode === "dual" ? workspaceLayout.activePane : "single",
                nonce: Date.now(),
              });
            }}
            onAiCorrection={() => {
              if (!isNetworkAiAvailable()) return;
              setPatentCheckRequest(null);
              setTextPolishOpen(false);
              setAiCorrectionOpen((open) => !open);
            }}
            onTextPolish={() => {
              if (!isNetworkAiAvailable()) return;
              setPatentCheckRequest(null);
              setAiCorrectionOpen(false);
              setTextPolishActionError(null);
              setTextPolishOpen((open) => !open);
            }}
            formatState={formatState}
            capabilities={activeEditorCapabilities}
          />
        ) : null}
        <AnimatedMainView viewKey={mainViewKey} onStageRef={setMainViewStageNode}>
          {patents.state.sessions.filter(session => drawingSessions[session.sessionId]).map(drawingPatentSession => {
 const ownerId = drawingPatentSession.sessionId;
 const visible = drawingActive && drawingMarkupPatentId === drawingPatentSession.patentId;
 const enabled = drawingRuntime.owner === ownerId;
 return (
            <PersistentWorkspace key={ownerId}
              onActivate={() => {
                if (drawingPane) activatePane(drawingPane);
              }}
              className="embedded-drawing-pane"
              readOnly={patents.isAutomationReadOnly(drawingPatentSession.patentId)}
              visible={visible}
              hostKey={toolPane("drawing-markup", drawingPatentSession.patentId) ? `${drawingPatentSession.patentId}:tool:drawing-markup` : null}
            >
              <EditorSessionScope sessionId={ownerId}>
              <div inert={!enabled} style={{ display: "contents" }}>
              <DrawingWorkspace
                ref={handle => {
                  if (handle) drawingHandles.current.set(ownerId, handle); else drawingHandles.current.delete(ownerId);
                  if (drawingOwner?.sessionId === ownerId) drawingWorkspaceRef.current = handle;
                }}
                key={drawingPatentSession.patentId}
                session={drawingPatentSession}
                openProjectRequest={folderDrawingTargets[drawingPatentSession.patentId]}
                active={visible && enabled}
                runtimeEnabled={enabled}
              />
              </div></EditorSessionScope>
              {visible && !enabled ? <div role="status">{drawingRuntime.failed ? "原专利图纸尚未保存，切换已暂停，请返回原专利检查或重试。" : "正在保存并切换图纸…"}{drawingRuntime.failed ? <button type="button" onClick={drawingRuntime.retry}>重试切换</button> : null}</div> : null}
            </PersistentWorkspace>
          ); })}
          {patents.state.sessions.filter(session => flowchartSessions[session.sessionId]).map(flowchartPatentSession => {
 const ownerId = flowchartPatentSession.sessionId;
 const entry = flowchartSessions[ownerId];
 if (!entry) return null;
 const visible = flowchartActive && flowchartOwner?.sessionId === ownerId;
 const enabled = flowchartRuntime.owner === ownerId;
 const flowchartWorkspace = entry;
 const setFlowchartWorkspace = (action: import("react").SetStateAction<typeof entry | null>) => setFlowchartForSession(ownerId, action);
 const flowchartFigureOptions = flowchartPatentSession.patent.figures.map((figure, index) => ({...figure, label: `图${index + 1}`}));
 const flowchartLinkedFigureLabels = new Map<string, string[]>();
 flowchartPatentSession.patent.figures.forEach((figure, index) => {
   const projectId = figure.flowchartLink?.projectId;
   if (projectId) flowchartLinkedFigureLabels.set(projectId, [...(flowchartLinkedFigureLabels.get(projectId) ?? []), `图${index + 1}`]);
 });
 return (
            <PersistentWorkspace key={ownerId}
              onActivate={() => {
                if (flowchartPane) activatePane(flowchartPane);
              }}
              className="embedded-flowchart-pane"
              readOnly={patents.isAutomationReadOnly(flowchartWorkspace.patentId)}
              visible={visible}
              hostKey={toolPane("flowchart", entry.patentId) ? `${entry.patentId}:tool:flowchart` : null}
            >
              <EditorSessionScope sessionId={ownerId}>
              <div inert={!enabled} style={{ display: "contents" }}>
              <FlowchartWorkspace
                ref={handle => {
                  if (handle) flowchartHandles.current.set(ownerId, handle); else flowchartHandles.current.delete(ownerId);
                  if (flowchartOwner?.sessionId === ownerId) flowchartWorkspaceRef.current = handle;
                }}
                key={flowchartWorkspace.patentId}
                patentId={flowchartWorkspace.patentId}
                patentName={flowchartPatentSession?.patent.name ?? null}
                patentRevision={flowchartWorkspace.patentRevision}
                {...(flowchartPatentSession
                  ? { patentSessionId: flowchartPatentSession.sessionId }
                  : {})}
                active={visible && enabled}
                runtimeEnabled={enabled}
                embedded
                initialProjectId={flowchartWorkspace.initialProjectId}
                initialMode={flowchartWorkspace.editorMode}
                {...(flowchartWorkspace.defaultReplaceFigureId
                  ? { defaultReplaceFigureId: flowchartWorkspace.defaultReplaceFigureId }
                  : {})}
                api={patents.flowcharts}
                linkedFigureLabels={flowchartLinkedFigureLabels}
                figureOptions={flowchartFigureOptions}
                drawingPage={
                  flowchartPatentSession?.patent.books.find(
                    (book) => book.kind === "description-drawings",
                  )?.document.page
                }
                onExit={() => {
                  runSafely(
                    closeToolPane("flowchart", () =>
                      setFlowchartWorkspace((current) =>
                        current ? { ...current, active: false } : current,
                      ),
                    ),
                  );
                }}
                onEditorModeChange={(editorMode) =>
                  setFlowchartWorkspace((current) =>
                    current ? { ...current, editorMode } : current,
                  )
                }
                onExportToCad={async (file, ownerPatentId) => {
                  if (activePatentSession?.patentId !== ownerPatentId)
                    throw new Error("当前专利已切换，请返回原专利后重新导出。");
                  if (drawingDropInFlight.current) throw new Error("正在导入图纸，请完成后重试。");
                  drawingDropInFlight.current = true;
                  try {
                    if (!(await launchDrawing()))
                      throw new Error("无法打开CAD标号，请先保存当前工作稿。");
                    setPendingDrawingImport({
                      id: randomUuid(),
                      patentId: ownerPatentId,
                      files: [file],
                    });
                  } catch (error) {
                    drawingDropInFlight.current = false;
                    throw error;
                  }
                }}
                {...(activePatentSession?.sessionId === ownerId ? { onExplicitSave: saveCurrentWorkspace } : {})}
              />
              </div></EditorSessionScope>
              {visible && !enabled ? <div role="status">{flowchartRuntime.failed ? "原专利流程图尚未保存，切换已暂停，请返回原专利检查或重试。" : "正在保存并切换流程图…"}{flowchartRuntime.failed ? <button type="button" onClick={flowchartRuntime.retry}>重试切换</button> : null}</div> : null}
            </PersistentWorkspace>
          ); })}
          <div
            ref={standardWorkspaceRef}
            className="standard-workspace-pane"
            data-testid="patent-workspace-drop-region"
            data-workspace-tab-drag-status={workspaceTabDragPreview?.status}
            data-workspace-tab-drag-effect={workspaceTabDragPreview?.effect ?? undefined}
            data-workspace-tab-drag-pane={workspaceTabDragPreview?.pane ?? undefined}
            hidden={embeddedEditorActive && workspaceLayout.mode === "single"}
            aria-hidden={embeddedEditorActive && workspaceLayout.mode === "single"}
          >
            {library.view === "library" && !isToolTutorial ? (
              <DocumentLibrary
                applicationMenu={
                  <>
                    <ToolTutorialLibraryEntry />
                    {applicationMenu}
                  </>
                }
                onCreateDesktopShortcut={() => runSafely(createDesktopShortcut())}
                onExitApplication={() =>
                  runSafely(
                    requestApplicationExit(window.patentApi.application, () => window.close()).then(
                      (result) => {
                        if (!result.ok) showError(result.error);
                      },
                    ),
                  )
                }
                navigationStateRef={patentLibraryNavigationRef}
                documents={library.activeDocuments}
                patents={patentsAvailable ? library.activePatents : undefined}
                loading={library.activeLoading}
                activeError={library.activeError}
                onRetryActive={() => runSafely(library.refreshActive())}
                onNewDocument={() => runSafely(createNewDocument())}
                onNewPatent={() => setCreatePatentOpen(true)}
                onImportPatdoc={() => runSafely(importPatdoc())}
                onImportDocx={() => runSafely(startDocxImport())}
                onOpenTrash={() => {
                  setTrashOpen(true);
                  runSafely(library.refreshTrash());
                }}
                onOpenDocument={(document) => runSafely(openLibraryDocument(document))}
                onOpenPatent={(patent, target, resultKey) =>
                  runSafely(openLibraryPatent(patent, target, resultKey))
                }
                onRenameDocument={(document) => runSafely(renameLibraryDocument(document))}
                onEditPatentSettings={(patent) => setSettingsPatent(patent)}
                onOpenSnapshots={(patent) =>
                  setRecoveryCenter({
                    initialTab: "snapshots",
                    ...(patent ? { patentId: patent.patentId } : {}),
                  })
                }
                onOpenBackups={(patent) =>
                  setRecoveryCenter({
                    initialTab: "backups",
                    ...(patent ? { patentId: patent.patentId } : {}),
                  })
                }
                onRecoverPatent={async (patent) => {
                  const recovered = await library.recoverPatent(patent);
                  if (!recovered) return;
                  runSafely(openLibraryPatent(patent));
                }}
                onExportPatdoc={(document) => runSafely(exportLibraryPatdoc(document))}
                onExportPatent={(patent) => setLibraryPatentExport([patent])}
                onOpenPatentFolder={(patent) => runSafely(openPatentFolder(patent))}
                onExportPatents={(selected) => {
                  if (selected.length > 100) {
                    showAppAlert("每次最多导出 100 项专利，请分批导出。");
                    return;
                  }
                  setLibraryPatentExport(selected);
                }}
                onImportBundle={() => runSafely(importLibraryBundle())}
                onExportDocx={(document) => runSafely(exportLibraryDocument(document, "docx"))}
                onExportPdf={(document) => runSafely(exportLibraryDocument(document, "pdf"))}
                onMoveToTrash={(document) => runSafely(moveLibraryDocumentToTrash(document))}
                onMovePatentToTrash={(patent) => runSafely(moveLibraryPatentToTrash(patent))}
                onMovePatentsToTrash={moveLibraryPatentsToTrash}
                deletingPatents={batchTrashBusy}
                patentLibraryViewMode={documents.settings.patentLibraryViewMode}
                onPatentLibraryViewModeChange={async (patentLibraryViewMode) =>
                  Boolean(await documents.updateAppSettings({ patentLibraryViewMode }))
                }
                patentFocusRequest={patentLibraryFocusRequest}
                onPatentFocusHandled={(requestKey) => {
                  setPatentLibraryFocusRequest((current) =>
                    current?.requestKey === requestKey ? null : current,
                  );
                }}
              />
            ) : null}
            <div
              className="persistent-editor-workspace"
              hidden={library.view === "library" && !isToolTutorial}
            >
            {patentsAvailable ? (
              <PatentBookViewportProvider store={patentBookViewportStore}>
                {activePatentSession?.patent.patentType === "design" ? (
                <DesignPatentWorkbench
                  session={activePatentSession}
                  onUpdate={(designPatent, assets) =>
                    patents.updateDesignPatent(activePatentSession.patentId, designPatent, assets)
                  }
                  onPrepareExport={() =>
                    patents.prepareDesignPatentExport(activePatentSession.patentId)
                  }
                  onExportCommitted={(patent, savedAt) =>
                    patents.adoptDesignPatentExport(activePatentSession.patentId, patent, savedAt)
                  }
                />
              ) : patents.activeSession && workspaceLayout.mode === "dual" ? (
                  <DualDocumentWorkspace
                    left={paneView("left")}
                    right={paneView("right")}
                    activePane={workspaceLayout.activePane}
                    initialRailSpace={windowLayout.fit?.initialRailSpace ?? "constrained"}
                    toolIdsByPane={
                      findSession?.scope === "left"
                        ? { left: ["find-replace"] }
                        : findSession?.scope === "right"
                          ? { right: ["find-replace"] }
                          : {}
                    }
                    switchers={{
                      left: renderPaneSwitcher("left"),
                      right: renderPaneSwitcher("right"),
                    }}
                    hasNonEmptyTextSelection={(editorId) =>
                      commandBus.hasNonEmptyTextSelection(editorId)
                    }
                    onPreserveSelectionPointer={preservePatentSelectionForPointer}
                    onRestoreRetainedSelection={(editorId) => commandBus.focus(editorId)}
                    onActivatePane={activatePane}
                    onClosePane={closePane}
                    onOpenPicker={openPickerInPane}
                    onOpenSinglePane={openPaneAsSingle}
                    onSwap={() => {
                      retainSelectionsForLayoutChange();
                      setWorkspaceLayout((current) => swapWorkspacePanes(current));
                    }}
                  />
                ) : patents.activeSession ? (
                  <PatentFunctionRailScope
                    scopeKey="single"
                    externalToolIds={visibleFindSession?.scope === "single" ? ["find-replace"] : []}
                  >
                    {patents.state.sessions.map((session) => {
                      const active = library.view === "editor" && session.patentId === patents.activeSession?.patentId;
                      return (
                        <Fragment key={session.patentId}>
                          {active && session.activeAuxiliaryDocumentId
                            ? renderAuxiliaryDocument(session, session.activeAuxiliaryDocumentId)
                            : null}
                          <PersistentBookWorkspace
                            session={session}
                            active={active && session.activeAuxiliaryDocumentId === null}
                            renderBook={(bookSession) => renderPatentBook(bookSession)}
                          />
                        </Fragment>
                      );
                    })}
                  </PatentFunctionRailScope>
                ) : (
                  <main
                    className="editor-workspace patent-editor-workspace"
                    aria-label="专利编辑区"
                  >
                    <p>{isToolTutorial ? "正在准备教学示例…" : "请从专利库打开或新建一个专利。"}</p>
                  </main>
                )}
                <SpatialPresence>
                  {contentSearchOrigin &&
                  activeWorkspaceTarget?.patentId === contentSearchOrigin ? (
                    <fieldset className="content-search-return">
                      <legend className="screen-reader-only">正文搜索导航</legend>
                      <button type="button" onClick={() => library.setView("library")}>
                        返回搜索结果
                      </button>
                      <button
                        type="button"
                        className="content-search-return__close"
                        aria-label="关闭搜索并取消高亮"
                        title="关闭搜索并取消高亮"
                        onClick={() => {
                          setContentSearchNavigation(null);
                          setContentSearchOrigin(null);
                          setFindSession(null);
                          setFindQuery("");
                          const editor = activeEditorId
                            ? commandBus.getEditor(activeEditorId)
                            : null;
                          if (editor) editor.commands.setTextSelection(editor.state.selection.to);
                          requestAnimationFrame(() => window.getSelection()?.removeAllRanges());
                          if (patentLibraryNavigationRef.current) {
                            patentLibraryNavigationRef.current = {
                              ...patentLibraryNavigationRef.current,
                              query: "",
                              searchContent: false,
                              selectedResultKey: null,
                              contentSearchSnapshot: null,
                            };
                          }
                        }}
                      >
                        ×
                      </button>
                    </fieldset>
                  ) : null}
                </SpatialPresence>
              </PatentBookViewportProvider>
            ) : (
              <EditorWorkspace
                sessions={documents.state.sessions}
                activeSessionId={activeSessionId}
                commandBus={commandBus}
                onModelChange={documents.updateDocumentModel}
                onTextCounts={documents.updateTextCounts}
                zoomPercent={zoomPercent}
              />
            )}
            </div>
          </div>
        </AnimatedMainView>
        {!embeddedEditorActive || workspaceLayout.mode === "dual" ? (
          <StatusBar
            libraryPatents={
              library.view === "library" && patentsAvailable ? library.activePatents : undefined
            }
            session={documents.activeSession}
            patentSession={patentsAvailable ? activePatentSession : null}
            patentTextCounts={
              patentsAvailable && activeWorkspaceTarget ? activePatentTextCounts : undefined
            }
            zoomPercent={effectiveZoomPercent}
            zoomMode={columnsActive ? "fit-width" : "absolute"}
            maxZoomPercent={activeZoomLimit}
            onZoomIn={() => handleZoom(10)}
            onZoomOut={() => handleZoom(-10)}
            onZoomReset={resetZoom}
          />
        ) : null}
        <MotionPresence>
          {trashOpen && library.view === "library" ? (
            <TrashDialog
              documents={library.trashDocuments}
              patents={library.trashPatents}
              loading={library.trashLoading}
              error={library.trashError}
              onRetry={() => runSafely(library.refreshTrash())}
              onClose={() => setTrashOpen(false)}
              onRestoreDocument={library.restoreDocument}
              onRestorePatent={library.restorePatent}
              onDeleteDocument={library.permanentlyDeleteDocument}
              onDeletePatent={library.permanentlyDeletePatent}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {documents.pendingCloseSession ? (
            <CloseDecisionDialog
              documentTitle={documents.pendingCloseSession.model.title}
              onSave={() => runSafely(documents.savePendingClose())}
              onDiscard={documents.discardPendingClose}
              onCancel={documents.cancelPendingClose}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {printCenterRequest ? (
            <PrintCenter
              sessionId={printCenterRequest.sessionId}
              sessionTargetId={printCenterRequest.sessionTargetId}
              document={printCenterRequest.document}
              {...(printCenterRequest.documents ? { documents: printCenterRequest.documents } : {})}
              {...(printCenterRequest.figureLabels
                ? { figureLabels: printCenterRequest.figureLabels }
                : {})}
              {...(printCenterRequest.combinedSuggestedName
                ? { combinedSuggestedName: printCenterRequest.combinedSuggestedName }
                : {})}
              suggestedName={printCenterRequest.suggestedName}
              preferences={documents.settings.printPreferences}
              structureIssues={
                activePatentSession?.activeBookKind === "claims" ||
                activePatentSession?.activeBookKind === "description"
                  ? activePatentStructureIssues.filter(
                      (issue) => issue.bookKind === activePatentSession.activeBookKind,
                    )
                  : []
              }
              onClose={() => setPrintCenterRequest(null)}
              onExportReport={(report) => {
                setPrintCenterRequest(null);
                setExportReport(report);
              }}
              onError={showError}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {exportReport ? (
            <ExportReportDialog report={exportReport} onClose={() => setExportReport(null)} />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {fileOperationMessage ? <FileOperationStatus message={fileOperationMessage} /> : null}
        </MotionPresence>
        <MotionPresence>{importNotice.dialog}</MotionPresence>
        <MotionPresence kind="panel">
          {patentCheckRequest && patentCheckSession ? (
            <PatentCheckPanel
              phase={patentCheckPhase}
              report={patentCheckReport}
              stale={patentCheckStale}
              patentName={patentCheckSession.patent.name ?? "未命名专利"}
              refreshing={
                patentCheckRunToken !== null &&
                patentCheckPhase === "result" &&
                patentCheckInspection.running
              }
              onRun={() => runPatentCheck(true)}
              onRecheck={() => runPatentCheck(false)}
              onCancel={() => {
                patentCheckRunGeneration.current++;
                patentCheckInspection.cancel();
                setPatentCheckInitialRunning(false);
              }}
              onClose={() => {
                patentCheckRunGeneration.current++;
                patentCheckInspection.cancel();
                setPatentCheckRequest(null);
                setPatentCheckRunToken(null);
                setPatentCheckInitialRunning(false);
              }}
              onLocate={(issue: InspectionIssue) => {
                const location = issue.locations[0];
                if (!location || !patentCheckRequest) return;
                const generation = ++patentCheckLocateGeneration.current;
                const request = patentCheckRequest;
                if (location.metadataField === "patent-name") {
                  const summary = library.activePatents.find(
                    (candidate) => candidate.patentId === request.patentId,
                  );
                  if (!summary) {
                    showAppAlert("当前专利信息尚未加载完成，请稍后重试。");
                    return;
                  }
                  setSettingsPatent(summary);
                  return;
                }
                const session = patents.state.sessions.find(
                  (candidate) => candidate.patentId === request.patentId,
                );
                const paneStale =
                  request.pane !== "single" &&
                  (workspaceLayout.mode !== "dual" ||
                    targetForPane(workspaceLayout, request.pane)?.patentId !== request.patentId);
                if (paneStale) {
                  showAppAlert("检查结果已过期，请重新打开专利后检查。");
                  setPatentCheckRequest(null);
                  return;
                }
                const switchToBook = () => {
                  if (request.pane === "single") {
                    patents.activateBook(request.patentId, location.bookKind);
                  } else {
                    selectTargetInPane(request.pane, {
                      patentId: request.patentId,
                      bookKind: location.bookKind,
                    });
                  }
                };
                if (!session) {
                  showAppAlert("当前专利尚未加载完成，请稍后重试。");
                  return;
                }
                if (location.targetId === null) {
                  switchToBook();
                  return;
                }
                const excerpt = issue.evidence[0]?.excerpt ?? null;
                void (async () => {
                  const editor = await resolvePatentCheckEditor({
                    commandBus,
                    sessionId: session.sessionId,
                    targetBookKind: location.bookKind,
                    switchToBook,
                  });
                  if (generation !== patentCheckLocateGeneration.current) return;
                  if (!editor) {
                    if (isTextPatentBook(location.bookKind)) {
                      showAppAlert("原文已变化，请重新检查。");
                    }
                    return;
                  }
                  const outcome = selectPatentIssueInEditor(editor, location, excerpt);
                  if (
                    outcome === "paragraph" &&
                    location.startOffset !== undefined &&
                    location.endOffset !== undefined
                  ) {
                    showAppAlert("未找到精确文字范围，已定位到相关段落。");
                  } else if (outcome === "missing") {
                    showAppAlert("未找到对应文字位置。");
                    return;
                  }
                })();
              }}
            />
          ) : null}
        </MotionPresence>
        <AiCorrectionPanel
          open={aiCorrectionOpen}
          taskKey={`${activePatentSession?.patentId ?? "draft"}:${activeAiBookKind}`}
          bookKind={activeAiBookKind}
          hidden={aiCorrectionHidden}
          status={aiCorrection.status}
          issues={aiCorrection.issues}
          error={aiCorrection.error}
          selectionAvailable={aiCorrection.selectionAvailable}
          modelConfigured={correctionModelReady}
          connectionDisabled={!documents.settings.aiConnectionsEnabled}
          resultScope={aiCorrection.resultScope}
          checkedAt={aiCorrection.checkedAt}
          checkedRevision={aiCorrection.checkedRevision}
          contentChanged={aiCorrection.contentChanged}
          modelName={aiCorrection.modelName}
          phase={aiCorrection.phase}
          reasoning={aiCorrection.reasoning}
          reasoningTruncated={aiCorrection.reasoningTruncated}
          resultLimitReached={aiCorrection.resultLimitReached}
          discardedIssueCount={aiCorrection.discardedIssueCount}
          reportedIssueCount={aiCorrection.reportedIssueCount}
          progress={aiCorrection.progress}
          onStart={(scope) => {
            void aiCorrection.start(scope).catch((error: unknown) => {
              showAppAlert(error instanceof Error ? error.message : "AI 纠错启动失败。");
            });
          }}
          onRestart={aiCorrection.restart}
          onCancel={() => void aiCorrection.cancel()}
          onClose={() => setAiCorrectionOpen(false)}
          onOpenSettings={() => openApplicationSettings("ai-models")}
          onLocate={(issue) => {
            void editorForCorrectionIssue(issue).then((editor) => {
              if (!editor || !selectCorrectionAnchor(editor, issue)) {
                showAppAlert("原文已变化，请重新检查。");
              }
            });
          }}
          onAccept={(issue) => {
            void applyAiCorrectionIssues([issue]).then((result) => {
              if (result.skippedIssueIds.length > 0) showAppAlert(result.skippedReasons.join("\n"));
            });
          }}
          onBatchAccept={async (issues) => {
            if (!(await confirmAppAction(`确定接受选中的 ${issues.length} 项修改吗？`))) return;
            void applyAiCorrectionIssues(issues).then((result) => {
              if (result.skippedIssueIds.length > 0) {
                showAppAlert(
                  `${result.skippedIssueIds.length} 项未应用。\n${result.skippedReasons.join("\n")}`,
                );
              }
            });
          }}
        />
        <TextPolishPanel
          onApplyResult={(result) => {
            const editor = activeEditorId ? commandBus.getEditor(activeEditorId) : null;
            if (
              !editor ||
              activeWorkspaceTarget?.kind !== "book" ||
              activeWorkspaceTarget.bookKind !== result.anchor.bookKind
            ) {
              setTextPolishActionError("请切回原文档后采纳修改。");
              return;
            }
            const applied = applyTextPolish(editor, result);
            setTextPolishActionError(applied.ok ? null : applied.message);
          }}
          documentKey={activePatentSession?.patentId ?? "draft"}
          open={textPolishOpen}
          hidden={
            library.view !== "editor" ||
            embeddedEditorActive ||
            !activeWorkspaceTarget ||
            !activePatentSession
          }
          inputDraft={textPolish.inputDraft}
          onInputDraftChange={textPolish.saveInputDraft}
          history={textPolish.history}
          onOpenHistory={textPolish.openHistory}
          onRefreshHistory={textPolish.refreshHistory}
          onManageHistory={textPolish.manageHistory}
          maxUploadCharacters={documents.settings.aiCorrection.maxUploadCharacters}
          onRecoverHistory={textPolish.recoverHistory}
          historyRecoveryAvailable={textPolish.historyRecoveryAvailable}
          historyLoading={textPolish.historyLoading}
          storageError={textPolish.storageError}
          status={textPolish.status}
          selection={textPolish.selection}
          result={textPolish.result}
          error={textPolish.error ?? textPolishActionError}
          modelConfigured={activeAiCorrectionProfile !== null}
          phase={textPolish.phase}
          summaryBatch={textPolish.summaryBatch}
          reasoning={textPolish.reasoning}
          reasoningByTurn={textPolish.reasoningByTurn}
          reasoningTruncated={textPolish.reasoningTruncated}
          conversationId={textPolish.conversationId}
          messages={textPolish.messages}
          source={textPolish.source}
          model={textPolish.model}
          configuredModelName={activeAiCorrectionProfile?.displayName}
          configuredModel={
            activeAiCorrectionProfile
              ? {
                  profileId: activeAiCorrectionProfile.profileId,
                  providerId: activeAiCorrectionProfile.providerId,
                  displayName: activeAiCorrectionProfile.displayName,
                  baseUrl: activeAiCorrectionProfile.baseUrl,
                  model: activeAiCorrectionProfile.model,
                }
              : null
          }
          onChangeModel={textPolish.changeModel}
          summary={textPolish.summary}
          latestValidDraft={textPolish.latestValidDraft}
          canRetry={textPolish.canRetry}
          onStart={(requirement) => {
            setTextPolishActionError(null);
            void textPolish.start(requirement).catch((error: unknown) => {
              setTextPolishActionError(
                error instanceof Error ? error.message : "小栈AI助手启动失败。",
              );
            });
          }}
          onCancel={() => {
            setTextPolishActionError(null);
            void textPolish.cancel().catch((error: unknown) => {
              setTextPolishActionError(
                error instanceof Error ? error.message : "停止本轮失败，请重试。",
              );
            });
          }}
          onSend={async (instruction, referenceText) => {
            setTextPolishActionError(null);
            try {
              return await textPolish.send(instruction, referenceText);
            } catch (error: unknown) {
              setTextPolishActionError(
                error instanceof Error ? error.message : "发送连续润色要求失败。",
              );
              return false;
            }
          }}
          onRetry={async () => {
            setTextPolishActionError(null);
            try {
              return await textPolish.retry();
            } catch (error: unknown) {
              setTextPolishActionError(
                error instanceof Error ? error.message : "重试连续润色失败。",
              );
              return false;
            }
          }}
          onReset={async () => {
            setTextPolishActionError(null);
            try {
              await textPolish.reset();
            } catch (error: unknown) {
              setTextPolishActionError(
                error instanceof Error ? error.message : "新建连续对话失败。",
              );
              throw error;
            }
          }}
          onClose={() => {
            setTextPolishOpen(false);
            setTextPolishActionError(null);
          }}
          onOpenSettings={() => openApplicationSettings("ai-models")}
          onCopyText={async (text) => {
            const copyResult = await window.patentApi.clipboard.writeText(text);
            return copyResult.ok;
          }}
        />
        {patents.state.sessions.map(owner => {
          const physicsFormulaTarget = physicsFormulaTargetSessions[owner.sessionId];
          const drawingFormulaEditor = drawingFormulaEditorSessions[owner.sessionId];
          const drawingChemistryEditor = drawingChemistryEditorSessions[owner.sessionId];
          const formulaDrawing = formulaDrawingSessions[owner.sessionId];
          const drawingFormulaEditorOpen = drawingFormulaEditorOpenSessions[owner.sessionId] ?? false;
          const drawingChemistryEditorOpen = drawingChemistryEditorOpenSessions[owner.sessionId] ?? false;
          const setPhysicsFormulaTarget = (value: null) => setPhysicsFormulaTargetForSession(owner.sessionId, value);
          const setDrawingFormulaEditorOpen = (value: boolean) => setDrawingFormulaEditorOpenForSession(owner.sessionId, value);
          const setDrawingChemistryEditorOpen = (value: boolean) => setDrawingChemistryEditorOpenForSession(owner.sessionId, value);
          return <EditorSessionScope key={owner.sessionId} sessionId={owner.sessionId}>
          <div hidden={library.view !== "editor" || activePatentSession?.sessionId !== owner.sessionId} inert={activePatentSession?.sessionId !== owner.sessionId}>
        <MotionPresence>
          {physicsFormulaTarget ? (
            <FormulaCollectionDialog
              titleId={`${owner.sessionId}-physics-formula-title`}
              title="物理公式"
              groups={PHYSICS_FORMULA_GROUPS}
              displayMode="modeless"
              positionKey={`${owner.sessionId}:physics-formula`}
              drawingsOnly={typeof physicsFormulaTarget !== "string"}
              onCancel={() => setPhysicsFormulaTarget(null)}
              onInsert={(latex) => {
                if (typeof physicsFormulaTarget !== "string") return;
                const targetEditorId = focusedPatentEditorId && editorBelongsToSession(focusedPatentEditorId, owner.sessionId) ? focusedPatentEditorId : physicsFormulaTarget;
                const editor = commandBus.getEditor(targetEditorId);
                if (editor) {
                  editor.chain().focus().insertBlockMath({ latex }).run();
                  setPhysicsFormulaTarget(null);
                } else {
                  showAppAlert("原文档已关闭，无法插入公式。");
                  setPhysicsFormulaTarget(null);
                }
              }}
              onInsertToDrawings={(latex) => {
                const target = physicsFormulaTarget;
                setPhysicsFormulaTarget(null);
                void openFormulaDrawingInsert(
                  { kind: "physics", latex },
                  typeof target === "string" ? owner : target,
                );
              }}
              onReplaceToDrawings={(latex) => {
                const target = physicsFormulaTarget;
                setPhysicsFormulaTarget(null);
                void openFormulaDrawingInsert(
                  { kind: "physics", latex, operation: "replace" },
                  typeof target === "string" ? owner : target,
                );
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {drawingFormulaEditor ? (
            <FormulaDialog
              displayMode="modeless"
              positionKey={`${owner.sessionId}:drawing-formula`}
              open={drawingFormulaEditorOpen}
              initialLatex=""
              initialMode="block"
              allowModeChange={false}
              drawingsOnly
              onConfirm={() => undefined}
              onCancel={() => setDrawingFormulaEditorOpen(false)}
              onInsertToDrawings={(latex) => {
                const target = drawingFormulaEditor;
                setDrawingFormulaEditorOpen(false);
                void openFormulaDrawingInsert(
                  { kind: target.kind, latex },
                  target,
                  "drawing-formula",
                );
              }}
              onReplaceToDrawings={(latex) => {
                const target = drawingFormulaEditor;
                setDrawingFormulaEditorOpen(false);
                void openFormulaDrawingInsert(
                  { kind: target.kind, latex, operation: "replace" },
                  target,
                  "drawing-formula",
                );
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {drawingChemistryEditor ? (
            <ChemistryDialog
              displayMode="modeless"
              positionKey={`${owner.sessionId}:drawing-chemistry`}
              open={drawingChemistryEditorOpen}
              sessionId={drawingChemistryEditor.sessionId}
              request={
                drawingChemistryEditor.request ?? {
                  type: "new",
                  initialKind: drawingChemistryEditor.kind,
                }
              }
              drawingsOnly
              onConfirm={(draft) => {
                if (draft.kind === "structure") saveChemicalFigure(draft, drawingChemistryEditor);
              }}
              onCancel={() => setDrawingChemistryEditorOpen(false)}
              onInsertEquationToDrawings={(latex) => {
                const target = drawingChemistryEditor;
                setDrawingChemistryEditorOpen(false);
                void openFormulaDrawingInsert(
                  { kind: "chemical-equation", latex },
                  target,
                  "drawing-chemistry",
                );
              }}
              onReplaceEquationToDrawings={(latex) => {
                const target = drawingChemistryEditor;
                setDrawingChemistryEditorOpen(false);
                void openFormulaDrawingInsert(
                  { kind: "chemical-equation", latex, operation: "replace" },
                  target,
                  "drawing-chemistry",
                );
              }}
              onReplaceStructureToDrawings={(drawing) => {
                const target = drawingChemistryEditor;
                setDrawingChemistryEditorOpen(false);
                void openFormulaDrawingInsert(
                  {
                    kind: "chemical-structure",
                    ...drawing,
                    operation: "replace",
                  },
                  target,
                  "drawing-chemistry",
                );
              }}
              onInsertStructureToDrawings={(drawing) => {
                const target = drawingChemistryEditor;
                setDrawingChemistryEditorOpen(false);
                void openFormulaDrawingInsert(
                  {
                    kind: "chemical-structure",
                    ...drawing,
                  },
                  target,
                  "drawing-chemistry",
                );
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {formulaDrawing ? (
            <FormulaFigureInsertDialog
              mode={formulaDrawing.request.operation === "replace" ? "replace" : "insert"}
              sessionId={formulaDrawing.sessionId}
              figureOptions={(
                patents.state.sessions.find(
                  (session) => session.patentId === formulaDrawing.patentId,
                )?.patent.figures ?? []
              ).map((figure, index) => ({
                ...figure,
                label: `图${index + 1}`,
              }))}
              contentKind={formulaDrawing.request.kind}
              previewUrl={formulaDrawing.previewUrl}
              onReplacementPreview={(widthMm) =>
                renderFormulaDrawingReplacement(
                  formulaDrawing.sessionId,
                  formulaDrawing.request,
                  widthMm,
                )
              }
              previewWidthMm={(target) => {
                const session = patents.state.sessions.find(
                  (candidate) => candidate.patentId === formulaDrawing.patentId,
                );
                return session
                  ? formulaDrawingFigureWidthMm(
                      session.patent,
                      formulaDrawing.request,
                      formulaDrawing,
                      target.kind === "replace" ? target.figureId : undefined,
                    )
                  : formulaDrawingRequestedWidthMm(formulaDrawing.widthPx);
              }}
              onConfirm={(target, rendered) => insertFormulaDrawing(target, rendered, formulaDrawing)}
              onCancel={() => closeFormulaDrawingInsert(true, formulaDrawing)}
            />
          ) : null}
        </MotionPresence>
          </div></EditorSessionScope>;
        })}
        <MotionPresence>
          {patentExport ? (
            <PatentExportDialog
              key={patentExport.requestId}
              format={patentExport.format}
              bookKind={patentExport.bookKind}
              suggestedName={patentExport.suggestedName}
              onExport={(format, mode, suggestedName) =>
                runSafely(confirmPatentExport(format, mode, suggestedName))
              }
              onCancel={() => setPatentExport(null)}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {patentFolder ? <PatentFolderDialog patent={patentFolder} busy={patentFolderBusy} exportNotice={patentFolderExportNotice} onOpen={entry => runSafely(openFolderEntry(entry))} onExport={items => runSafely(exportFolderEntries(items))} onCancel={() => { if (!patentFolderOperation.current) setPatentFolder(null); }} /> : null}
        </MotionPresence>
        <MotionPresence>
          {libraryPatentExport ? (
            <LibraryPatentExportDialog
              count={libraryPatentExport.length}
              onExport={(format) => runSafely(confirmLibraryPatentExport(format))}
              onCancel={() => setLibraryPatentExport(null)}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {libraryPickerRequest ? (
            <div
              data-dual-switcher-trigger={
                libraryPickerRequest.origin === "header-switcher"
                  ? libraryPickerRequest.pane
                  : undefined
              }
            >
              <PatentLibraryPickerDialog
                sessions={patents.state.sessions}
                onOpenPatent={patents.openPatent}
                onSelectPatent={(patentId) => {
                  if (libraryPickerRequest.origin === "header-switcher") {
                    setPaneSwitcherPatentRequest({ pane: libraryPickerRequest.pane, patentId });
                  } else {
                    selectPickerPatent(libraryPickerRequest.pane, patentId);
                  }
                  setLibraryPickerRequest(null);
                }}
                onCancel={() => setLibraryPickerRequest(null)}
              />
            </div>
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {library.view === "library" &&
          library.legacyDrafts.length > 0 &&
          !library.legacyMigrationDismissed ? (
            <LegacyMigrationDialog
              drafts={library.legacyDrafts}
              onImport={importLegacyDraft}
              onLater={library.dismissLegacyMigration}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {appError ? <ErrorDialog error={appError} onClose={() => setAppError(null)} /> : null}
        </MotionPresence>
        <MotionPresence>
          {operationFeedback ? (
            <OperationFeedbackOverlay
              feedback={operationFeedback}
              onClose={() => setOperationFeedback(null)}
            />
          ) : null}
          {docxImportPreview ? (
            <DocxImportDialog
              preview={docxImportPreview}
              busy={docxImportBusy}
              onUpdate={updateDocxImport}
              onCancel={cancelDocxImport}
              onCommit={commitDocxImport}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {createPatentOpen ? (
            <CreatePatentDialog
              busy={createPatentBusy}
              onCreate={(request) => runSafely(createNewPatent(request))}
              onCancel={() => setCreatePatentOpen(false)}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {settingsPatent ? (
            <PatentSettingsDialog
              busy={settingsBusy}
              name={settingsPatent.name}
              customer={settingsPatent.customer}
              patentType={settingsPatent.patentType}
              onSave={(request) => runSafely(savePatentSettings(request))}
              onCancel={() => setSettingsPatent(null)}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {recoveryCenter ? (
            <RecoveryCenter
              {...recoveryCenter}
              report={startupRecoveryReport}
              onClose={() => setRecoveryCenter(null)}
              onImportFile={() => runSafely(importPatdoc())}
              onRestored={async () => {
                const refreshed = await library.refreshActive();
                if (!refreshed) throw new Error("恢复副本已创建，请刷新专利库后查看。");
              }}
            />
          ) : null}
        </MotionPresence>
        <ApplicationSettingsDialog
          open={applicationSettingsOpen}
          closeGuardRegistrar={applicationPersistence}
          onClose={closeApplicationSettings}
          workspaceProps={{
            preferences: documents.settings,
            onSavePreferences: async (patch) => Boolean(await documents.updateAppSettings(patch)),
            initialRoute: applicationSettingsInitialRoute,
            prepareCurrentPatentTemplate: async () => {
              const prepared = await patents.prepareActivePatentExport();
              return prepared
                ? {
                    patentId: prepared.patentId,
                    expectedRevision: prepared.expectedRevision,
                  }
                : null;
            },
            pageMarginContext: {
              hasEditableDocument: hasEditablePageForMargins,
              pageWidthMm: activePageForMargins?.widthMm ?? 210,
              pageHeightMm: activePageForMargins?.heightMm ?? 297,
              onSaved: handlePageMarginsSaved,
              validateChange: validateTablePageMargins,
            },
            shortcutSettings: documents.settings.shortcuts,
            customDualViewPresets: documents.settings.customDualViewPresets,
            referenceMarkLocatorEnabled: documents.settings.referenceMarkLocatorEnabled,
            onReferenceMarkLocatorEnabledChange: async (enabled) => {
              const saved = Boolean(
                await documents.updateAppSettings({ referenceMarkLocatorEnabled: enabled }),
              );
              if (saved && !enabled) {
                setActiveReferenceMarksByPatent({});
                setRecentReferenceMarksByPatent({});
              }
              return saved;
            },
            onSaveShortcutSettings: async (shortcuts) =>
              Boolean(await documents.updateAppSettings({ shortcuts })),
            onOpenCustomDualView: () => setCustomDualViewOpen(true),
            onOpenInventionContentSettings: () => setInventionContentSettingsOpen(true),
            onAiCorrectionSettingsChanged: () => {
              void documents.refreshSettings();
            },
            onBackupRestored: library.refreshActive,
            prepareSnapshot: patents.preparePatentSnapshot,
            onSnapshotRestored: async (documentId) => {
              const refreshed = await library.refreshActive();
              if (!refreshed) throw new Error("专利库刷新失败，请重试读取专利库。");
              patentLibraryFocusRequestKeyRef.current += 1;
              setPatentLibraryFocusRequest({
                patentId: documentId,
                requestKey: patentLibraryFocusRequestKeyRef.current,
              });
              library.setView("library");
            },
          }}
        />
        <MotionPresence>
          {startupRecoveryReport && !applicationSettingsOpen ? (
            isSuccessfulDataImportRecovery(startupRecoveryReport) ? (
              <section role="status" aria-label="完整数据迁移完成">
                <h2>完整数据迁移已完成</h2>
                <p>完整专利库和可移植设置已恢复。</p>
                <p>启动后的二次完整性验证通过，现在可以继续使用专利库。</p>
                <p>
                  {isNetworkAiAvailable()
                    ? "备份位置和 AI 密钥等本机设置需要在这台电脑重新配置。"
                    : "备份位置等本机设置需要在这台电脑重新配置。"}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setStartupRecoveryReport(null);
                    openApplicationSettings("data-safety");
                  }}
                >
                  设置数据安全
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStartupRecoveryReport(null);
                    dismissDataSafetyGuide();
                    try {
                      window.localStorage.setItem(POST_IMPORT_REMINDER_KEY, "pending");
                      window.sessionStorage.setItem(POST_IMPORT_REMINDER_DEFERRED_KEY, "true");
                    } catch {
                      // Keep the current notice dismissible even if storage is unavailable.
                    }
                  }}
                >
                  稍后设置
                </button>
              </section>
            ) : startupRecoveryReport.dataImportRecovery === "manual-safe-recovery" ? (
              <section
                className="manual-recovery-notice"
                role="alert"
                aria-label="完整数据迁移需要人工恢复"
              >
                <h2>完整数据迁移需要人工恢复</h2>
                <p>任务编号：当前启动恢复任务</p>
                <p>发生阶段：启动后的安全恢复检查</p>
                <p>不要删除迁移候选目录，也不要自行移动其中的文件。</p>
                <p>请从已有 PATDOC 备份恢复到独立的新库；原文档库和迁移候选目录都会保留。</p>
                <div className="manual-recovery-notice__actions">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => setRecoveryCenter({ initialTab: "backups" })}
                  >
                    从备份恢复
                  </button>
                  <button type="button" onClick={() => openApplicationSettings("data-safety")}>
                    查看数据安全
                  </button>
                </div>
              </section>
            ) : (
              <StartupRecoveryNotice
                report={startupRecoveryReport}
                onDismiss={() => setStartupRecoveryReport(null)}
                onOpenDataSafety={() => openApplicationSettings("data-safety")}
                onOpenSnapshots={() => setRecoveryCenter({ initialTab: "snapshots" })}
                onOpenBackups={() => setRecoveryCenter({ initialTab: "backups" })}
              />
            )
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {postImportReminder && !startupRecoveryReport && !applicationSettingsOpen ? (
            <section role="status" aria-label="完整迁移数据安全提示" className="data-safety-guide">
              <h2 className="data-safety-guide__title">建议完成这台电脑的数据安全设置</h2>
              <p className="data-safety-guide__message">
                完整数据已经恢复；备份位置和 AI 密钥仍需要在本机重新配置。
              </p>
              <div className="data-safety-guide__actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    setPostImportReminder(false);
                    clearPostImportReminder();
                    dismissDataSafetyGuide();
                    openApplicationSettings("data-safety");
                  }}
                >
                  设置数据安全
                </button>
                <button
                  type="button"
                  className="data-safety-guide__secondary"
                  onClick={() => {
                    setPostImportReminder(false);
                    clearPostImportReminder();
                    dismissDataSafetyGuide();
                  }}
                >
                  知道了
                </button>
              </div>
            </section>
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {dataSafetyGuideVisible ? (
            <DataSafetyGuide
              backupEnabled={documents.settings.backup.enabled}
              snapshotEnabled={documents.settings.snapshot.enabled}
              onDismiss={dismissDataSafetyGuide}
              onOpenSettings={() => {
                dismissDataSafetyGuide();
                openApplicationSettings(
                  documents.settings.backup.enabled ? "snapshot-settings" : "data-safety",
                );
              }}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {pageMarginOpen ? (
            <PageMarginDialog
              open
              onClose={() => setPageMarginOpen(false)}
              onSaved={handlePageMarginsSaved}
              validateChange={validateTablePageMargins}
              pageWidthMm={activePageForMargins?.widthMm ?? 210}
              pageHeightMm={activePageForMargins?.heightMm ?? 297}
              hasEditableDocument={hasEditablePageForMargins}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {customDualViewOpen ? (
            <CustomDualViewDialog
              open
              presets={documents.settings.customDualViewPresets}
              shortcuts={documents.settings.shortcuts}
              onClose={() => setCustomDualViewOpen(false)}
              onSave={async (customDualViewPresets, shortcuts) =>
                Boolean(await documents.updateAppSettings({ customDualViewPresets, shortcuts }))
              }
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {inventionContentSettingsOpen ? (
            <InventionContentSettingsDialog
              value={documents.settings.inventionContentPrefix}
              onClose={() => setInventionContentSettingsOpen(false)}
              onSave={async (inventionContentPrefix) =>
                Boolean(await documents.updateAppSettings({ inventionContentPrefix }))
              }
            />
          ) : null}
        </MotionPresence>
        <CustomDualViewShortcutBindings
          presets={documents.settings.customDualViewPresets}
          onSelect={(index) => void selectCustomDualViewPreset(index)}
        />
        <PatentWorkspaceTabDragLayer session={workspaceTabDrag.session} />
      </div>
    </ShortcutProvider>
    </ActiveEditorSessionContext.Provider>
  );
}

function CustomDualViewShortcutBindings({
  presets,
  onSelect,
}: {
  presets: readonly CustomDualViewPreset[];
  onSelect(index: number): void;
}) {
  return presets.map((_, index) => (
    <CustomDualViewShortcutBinding
      index={index}
      key={customDualViewShortcutId(index)}
      onSelect={onSelect}
    />
  ));
}

function CustomDualViewShortcutBinding({
  index,
  onSelect,
}: {
  index: number;
  onSelect(index: number): void;
}) {
  useShortcutAction(customDualViewShortcutId(index), true, () => {
    onSelect(index);
    return true;
  });
  return null;
}

function PatentEditorViewport({
  displayWidthMm,
  animateZoom = true,
  automationReadOnly = false,
  session,
  zoomPercent,
  onZoomLimit,
  onAutoFit,
  children,
}: {
  session: PatentSession;
  zoomPercent: number;
  animateZoom?: boolean;
  displayWidthMm?: number | null | undefined;
  automationReadOnly?: boolean;
  onZoomLimit?: ((max: number) => void) | undefined;
  onAutoFit?: ((zoom: number) => void) | undefined;
  children: ReactNode;
}) {
  const auxiliaryDocumentId = session.activeAuxiliaryDocumentId;
  const editorId = auxiliaryDocumentId
    ? auxiliaryDocumentEditorId(session.sessionId, auxiliaryDocumentId)
    : patentBookEditorId(session.sessionId, session.activeBookKind);
  const viewportRef = usePatentBookViewportRegistration(
    auxiliaryDocumentId
      ? `${session.patentId}:auxiliary:${auxiliaryDocumentId}`
      : `${session.patentId}:${session.activeBookKind}`,
  );
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const registerViewport = useCallback(
    (node: HTMLElement | null) => {
      viewportRef(node);
      setViewport(node);
    },
    [viewportRef],
  );
  useSmoothDocumentZoom(viewport, zoomPercent, animateZoom, editorId);
  useDualPaneZoomLimit(viewport, zoomPercent, onZoomLimit, editorId, onAutoFit, displayWidthMm);
  return (
    <main
      inert={automationReadOnly || undefined}
      ref={registerViewport}
      className="editor-workspace patent-editor-workspace"
      aria-label="专利编辑区"
      data-display-width-mm={displayWidthMm === null ? "unknown" : displayWidthMm}
      data-patent-text-projection={
        auxiliaryDocumentId || isTextPatentBook(session.activeBookKind) ? editorId : undefined
      }
    >
      {children}
    </main>
  );
}

function PatentLibrarySyncBridge({ children }: Readonly<{ children: ReactNode }>) {
  const library = useLibrary();
  const [importNotice, setImportNotice] = useState(0);
  useEffect(() => {
    if (!importNotice) return;
    const timer = window.setTimeout(() => setImportNotice(0), 4000);
    return () => window.clearTimeout(timer);
  }, [importNotice]);
  const externalPatentOpened = useCallback(() => {
    library.setView("editor");
    void library.refreshActive();
    setImportNotice((value) => value + 1);
  }, [library.setView, library.refreshActive]);
  const refreshLibraryAfterAutoTitle = useCallback(() => {
    void library.refreshActive();
  }, [library.refreshActive]);

  return (
    <PatentProvider
      onAutoTitlePersisted={refreshLibraryAfterAutoTitle}
      onExternalPatentOpened={externalPatentOpened}
    >
      {children}
      <SpatialPresence>
        {importNotice > 0 && (
          <div className="patdoc-import-success" role="status">
            已导入成功！
          </div>
        )}
      </SpatialPresence>
    </PatentProvider>
  );
}

export function App() {
  return (
    <ApplicationCloseProvider>
      <AutomationAuthorizationDialog />
      <LibraryProvider>
        <PatentLibrarySyncBridge>
          <DocumentProvider>
            <WorkbenchWindow />
          </DocumentProvider>
        </PatentLibrarySyncBridge>
      </LibraryProvider>
    </ApplicationCloseProvider>
  );
}
