import {
  ChevronDown,
  ChevronRight,
  Columns2,
  Folder,
  Image,
  List,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  APP_ERROR_PRESENTATIONS,
  type AppError,
  AppErrorCodeSchema,
} from "../../../shared/ipc/result";
import type { LibraryDocumentSummary, LibraryPatentSummary } from "../../../shared/library/model";
import { patentDisplayName } from "../../../shared/patent/display-name";
import type { PatentLibraryViewMode } from "../../../shared/settings/model";
import { MotionPresence } from "../app/motion-presence";
import { SaveStateBadge } from "../documents/save-state-badge";
import { BrandLogo } from "../shared/brand-logo";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { SpatialPresence } from "../shared/spatial-presence";
import { ContentSearchIndexDialog } from "./content-search-index-dialog";
import {
  ContentSearchResults,
  type ContentSearchResultsSnapshot,
  type ContentSearchTarget,
} from "./content-search-results";
import { buildPatentLibraryGroups } from "./patent-library-groups";
import { PatentTypeIcon } from "./patent-type-icon";
import { useLibraryListMotion } from "./use-library-list-motion";
import { VirtualPatentCards } from "./virtual-patent-cards";
import "./library-view.css";
import "./library-desktop.css";
import { formatPatentCounts } from "./patent-counts";

type DocumentLibraryProps = {
  applicationMenu?: ReactNode;
  onCreateDesktopShortcut?(): void;
  onExitApplication?(): void;
  navigationStateRef?: RefObject<PatentLibraryNavigationState | null>;
  documents: LibraryDocumentSummary[];
  patents?: LibraryPatentSummary[] | undefined;
  loading: boolean;
  activeError?: AppError | null;
  onRetryActive?(): void;
  onNewDocument(): void;
  onNewPatent?(): void;
  onImportPatdoc(): void;
  onImportDocx?(): void;
  onOpenTrash(): void;
  onOpenDocument(document: LibraryDocumentSummary): void;
  onOpenPatent?(
    patent: LibraryPatentSummary,
    target?: ContentSearchTarget,
    resultKey?: string,
  ): void;
  onRenameDocument(document: LibraryDocumentSummary): void;
  onEditPatentSettings?(patent: LibraryPatentSummary): void;
  onExportPatent?(patent: LibraryPatentSummary): void;
  onOpenPatentFolder?(patent: LibraryPatentSummary): void;
  onExportPatents?(patents: LibraryPatentSummary[]): void;
  onImportBundle?(): void;
  onRecoverPatent?(patent: LibraryPatentSummary): Promise<void> | void;
  onOpenSnapshots?(patent?: LibraryPatentSummary): void;
  onOpenBackups?(patent?: LibraryPatentSummary): void;
  onExportPatdoc(document: LibraryDocumentSummary): void;
  onExportDocx(document: LibraryDocumentSummary): void;
  onExportPdf(document: LibraryDocumentSummary): void;
  onMoveToTrash(document: LibraryDocumentSummary): void;
  onMovePatentToTrash?(patent: LibraryPatentSummary): void;
  onMovePatentsToTrash?(patents: LibraryPatentSummary[]): Promise<boolean>;
  deletingPatents?: boolean;
  patentFocusRequest?: PatentLibraryFocusRequest | null;
  onPatentFocusHandled?(requestKey: number): void;
  patentLibraryViewMode?: PatentLibraryViewMode;
  onPatentLibraryViewModeChange?(mode: PatentLibraryViewMode): Promise<boolean>;
};

export type PatentLibraryFocusRequest = Readonly<{
  patentId: string;
  requestKey: number;
}>;

export type PatentLibraryNavigationState = {
  query: string;
  searchContent: boolean;
  selectedResultKey: string | null;
  contentSearchSnapshot: ContentSearchResultsSnapshot | null;
  type: "all" | LibraryPatentSummary["patentType"];
  expandedMonths: Record<string, boolean>;
  sort: "created" | "modified";
  scrollTop: number;
};

function preventDoubleClickTextSelection(event: ReactMouseEvent<HTMLElement>) {
  if (event.button !== 0 || event.detail < 2) return;
  const control = (event.target as HTMLElement).closest(
    "button, input, textarea, select, [contenteditable='true']",
  );
  if (control && !control.classList.contains("patent-illustrated-hover__trigger")) return;
  // Native word selection occurs on the second mousedown, before dblclick opens the patent.
  event.preventDefault();
}

const libraryDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatModifiedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Invalid Date" : libraryDateFormatter.format(date);
}

const QUARANTINE_FALLBACK_DIAGNOSIS = {
  message: "该项内容已被保护性隔离，原数据仍完整保留，没有被改动。",
  nextAction:
    "请先查看快照版本；没有可用快照时，从定时备份恢复为新副本。原数据仍保留，其他内容不受影响。",
} as const;

/**
 * Turns the stored recovery code into the same wording the rest of the application uses for it.
 *
 * A broken journal chain and a damaged file need very different reactions from the user, so the
 * card must not keep promising "文件内容损坏…重新选择文件" for a patent whose content is intact.
 */
function recoveryDiagnosis(code: string | null): {
  message: string;
  nextAction: string;
} {
  const parsed = AppErrorCodeSchema.safeParse(code);
  return parsed.success ? APP_ERROR_PRESENTATIONS[parsed.data] : QUARANTINE_FALLBACK_DIAGNOSIS;
}

const PATENT_TYPE_LABELS: Record<LibraryPatentSummary["patentType"], string> = {
  invention: "发明",
  "utility-model": "实用新型",
  design: "外观设计",
};

type PatentCardMenuProps = {
  open: boolean;
  position: { x: number; y: number } | null;
  setOpen(open: boolean): void;
  quarantined: boolean;
  recovering: boolean;
  deleteDisabled: boolean;
  onOpen(): void;
  onSettings(): void;
  onFolder?: (() => void) | undefined;
  onExport(): void;
  onMultiSelect?: (() => void) | undefined;
  onRecover(): void | Promise<void>;
  onDelete(): void;
};

