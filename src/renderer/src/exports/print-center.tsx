import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanonicalDocument } from "../../../shared/document/model";
import type { ExportReport } from "../../../shared/exports/report";
import type {
  PrintPreview,
  PrintPreviewRequest,
  SavePreviewPdfRequest,
} from "../../../shared/ipc/contract";
import type { AppError, AppResult } from "../../../shared/ipc/result";
import type { DocumentStructureIssue } from "../../../shared/patent/document-structure-ruler";
import type {
  DirectPrintRequest,
  PagesPerSheet,
  PrinterDescriptor,
  PrintLayoutSettings,
  PrintOutputSettings,
  PrintPreferences,
} from "../../../shared/printing/model";
import { STANDARD_PAPER_SIZE_NAMES } from "../../../shared/printing/paper-sizes";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { SpatialPresence } from "../shared/spatial-presence";
import { SpatialView } from "../shared/spatial-view";
import { StandardDialog } from "../shared/standard-dialog";
import {
  createPdfPageRenderer,
  type PdfPageRenderer,
  type PdfPreviewZoom,
} from "./pdf-page-renderer";
import {
  createPrintCenterController,
  type PrintCenterController,
  type PrintCenterState,
} from "./print-center-state";
import "./print-center.css";

export type PrintCenterApi = {
  listPrinters(): Promise<AppResult<PrinterDescriptor[]>>;
  preview(request: PrintPreviewRequest): Promise<AppResult<PrintPreview>>;
  discardPreview(previewId: string): Promise<AppResult<void>>;
  savePreviewPdf(request: SavePreviewPdfRequest): Promise<AppResult<ExportReport | null>>;
  print(request: DirectPrintRequest): Promise<AppResult<void>>;
  openPrinterSettings(): Promise<AppResult<void>>;
};

export type PrintCenterProps = {
  documents?: CanonicalDocument[];
  figureLabels?: Record<string, string>;
  combinedSuggestedName?: string;
  sessionId: string;
  sessionTargetId?: string;
  document: CanonicalDocument;
  suggestedName: string;
  preferences: PrintPreferences;
  api?: PrintCenterApi;
  structureIssues?: readonly DocumentStructureIssue[];
  onClose(): void;
  onExportReport(report: ExportReport): void;
  onError(error: AppError): void;
};

const DEFAULT_PRINTER_VALUE = "__system-default__";
const PAGES_PER_SHEET_OPTIONS: PagesPerSheet[] = [1, 2, 4, 6, 9, 16];

function defaultApi(): PrintCenterApi {
  return window.patentApi.exports;
}

function cloneState(state: PrintCenterState): PrintCenterState {
  return {
    ...state,
    printers: [...state.printers],
    settings: structuredClone(state.settings),
    pageSelection: structuredClone(state.pageSelection),
    preview: {
      ...state.preview,
    },
  };
}

function currentSelectionValue(state: PrintCenterState): string {
  return state.pageSelection.mode;
}

function customRangeValue(state: PrintCenterState): string {
  return state.pageSelection.mode === "custom" ? state.pageSelection.source : "";
}

function renderContainerSize(container: HTMLElement): { width: number; height: number } {
  const style = container ? getComputedStyle(container) : null;
  const padding = (value: string | undefined) => Number.parseFloat(value ?? "0") || 0;
  return {
    width: Math.max(
      1,
      (container?.clientWidth || 720) - padding(style?.paddingLeft) - padding(style?.paddingRight),
    ),
    height: Math.max(
      1,
      (container?.clientHeight || 900) - padding(style?.paddingTop) - padding(style?.paddingBottom),
    ),
  };
}

function coercePagesPerSheet(value: string): PagesPerSheet {
  const parsed = Number(value);
  return PAGES_PER_SHEET_OPTIONS.includes(parsed as PagesPerSheet) ? (parsed as PagesPerSheet) : 1;
}

function printButtonLabel(busyAction: "print" | "export" | null): string {
  return busyAction === "print" ? "正在打印……" : "打印";
}

