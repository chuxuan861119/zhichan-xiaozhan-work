import type { CanonicalDocument } from "../../../shared/document/model";
import type { PrintPreview, PrintPreviewRequest } from "../../../shared/ipc/contract";
import type { AppResult } from "../../../shared/ipc/result";
import {
  createDefaultPrintSettings,
  type PrinterDescriptor,
  type PrintLayoutSettings,
  PrintLayoutSettingsSchema,
  type PrintOutputSettings,
  type PrintPreferences,
  type PrintSettings,
} from "../../../shared/printing/model";
import { type PageRangeSelection, resolvePageRanges } from "../../../shared/printing/page-range";

type PreviewStatus = "idle" | "loading" | "updating" | "ready" | "error";

export type PrintCenterPreviewState = {
  status: PreviewStatus;
  previewId: string | null;
  bytes: Uint8Array | null;
  error: string | null;
};

export type PrintCenterState = {
  scope: "current" | "all";
  sessionId: string;
  document: CanonicalDocument;
  suggestedName: string;
  printers: PrinterDescriptor[];
  settings: PrintSettings;
  pageSelection: PageRangeSelection;
  pageRangeError: string | null;
  currentPage: number;
  totalPages: number | null;
  preview: PrintCenterPreviewState;
  canPrint: boolean;
  printDisabledReason: string | null;
  missingRememberedPrinterName: string | null;
  closed: boolean;
};

export type PrintCenterControllerOptions = {
  documents?: CanonicalDocument[];
  figureLabels?: Record<string, string>;
  combinedSuggestedName?: string;
  sessionId: string;
  targetId: string;
  document: CanonicalDocument;
  suggestedName: string;
  preferences: PrintPreferences;
  printers: PrinterDescriptor[];
  preview(request: PrintPreviewRequest): Promise<AppResult<PrintPreview>>;
  discardPreview(previewId: string): Promise<AppResult<void>>;
  debounceMs?: number;
};

export type PrintCenterController = {
  setScope(scope: "current" | "all"): void;
  getState(): PrintCenterState;
  subscribe(listener: (state: PrintCenterState) => void): () => void;
  start(): void;
  updateLayout(patch: Partial<PrintLayoutSettings>): void;
  updateOutput(patch: Partial<PrintOutputSettings>): void;
  setPageSelection(selection: PageRangeSelection): void;
  setTotalPages(totalPages: number): void;
  goToPage(pageNumber: number): void;
  close(): void;
};

const DEFAULT_DEBOUNCE_MS = 250;

function rememberedPrinterMissing(
  printerDeviceName: string | null,
  printers: readonly PrinterDescriptor[],
): boolean {
  return (
    printerDeviceName !== null &&
    !printers.some((printer) => printer.deviceName === printerDeviceName)
  );
}

function printerAvailable(state: PrintCenterState): boolean {
  if (state.printers.length === 0) return false;
  const selectedPrinter = state.settings.output.printerDeviceName;
  return (
    selectedPrinter === null ||
    state.printers.some((printer) => printer.deviceName === selectedPrinter)
  );
}

function disabledReason(state: PrintCenterState): string | null {
  if (state.closed) return "打印窗口已关闭。";
  if (!printerAvailable(state)) return "没有可用打印机。";
  if (state.preview.status === "loading") return "正在生成预览。";
  if (state.preview.status === "updating") return "正在更新预览。";
  if (state.preview.status === "error") return state.preview.error ?? "预览生成失败。";
  if (state.preview.status !== "ready") return "预览尚未就绪。";
  if (state.totalPages === null) return "正在读取 PDF 页数。";
  if (state.pageRangeError) return state.pageRangeError;
  return null;
}

function recomputePageRanges(state: PrintCenterState): void {
  if (state.totalPages === null) {
    state.pageRangeError = null;
    if (state.pageSelection.mode === "all") state.settings.output.pageRanges = undefined;
    return;
  }

  const result = resolvePageRanges(state.pageSelection, state.currentPage, state.totalPages);
  if (!result.ok) {
    state.pageRangeError = result.error;
    state.settings.output.pageRanges = undefined;
    return;
  }

  state.pageRangeError = null;
  state.settings.output.pageRanges = result.pageRanges;
}

function recomputePrintAvailability(state: PrintCenterState): void {
  recomputePageRanges(state);
  state.printDisabledReason = disabledReason(state);
  state.canPrint = state.printDisabledReason === null;
}

function clampPage(pageNumber: number, totalPages: number | null): number {
  const upper = totalPages ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(1, Math.trunc(pageNumber)), upper);
}

function initialState(options: PrintCenterControllerOptions): PrintCenterState {
  const settings = createDefaultPrintSettings(options.document.page, options.preferences);
  const documentLayout = createDefaultPrintSettings(options.document.page).layout;
  settings.layout.paperSize = documentLayout.paperSize;
  settings.layout.orientation =
    options.document.page.widthMm > options.document.page.heightMm ? "landscape" : "portrait";
  const missingRememberedPrinterName = rememberedPrinterMissing(
    settings.output.printerDeviceName,
    options.printers,
  )
    ? settings.output.printerDeviceName
    : null;
  if (missingRememberedPrinterName) settings.output.printerDeviceName = null;

  const state: PrintCenterState = {
    scope: "current",
    sessionId: options.sessionId,
    document: options.document,
    suggestedName: options.suggestedName,
    printers: [...options.printers],
    settings,
    pageSelection: { mode: "all" },
    pageRangeError: null,
    currentPage: 1,
    totalPages: null,
    preview: {
      status: "idle",
      previewId: null,
      bytes: null,
      error: null,
    },
    canPrint: false,
    printDisabledReason: null,
    missingRememberedPrinterName,
    closed: false,
  };
  recomputePrintAvailability(state);
  return state;
}