function PatentCardMenu({
  open,
  position,
  setOpen,
  quarantined,
  recovering,
  deleteDisabled,
  onOpen,
  onSettings,
  onFolder,
  onExport,
  onMultiSelect,
  onRecover,
  onDelete,
}: PatentCardMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const keyboardOpen = useRef<"first" | "last" | null>(null);

  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const panel = panelRef.current;
    const rect = panel.getBoundingClientRect();
    const trigger = triggerRef.current?.getBoundingClientRect();
    const x = position?.x ?? (trigger?.right ?? 8) - rect.width;
    const below = (trigger?.bottom ?? 8) + 4;
    const y =
      position?.y ??
      (below + rect.height > window.innerHeight - 8
        ? (trigger?.top ?? 8) - rect.height - 4
        : below);
    panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    if (keyboardOpen.current && panelRef.current) {
      const items = panelRef.current.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      );
      (keyboardOpen.current === "first" ? items[0] : items[items.length - 1])?.focus();
      keyboardOpen.current = null;
    }
    const handleMouseDown = (event: MouseEvent) => {
      if (
        !containerRef.current?.contains(event.target as Node) &&
        !panelRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (event.isComposing) return;
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const handleScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !panelRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleResize = () => setOpen(false);
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("contextmenu", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("contextmenu", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [open, setOpen]);

  const run = (action: () => void | Promise<void>) => {
    setOpen(false);
    triggerRef.current?.focus();
    void action();
  };
  const renderPanel = (panel: ReactNode) => createPortal(panel, document.body);

  return (
    <div className="patent-card-menu" ref={containerRef}>
      <button
        type="button"
        className="patent-card-menu-trigger"
        ref={triggerRef}
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          keyboardOpen.current = event.key === "ArrowDown" ? "first" : "last";
          setOpen(true);
        }}
      >
        <MoreHorizontal size={19} aria-hidden="true" />
      </button>
      {renderPanel(
        <SpatialPresence>
          {open ? (
            <div
              ref={panelRef}
              className="patent-card-menu-panel"
              style={{
                position: "fixed",
                left: position?.x ?? 0,
                top: position?.y ?? 0,
                right: "auto",
                zIndex: "var(--ui-layer-panel, 500)",
                maxHeight: "calc(100vh - 16px)",
                maxWidth: "calc(100vw - 16px)",
                overflowY: "auto",
              }}
              role="menu"
              aria-label="专利操作"
              onDoubleClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onKeyDown={(event) => {
                if (event.key === "Tab") {
                  setOpen(false);
                  return;
                }
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const items = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]:not(:disabled)',
                  ),
                ];
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                        items.length;
                items[next]?.focus();
              }}
            >
              <button
                type="button"
                role="menuitem"
                disabled={quarantined}
                onClick={() => run(onOpen)}
              >
                继续编辑
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={quarantined}
                onClick={() => run(onSettings)}
                data-cancel-patent-selection
              >
                设置
              </button>
              {onFolder ? (
                <button type="button" role="menuitem" disabled={quarantined} onClick={() => run(onFolder)}>
                  打开文件夹
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                disabled={quarantined}
                onClick={() => run(onExport)}
              >
                导出
              </button>
              {onMultiSelect ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={quarantined}
                  onClick={() => run(onMultiSelect)}
                >
                  多选
                </button>
              ) : null}
              {quarantined ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={recovering}
                  onClick={() => run(onRecover)}
                >
                  {recovering ? "正在修复" : "修复并打开"}
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => run(onDelete)}
                disabled={deleteDisabled}
              >
                删除
              </button>
            </div>
          ) : null}
        </SpatialPresence>,
      )}
    </div>
  );
}

function useLibraryHeaderMenuPosition(
  open: boolean,
  containerRef: RefObject<HTMLDivElement | null>,
  panelRef: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = containerRef.current?.querySelector<HTMLButtonElement>(":scope > button");
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const position = () => {
      const anchor = trigger.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8));
      const below = anchor.bottom + 8;
      const top =
        below + bounds.height <= window.innerHeight - 8
          ? below
          : Math.max(8, anchor.top - bounds.height - 8);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    observer?.observe(trigger);
    observer?.observe(panel);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      observer?.disconnect();
    };
  }, [open, containerRef, panelRef]);
}

function LibraryMoreMenu({
  onCreateDesktopShortcut,
  onExitApplication,
}: {
  onCreateDesktopShortcut(): void;
  onExitApplication(): void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useLibraryHeaderMenuPosition(open, containerRef, panelRef);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (
        !containerRef.current?.contains(event.target as Node) &&
        !panelRef.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        containerRef.current?.querySelector<HTMLButtonElement>(":scope > button")?.focus();
      }
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <div className="library-more-menu" ref={containerRef} data-cancel-patent-selection>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => {
              const items =
                panelRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]");
              items?.[event.key === "ArrowUp" ? items.length - 1 : 0]?.focus();
            });
          }
        }}
      >
        更多
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {createPortal(
        <SpatialPresence>
          {open ? (
            <div
              ref={panelRef}
              className="library-more-menu__panel library-header-dropdown"
              data-cancel-patent-selection
              role="menu"
              aria-label="专利库更多操作"
              onKeyDown={(event) => {
                const items = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
                ];
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
                          items.length;
                  items[next]?.focus();
                }
              }}
            >
              <button type="button" role="menuitem" onClick={() => run(onCreateDesktopShortcut)}>
                创建桌面快捷方式
              </button>
              <button type="button" role="menuitem" onClick={() => run(onExitApplication)}>
                退出软件
              </button>
            </div>
          ) : null}
        </SpatialPresence>,
        document.body,
      )}
    </div>
  );
}

