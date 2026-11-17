import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { DEFAULT_PAGE_SETTINGS } from "../../../shared/document/defaults";
import type { PageSettings } from "../../../shared/document/model";
import {
  type DrawioExportFormat,
  DrawioFrameMessageSchema,
  type DrawioToolbarAction,
  type DrawioToolbarState,
  type FlowchartEditorMode,
} from "../../../shared/flowcharts/bridge";
import type { FlowchartProjectDescriptor } from "../../../shared/flowcharts/model";
import type { FlowchartOpenedProject, PatentApi } from "../../../shared/ipc/contract";
import { useApplicationCloseParticipant } from "../app/application-close-coordinator";
import { MotionPresence } from "../app/motion-presence";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { SpatialPresence } from "../shared/spatial-presence";
import { StandardDialog } from "../shared/standard-dialog";
import { DRAWIO_FRAME_ORIGIN, DrawioFrameBridge } from "./drawio-frame-bridge";
import {
  getFlowchartExportExtension,
  getFlowchartExportMediaType,
  prepareFlowchartExport,
} from "./flowchart-download";
import { FlowchartExportDialog, type FlowchartFigureOption } from "./flowchart-export-dialog";
import { FlowchartImagePreview } from "./flowchart-image-preview";
import { FlowchartProjectMenu } from "./flowchart-project-menu";
import { buildAutomaticFlowchartName, sortFlowchartProjects } from "./flowchart-project-utils";
import "./flowchart.css";
import { SharedDrawioFrame } from "./shared-drawio-frame";

const AUTOSAVE_DELAY_MS = 1_000;
const INITIAL_SOURCE =
  '<mxfile host="专利工作台"><diagram id="page-1" name="第1页"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

type FlowchartApi = PatentApi["flowcharts"];
type OpenedProject = FlowchartOpenedProject;

type FlowchartWorkspaceProps = {
  patentId: string;
  patentName?: string | null;
  patentRevision: number;
  patentSessionId?: string;
  active?: boolean;
  runtimeEnabled?: boolean;
  embedded?: boolean;
  api?: FlowchartApi;
  saveProject?: FlowchartApi["save"];
  initialProjectId?: string | null;
  initialMode?: FlowchartEditorMode;
  linkedFigureLabels?: ReadonlyMap<string, readonly string[]>;
  figureOptions?: readonly FlowchartFigureOption[];
  drawingPage?: PageSettings | undefined;
  defaultReplaceFigureId?: string;
  onImport?(): void;
  onExternalExport?(projectId: string): void;
  onExportToDrawings?(projectId: string): Promise<void> | void;
  onExportToCad?(file: File, ownerPatentId: string): Promise<void>;
  onEditorModeChange?(mode: FlowchartEditorMode): void;
  onExplicitSave?(): Promise<boolean>;
  onExit(): void;
};

export type FlowchartWorkspaceHandle = Readonly<{
  requestClose(): Promise<boolean>;
  flush(): Promise<boolean>;
  suspend(): Promise<boolean>;
  dispatchNativeHistory(command: "undo" | "redo"): boolean;
}>;

type EditorPage = Readonly<{ id: string; name: string }>;
type NameDialogState = Readonly<{
  mode: "rename" | "duplicate";
  project: FlowchartProjectDescriptor | null;
  value: string;
}>;