class PrintCenterControllerImpl implements PrintCenterController {
  readonly #options: PrintCenterControllerOptions;
  readonly #debounceMs: number;
  #state: PrintCenterState;
  #started = false;
  #layoutVersion = 0;
  #inFlight = false;
  #queued = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #listeners = new Set<(state: PrintCenterState) => void>();

  constructor(options: PrintCenterControllerOptions) {
    this.#options = options;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#state = initialState(options);
  }

  getState(): PrintCenterState {
    return this.#state;
  }

  subscribe(listener: (state: PrintCenterState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  start(): void {
    if (this.#started || this.#state.closed) return;
    this.#started = true;
    void this.#requestPreviewNow();
  }

  updateLayout(patch: Partial<PrintLayoutSettings>): void {
    if (this.#state.closed) return;
    this.#state.settings.layout = PrintLayoutSettingsSchema.parse({
      ...this.#state.settings.layout,
      ...patch,
    });
    this.#layoutVersion += 1;
    this.#state.preview.status = this.#state.preview.previewId ? "updating" : "loading";
    this.#state.preview.error = null;
    recomputePrintAvailability(this.#state);
    this.#emit();
    this.#schedulePreviewRefresh();
  }

  setScope(scope: "current" | "all"): void {
    if (this.#state.closed || scope === this.#state.scope) return;
    if (scope === "all" && !this.#options.documents?.length) return;
    this.#state.scope = scope;
    this.#state.suggestedName =
      scope === "all"
        ? (this.#options.combinedSuggestedName ?? this.#options.suggestedName)
        : this.#options.suggestedName;
    this.#state.currentPage = 1;
    this.#state.totalPages = null;
    this.#state.pageSelection = { mode: "all" };
    this.#state.settings.output.pageRanges = undefined;
    this.updateLayout({});
  }

  updateOutput(patch: Partial<PrintOutputSettings>): void {
    if (this.#state.closed) return;
    this.#state.settings.output = { ...this.#state.settings.output, ...patch };
    recomputePrintAvailability(this.#state);
    this.#emit();
  }

  setPageSelection(selection: PageRangeSelection): void {
    if (this.#state.closed) return;
    this.#state.pageSelection = selection;
    recomputePrintAvailability(this.#state);
    this.#emit();
  }

  setTotalPages(totalPages: number): void {
    if (this.#state.closed) return;
    if (!Number.isInteger(totalPages) || totalPages < 1) return;
    this.#state.totalPages = totalPages;
    this.#state.currentPage = clampPage(this.#state.currentPage, totalPages);
    recomputePrintAvailability(this.#state);
    this.#emit();
  }

  goToPage(pageNumber: number): void {
    if (this.#state.closed) return;
    this.#state.currentPage = clampPage(pageNumber, this.#state.totalPages);
    recomputePrintAvailability(this.#state);
    this.#emit();
  }

  close(): void {
    if (this.#state.closed) return;
    this.#state.closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const previewId = this.#state.preview.previewId;
    if (previewId) void this.#options.discardPreview(previewId);
    recomputePrintAvailability(this.#state);
    this.#emit();
  }

  #schedulePreviewRefresh(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#inFlight) {
        this.#queued = true;
        return;
      }
      void this.#requestPreviewNow();
    }, this.#debounceMs);
  }

  async #requestPreviewNow(): Promise<void> {
    if (this.#state.closed) return;
    if (this.#inFlight) {
      this.#queued = true;
      return;
    }

    this.#inFlight = true;
    const version = this.#layoutVersion;
    const request: PrintPreviewRequest = {
      sessionId: this.#state.sessionId,
      targetId: this.#options.targetId,
      document: this.#state.document,
      suggestedName: this.#state.suggestedName,
      layout: this.#state.settings.layout,
      ...(this.#state.scope === "all" && this.#options.documents
        ? { documents: this.#options.documents }
        : {}),
      ...(this.#options.figureLabels ? { figureLabels: this.#options.figureLabels } : {}),
    };
    this.#state.preview.status = this.#state.preview.previewId ? "updating" : "loading";
    this.#state.preview.error = null;
    recomputePrintAvailability(this.#state);
    this.#emit();

    try {
      const result = await this.#options.preview(request);
      if (this.#state.closed) {
        if (result.ok) void this.#options.discardPreview(result.value.previewId);
        return;
      }

      if (version !== this.#layoutVersion) {
        if (result.ok) void this.#options.discardPreview(result.value.previewId);
        return;
      }

      if (!result.ok) {
        this.#state.preview.status = "error";
        this.#state.preview.error = result.error.message;
        this.#emit();
        return;
      }

      const previousPreviewId = this.#state.preview.previewId;
      this.#state.preview = {
        status: "ready",
        previewId: result.value.previewId,
        bytes: Uint8Array.from(result.value.bytes),
        error: null,
      };
      if (previousPreviewId && previousPreviewId !== result.value.previewId) {
        void this.#options.discardPreview(previousPreviewId);
      }
      this.#emit();
    } catch {
      if (!this.#state.closed && version === this.#layoutVersion) {
        this.#state.preview.status = "error";
        this.#state.preview.error = "预览生成失败。";
        this.#emit();
      }
    } finally {
      this.#inFlight = false;
      recomputePrintAvailability(this.#state);
      this.#emit();
      if (!this.#state.closed && this.#queued) {
        this.#queued = false;
        void this.#requestPreviewNow();
      }
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#state);
  }
}

export function createPrintCenterController(
  options: PrintCenterControllerOptions,
): PrintCenterController {
  return new PrintCenterControllerImpl(options);
}