function ImportMenu({
  onImportDocx,
  onImportPatdoc,
  onImportBundle,
}: {
  onImportDocx(): void;
  onImportPatdoc(): void;
  onImportBundle?(): void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useLibraryHeaderMenuPosition(open, containerRef, panelRef);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (
        !containerRef.current?.contains(event.target as Node) &&
        !panelRef.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <div className="library-import-menu" ref={containerRef} data-cancel-patent-selection>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        导入
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {createPortal(
        <SpatialPresence>
          {open ? (
            <div
              ref={panelRef}
              className="library-import-menu__panel library-header-dropdown"
              data-cancel-patent-selection
              role="menu"
              aria-label="导入文件"
            >
              <button type="button" role="menuitem" onClick={() => run(onImportDocx)}>
                导入 DOCX
              </button>
              <button type="button" role="menuitem" onClick={() => run(onImportPatdoc)}>
                导入 PATDOC
              </button>
              {onImportBundle ? (
                <button type="button" role="menuitem" onClick={() => run(onImportBundle)}>
                  导入专利压缩包
                </button>
              ) : null}
            </div>
          ) : null}
        </SpatialPresence>,
        document.body,
      )}
    </div>
  );
}

function HoverPreview({
  label,
  className,
  children,
  preview,
  popoverClassName,
}: {
  label: string;
  className: string;
  children: ReactNode;
  preview: ReactNode;
  popoverClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const openSoon = () => {
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(true), 300);
  };
  const closeSoon = () => {
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(false), 180);
  };
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (!open || popoverClassName === "patent-illustrated-hover__popover--image") return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const position = () => {
      const anchor = trigger.getBoundingClientRect();
      const preview = popover.getBoundingClientRect();
      const gap = 8;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - preview.width - 8));
      const above = anchor.top - preview.height - gap;
      const top =
        above >= 8
          ? above
          : Math.max(8, Math.min(anchor.bottom + gap, window.innerHeight - preview.height - 8));
      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;
      popover.style.visibility = "visible";
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, popoverClassName]);

  return (
    <fieldset
      className={`patent-illustrated-hover ${className}`}
      onMouseEnter={openSoon}
      onMouseLeave={closeSoon}
      onFocus={() => {
        clearTimer();
        setOpen(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="patent-illustrated-hover__trigger"
        aria-label={label}
      >
        {children}
      </button>
      {createPortal(
        <SpatialPresence>
          {open ? (
            <span
              ref={popoverRef}
              className={`patent-illustrated-hover__popover${popoverClassName ? ` ${popoverClassName}` : ""}`}
              role="dialog"
              aria-label={label}
              onMouseEnter={clearTimer}
              onMouseLeave={closeSoon}
            >
              {preview}
            </span>
          ) : null}
        </SpatialPresence>,
        document.body,
      )}
    </fieldset>
  );
}

function PatentLibraryDrawing({ patent, title }: { patent: LibraryPatentSummary; title: string }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (visible || !containerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    setFailed(false);
    if (!patent.drawingPreviewAssetId || patent.recoveryState !== "healthy") {
      setPreviewUrl(null);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    const getLibraryPreview = window.patentApi.patents.getLibraryPreview;
    if (!getLibraryPreview) return;
    void getLibraryPreview(patent.patentId)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setFailed(true);
          return;
        }
        const bytes = Uint8Array.from(result.value);
        objectUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
        setPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [patent.drawingPreviewAssetId, patent.patentId, patent.recoveryState, visible]);

  if (!previewUrl) {
    return (
      <div
        ref={containerRef}
        className="patent-illustrated-card__empty-image"
        role="img"
        aria-label={`${title}${patent.recoveryState !== "healthy" ? "附图暂不可读" : failed ? "附图读取失败" : patent.drawingPreviewAssetId ? "正在加载附图" : "暂无附图"}`}
      >
        <Image aria-hidden="true" size={24} strokeWidth={1.4} />
        <span>
          {patent.recoveryState !== "healthy"
            ? "附图暂不可读"
            : failed
              ? "附图读取失败"
              : patent.drawingPreviewAssetId
                ? "正在加载附图…"
                : "暂无附图"}
        </span>
      </div>
    );
  }

  return (
    <HoverPreview
      label={`查看${title}附图大图`}
      className="patent-illustrated-card__image-hover"
      popoverClassName="patent-illustrated-hover__popover--image"
      preview={<img src={previewUrl} alt={`${title}附图预览`} />}
    >
      <img src={previewUrl} alt={`${title}附图缩略图`} />
    </HoverPreview>
  );
}

export function DocumentLibrary({
  applicationMenu,
  onCreateDesktopShortcut,
  onExitApplication,
  navigationStateRef,
  documents,
  patents,
  loading,
  activeError = null,
  onRetryActive,
  onNewDocument,
  onNewPatent,
  onImportPatdoc,
  onImportDocx,
  onOpenTrash,
  onOpenDocument,
  onOpenPatent,
  onRenameDocument,
  onEditPatentSettings,
  onExportPatent,
  onOpenPatentFolder,
  onExportPatents,
  onImportBundle,
  onRecoverPatent,
  onOpenSnapshots,
  onOpenBackups,
  onExportPatdoc,
  onExportDocx,
  onExportPdf,
  onMoveToTrash,
  onMovePatentToTrash,
  onMovePatentsToTrash,
  deletingPatents = false,
  patentFocusRequest = null,
  onPatentFocusHandled,
  patentLibraryViewMode = "single",
  onPatentLibraryViewModeChange,
}: DocumentLibraryProps) {
  const initialNavigation = useRef(navigationStateRef?.current);
  const libraryRef = useRef<HTMLElement>(null);
  const [selectingForExport, setSelectingForExport] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!patents) return;
    const activeIds = new Set(patents.map((patent) => patent.patentId));
    setSelectedIds((selected) => {
      const remaining = new Set([...selected].filter((id) => activeIds.has(id)));
      return remaining.size === selected.size ? selected : remaining;
    });
  }, [patents]);
  useEffect(() => {
    if (!selectingForExport) return;
    const cancelOnAction = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const action = event.target.closest("button, input, select, [role='menuitem']");
      if (!action || action.matches(":disabled")) return;
      if (
        action.closest(
          "[data-cancel-patent-selection], .menu-bar, [role='toolbar'], .toolbar-overflow-menu",
        )
      ) {
        setSelectingForExport(false);
        setSelectedIds(new Set());
      }
    };
    document.addEventListener("click", cancelOnAction, true);
    return () => document.removeEventListener("click", cancelOnAction, true);
  }, [selectingForExport]);
  const [patentMenu, setPatentMenu] = useState<{
    patentId: string;
    position: { x: number; y: number } | null;
  } | null>(null);
  const [patentQuery, setPatentQuery] = useState(initialNavigation.current?.query ?? "");
  const [recoveringPatentId, setRecoveringPatentId] = useState<string | null>(null);
  const [highlightedPatent, setHighlightedPatent] = useState<PatentLibraryFocusRequest | null>(
    null,
  );
  const [patentTypeFilter, setPatentTypeFilter] = useState<
    "all" | LibraryPatentSummary["patentType"]
  >(initialNavigation.current?.type ?? "all");
  const [sort, setSort] = useState<"created" | "modified">(
    initialNavigation.current?.sort ?? "created",
  );
  const [selectedPatentLibraryViewMode, setSelectedPatentLibraryViewMode] =
    useState<PatentLibraryViewMode>(patentLibraryViewMode);
  const [savingPatentLibraryViewMode, setSavingPatentLibraryViewMode] = useState(false);
  const [expandedMonthKeys, setExpandedMonthKeys] = useState<Record<string, boolean>>(
    initialNavigation.current?.expandedMonths ?? {},
  );
  const [collapsedFilteredMonthKeys, setCollapsedFilteredMonthKeys] = useState<Set<string>>(
    new Set(),
  );
  const [searchContent, setSearchContent] = useState(
    initialNavigation.current?.searchContent ?? false,
  );
  const [checkingContentIndex, setCheckingContentIndex] = useState(false);
  const [contentIndexDialogOpen, setContentIndexDialogOpen] = useState(false);
  const [contentSearchRefresh, setContentSearchRefresh] = useState(0);
  const [selectedResultKey, setSelectedResultKey] = useState<string | null>(
    initialNavigation.current?.selectedResultKey ?? null,
  );
  const [contentSearchSnapshot, setContentSearchSnapshot] =
    useState<ContentSearchResultsSnapshot | null>(
      initialNavigation.current?.contentSearchSnapshot ?? null,
    );
  useLayoutEffect(() => {
    if (libraryRef.current)
      libraryRef.current.scrollTop = initialNavigation.current?.scrollTop ?? 0;
  }, []);
  useEffect(() => {
    if (navigationStateRef)
      navigationStateRef.current = {
        query: patentQuery,
        searchContent,
        selectedResultKey,
        contentSearchSnapshot,
        type: patentTypeFilter,
        expandedMonths: expandedMonthKeys,
        sort,
        scrollTop: libraryRef.current?.scrollTop ?? 0,
      };
  }, [
    navigationStateRef,
    patentQuery,
    searchContent,
    selectedResultKey,
    contentSearchSnapshot,
    patentTypeFilter,
    expandedMonthKeys,
    sort,
  ]);
  const contentSearchActive = searchContent && patentQuery.trim().length > 0;
  const applySearchContent = (enabled: boolean) => {
    setSearchContent(enabled);
    setSelectedResultKey(null);
    setSelectingForExport(false);
    setSelectedIds(new Set());
  };
  const requestSearchContent = async (enabled: boolean) => {
    if (!enabled) {
      applySearchContent(false);
      return;
    }
    if (checkingContentIndex) return;
    setCheckingContentIndex(true);
    try {
      const result = await window.patentApi.contentSearch?.request({ action: "status" });
      if (
        result?.ok &&
        ((result.value.indexedCount === 0 && (result.value.pendingCount ?? 0) > 0) ||
          (result.value.indexedCount === undefined && result.value.updatedAt === null))
      ) {
        setContentIndexDialogOpen(true);
        return;
      }
      applySearchContent(true);
    } catch {
      applySearchContent(true);
    } finally {
      setCheckingContentIndex(false);
    }
  };
  const visiblePatents = useMemo(() => {
    if (!patents) return [];
    const normalizedQuery = patentQuery.trim().toLocaleLowerCase("zh-CN");
    return patents.filter((patent) => {
      const matchesType = patentTypeFilter === "all" || patent.patentType === patentTypeFilter;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        patentDisplayName(patent).toLocaleLowerCase("zh-CN").includes(normalizedQuery) ||
        (patent.customer ?? "").toLocaleLowerCase("zh-CN").includes(normalizedQuery);
      return matchesType && matchesQuery;
    });
  }, [patentQuery, patentTypeFilter, patents]);
  const filterActive = patentQuery.trim().length > 0 || patentTypeFilter !== "all";
  const patentGroups = useMemo(
    () =>
      sort === "modified"
        ? visiblePatents.length === 0
          ? []
          : [
              {
                key: "recent",
                label: "最近编辑",
                defaultExpanded: true,
                patents: visiblePatents.toSorted(
                  (a, b) =>
                    Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt) ||
                    a.patentId.localeCompare(b.patentId),
                ),
              },
            ]
        : buildPatentLibraryGroups(visiblePatents, new Date(), filterActive),
    [filterActive, visiblePatents, sort],
  );
  const listRef = useRef<HTMLElement | null>(null);
  const [virtualFocusReady, setVirtualFocusReady] = useState<number | null>(null);
  const onVirtualFocusReady = useCallback(
    (requestKey: number) => setVirtualFocusReady(requestKey),
    [],
  );
  const focusCardRef = useRef<HTMLElement | null>(null);
  const handledFocusRequestKeyRef = useRef<number | null>(null);
  const libraryLayoutKey = patents
    ? patentGroups
        .map((group) => {
          const expanded = filterActive
            ? !collapsedFilteredMonthKeys.has(group.key)
            : (expandedMonthKeys[group.key] ?? group.defaultExpanded);
          return `${group.key}:${expanded ? "1" : "0"}:${group.patents.map((patent) => patent.patentId).join(",")}`;
        })
        .join("|")
    : documents.map((document) => document.libraryDocumentId).join("|");
  const captureLibraryPositions = useLibraryListMotion(
    listRef,
    `${selectedPatentLibraryViewMode}:${libraryLayoutKey}`,
    patents ? patentQuery : "",
  );

  const illustrated = selectedPatentLibraryViewMode === "illustrated";
  const single = selectedPatentLibraryViewMode === "single";
  // Keep card contents stable while the surrounding columns or month heights animate.
  const renderPatentCard = useMemo(() => {
    const enterMultiSelect = (patent: LibraryPatentSummary) => {
      setSelectingForExport(true);
      setSelectedIds((current) => new Set(current).add(patent.patentId));
    };
    const selectionBox = (patent: LibraryPatentSummary) => (
      <SpatialPresence>
        {onExportPatents && selectingForExport ? (
          <input
            type="checkbox"
            className="patent-export-checkbox"
            aria-label={`选择 ${patentDisplayName(patent)}`}
            checked={selectedIds.has(patent.patentId)}
            disabled={deletingPatents || patent.recoveryState === "quarantined"}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setSelectedIds((current) => {
                const next = new Set(current);
                if (checked) next.add(patent.patentId);
                else next.delete(patent.patentId);
                return next;
              });
            }}
          />
        ) : null}
      </SpatialPresence>
    );
    const runPatentRecovery = async (patent: LibraryPatentSummary) => {
      setRecoveringPatentId(patent.patentId);
      try {
        await onRecoverPatent?.(patent);
      } finally {
        setRecoveringPatentId(null);
      }
    };
    const renderQuarantineWarning = (patent: LibraryPatentSummary) => {
      const diagnosis = recoveryDiagnosis(patent.recoveryErrorCode);
      const recovering = recoveringPatentId === patent.patentId;
      return (
        <div className="library-card-warning" aria-live="polite">
          <p className="library-card-warning__diagnosis">
            {diagnosis.message}（诊断代码：{patent.recoveryErrorCode ?? "UNKNOWN"}）
          </p>
          <p className="library-card-warning__next-action">{diagnosis.nextAction}</p>
          <p className="library-card-warning__note">
            「修复并打开」会先创建安全备份，再尝试修复；无法安全修复时保留原状态，可改用快照或定时备份。
          </p>
          <div className="library-card-warning__actions">
            <button
              type="button"
              className="primary-button"
              disabled={recovering}
              onClick={() => void runPatentRecovery(patent)}
            >
              {recovering ? "正在修复" : "修复并打开"}
            </button>
            {onOpenSnapshots ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => onOpenSnapshots(patent)}
              >
                查看快照版本
              </button>
            ) : null}
            {onOpenBackups ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => onOpenBackups(patent)}
              >
                从备份恢复
              </button>
            ) : null}
          </div>
        </div>
      );
    };
    const searchResultNumbers = new Map<string, number>();
    if (patentQuery.trim()) {
      patentGroups.forEach((group) => {
        group.patents.forEach((patent) => {
          searchResultNumbers.set(patent.patentId, searchResultNumbers.size + 1);
        });
      });
    }

    const renderCard = (patent: LibraryPatentSummary) => {
      const title = patentDisplayName(patent);
      const resultNumber = searchResultNumbers.get(patent.patentId);
      const quarantined = patent.recoveryState === "quarantined";
      const recovering = recoveringPatentId === patent.patentId;
      const highlighted = highlightedPatent?.patentId === patent.patentId;
      const menuProps = {
        open: patentMenu?.patentId === patent.patentId,
        position: patentMenu?.patentId === patent.patentId ? patentMenu.position : null,
        setOpen: (open: boolean) =>
          setPatentMenu((current) =>
            open
              ? { patentId: patent.patentId, position: null }
              : current?.patentId === patent.patentId
                ? null
                : current,
          ),
      };
      const openContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setPatentMenu({
          patentId: patent.patentId,
          position: { x: event.clientX, y: event.clientY },
        });
      };
      if (illustrated) {
        return (
          <article
            ref={patentFocusRequest?.patentId === patent.patentId ? focusCardRef : undefined}
            className={`library-card patent-card patent-illustrated-card${quarantined ? " is-quarantined" : ""}${highlighted ? " is-snapshot-restore-highlight" : ""}`}
            onContextMenu={openContextMenu}
            onMouseDown={preventDoubleClickTextSelection}
            aria-label={title}
            key={patent.patentId}
            data-library-item-key={patent.patentId}
            onDoubleClick={(event) => {
              if (quarantined) return;
              const button = (event.target as HTMLElement).closest("button");
              if (button && !button.classList.contains("patent-illustrated-hover__trigger")) {
                return;
              }
              onOpenPatent?.(patent);
            }}
          >
            <div className="patent-illustrated-card__media">
              <PatentLibraryDrawing patent={patent} title={title} />
            </div>
            <div className="patent-illustrated-card__body">
              <div className="patent-illustrated-card__title-row">
                {selectionBox(patent)}
                {resultNumber ? (
                  <span
                    className="library-search-result-number"
                    role="img"
                    aria-label={`第 ${resultNumber} 条结果`}
                  >
                    {resultNumber}.
                  </span>
                ) : null}
                <h2 title={title}>{title}</h2>
                <span className={`patent-type-badge patent-type-badge--${patent.patentType}`}>
                  {PATENT_TYPE_LABELS[patent.patentType]}
                </span>
              </div>
              <p className="patent-illustrated-card__customer" title={patent.customer ?? ""}>
                {patent.customer || "未填写客户名称"}
              </p>
              {quarantined ? (
                renderQuarantineWarning(patent)
              ) : patent.abstractText ? (
                <HoverPreview
                  label={`查看${title}完整摘要`}
                  className="patent-illustrated-card__abstract-hover"
                  preview={<span>{patent.abstractText}</span>}
                >
                  <span>{patent.abstractText}</span>
                </HoverPreview>
              ) : (
                <p className="patent-illustrated-card__empty-abstract">暂无摘要</p>
              )}
            </div>
            <footer className="patent-illustrated-card__footer">
              <p className="patent-illustrated-card__dates">
                <span>创建：{formatModifiedAt(patent.createdAt)}</span>
                <span>最后编辑：{formatModifiedAt(patent.modifiedAt)}</span>
              </p>
              <div className="library-card-actions patent-card-actions patent-illustrated-card__actions">
                <PatentCardMenu
                  {...menuProps}
                  deleteDisabled={deletingPatents}
                  quarantined={quarantined}
                  recovering={recovering}
                  onOpen={() => onOpenPatent?.(patent)}
                  onSettings={() => onEditPatentSettings?.(patent)}
                  onFolder={onOpenPatentFolder ? () => onOpenPatentFolder(patent) : undefined}
                  onExport={() => onExportPatent?.(patent)}
                  onMultiSelect={onExportPatents ? () => enterMultiSelect(patent) : undefined}
                  onRecover={() => runPatentRecovery(patent)}
                  onDelete={() => {
                    captureLibraryPositions();
                    onMovePatentToTrash?.(patent);
                  }}
                />
              </div>
            </footer>
          </article>
        );
      }
      if (single) {
        return (
          <article
            ref={patentFocusRequest?.patentId === patent.patentId ? focusCardRef : undefined}
            className={`library-card patent-card patent-list-row${quarantined ? " is-quarantined" : ""}${highlighted ? " is-snapshot-restore-highlight" : ""}`}
            aria-label={title}
            title="双击继续编辑"
            key={patent.patentId}
            data-library-item-key={patent.patentId}
            onContextMenu={openContextMenu}
            onMouseDown={preventDoubleClickTextSelection}
            onDoubleClick={(event) => {
              if (!quarantined && !(event.target as HTMLElement).closest("button, input")) {
                onOpenPatent?.(patent);
              }
            }}
          >
            <div className="patent-list-row__selection">
              {selectingForExport ? (
                selectionBox(patent)
              ) : onExportPatents ? (
                <button
                  type="button"
                  className="patent-list-select"
                  aria-label={`多选 ${title}`}
                  disabled={quarantined || searchContent}
                  onClick={() => enterMultiSelect(patent)}
                />
              ) : null}
            </div>
            <div className="patent-list-row__title">
              {resultNumber ? (
                <span
                  className="library-search-result-number"
                  role="img"
                  aria-label={`第 ${resultNumber} 条结果`}
                >
                  {resultNumber}.
                </span>
              ) : null}
              <h2 title={title}>
                <button
                  type="button"
                  className="patent-list-title-button"
                  disabled={quarantined}
                  onClick={() => onOpenPatent?.(patent)}
                >
                  {title}
                </button>
              </h2>
            </div>
            <span className="patent-list-row__customer" title={patent.customer ?? ""}>
              {patent.customer || "—"}
            </span>
            <span className={`patent-type-badge patent-type-badge--${patent.patentType}`}>
              {PATENT_TYPE_LABELS[patent.patentType]}
            </span>
            <time
              className="patent-list-row__date"
              dateTime={patent.modifiedAt}
              title={`创建：${formatModifiedAt(patent.createdAt)}`}
            >
              <span className="screen-reader-only">最后编辑：</span>
              {formatModifiedAt(patent.modifiedAt)}
            </time>
            <div className="library-card-actions patent-card-actions">
              <PatentCardMenu
                {...menuProps}
                deleteDisabled={deletingPatents}
                quarantined={quarantined}
                recovering={recovering}
                onOpen={() => onOpenPatent?.(patent)}
                onSettings={() => onEditPatentSettings?.(patent)}
                onFolder={onOpenPatentFolder ? () => onOpenPatentFolder(patent) : undefined}
                onExport={() => onExportPatent?.(patent)}
                onMultiSelect={onExportPatents ? () => enterMultiSelect(patent) : undefined}
                onRecover={() => runPatentRecovery(patent)}
                onDelete={() => {
                  captureLibraryPositions();
                  onMovePatentToTrash?.(patent);
                }}
              />
            </div>
            {quarantined ? renderQuarantineWarning(patent) : null}
          </article>
        );
      }
      return (
        <article
          ref={patentFocusRequest?.patentId === patent.patentId ? focusCardRef : undefined}
          className={`library-card patent-card${quarantined ? " is-quarantined" : ""}${highlighted ? " is-snapshot-restore-highlight" : ""}`}
          onContextMenu={openContextMenu}
          onMouseDown={preventDoubleClickTextSelection}
          aria-label={title}
          title="双击卡片继续编辑"
          key={patent.patentId}
          data-library-item-key={patent.patentId}
          onDoubleClick={(event) => {
            if (quarantined) return;
            if ((event.target as HTMLElement).closest(".library-card-actions")) return;
            onOpenPatent?.(patent);
          }}
        >
          <div className="library-card-main">
            <div className="library-card-title-row">
              {selectionBox(patent)}
              <div className="library-card-title-content">
                {resultNumber ? (
                  <span
                    className="library-search-result-number"
                    role="img"
                    aria-label={`第 ${resultNumber} 条结果`}
                  >
                    {resultNumber}.
                  </span>
                ) : null}
                <h2 title={title}>{title}</h2>
                <span className={`patent-type-badge patent-type-badge--${patent.patentType}`}>
                  {PATENT_TYPE_LABELS[patent.patentType]}
                </span>
              </div>
            </div>
            <p className="library-card-meta">
              <span
                className="library-card-customer"
                title={patent.customer ?? ""}
                aria-hidden={patent.customer ? undefined : true}
              >
                {patent.customer ?? ""}
              </span>
              <span>创建：{formatModifiedAt(patent.createdAt)}</span>
              <span className="patent-card-meta-modified">
                最后编辑：{formatModifiedAt(patent.modifiedAt)}
              </span>
            </p>
            {quarantined ? renderQuarantineWarning(patent) : null}
          </div>
          <div className="library-card-actions patent-card-actions">
            <PatentCardMenu
              {...menuProps}
              deleteDisabled={deletingPatents}
              quarantined={quarantined}
              recovering={recovering}
              onOpen={() => onOpenPatent?.(patent)}
              onSettings={() => onEditPatentSettings?.(patent)}
              onFolder={onOpenPatentFolder ? () => onOpenPatentFolder(patent) : undefined}
              onExport={() => onExportPatent?.(patent)}
              onMultiSelect={onExportPatents ? () => enterMultiSelect(patent) : undefined}
              onRecover={() => runPatentRecovery(patent)}
              onDelete={() => {
                captureLibraryPositions();
                onMovePatentToTrash?.(patent);
              }}
            />
          </div>
        </article>
      );
    };
    return renderCard;
  }, [
    patentGroups,
    patentQuery,
    illustrated,
    single,
    searchContent,
    selectedIds,
    selectingForExport,
    deletingPatents,
    recoveringPatentId,
    highlightedPatent,
    patentMenu,
    patentFocusRequest,
    onExportPatents,
    onRecoverPatent,
    onOpenPatent,
    onEditPatentSettings,
    onExportPatent,
    onOpenPatentFolder,
    onMovePatentToTrash,
    onOpenSnapshots,
    onOpenBackups,
    captureLibraryPositions,
  ]);

  useEffect(() => {
    setSelectedPatentLibraryViewMode(patentLibraryViewMode);
  }, [patentLibraryViewMode]);

  const wasFilterActiveRef = useRef(filterActive);
  useEffect(() => {
    if (wasFilterActiveRef.current && !filterActive) setExpandedMonthKeys({});
    wasFilterActiveRef.current = filterActive;
  }, [filterActive]);

  useEffect(() => {
    if (!patentFocusRequest) return;
    setPatentQuery("");
    setPatentTypeFilter("all");
  }, [patentFocusRequest]);

  useEffect(() => {
    if (!patentFocusRequest) return;
    if (handledFocusRequestKeyRef.current === patentFocusRequest.requestKey) return;
    if (filterActive) return;
    const focusGroup = patentGroups.find((group) =>
      group.patents.some((patent) => patent.patentId === patentFocusRequest.patentId),
    );
    if (!focusGroup) return;
    if (!(expandedMonthKeys[focusGroup.key] ?? focusGroup.defaultExpanded)) {
      setExpandedMonthKeys((current) => ({ ...current, [focusGroup.key]: true }));
      return;
    }
    if (visiblePatents.length > 100 && virtualFocusReady !== patentFocusRequest.requestKey) return;
    if (!focusCardRef.current) return;
    setHighlightedPatent(patentFocusRequest);
    focusCardRef.current.scrollIntoView({ block: "nearest" });
    handledFocusRequestKeyRef.current = patentFocusRequest.requestKey;
    onPatentFocusHandled?.(patentFocusRequest.requestKey);
  }, [
    onPatentFocusHandled,
    patentFocusRequest,
    patentGroups,
    expandedMonthKeys,
    filterActive,
    virtualFocusReady,
    visiblePatents.length,
  ]);

  useEffect(() => {
    if (!highlightedPatent) return;
    const timeoutId = window.setTimeout(() => setHighlightedPatent(null), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [highlightedPatent]);

  if (patents) {
    const selectablePatents = visiblePatents.filter(
      (patent) => patent.recoveryState !== "quarantined",
    );
    const selectedPatents = selectablePatents.filter((patent) => selectedIds.has(patent.patentId));
    const allPatentsSelected =
      selectablePatents.length > 0 && selectedPatents.length === selectablePatents.length;
    const toggleAllPatents = () => {
      setSelectingForExport(!allPatentsSelected);
      setSelectedIds(
        allPatentsSelected
          ? new Set()
          : new Set(selectablePatents.map((patent) => patent.patentId)),
      );
    };
    const setPatentLibraryViewMode = async (mode: PatentLibraryViewMode) => {
      if (
        mode === selectedPatentLibraryViewMode ||
        savingPatentLibraryViewMode ||
        !onPatentLibraryViewModeChange
      ) {
        return;
      }
      setSavingPatentLibraryViewMode(true);
      captureLibraryPositions();
      try {
        if (await onPatentLibraryViewModeChange(mode)) setSelectedPatentLibraryViewMode(mode);
      } finally {
        setSavingPatentLibraryViewMode(false);
      }
    };
    return (
      <div className="library-shell">
        <aside className="library-sidebar" aria-label="专利库导航">
          <div className="library-wordmark">
            <BrandLogo decorative />
            <span>知产小栈</span>
            <span className="library-wordmark__work">Work</span>
          </div>
          <p className="library-sidebar__label">资料库</p>
          <nav>
            {(
              [
                ["all", "专利库"],
                ["invention", "发明"],
                ["utility-model", "实用新型"],
                ["design", "外观设计"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-current={patentTypeFilter === value ? "page" : undefined}
                onClick={() => {
                  captureLibraryPositions();
                  setPatentTypeFilter(value);
                  setCollapsedFilteredMonthKeys(new Set());
                }}
              >
                {value === "all" ? (
                  <Folder size={21} strokeWidth={1.7} aria-hidden="true" />
                ) : (
                  <PatentTypeIcon type={value} />
                )}
                <span>{label}</span>
              </button>
            ))}
            <div className="library-sidebar__divider" />
            <button type="button" data-cancel-patent-selection onClick={onOpenTrash}>
              <Trash2 size={21} strokeWidth={1.7} aria-hidden="true" />
              <span>回收站</span>
            </button>
          </nav>
          {applicationMenu ? (
            <div className="library-sidebar__footer">{applicationMenu}</div>
          ) : null}
        </aside>
        <main
          className="library-view library-desktop-view"
          aria-label="专利库"
          ref={libraryRef}
          onScroll={(event) => {
            if (navigationStateRef?.current)
              navigationStateRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
        >
          <div className="library-toolbar">
            <header className="library-header">
              <div className="library-heading">
                <h1>专利库</h1>
              </div>
              <div className="library-header-actions">
                <button
                  className="primary-button"
                  type="button"
                  data-cancel-patent-selection
                  onClick={() => onNewPatent?.()}
                >
                  <Plus size={18} aria-hidden="true" />
                  新建专利
                </button>
                <ImportMenu
                  {...(onImportBundle ? { onImportBundle } : {})}
                  onImportDocx={onImportDocx ?? (() => undefined)}
                  onImportPatdoc={onImportPatdoc}
                />
                {onExportPatents ? (
                  <div className="library-export-menu">
                    <button
                      type="button"
                      aria-expanded={selectingForExport}
                      aria-pressed={selectingForExport}
                      aria-controls="library-selection-actions"
                      disabled={searchContent || deletingPatents}
                      title={searchContent ? "关闭搜索正文后可批量操作" : undefined}
                      onClick={() => {
                        setSelectingForExport(!selectingForExport);
                        setSelectedIds(new Set());
                      }}
                    >
                      导出
                    </button>
                  </div>
                ) : null}
                {onCreateDesktopShortcut && onExitApplication ? (
                  <LibraryMoreMenu
                    onCreateDesktopShortcut={onCreateDesktopShortcut}
                    onExitApplication={onExitApplication}
                  />
                ) : null}
              </div>
            </header>
            <section className="library-filters patent-library-filters" aria-label="专利筛选">
              <div className="patent-library-search">
                <Search className="patent-library-search__icon" aria-hidden="true" size={18} />
                <input
                  type="search"
                  aria-label={searchContent ? "搜索五书正文" : "搜索专利题目与客户"}
                  maxLength={200}
                  placeholder={searchContent ? "搜索五书正文" : "搜索专利题目或客户"}
                  value={patentQuery}
                  onChange={(event) => {
                    setPatentQuery(event.currentTarget.value);
                    setSelectedResultKey(null);
                    setCollapsedFilteredMonthKeys(new Set());
                  }}
                />
                <label
                  className="patent-search-content-toggle"
                  data-active={searchContent || undefined}
                >
                  <span>搜索正文</span>
                  <input
                    type="checkbox"
                    aria-label="搜索正文"
                    checked={searchContent}
                    disabled={checkingContentIndex}
                    onChange={(event) => void requestSearchContent(event.currentTarget.checked)}
                  />
                  <span className="patent-search-content-toggle__track" aria-hidden="true">
                    <span />
                  </span>
                </label>
              </div>
              <label className="library-filter-select">
                <select
                  aria-label="专利类型"
                  value={patentTypeFilter}
                  onChange={(event) => {
                    captureLibraryPositions();
                    setPatentTypeFilter(
                      event.currentTarget.value as "all" | LibraryPatentSummary["patentType"],
                    );
                    setCollapsedFilteredMonthKeys(new Set());
                  }}
                >
                  <option value="all">全部类型</option>
                  <option value="invention">发明</option>
                  <option value="utility-model">实用新型</option>
                  <option value="design">外观设计</option>
                </select>
              </label>
              <label className="library-filter-select">
                <select
                  aria-label="排序方式"
                  disabled={contentSearchActive}
                  value={sort}
                  onChange={(event) => {
                    captureLibraryPositions();
                    setSort(event.currentTarget.value as "created" | "modified");
                  }}
                >
                  <option value="created">创建月份</option>
                  <option value="modified">最近编辑</option>
                </select>
              </label>
              <fieldset className="patent-library-view-toggle" disabled={contentSearchActive}>
                <legend className="screen-reader-only">专利库视图</legend>
                <button
                  type="button"
                  aria-label="单栏视图"
                  title="单栏显示"
                  aria-pressed={selectedPatentLibraryViewMode === "single"}
                  disabled={savingPatentLibraryViewMode || !onPatentLibraryViewModeChange}
                  onClick={() => void setPatentLibraryViewMode("single")}
                >
                  <List aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  aria-label="双栏视图"
                  title="双栏显示"
                  aria-pressed={selectedPatentLibraryViewMode === "double"}
                  disabled={savingPatentLibraryViewMode || !onPatentLibraryViewModeChange}
                  onClick={() => void setPatentLibraryViewMode("double")}
                >
                  <Columns2 aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  aria-label="图文视图"
                  title="图文显示"
                  aria-pressed={selectedPatentLibraryViewMode === "illustrated"}
                  disabled={savingPatentLibraryViewMode || !onPatentLibraryViewModeChange}
                  onClick={() => void setPatentLibraryViewMode("illustrated")}
                >
                  <Image aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
              </fieldset>
            </section>
            <SpatialCollapse
              open={selectingForExport}
              className="library-selection-collapse"
              retentionMs={420}
            >
              {selectingForExport && onExportPatents ? (
                <fieldset
                  id="library-selection-actions"
                  className="library-header-actions library-selection-actions"
                  aria-label="专利多选操作"
                >
                  <span className="library-selection-count">
                    已选择 <strong>{selectedPatents.length}</strong> 项专利
                  </span>
                  <button
                    type="button"
                    aria-label="全选当前筛选专利"
                    aria-pressed={allPatentsSelected}
                    disabled={deletingPatents || !selectablePatents.length}
                    onClick={toggleAllPatents}
                  >
                    {allPatentsSelected ? "取消全选" : "全选"}
                  </button>
                  <button
                    type="button"
                    className="primary-button library-selection-export"
                    disabled={deletingPatents || !selectedPatents.length}
                    onClick={() => onExportPatents(selectedPatents)}
                  >
                    导出所选（{selectedPatents.length}）
                  </button>
                  {onMovePatentsToTrash ? (
                    <button
                      type="button"
                      className="library-batch-delete"
                      disabled={deletingPatents || !selectedPatents.length}
                      onClick={async () => {
                        if (await onMovePatentsToTrash(selectedPatents)) {
                          setSelectingForExport(false);
                          setSelectedIds(new Set());
                        }
                      }}
                    >
                      {deletingPatents ? "正在删除…" : "批量删除"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label="取消选择"
                    disabled={deletingPatents}
                    onClick={() => {
                      setSelectingForExport(false);
                      setSelectedIds(new Set());
                    }}
                  >
                    取消
                  </button>
                </fieldset>
              ) : null}
            </SpatialCollapse>
          </div>
          <SpatialPresence>
            {activeError ? (
              <section className="library-read-error" role="alert">
                <div>
                  <strong>专利库暂时无法读取</strong>
                  <p>已保留上次成功读取的结果。{activeError.message}</p>
                </div>
                <button type="button" onClick={() => onRetryActive?.()}>
                  重试读取专利库
                </button>
              </section>
            ) : null}
          </SpatialPresence>
          <SpatialPresence>
            {loading && patents.length === 0 ? <p className="library-empty">正在读取专利库…</p> : null}
          </SpatialPresence>
          <SpatialPresence>
            {!loading && !activeError && patents.length === 0 ? (
              <section className="library-empty" aria-label="空专利库">
                <p>还没有专利，点击“新建专利”开始。</p>
              </section>
            ) : null}
          </SpatialPresence>
          {!loading && !activeError && patents.length > 0 && patentQuery.trim().length > 0 ? (
            <h2 className="library-search-results-title">搜索结果</h2>
          ) : null}
          {contentSearchActive ? (
            <ContentSearchResults
              refreshToken={contentSearchRefresh}
              onUpdateIndex={() => setContentIndexDialogOpen(true)}
              query={patentQuery.trim()}
              patents={patents}
              type={patentTypeFilter}
              selectedResultKey={selectedResultKey}
              onOpen={(patent, target, resultKey) => {
                setSelectedResultKey(resultKey ?? null);
                if (navigationStateRef?.current)
                  navigationStateRef.current.selectedResultKey = resultKey ?? null;
                onOpenPatent?.(patent, target, resultKey);
              }}
              snapshot={contentSearchSnapshot}
              onSnapshotChange={setContentSearchSnapshot}
            />
          ) : null}
          <SpatialPresence>
            {!contentSearchActive &&
            !loading &&
            patents.length > 0 &&
            visiblePatents.length === 0 ? (
              <p className="library-empty">没有符合条件的专利。</p>
            ) : null}
          </SpatialPresence>
          <section
            ref={listRef}
            hidden={contentSearchActive}
            className="library-list"
            aria-label="专利列表"
            data-view-mode={selectedPatentLibraryViewMode}
          >
            {single && visiblePatents.length > 0 && !contentSearchActive ? (
              <div className="patent-list-columns">
                <span className="patent-list-row__selection">
                  {onExportPatents ? (
                    <input
                      type="checkbox"
                      className="patent-export-checkbox"
                      aria-label="选择全部专利进行批量操作"
                      checked={allPatentsSelected}
                      ref={(checkbox) => {
                        if (checkbox) {
                          checkbox.indeterminate =
                            selectedPatents.length > 0 && !allPatentsSelected;
                        }
                      }}
                      disabled={deletingPatents || !selectablePatents.length}
                      onChange={toggleAllPatents}
                    />
                  ) : null}
                </span>
                <span>专利题目</span>
                <span>客户</span>
                <span>专利类型</span>
                <span>最近编辑</span>
                <span />
              </div>
            ) : null}
            {(contentSearchActive ? [] : patentGroups).map((group) => {
              const expanded = filterActive
                ? !collapsedFilteredMonthKeys.has(group.key)
                : (expandedMonthKeys[group.key] ?? group.defaultExpanded);
              const groupId = `patent-library-month-${group.key}`;
              return (
                <section className="library-month-group" key={group.key}>
                  <button
                    type="button"
                    className="patent-library-month-heading"
                    aria-controls={groupId}
                    aria-expanded={expanded}
                    key={`${group.key}-heading`}
                    onClick={() => {
                      if (filterActive) {
                        setCollapsedFilteredMonthKeys((current) => {
                          const next = new Set(current);
                          if (expanded) next.add(group.key);
                          else next.delete(group.key);
                          return next;
                        });
                      } else {
                        setExpandedMonthKeys((current) => ({ ...current, [group.key]: !expanded }));
                      }
                    }}
                  >
                    <span>{group.label}</span>
                    <span className="patent-library-month-count">
                      {formatPatentCounts(group.patents)}
                    </span>
                    <span className="patent-library-month-chevron" aria-hidden="true">
                      <ChevronRight size={18} strokeWidth={2} />
                    </span>
                  </button>
                  <SpatialCollapse
                    open={expanded}
                    animateInitial={false}
                    className="library-month-collapse"
                    key={`${group.key}-cards`}
                  >
                    {
                      <VirtualPatentCards
                        mode={selectedPatentLibraryViewMode}
                        patents={group.patents}
                        renderCard={renderPatentCard}
                        focus={patentFocusRequest}
                        virtual={visiblePatents.length > 100}
                        onFocusReady={onVirtualFocusReady}
                        id={groupId}
                        key={`${group.key}-cards`}
                      />
                    }
                  </SpatialCollapse>
                </section>
              );
            })}
          </section>
          <MotionPresence>
            {contentIndexDialogOpen ? (
              <ContentSearchIndexDialog
                onCancel={() => setContentIndexDialogOpen(false)}
                onComplete={() => {
                  setContentSearchSnapshot(null);
                  setContentSearchRefresh((n) => n + 1);
                  applySearchContent(true);
                  setContentIndexDialogOpen(false);
                }}
              />
            ) : null}
          </MotionPresence>
        </main>
      </div>
    );
  }

  return (
    <main className="library-view" aria-label="文档库">
      <header className="library-header">
        <div>
          <h1>文档库</h1>
          <p>这里保存软件自动管理的内部草稿；导入和导出是独立副本。</p>
        </div>
        <div className="library-header-actions">
          <button className="primary-button" type="button" onClick={onNewDocument}>
            新建文档
          </button>
          <button type="button" onClick={onImportPatdoc}>
            导入 PATDOC
          </button>
          <button type="button" onClick={onOpenTrash}>
            回收站
          </button>
        </div>
      </header>
      {loading ? <p className="library-empty">正在读取文档库…</p> : null}
      {!loading && documents.length === 0 ? (
        <section className="library-empty" aria-label="空文档库">
          <h2>还没有文档</h2>
          <p>点“新建文档”开始，之后每次打开软件都会先回到这里。</p>
        </section>
      ) : null}
      <section ref={listRef} className="library-list" aria-label="内部文档">
        {documents.map((document) => {
          const quarantined = document.recoveryState === "quarantined";
          return (
            <article
              className={`library-card ${quarantined ? "is-quarantined" : ""}`}
              aria-label={document.title}
              key={document.libraryDocumentId}
              data-library-item-key={document.libraryDocumentId}
            >
              <div className="library-card-main">
                <div className="library-card-title-row">
                  <h2>{document.title}</h2>
                  <SaveStateBadge state={document.saveState} />
                </div>
                <p className="library-card-meta">
                  最后编辑：{formatModifiedAt(document.modifiedAt)} · 修订 {document.revision}
                </p>
                <p className="library-card-snippet">{document.snippet || "暂无正文摘要。"}</p>
                {quarantined ? (
                  <p className="library-card-warning">
                    {recoveryDiagnosis(document.recoveryErrorCode).message}（诊断代码：
                    {document.recoveryErrorCode ?? "UNKNOWN"}）
                  </p>
                ) : null}
              </div>
              <div className="library-card-actions">
                <button
                  type="button"
                  disabled={quarantined}
                  onClick={() => onOpenDocument(document)}
                >
                  继续编辑 {document.title}
                </button>
                <button
                  type="button"
                  disabled={quarantined}
                  onClick={() => onRenameDocument(document)}
                >
                  重命名 {document.title}
                </button>
                <button type="button" onClick={() => onExportPatdoc(document)}>
                  导出 PATDOC {document.title}
                </button>
                <button type="button" disabled={quarantined} onClick={() => onExportDocx(document)}>
                  导出 DOCX {document.title}
                </button>
                <button type="button" disabled={quarantined} onClick={() => onExportPdf(document)}>
                  导出 PDF {document.title}
                </button>
                <button
                  type="button"
                  disabled={quarantined}
                  onClick={() => onMoveToTrash(document)}
                >
                  删除 {document.title}
                </button>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