export function PrintCenter({
  documents,
  figureLabels,
  combinedSuggestedName,
  sessionId,
  sessionTargetId,
  document,
  suggestedName,
  preferences,
  api,
  structureIssues = [],
  onClose,
  onExportReport,
  onError,
}: PrintCenterProps) {
  const [state, setState] = useState<PrintCenterState | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [zoom, setZoom] = useState<PdfPreviewZoom>({ mode: "fit-width" });
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const [busyAction, setBusyAction] = useState<"print" | "export" | null>(null);
  const [pendingStructureAction, setPendingStructureAction] = useState<"print" | "export" | null>(
    null,
  );
  const [previewMessage, setPreviewMessage] = useState("正在加载打印机……");
  const [openedPreviewId, setOpenedPreviewId] = useState<string | null>(null);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasesRef = useRef(new Map<number, HTMLCanvasElement>());
  const [pageSize, setPageSize] = useState({ width: 720, height: 1018 });
  const [visibleStart, setVisibleStart] = useState(1);
  const controllerRef = useRef<PrintCenterController | null>(null);
  const rendererRef = useRef<PdfPageRenderer | null>(null);
  const apiRef = useRef<PrintCenterApi | null>(null);
  apiRef.current ??= api ?? defaultApi();
  const resolvedApi = apiRef.current;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const controllerInput = useMemo(
    () => ({
      sessionId,
      targetId: sessionTargetId ?? document.documentId,
      document,
      suggestedName,
      preferences,
      ...(documents ? { documents } : {}),
      ...(figureLabels ? { figureLabels } : {}),
      ...(combinedSuggestedName ? { combinedSuggestedName } : {}),
    }),
    [
      sessionId,
      sessionTargetId,
      document,
      suggestedName,
      preferences,
      documents,
      figureLabels,
      combinedSuggestedName,
    ],
  );

  useEffect(() => {
    rendererRef.current = createPdfPageRenderer();
    return () => {
      rendererRef.current?.close();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let controller: PrintCenterController | undefined;

    void resolvedApi.listPrinters().then((result) => {
      if (disposed) return;
      if (!result.ok) {
        onErrorRef.current(result.error);
        setPreviewMessage("打印机列表读取失败。");
        return;
      }

      controller = createPrintCenterController({
        ...controllerInput,
        printers: result.value,
        preview: resolvedApi.preview,
        discardPreview: resolvedApi.discardPreview,
      });
      controllerRef.current = controller;
      unsubscribe = controller.subscribe((nextState) => setState(cloneState(nextState)));
      setPreviewMessage("");
      controller.start();
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      controller?.close();
      controllerRef.current = null;
    };
  }, [controllerInput, resolvedApi]);

  useEffect(() => {
    const controller = controllerRef.current;
    const renderer = rendererRef.current;
    if (!controller || !renderer || !state?.preview.bytes || !state.preview.previewId) {
      return;
    }

    const previewId = state.preview.previewId;
    let cancelled = false;
    setOpenedPreviewId(null);
    setPreviewMessage("正在打开 PDF 预览……");
    void renderer
      .open(state.preview.bytes)
      .then(({ totalPages }) => {
        if (cancelled) return;
        controller.setTotalPages(totalPages);
        setVisibleStart(1);
        if (previewContainerRef.current) previewContainerRef.current.scrollTop = 0;
        setOpenedPreviewId(previewId);
      })
      .catch(() => {
        if (!cancelled) setPreviewMessage("PDF 预览加载失败。");
      });

    return () => {
      cancelled = true;
    };
  }, [state?.preview.previewId, state?.preview.bytes]);

  useEffect(() => {
    const container = previewContainerRef.current;
    if (!container || !openedPreviewId) return;
    const measure = () => {
      const size = renderContainerSize(container);
      setPreviewSize((previous) =>
        previous?.width === size.width && previous.height === size.height ? previous : size,
      );
    };
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [openedPreviewId]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const container = previewContainerRef.current;
    if (
      !renderer ||
      !container ||
      !state?.preview.previewId ||
      openedPreviewId !== state.preview.previewId ||
      state.totalPages === null
    ) {
      return;
    }
    let cancelled = false;
    // Keep only the visible pages and a small buffer rasterized; all page slots
    // remain in the scroll flow so long documents do not allocate one bitmap per page.
    const size = previewSize ?? renderContainerSize(container);
    const start = Math.max(1, visibleStart - 2);
    const end = Math.min(
      state.totalPages,
      visibleStart + Math.ceil(size.height / pageSize.height) + 2,
    );
    for (const [number, canvas] of canvasesRef.current) {
      if (number < start || number > end) {
        canvas.width = 1;
        canvas.height = 1;
      }
    }
    void (async () => {
      try {
        for (let number = start; number <= end; number++) {
          if (cancelled) return;
          const canvas = canvasesRef.current.get(number);
          if (!canvas) continue;
          const result = await renderer.render(canvas, {
            pageNumber: number,
            zoom,
            container: size,
          });
          if (cancelled) return;
          setPageSize((previous) =>
            previous.width === result.width && previous.height === result.height
              ? previous
              : { width: result.width, height: result.height },
          );
        }
        if (!cancelled) setPreviewMessage("");
      } catch {
        if (!cancelled) setPreviewMessage("PDF 页面渲染失败。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    visibleStart,
    pageSize.height,
    state?.totalPages,
    state?.preview.previewId,
    openedPreviewId,
    zoom,
    previewSize,
  ]);

  const scrollToPage = (page: number) => {
    const container = previewContainerRef.current;
    if (!container) return;
    container.scrollTop = (page - 1) * (pageSize.height + 22);
    setVisibleStart(page);
    controllerRef.current?.goToPage(page);
  };

  const updateLayout = (patch: Partial<PrintLayoutSettings>) =>
    controllerRef.current?.updateLayout(patch);
  const updateOutput = (patch: Partial<PrintOutputSettings>) =>
    controllerRef.current?.updateOutput(patch);

  const runExport = async (confirmed = false) => {
    if (!state?.preview.previewId || state.preview.status !== "ready") return;
    if (structureIssues.length > 0 && !confirmed) {
      setPendingStructureAction("export");
      return;
    }
    setBusyAction("export");
    try {
      const result = await resolvedApi.savePreviewPdf({
        previewId: state.preview.previewId,
        suggestedName: state.suggestedName,
      });
      if (!result.ok) {
        onError(result.error);
        return;
      }
      if (result.value) onExportReport(result.value);
    } finally {
      setBusyAction(null);
    }
  };

  const runPrint = async (confirmed = false) => {
    if (!state?.preview.previewId || !state.canPrint) return;
    if (structureIssues.length > 0 && !confirmed) {
      setPendingStructureAction("print");
      return;
    }
    setBusyAction("print");
    try {
      const result = await resolvedApi.print({
        sessionId,
        previewId: state.preview.previewId,
        output: state.settings.output,
      });
      if (!result.ok) {
        onError(result.error);
        return;
      }
      onClose();
    } finally {
      setBusyAction(null);
    }
  };

  const cancel = () => {
    controllerRef.current?.close();
    onClose();
  };

  const openPrinterSettings = async () => {
    const result = await resolvedApi.openPrinterSettings();
    if (!result.ok) onError(result.error);
  };

  return (
    <StandardDialog
      open
      title="打印中心"
      size="xl"
      onCancel={cancel}
      movable
      resizable
      closeDisabled={busyAction !== null}
      className="print-center-dialog"
      bodyClassName="print-center-dialog__body"
      footer={
        <div className="print-center-actions">
          <button
            type="button"
            disabled={
              !state?.preview.previewId || state.preview.status !== "ready" || busyAction !== null
            }
            onClick={() => void runExport()}
          >
            {busyAction === "export" ? "正在导出……" : "导出 PDF"}
          </button>
          <button type="button" disabled={busyAction !== null} onClick={cancel}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!state?.canPrint || busyAction !== null}
            title={state?.printDisabledReason ?? undefined}
            onClick={() => void runPrint()}
          >
            {printButtonLabel(busyAction)}
          </button>
        </div>
      }
    >
      {state ? (
        <div className="print-center-body">
          <aside className="print-settings-panel" aria-label="打印设置">
            <label className="print-field print-field-wide">
              <span>打印内容</span>
              <select
                aria-label="打印内容"
                value={state.scope}
                disabled={busyAction !== null}
                onChange={(event) =>
                  controllerRef.current?.setScope(
                    event.currentTarget.value === "all" ? "all" : "current",
                  )
                }
              >
                <option value="current">当前文档</option>
                <option value="all" disabled={!documents?.length}>
                  全部五书
                </option>
              </select>
            </label>
            <SpatialPresence>
              {state.missingRememberedPrinterName ? (
                <p className="print-inline-notice" role="status">
                  已记忆的打印机不可用，已切换为系统默认打印机。
                </p>
              ) : null}
            </SpatialPresence>

            <label className="print-field print-field-wide">
              <span>打印机</span>
              <select
                aria-label="打印机"
                value={state.settings.output.printerDeviceName ?? DEFAULT_PRINTER_VALUE}
                onChange={(event) =>
                  updateOutput({
                    printerDeviceName:
                      event.currentTarget.value === DEFAULT_PRINTER_VALUE
                        ? null
                        : event.currentTarget.value,
                  })
                }
              >
                <option value={DEFAULT_PRINTER_VALUE}>
                  {state.printers.length > 0 ? "系统默认打印机" : "无可用打印机"}
                </option>
                {state.printers.map((printer) => (
                  <option key={printer.deviceName} value={printer.deviceName}>
                    {printer.displayName}
                  </option>
                ))}
              </select>
            </label>

            <div className="print-settings-grid">
              <label className="print-field">
                <span>份数</span>
                <input
                  aria-label="份数"
                  type="number"
                  min={1}
                  max={999}
                  value={state.settings.output.copies}
                  onChange={(event) =>
                    updateOutput({ copies: Math.max(1, Number(event.currentTarget.value) || 1) })
                  }
                />
              </label>
              <label className="print-field">
                <span>页码范围</span>
                <select
                  aria-label="页码范围"
                  value={currentSelectionValue(state)}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value === "custom") {
                      controllerRef.current?.setPageSelection({ mode: "custom", source: "" });
                    } else if (value === "current") {
                      controllerRef.current?.setPageSelection({ mode: "current" });
                    } else {
                      controllerRef.current?.setPageSelection({ mode: "all" });
                    }
                  }}
                >
                  <option value="all">所有页</option>
                  <option value="current">当前页</option>
                  <option value="custom">自定义范围</option>
                </select>
              </label>
            </div>
            <SpatialCollapse open={Boolean(state.pageSelection.mode === "custom")} parentGap={14}>
              {state.pageSelection.mode === "custom" ? (
                <label className="print-field print-field-wide">
                  <span>自定义页码</span>
                  <input
                    aria-label="自定义页码"
                    placeholder="例如 1-3, 5"
                    value={customRangeValue(state)}
                    onChange={(event) =>
                      controllerRef.current?.setPageSelection({
                        mode: "custom",
                        source: event.currentTarget.value,
                      })
                    }
                  />
                </label>
              ) : null}
            </SpatialCollapse>
            <SpatialPresence>
              {state.pageRangeError ? (
                <p className="print-error" role="alert">
                  {state.pageRangeError}
                </p>
              ) : null}
            </SpatialPresence>

            <div className="print-settings-grid">
              <label className="print-field">
                <span>双面打印</span>
                <select
                  aria-label="双面打印"
                  value={state.settings.output.duplexMode}
                  onChange={(event) =>
                    updateOutput({
                      duplexMode: event.currentTarget.value as PrintOutputSettings["duplexMode"],
                    })
                  }
                >
                  <option value="simplex">单面</option>
                  <option value="longEdge">双面，长边翻页</option>
                  <option value="shortEdge">双面，短边翻页</option>
                </select>
              </label>
              <label className="print-field">
                <span>颜色</span>
                <select
                  aria-label="颜色"
                  value={String(state.settings.output.color)}
                  onChange={(event) =>
                    updateOutput({ color: event.currentTarget.value === "true" })
                  }
                >
                  <option value="true">彩色</option>
                  <option value="false">黑白</option>
                </select>
              </label>
              <label className="print-field">
                <span>方向</span>
                <select
                  aria-label="方向"
                  value={state.settings.layout.orientation}
                  onChange={(event) =>
                    updateLayout({
                      orientation: event.currentTarget.value as PrintLayoutSettings["orientation"],
                    })
                  }
                >
                  <option value="portrait">纵向</option>
                  <option value="landscape">横向</option>
                </select>
              </label>
              <label className="print-field">
                <span>纸张</span>
                <select
                  aria-label="纸张"
                  value={state.settings.layout.paperSize}
                  onChange={(event) =>
                    updateLayout({
                      paperSize: event.currentTarget.value as PrintLayoutSettings["paperSize"],
                    })
                  }
                >
                  {STANDARD_PAPER_SIZE_NAMES.map((paperSize) => (
                    <option key={paperSize} value={paperSize}>
                      {paperSize}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <button
              type="button"
              className="print-more-toggle"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              更多设置
            </button>

            <SpatialCollapse open={Boolean(moreOpen)} parentGap={14}>
              {
                <div className="print-more-settings">
                  <div className="print-settings-grid">
                    <label className="print-field">
                      <span>缩放</span>
                      <input
                        aria-label="缩放"
                        type="number"
                        min={10}
                        max={200}
                        value={state.settings.layout.scalePercent}
                        onChange={(event) =>
                          updateLayout({
                            scalePercent: Math.min(
                              200,
                              Math.max(10, Number(event.currentTarget.value) || 100),
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="print-field">
                      <span>每张纸页数</span>
                      <select
                        aria-label="每张纸页数"
                        value={state.settings.output.pagesPerSheet}
                        onChange={(event) =>
                          updateOutput({
                            pagesPerSheet: coercePagesPerSheet(event.currentTarget.value),
                          })
                        }
                      >
                        {PAGES_PER_SHEET_OPTIONS.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="print-field print-checkbox-field">
                      <span>逐份打印</span>
                      <input
                        aria-label="逐份打印"
                        type="checkbox"
                        disabled={state.settings.output.copies <= 1}
                        checked={state.settings.output.collate}
                        onChange={(event) => updateOutput({ collate: event.currentTarget.checked })}
                      />
                    </label>
                    <label className="print-field">
                      <span>页边距</span>
                      <select
                        aria-label="页边距"
                        value={state.settings.layout.margins.mode}
                        onChange={(event) => {
                          const mode = event.currentTarget.value;
                          updateLayout({
                            margins:
                              mode === "none"
                                ? { mode: "none" }
                                : mode === "custom"
                                  ? {
                                      mode: "custom",
                                      topMm: 15,
                                      rightMm: 15,
                                      bottomMm: 15,
                                      leftMm: 15,
                                    }
                                  : { mode: "document" },
                          });
                        }}
                      >
                        <option value="document">文档默认</option>
                        <option value="none">无</option>
                        <option value="custom">自定义</option>
                      </select>
                    </label>
                  </div>
                  <button
                    type="button"
                    className="print-link-button"
                    onClick={() => void openPrinterSettings()}
                  >
                    打开系统打印机设置
                  </button>
                </div>
              }
            </SpatialCollapse>
          </aside>

          <main className="print-preview-panel" aria-label="分页预览">
            <div className="print-preview-toolbar">
              <button
                type="button"
                disabled={state.currentPage <= 1}
                onClick={() => scrollToPage(state.currentPage - 1)}
              >
                上一页
              </button>
              <span>
                第 {state.currentPage} / {state.totalPages ?? "…"} 页
              </span>
              <button
                type="button"
                disabled={state.totalPages === null || state.currentPage >= state.totalPages}
                onClick={() => scrollToPage(state.currentPage + 1)}
              >
                下一页
              </button>
              <label>
                预览缩放
                <select
                  aria-label="预览缩放"
                  value={zoom.mode === "percent" ? zoom.value : zoom.mode}
                  onChange={(event) => {
                    if (event.currentTarget.value === "fit-page") setZoom({ mode: "fit-page" });
                    else if (event.currentTarget.value === "fit-width")
                      setZoom({ mode: "fit-width" });
                    else setZoom({ mode: "percent", value: Number(event.currentTarget.value) });
                  }}
                >
                  <option value="fit-page">适合页面</option>
                  <option value="fit-width">适合宽度</option>
                  <option value={50}>50%</option>
                  <option value={100}>100%</option>
                  <option value={150}>150%</option>
                  <option value={200}>200%</option>
                </select>
              </label>
            </div>
            <div
              className="print-preview-canvas-wrap"
              ref={previewContainerRef}
              onScroll={(event) => {
                const page = Math.min(
                  state.totalPages ?? 1,
                  Math.max(
                    1,
                    Math.floor(event.currentTarget.scrollTop / (pageSize.height + 22)) + 1,
                  ),
                );
                setVisibleStart(page);
                controllerRef.current?.goToPage(page);
              }}
            >
              {Array.from({ length: state.totalPages ?? 0 }, (_, index) => (
                <canvas
                  // biome-ignore lint/suspicious/noArrayIndexKey: page order is immutable within a preview id.
                  key={`${state.preview.previewId}:${index}`}
                  ref={(canvas) => {
                    if (canvas) canvasesRef.current.set(index + 1, canvas);
                    else canvasesRef.current.delete(index + 1);
                  }}
                  width={1}
                  height={1}
                  style={{ width: pageSize.width, height: pageSize.height }}
                  aria-label={index === 0 ? "打印预览画布" : `打印预览第 ${index + 1} 页`}
                />
              ))}
              <SpatialPresence>
                {state.preview.status === "loading" || state.preview.status === "updating" ? (
                  <div className="print-preview-overlay" role="status">
                    {state.preview.status === "updating" ? "正在更新预览……" : "正在生成预览……"}
                  </div>
                ) : null}
              </SpatialPresence>
              <SpatialView
                viewKey={String(state.preview.status === "error" && state.preview.error)}
              >
                {state.preview.status === "error" && state.preview.error ? (
                  <div className="print-preview-message" role="status">
                    {state.preview.error}
                  </div>
                ) : previewMessage ? (
                  <div className="print-preview-message" role="status">
                    {previewMessage}
                  </div>
                ) : null}
              </SpatialView>
            </div>
            <p className="print-output-note">
              输出：{state.settings.output.color ? "彩色" : "黑白"}， 每张纸{" "}
              {state.settings.output.pagesPerSheet} 页
            </p>
          </main>
        </div>
      ) : (
        <p className="print-center-loading" role="status">
          {previewMessage}
        </p>
      )}

      {pendingStructureAction
        ? createPortal(
            <StandardDialog
              open
              title="文档结构错误"
              size="s"
              dialogRole="alertdialog"
              onCancel={onClose}
              footer={
                <>
                  <button type="button" onClick={onClose}>
                    返回修改
                  </button>
                  <button
                    type="button"
                    className="standard-dialog__danger-button"
                    onClick={() => {
                      const action = pendingStructureAction;
                      setPendingStructureAction(null);
                      void (action === "print" ? runPrint(true) : runExport(true));
                    }}
                  >
                    仍然继续
                  </button>
                </>
              }
            >
              <ul className="print-structure-issues">
                {structureIssues.map((issue) => (
                  <li key={issue.id}>{issue.summary}</li>
                ))}
              </ul>
              <p>这些问题不会阻止保存。建议返回修改，也可以仅为本次操作继续。</p>
            </StandardDialog>,
            globalThis.document.body,
          )
        : null}
    </StandardDialog>
  );
}