function newSessionId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function downloadBytes(bytes: Uint8Array, name: string) {
  const blob = new Blob([Uint8Array.from(bytes)], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name}.drawio`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadExport(data: string | Uint8Array, name: string, format: DrawioExportFormat) {
  const anchor = document.createElement("a");
  let objectUrl: string | null = null;
  if (typeof data === "string" && data.startsWith("data:")) {
    anchor.href = data;
  } else {
    const blobPart = typeof data === "string" ? data : Uint8Array.from(data);
    objectUrl = URL.createObjectURL(
      new Blob([blobPart], { type: getFlowchartExportMediaType(format) }),
    );
    anchor.href = objectUrl;
  }
  anchor.download = `${name}.${getFlowchartExportExtension(format)}`;
  anchor.click();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
}

function decodeSvgExport(data: string): string {
  if (!data.startsWith("data:")) return data;
  const separator = data.indexOf(",");
  if (separator < 0) throw new Error("流程图编辑器返回了无效的 SVG 数据。");
  const metadata = data.slice(0, separator);
  const body = data.slice(separator + 1);
  if (!metadata.includes(";base64")) return decodeURIComponent(body);
  const binary = atob(body);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export const FlowchartWorkspace = forwardRef<
  FlowchartWorkspaceHandle,
  Readonly<FlowchartWorkspaceProps>
>(function FlowchartWorkspace(
  {
    patentId,
    patentName = null,
    patentRevision,
    patentSessionId = "00000000-0000-4000-8000-000000000000",
    active = true,
    runtimeEnabled = true,
    embedded = false,
    api = window.patentApi.flowcharts,
    saveProject = api.save,
    initialProjectId = null,
    initialMode = "flowchart",
    linkedFigureLabels = new Map(),
    figureOptions = [],
    drawingPage = DEFAULT_PAGE_SETTINGS,
    defaultReplaceFigureId,
    onImport = () => undefined,
    onExternalExport = () => undefined,
    onExportToDrawings = () => undefined,
    onExportToCad,
    onEditorModeChange = () => undefined,
    onExplicitSave,
    onExit,
  },
  ref,
) {
  const externalScopeId = useId();
  const exportInFlightRef = useRef(false);
  const onExportToCadRef = useRef(onExportToCad);
  onExportToCadRef.current = onExportToCad;
  const canReplaceDrawingRef = useRef(false);
  canReplaceDrawingRef.current = figureOptions.length > 0;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<DrawioFrameBridge | null>(null);
  const sessionIdRef = useRef(newSessionId());
  const bridgeRevisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const changeRevisionRef = useRef(0);
  const openedRef = useRef<OpenedProject | null>(null);
  const openedPatentIdRef = useRef<string | null>(null);
  const pagesRef = useRef<EditorPage[]>([]);
  const projectsRef = useRef<FlowchartProjectDescriptor[]>([]);
  const currentPatentRevisionRef = useRef(patentRevision);
  const bootstrapKeyRef = useRef<string | null>(null);
  const flushPromiseRef = useRef<Promise<boolean> | null>(null);
  const flushFinishesEditingRef = useRef(true);
  const flushRef = useRef<() => Promise<boolean>>(async () => false);
  const toggleProjectMenuRef = useRef<() => void>(() => undefined);
  const projectActionRef = useRef<(action: DrawioToolbarAction) => void>(() => undefined);
  const editorModeRef = useRef(initialMode);
  const pendingEditorModeRef = useRef<FlowchartEditorMode | null>(initialMode);
  const onEditorModeChangeRef = useRef(onEditorModeChange);
  const onExplicitSaveRef = useRef(onExplicitSave);
  const [projects, setProjects] = useState<FlowchartProjectDescriptor[]>([]);
  const [opened, setOpened] = useState<OpenedProject | null>(null);
  const [currentPatentRevision, setCurrentPatentRevision] = useState(patentRevision);
  const [loading, setLoading] = useState(true);
  const restorePageOnReady = useRef(true);
  const [frameStatus, setFrameStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState("已保存");
  const [pages, setPages] = useState<EditorPage[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [selectionCount, setSelectionCount] = useState(0);
  const [selectedCellIds, setSelectedCellIds] = useState<string[]>([]);
  const [patentExportOpen, setPatentExportOpen] = useState<"insert" | "replace" | null>(null);
  const patentPreviewUrlsRef = useRef<string[]>([]);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [externalExport, setExternalExport] = useState<{
    format: DrawioExportFormat;
    selectionOnly: boolean;
    allPages?: boolean;
    scale?: number;
    busy: boolean;
  } | null>(null);
  const [externalPreview, setExternalPreview] = useState<{
    src: string | null;
    busy: boolean;
    error: string | null;
  }>({ src: null, busy: false, error: null });
  const externalPreviewVersionRef = useRef(0);
  const [deleteDialog, setDeleteDialog] = useState<FlowchartProjectDescriptor | null>(null);
  const interactive = useRef(active);
  interactive.current = active;
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [activated, setActivated] = useState(active);

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  useEffect(() => {
    if (!runtimeEnabled || !opened || frameStatus !== "loading") return;
    const timer = window.setTimeout(() => setFrameStatus("failed"), 15000);
    return () => window.clearTimeout(timer);
  }, [opened, frameStatus, runtimeEnabled]);

  useEffect(() => {
    if (!runtimeEnabled) {
      restorePageOnReady.current = true;
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      setFrameStatus("loading");
    }
  }, [runtimeEnabled]);

  const retryFrame = () => {
    // Reload is only offered before the editor becomes interactive.
    if (dirtyRef.current) {
      setError("当前仍有未保存修改，请先保存或导出工程备份。");
      return;
    }
    bridgeRef.current?.dispose();
    bridgeRef.current = null;
    sessionIdRef.current = newSessionId();
    setFrameStatus("loading");
  };

  useEffect(() => {
    openedRef.current = opened;
  }, [opened]);
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  useEffect(() => {
    currentPatentRevisionRef.current = currentPatentRevision;
  }, [currentPatentRevision]);
  useEffect(() => {
    editorModeRef.current = initialMode;
    pendingEditorModeRef.current = initialMode;
    bridgeRef.current?.setEditorMode(initialMode);
  }, [initialMode]);
  useEffect(() => {
    onEditorModeChangeRef.current = onEditorModeChange;
  }, [onEditorModeChange]);
  useEffect(() => {
    onExplicitSaveRef.current = onExplicitSave;
  }, [onExplicitSave]);

  const adoptOpenedProject = useCallback(
    (value: OpenedProject) => {
      restorePageOnReady.current = true;
      setFrameStatus("loading");
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      sessionIdRef.current = newSessionId();
      bridgeRevisionRef.current = value.project.revision;
      dirtyRef.current = false;
      changeRevisionRef.current = 0;
      setDirty(false);
      setSaveStatus("已保存");
      setPages([]);
      setActivePageId(value.project.lastPageId);
      setSelectionCount(0);
      setSelectedCellIds([]);
      setHistoryState({ canUndo: false, canRedo: false });
      setCurrentPatentRevision(value.patentRevision);
      currentPatentRevisionRef.current = value.patentRevision;
      openedRef.current = value;
      openedPatentIdRef.current = patentId;
      setOpened(value);
      setProjectMenuOpen(false);
      setError(null);
    },
    [patentId],
  );

  const openProject = useCallback(
    async (project: FlowchartProjectDescriptor, cancelled: () => boolean = () => false) => {
      setBusy(true);
      const result = await api.load({ patentId, projectId: project.projectId });
      if (cancelled()) return false;
      if (!result.ok) {
        setBusy(false);
        setError(result.error.message);
        return false;
      }
      adoptOpenedProject(result.value);
      setBusy(false);
      return true;
    },
    [adoptOpenedProject, api, patentId],
  );

  useEffect(() => {
    const bootstrapKey = `${patentId}:${initialProjectId ?? "recent"}:${bootstrapAttempt}`;
    if (!activated || bootstrapKeyRef.current === bootstrapKey) return;
    bootstrapKeyRef.current = bootstrapKey;
    const existing = openedRef.current;
    // Generic toolbar entries activate the live editor, not the latest saved project.
    if (
      existing &&
      openedPatentIdRef.current === patentId &&
      (!initialProjectId || initialProjectId === existing.project.projectId)
    ) {
      setLoading(false);
      setBusy(false);
      return;
    }
    let cancelled = false;
    let completed = false;
    const bootstrap = async () => {
      setLoading(true);
      setError(null);
      setProjectMenuOpen(false);
      if (existing && openedPatentIdRef.current === patentId) {
        const saved = await flushRef.current();
        if (cancelled) return;
        if (!saved) {
          setLoading(false);
          return;
        }
      }
      const listed = await api.list(patentId);
      if (cancelled) return;
      if (!listed.ok) {
        setError(listed.error.message);
        setLoading(false);
        return;
      }
      const sorted = sortFlowchartProjects(listed.value);
      setProjects(sorted);
      projectsRef.current = sorted;
      const requested = initialProjectId
        ? sorted.find((item) => item.projectId === initialProjectId)
        : undefined;
      const target = requested ?? sorted[0];
      if (target) {
        await openProject(target, () => cancelled);
        if (!cancelled) setLoading(false);
        return;
      }
      const created = await api.create({
        patentId,
        expectedPatentRevision: currentPatentRevisionRef.current,
        name: buildAutomaticFlowchartName(patentName, sorted),
        source: new TextEncoder().encode(INITIAL_SOURCE),
        pageCount: 1,
        lastPageId: "page-1",
      });
      if (cancelled) return;
      if (!created.ok) {
        setError(created.error.message);
      } else {
        const next = [created.value.project];
        setProjects(next);
        projectsRef.current = next;
        adoptOpenedProject(created.value);
      }
      setLoading(false);
    };
    void bootstrap().finally(() => {
      completed = true;
    });
    return () => {
      cancelled = true;
      if (!completed && bootstrapKeyRef.current === bootstrapKey) bootstrapKeyRef.current = null;
    };
  }, [
    activated,
    adoptOpenedProject,
    api,
    bootstrapAttempt,
    initialProjectId,
    openProject,
    patentId,
    patentName,
  ]);

  const flush = useCallback(
    (finishEditing = true, preserveEditing = false): Promise<boolean> => {
      const currentFlush = flushPromiseRef.current;
      if (currentFlush) {
        if (!preserveEditing && (!finishEditing || flushFinishesEditingRef.current))
          return currentFlush;
        // Closing during an automatic save must still capture the live text afterwards.
        return currentFlush.then((saved) => (saved ? flush(true, preserveEditing) : false));
      }
      flushFinishesEditingRef.current = finishEditing;
      const operation = (async () => {
        let editingPreserved = false;
        do {
          const current = openedRef.current;
          const bridge = bridgeRef.current;
          // A label being typed has not emitted a model-change event yet. Ask the live
          // editor to finish editing even when the last reported state was clean.
          if (!dirtyRef.current && (!current || !bridge || frameStatus !== "ready")) return true;
          if (!current || !bridge) {
            setSaveStatus("保存失败，可重试或导出工程备份");
            setError("流程图编辑器当前不可用，未保存修改仍保留在当前会话中。");
            return false;
          }
          const savedChangeRevision = changeRevisionRef.current;
          setSaveStatus("正在保存…");
          try {
            const captureEditing: boolean = preserveEditing && !editingPreserved;
            editingPreserved ||= captureEditing;
            const sourceText = await (captureEditing
              ? bridge.requestSave(finishEditing, true)
              : bridge.requestSave(finishEditing));
            if (
              !dirtyRef.current &&
              sourceText === new TextDecoder().decode(current.source) &&
              (activePageId ?? current.project.lastPageId) === current.project.lastPageId
            ) {
              setSaveStatus("已保存");
              return true;
            }
            const result = await saveProject({
              patentId,
              projectId: current.project.projectId,
              expectedPatentRevision: current.patentRevision,
              expectedProjectRevision: current.project.revision,
              source: new TextEncoder().encode(sourceText),
              pageCount: Math.max(1, pagesRef.current.length || current.project.pageCount),
              lastPageId: activePageId ?? current.project.lastPageId,
            });
            if (!result.ok) throw new Error(result.error.message);
            setOpened(result.value);
            openedRef.current = result.value;
            setCurrentPatentRevision(result.value.patentRevision);
            currentPatentRevisionRef.current = result.value.patentRevision;
            const nextProjects = sortFlowchartProjects(
              projectsRef.current.map((item) =>
                item.projectId === result.value.project.projectId ? result.value.project : item,
              ),
            );
            setProjects(nextProjects);
            projectsRef.current = nextProjects;
            if (changeRevisionRef.current !== savedChangeRevision) {
              setSaveStatus("有新修改，等待再次保存");
              continue;
            }
            dirtyRef.current = false;
            setDirty(false);
            setSaveStatus("已保存");
            setError(null);
            return true;
          } catch {
            setSaveStatus("保存失败，可重试或导出工程备份");
            setError("流程图保存失败。修改仍保留在当前编辑会话中，请重试或导出工程备份。");
            return false;
          }
        } while (dirtyRef.current);
        return true;
      })();
      flushPromiseRef.current = operation;
      void operation.finally(() => {
        if (flushPromiseRef.current === operation) flushPromiseRef.current = null;
      });
      return operation;
    },
    [activePageId, frameStatus, patentId, saveProject],
  );

  useImperativeHandle(
    ref,
    () => ({
      requestClose: flush,
      flush,
      suspend: () => flush(true, true),
      dispatchNativeHistory(command) {
        if (
          !active ||
          frameStatus !== "ready" ||
          !bridgeRef.current ||
          document.activeElement !== iframeRef.current
        )
          return false;
        bridgeRef.current[command]();
        return true;
      },
    }),
    [active, frameStatus, flush],
  );

  useApplicationCloseParticipant(`flowchart-workspace:${patentId}`, flush, "editor");

  useEffect(() => {
    if (!dirty || !active) return undefined;
    const timer = setTimeout(() => void flush(false), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active, dirty, flush]);

  useEffect(() => {
    const handledToolbarActions = new Set<string>();
    const handledToolbarActionOrder: string[] = [];
    const receive = (event: MessageEvent<unknown>) => {
      const current = openedRef.current;
      if (
        !current ||
        event.origin !== DRAWIO_FRAME_ORIGIN ||
        event.source !== iframeRef.current?.contentWindow
      )
        return;
      const parsed = DrawioFrameMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (
        message.sessionId !== sessionIdRef.current ||
        message.projectId !== current.project.projectId ||
        message.projectRevision !== bridgeRevisionRef.current
      )
        return;
      if (message.type === "error" && message.code === "SESSION_RESTORE_FAILED") {
        setFrameStatus("failed");
        setError(message.message);
      } else if (message.type === "ready") {
        setFrameStatus("ready");
        setPages(message.pages);
        const savedPage = current.project.lastPageId;
        if (
          restorePageOnReady.current &&
          savedPage &&
          message.pages.some((page) => page.id === savedPage)
        ) {
          restorePageOnReady.current = false;
          setActivePageId(savedPage);
          if (savedPage !== message.activePageId) bridgeRef.current?.setPage(savedPage);
        } else {
          setActivePageId(message.activePageId ?? null);
        }
      } else if (message.type === "changed") {
        changeRevisionRef.current += 1;
        dirtyRef.current = true;
        setDirty(true);
        setSaveStatus("有未保存修改");
      } else if (message.type === "selection-changed") {
        setSelectionCount(message.selectionCount);
        setSelectedCellIds(message.selectedCellIds);
      } else if (message.type === "page-changed") {
        setActivePageId(message.pageId);
      } else if (message.type === "history-state") {
        setHistoryState({ canUndo: message.canUndo, canRedo: message.canRedo });
      } else if (message.type === "editor-mode-changed") {
        const pendingMode = pendingEditorModeRef.current;
        if (pendingMode && message.mode !== pendingMode) {
          bridgeRef.current?.setEditorMode(pendingMode);
          return;
        }
        pendingEditorModeRef.current = null;
        editorModeRef.current = message.mode;
        onEditorModeChangeRef.current(message.mode);
      } else if (message.type === "toolbar-action") {
        const actionKey = `${message.sessionId}:${message.projectId}:${message.projectRevision}:${message.actionId}`;
        bridgeRef.current?.acknowledgeToolbarAction(message.actionId);
        if (!interactive.current || handledToolbarActions.has(actionKey)) return;
        handledToolbarActions.add(actionKey);
        handledToolbarActionOrder.push(actionKey);
        if (handledToolbarActionOrder.length > 128) {
          const expiredActionKey = handledToolbarActionOrder.shift();
          if (expiredActionKey) handledToolbarActions.delete(expiredActionKey);
        }
        if (message.action === "toggle-project-menu") toggleProjectMenuRef.current();
        else if (message.action === "save") {
          const explicitSave = onExplicitSaveRef.current;
          if (explicitSave) void explicitSave();
          else void flushRef.current();
        } else if (message.action === "export-external")
          setExternalExport({ format: "drawio", selectionOnly: false, busy: false });
        else if (message.action === "export-to-description-drawing") setPatentExportOpen("insert");
        else if (message.action === "replace-description-drawing" && canReplaceDrawingRef.current)
          setPatentExportOpen("replace");
        else if (message.action === "cycle-tab-next" || message.action === "cycle-tab-previous") {
          window.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Tab",
              ctrlKey: true,
              shiftKey: message.action === "cycle-tab-previous",
              cancelable: true,
            }),
          );
        } else projectActionRef.current(message.action);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(
    () => () => {
      bridgeRef.current?.dispose();
    },
    [],
  );

  const createAutomaticProject = async (
    currentProjects: readonly FlowchartProjectDescriptor[] = projectsRef.current,
    expectedPatentRevision = currentPatentRevisionRef.current,
  ) => {
    setBusy(true);
    const result = await api.create({
      patentId,
      expectedPatentRevision,
      name: buildAutomaticFlowchartName(patentName, currentProjects),
      source: new TextEncoder().encode(INITIAL_SOURCE),
      pageCount: 1,
      lastPageId: "page-1",
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return false;
    }
    const next = sortFlowchartProjects([
      result.value.project,
      ...currentProjects.filter((item) => item.projectId !== result.value.project.projectId),
    ]);
    setProjects(next);
    projectsRef.current = next;
    adoptOpenedProject(result.value);
    return true;
  };

  const importProject = async () => {
    setBusy(true);
    const result = await api.importFile({
      patentId,
      expectedPatentRevision: currentPatentRevisionRef.current,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (!result.value) return;
    const imported = result.value;
    const next = sortFlowchartProjects([
      imported.project,
      ...projectsRef.current.filter((item) => item.projectId !== imported.project.projectId),
    ]);
    setProjects(next);
    projectsRef.current = next;
    onImport();
    adoptOpenedProject(imported);
  };

  const renameProject = async (project: FlowchartProjectDescriptor, nameInput: string) => {
    const latestProject =
      projectsRef.current.find((item) => item.projectId === project.projectId) ?? project;
    const name = nameInput.trim();
    if (!name || name === latestProject.name) return;
    const result = await api.rename({
      patentId,
      projectId: latestProject.projectId,
      expectedPatentRevision: currentPatentRevisionRef.current,
      expectedProjectRevision: latestProject.revision,
      name,
    });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    const next = sortFlowchartProjects(
      projectsRef.current.map((item) =>
        item.projectId === project.projectId ? result.value.project : item,
      ),
    );
    setProjects(next);
    projectsRef.current = next;
    if (openedRef.current?.project.projectId === project.projectId) {
      // Renaming changes metadata, not the canvas or its undo history.
      openedRef.current = result.value;
      setOpened(result.value);
    }
    setCurrentPatentRevision(result.value.patentRevision);
    currentPatentRevisionRef.current = result.value.patentRevision;
  };

  const duplicateProject = async (project: FlowchartProjectDescriptor, nameInput: string) => {
    const latestProject =
      projectsRef.current.find((item) => item.projectId === project.projectId) ?? project;
    const name = nameInput.trim();
    if (!name) return;
    const result = await api.duplicate({
      patentId,
      projectId: latestProject.projectId,
      expectedPatentRevision: currentPatentRevisionRef.current,
      name,
    });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setCurrentPatentRevision(result.value.patentRevision);
    currentPatentRevisionRef.current = result.value.patentRevision;
    const next = sortFlowchartProjects([result.value.project, ...projectsRef.current]);
    setProjects(next);
    projectsRef.current = next;
  };

  const deleteProject = async (project: FlowchartProjectDescriptor) => {
    setBusy(true);
    const result = await api.delete({
      patentId,
      projectId: project.projectId,
      expectedPatentRevision: currentPatentRevisionRef.current,
    });
    if (!result.ok) {
      setBusy(false);
      setError(result.error.message);
      return;
    }
    setCurrentPatentRevision(result.value.patentRevision);
    currentPatentRevisionRef.current = result.value.patentRevision;
    const remaining = sortFlowchartProjects(
      projectsRef.current.filter((item) => item.projectId !== project.projectId),
    );
    setProjects(remaining);
    projectsRef.current = remaining;
    setDeleteDialog(null);
    setBusy(false);
    if (openedRef.current?.project.projectId !== project.projectId) return;
    if (remaining[0]) {
      await openProject(remaining[0]);
      return;
    }
    bridgeRef.current?.dispose();
    bridgeRef.current = null;
    openedRef.current = null;
    setOpened(null);
    await createAutomaticProject(remaining, result.value.patentRevision);
  };

  const exportBackup = async () => {
    if (!opened) return;
    try {
      const bridge = bridgeRef.current;
      if (!bridge) throw new Error("编辑器不可用");
      const source = await bridge.requestSave();
      downloadBytes(new TextEncoder().encode(source), `${opened.project.name}-当前画布备份`);
    } catch {
      setError(
        "无法读取当前画布，尚未生成包含未保存修改的备份。请重试；也可单独导出上次保存版本，但它不包含本次未保存的修改。",
      );
    }
  };

  const exportStoredBackup = async () => {
    if (!opened) return;
    const result = await api.exportBackup({ patentId, projectId: opened.project.projectId });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    downloadBytes(result.value, `${opened.project.name}-上次保存版本`);
  };

  const runAfterFlush = async (action: () => Promise<void>) => {
    if (!(await flush())) return false;
    setProjectMenuOpen(false);
    await action();
    return true;
  };
  flushRef.current = flush;
  toggleProjectMenuRef.current = () => setProjectMenuOpen((current) => !current);
  projectActionRef.current = (action) => {
    const current = openedRef.current;
    if (!current) return;
    if (action === "project-create") {
      void runAfterFlush(async () => {
        await createAutomaticProject();
      });
    } else if (action === "project-import") {
      void runAfterFlush(importProject);
    } else if (action === "project-rename") {
      void runAfterFlush(async () => {
        const latest = openedRef.current;
        if (latest)
          setNameDialog({ mode: "rename", project: latest.project, value: latest.project.name });
      });
    } else if (action === "project-duplicate") {
      void runAfterFlush(async () => {
        const latest = openedRef.current;
        if (latest)
          setNameDialog({
            mode: "duplicate",
            project: latest.project,
            value: `${latest.project.name} - 副本`,
          });
      });
    } else if (action === "project-delete") {
      setProjectMenuOpen(false);
      setDeleteDialog(current.project);
    }
  };

  const submitNameDialog = async () => {
    const dialog = nameDialog;
    if (!dialog?.value.trim()) return;
    setNameDialog(null);
    if (dialog.mode === "rename" && dialog.project) {
      await renameProject(dialog.project, dialog.value);
    } else if (dialog.mode === "duplicate" && dialog.project) {
      await duplicateProject(dialog.project, dialog.value);
    }
  };

  const submitExternalExport = async (toCad = false) => {
    const request = externalExport;
    const current = openedRef.current;
    const bridge = bridgeRef.current;
    if (
      exportInFlightRef.current ||
      !request ||
      !current ||
      !bridge ||
      (request.selectionOnly && selectionCount === 0)
    )
      return;
    exportInFlightRef.current = true;
    setExternalExport({ ...request, busy: true });
    try {
      if (!(await flush())) {
        setExternalExport({ ...request, busy: false });
        return;
      }
      if (toCad) {
        if (!onExportToCadRef.current) throw new Error("CAD标号入口不可用。");
        const data = await bridge.requestExport({
          format: request.allPages ? "pdf" : "svg",
          selectionOnly: request.selectionOnly,
          ...(request.allPages ? { allPages: true } : {}),
        });
        const pdf = await prepareFlowchartExport(data, "pdf", {
          allPages: request.allPages === true,
          renderPdf: async (svgs) => {
            const result = await window.patentApi.exports.flowchartPdf({
              patentId,
              sessionId: patentSessionId,
              svgs,
            });
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
          },
        });
        if (typeof pdf === "string") throw new Error("未能生成矢量图纸，请重试。");
        await onExportToCadRef.current(
          new File([Uint8Array.from(pdf)], `${current.project.name}.pdf`, {
            type: "application/pdf",
          }),
          patentId,
        );
        setExternalExport(null);
        setError(null);
        return;
      }
      const data =
        request.format === "drawio" && !request.selectionOnly
          ? await bridge.requestSave()
          : await bridge.requestExport({
              format: request.format,
              selectionOnly: request.selectionOnly,
              ...(request.format === "pdf" && request.allPages ? { allPages: true } : {}),
            });
      downloadExport(
        await prepareFlowchartExport(data, request.format, {
          scale: request.scale ?? 2,
          allPages: request.format === "pdf" && request.allPages === true,
          renderPdf: async (svgs) => {
            const result = await window.patentApi.exports.flowchartPdf({
              patentId,
              sessionId: patentSessionId,
              svgs,
            });
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
          },
        }),
        current.project.name,
        request.format,
      );
      onExternalExport(current.project.projectId);
      setExternalExport(null);
      setError(null);
    } catch (error) {
      setExternalExport({ ...request, busy: false });
      setError(error instanceof Error ? error.message : "流程图导出失败，请重试。");
    } finally {
      exportInFlightRef.current = false;
    }
  };

  const externalPreviewSelectionOnly = externalExport?.selectionOnly ?? null;
  useEffect(() => {
    if (externalPreviewSelectionOnly === null) {
      setExternalPreview({ src: null, busy: false, error: null });
      return;
    }
    const bridge = bridgeRef.current;
    if (!bridge) {
      setExternalPreview({ src: null, busy: false, error: "流程图编辑器尚未就绪。" });
      return;
    }
    const version = externalPreviewVersionRef.current + 1;
    externalPreviewVersionRef.current = version;
    let cancelled = false;
    setExternalPreview({ src: null, busy: true, error: null });
    void bridge
      .requestExport({ format: "svg", selectionOnly: externalPreviewSelectionOnly })
      .then((data) => {
        if (cancelled || externalPreviewVersionRef.current !== version) return;
        const src = data.startsWith("data:image/svg")
          ? data
          : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`;
        setExternalPreview({ src, busy: false, error: null });
      })
      .catch(() => {
        if (!cancelled && externalPreviewVersionRef.current === version) {
          setExternalPreview({ src: null, busy: false, error: "无法生成导出内容预览。" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [externalPreviewSelectionOnly]);

  const closePatentExport = () => {
    for (const url of patentPreviewUrlsRef.current) URL.revokeObjectURL(url);
    patentPreviewUrlsRef.current = [];
    setPatentExportOpen(null);
  };

  const generatePatentPreview = async (request: {
    scope: "page" | "selection";
    selectedCellIds: string[];
    borderMm: number;
    outputWidthMm?: number;
    target:
      | { kind: "new"; insertIndex: number }
      | { kind: "replace"; figureId: string; assetId: string };
  }) => {
    const current = openedRef.current;
    const bridge = bridgeRef.current;
    if (!current || !bridge || !activePageId) throw new Error("当前流程图页面尚未就绪。");
    if (!(await flush())) throw new Error("请先解决流程图保存失败，再生成附图预览。");
    const latest = openedRef.current;
    if (!latest) throw new Error("流程图工程已经关闭。");
    const exported = await bridge.requestExport({
      format: "svg",
      selectionOnly: request.scope === "selection",
    });
    const target = request.target;
    const rotationDeg =
      target.kind === "replace"
        ? (figureOptions.find((figure) => figure.figureId === target.figureId)?.rotationDeg ?? 0)
        : 0;
    const result = await api.renderPreview({
      patentId,
      projectId: latest.project.projectId,
      expectedProjectRevision: latest.project.revision,
      expectedSourceSha256: latest.project.sourceSha256,
      pageId: activePageId,
      exportScope: request.scope,
      selectedCellIds: request.selectedCellIds,
      borderMm: request.borderMm,
      drawingPage,
      rotationDeg,
      ...(request.outputWidthMm === undefined ? {} : { outputWidthMm: request.outputWidthMm }),
      svg: decodeSvgExport(exported),
      target: request.target,
    });
    if (!result.ok) throw new Error(result.error.message);
    const previewUrl = URL.createObjectURL(
      new Blob([Uint8Array.from(result.value.preview)], { type: "image/png" }),
    );
    patentPreviewUrlsRef.current.push(previewUrl);
    return {
      previewToken: result.value.previewToken,
      previewUrl,
      warnings: result.value.warnings,
      outputWidthMm: result.value.outputWidthMm,
      rotationDeg,
    };
  };

  const frameContext = opened
    ? {
        sessionId: sessionIdRef.current,
        projectId: opened.project.projectId,
        projectRevision: bridgeRevisionRef.current,
      }
    : null;

  const toolbarState = useMemo<DrawioToolbarState | null>(() => {
    if (!opened) return null;
    const activePageName = pages.find((page) => page.id === activePageId)?.name ?? null;
    const toolbarSaveStatus = saveStatus.startsWith("保存失败")
      ? "error"
      : saveStatus === "正在保存…"
        ? "saving"
        : dirty
          ? "dirty"
          : "saved";
    return {
      projectName: opened.project.name,
      activePageName,
      saveStatus: toolbarSaveStatus,
      dirty,
      saveBusy: toolbarSaveStatus === "saving",
      exportBusy: externalExport?.busy ?? false,
      canUndo: historyState.canUndo,
      canRedo: historyState.canRedo,
      canReplaceDrawing: figureOptions.length > 0,
    };
  }, [
    activePageId,
    dirty,
    externalExport?.busy,
    figureOptions.length,
    historyState,
    opened,
    pages,
    saveStatus,
  ]);

  useEffect(() => {
    if (toolbarState) bridgeRef.current?.updateToolbar(toolbarState);
  }, [toolbarState]);

  if (!opened) {
    return (
      <main
        className={`flowchart-workspace ${embedded ? "is-embedded" : ""}`}
        aria-label="流程图编辑工作区"
      >
        <section className="flowchart-workspace__entry-state" role={error ? "alert" : "status"}>
          <p>{error ?? (loading || busy ? "正在打开流程图…" : "流程图尚未打开。")}</p>
          {
            <SpatialPresence>
              {error ? (
                <div>
                  <button type="button" onClick={() => setBootstrapAttempt((value) => value + 1)}>
                    重试
                  </button>
                  <button type="button" onClick={onExit}>
                    返回主界面
                  </button>
                </div>
              ) : null}
            </SpatialPresence>
          }
        </section>
      </main>
    );
  }

  return (
    <>
      <main
        className={`flowchart-workspace ${embedded ? "is-embedded" : ""}`}
        aria-label="流程图编辑工作区"
      >
        <SpatialPresence>
          {error ? (
            <section className="flowchart-workspace__error" role="alert">
              <p>{error}</p>
              <button type="button" onClick={() => void flush()}>
                重试保存
              </button>
              <button type="button" onClick={() => void exportBackup()}>
                导出工程备份
              </button>
              <button type="button" onClick={() => void exportStoredBackup()}>
                导出上次保存版本
              </button>
            </section>
          ) : null}
        </SpatialPresence>
        <SharedDrawioFrame
          sessionId={sessionIdRef.current}
          frameRef={iframeRef}
          enabled={runtimeEnabled}
          visible={active && frameStatus === "ready"}
          interactive={!loading && !busy && frameStatus === "ready"}
          onReady={() => {
            if (!frameContext || !iframeRef.current) return;
            bridgeRef.current?.dispose();
            bridgeRef.current = new DrawioFrameBridge(iframeRef.current, frameContext);
            bridgeRef.current.activateSession(new TextDecoder().decode(opened.source));
            bridgeRef.current.configure();
            pendingEditorModeRef.current = editorModeRef.current;
            bridgeRef.current.setEditorMode(editorModeRef.current);
            if (toolbarState) bridgeRef.current.updateToolbar(toolbarState);
          }}
        />
        <SpatialPresence>
          {runtimeEnabled && frameStatus !== "ready" ? (
            <section
              className="flowchart-workspace__frame-state"
              role={frameStatus === "failed" ? "alert" : "status"}
            >
              <strong>
                {frameStatus === "failed" ? "绘图编辑器加载超时" : "正在加载绘图编辑器…"}
              </strong>
              <p>
                {frameStatus === "failed"
                  ? "工程数据未更改。请重新加载，或返回后重试。"
                  : "首次打开可能需要稍等片刻。"}
              </p>
              {frameStatus === "failed" ? (
                <div>
                  <button type="button" className="primary-button" onClick={retryFrame}>
                    重新加载编辑器
                  </button>
                  <button type="button" onClick={onExit}>
                    返回主界面
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </SpatialPresence>
        <output className="flowchart-workspace__selection" aria-live="polite">
          {selectionCount > 0 ? `已选择 ${selectionCount} 个对象` : "未选择对象"}
        </output>
        {
          <SpatialPresence>
            {projectMenuOpen ? (
              <FlowchartProjectMenu
                projects={projects}
                currentProjectId={opened.project.projectId}
                linkedFigureLabels={linkedFigureLabels}
                busy={busy}
                onClose={() => setProjectMenuOpen(false)}
                onSelect={(project) => {
                  if (project.projectId === opened.project.projectId) {
                    setProjectMenuOpen(false);
                    return;
                  }
                  void runAfterFlush(async () => {
                    await openProject(project);
                  });
                }}
              />
            ) : null}
          </SpatialPresence>
        }
      </main>
      <MotionPresence>
        {nameDialog ? (
          <StandardDialog
            open
            title={nameDialog.mode === "rename" ? "重命名流程图工程" : "复制流程图工程"}
            size="m"
            onCancel={() => setNameDialog(null)}
            closeDisabled={busy}
            className="flowchart-dialog"
            bodyClassName="flowchart-dialog-body"
            footer={
              <>
                <button type="button" disabled={busy} onClick={() => setNameDialog(null)}>
                  取消
                </button>
                <button
                  type="submit"
                  form="flowchart-name-form"
                  className="primary-button"
                  disabled={busy || !nameDialog.value.trim()}
                >
                  {nameDialog.mode === "rename" ? "确认重命名" : "确认复制"}
                </button>
              </>
            }
          >
            <form
              id="flowchart-name-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitNameDialog();
              }}
            >
              <label>
                工程名称
                <input
                  value={nameDialog.value}
                  onChange={(event) =>
                    setNameDialog((current) =>
                      current ? { ...current, value: event.target.value } : current,
                    )
                  }
                />
              </label>
            </form>
          </StandardDialog>
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {deleteDialog ? (
          <StandardDialog
            open
            title="删除流程图工程"
            size="s"
            dialogRole="alertdialog"
            onCancel={() => setDeleteDialog(null)}
            closeDisabled={busy}
            footer={
              <>
                <button type="button" disabled={busy} onClick={() => setDeleteDialog(null)}>
                  取消删除
                </button>
                <button
                  type="button"
                  className="standard-dialog__danger-button"
                  disabled={busy}
                  onClick={() => {
                    void runAfterFlush(async () => {
                      await deleteProject(deleteDialog);
                    });
                  }}
                >
                  确认删除
                </button>
              </>
            }
          >
            <p>
              确定删除“{deleteDialog.name}
              ”吗？已导出的说明书附图会保留为普通图片，但不再关联源工程。
            </p>
          </StandardDialog>
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {externalExport ? (
          <StandardDialog
            open
            title="导出至电脑"
            size="xl"
            onCancel={() => setExternalExport(null)}
            closeDisabled={externalExport.busy}
            className="flowchart-dialog flowchart-export-dialog flowchart-export-dialog--external"
            bodyClassName="flowchart-dialog-body"
            footer={
              <>
                <button
                  type="button"
                  disabled={externalExport.busy}
                  onClick={() => setExternalExport(null)}
                >
                  取消
                </button>
                {onExportToCad ? (
                  <button
                    type="button"
                    disabled={
                      externalExport.busy || (externalExport.selectionOnly && selectionCount === 0)
                    }
                    title="将所选范围作为矢量PDF导入并打开CAD标号；原流程图保留。"
                    onClick={() => void submitExternalExport(true)}
                  >
                    导出至CAD标号
                  </button>
                ) : null}
                <button
                  type="submit"
                  form="flowchart-external-export-form"
                  className="primary-button"
                  disabled={externalExport.busy}
                >
                  {externalExport.busy ? "正在导出…" : "确认导出"}
                </button>
              </>
            }
          >
            <form
              id="flowchart-external-export-form"
              className="flowchart-export-layout"
              onSubmit={(event) => {
                event.preventDefault();
                void submitExternalExport();
              }}
            >
              <aside className="flowchart-export-options" aria-label="导出设置">
                <div className="flowchart-export-format">
                  <label className="flowchart-export-field">
                    <span>导出格式</span>
                    <select
                      value={externalExport.format}
                      disabled={externalExport.busy}
                      onChange={(event) =>
                        setExternalExport((current) =>
                          current
                            ? {
                                ...current,
                                format: event.target.value as DrawioExportFormat,
                                allPages: false,
                              }
                            : current,
                        )
                      }
                    >
                      <option value="drawio">draw.io 工程</option>
                      <option value="svg">SVG</option>
                      <option value="png">PNG</option>
                      <option value="jpeg">JPG</option>
                      <option value="pdf">PDF</option>
                    </select>
                  </label>
                  <SpatialCollapse
                    parentGap="var(--flowchart-export-option-gap)"
                    open={Boolean(
                      externalExport.format === "png" || externalExport.format === "jpeg",
                    )}
                  >
                    {externalExport.format === "png" || externalExport.format === "jpeg" ? (
                      <label className="flowchart-export-field">
                        <span>图片清晰度</span>
                        <select
                          aria-label="图片清晰度"
                          disabled={externalExport.busy}
                          value={externalExport.scale ?? 2}
                          onChange={(event) =>
                            setExternalExport((current) =>
                              current ? { ...current, scale: Number(event.target.value) } : current,
                            )
                          }
                        >
                          <option value={1}>标准 · 1 倍</option>
                          <option value={2}>高清 · 2 倍</option>
                          <option value={4}>精细 · 4 倍</option>
                        </select>
                      </label>
                    ) : null}
                  </SpatialCollapse>
                  <SpatialCollapse
                    open={Boolean(externalExport.format === "pdf")}
                    parentGap="var(--flowchart-export-option-gap)"
                  >
                    {externalExport.format === "pdf" ? (
                      <p className="flowchart-export-hint">矢量线稿 · A4 分页</p>
                    ) : null}
                  </SpatialCollapse>
                </div>
                <fieldset className="flowchart-export-section flowchart-export-section--collapsible">
                  <legend>导出范围</legend>
                  <div className="flowchart-export-choice-grid">
                    <label className="flowchart-export-choice-card">
                      <input
                        type="radio"
                        name={externalScopeId}
                        checked={!externalExport.selectionOnly && !externalExport.allPages}
                        disabled={externalExport.busy}
                        onChange={() =>
                          setExternalExport((current) =>
                            current
                              ? { ...current, selectionOnly: false, allPages: false }
                              : current,
                          )
                        }
                      />
                      <span>
                        <strong>
                          {externalExport.format === "drawio" ? "完整工程" : "当前页面"}
                        </strong>
                      </span>
                    </label>
                    <label
                      className="flowchart-export-choice-card"
                      title={selectionCount === 0 ? "请先在画布中选择对象" : undefined}
                    >
                      <input
                        type="radio"
                        name={externalScopeId}
                        aria-label="当前选取"
                        checked={externalExport.selectionOnly}
                        disabled={selectionCount === 0 || externalExport.busy}
                        onChange={() =>
                          setExternalExport((current) =>
                            current
                              ? { ...current, selectionOnly: true, allPages: false }
                              : current,
                          )
                        }
                      />
                      <span>
                        <strong>当前选取</strong>
                      </span>
                    </label>
                  </div>
                  <SpatialCollapse open={Boolean(externalExport.format === "pdf")} parentGap={10}>
                    {externalExport.format === "pdf" ? (
                      <label className="flowchart-export-choice-card">
                        <input
                          type="radio"
                          name={externalScopeId}
                          checked={externalExport.allPages ?? false}
                          disabled={externalExport.busy}
                          onChange={() =>
                            setExternalExport((current) =>
                              current
                                ? { ...current, allPages: true, selectionOnly: false }
                                : current,
                            )
                          }
                        />
                        <span>
                          <strong>所有页面</strong>
                        </span>
                      </label>
                    ) : null}
                  </SpatialCollapse>
                </fieldset>
              </aside>
              <section className="flowchart-export-preview" aria-label="导出预览">
                <FlowchartImagePreview
                  title={
                    <span>
                      导出预览 {externalExport.allPages ? <small>仅展示当前页面</small> : null}
                    </span>
                  }
                  src={externalPreview.src}
                  alt="导出内容预览"
                  busy={externalPreview.busy}
                  message={externalPreview.error}
                />
              </section>
            </form>
          </StandardDialog>
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {patentExportOpen ? (
          <FlowchartExportDialog
            mode={patentExportOpen}
            sessionId={patentSessionId}
            figureOptions={figureOptions}
            selectedCellIds={selectedCellIds}
            defaultReplaceFigureId={defaultReplaceFigureId}
            onCancel={closePatentExport}
            onPreview={generatePatentPreview}
            onConfirm={async (previewToken) => {
              const result = await api.commitPreview({
                patentId,
                sessionId: patentSessionId,
                expectedPatentRevision: currentPatentRevision,
                projectId: opened.project.projectId,
                previewToken,
              });
              if (!result.ok) throw new Error(result.error.message);
              setCurrentPatentRevision(result.value.patent.revision);
              await onExportToDrawings(opened.project.projectId);
              closePatentExport();
            }}
          />
        ) : null}
      </MotionPresence>
    </>
  );
});
