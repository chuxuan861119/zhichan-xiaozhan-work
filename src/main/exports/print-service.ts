import { randomUUID } from "node:crypto";
import type { BrowserWindowConstructorOptions } from "electron";
import { referencedDocumentAssetIds } from "../../shared/document/asset-references.js";
import { type CanonicalDocument, CanonicalDocumentSchema } from "../../shared/document/model.js";
import type { ExportIssue, ExportReport } from "../../shared/exports/report.js";
import {
  createDefaultPrintSettings,
  type DirectPrintRequest,
  type PrintLayoutSettings,
  PrintLayoutSettingsSchema,
  type PrintOutputSettings,
  PrintOutputSettingsSchema,
} from "../../shared/printing/model.js";
import type { AssetStore, StoredAsset } from "../assets/asset-store.js";
import { writeExportFile } from "../platform/atomic-export-write.js";
import { isAllowedPrintNavigationUrl } from "../security.js";
import type { PrintDocumentLease } from "./print-document-store.js";
import {
  PrintCancelledError,
  PrintDriverSettingsError,
  PrintPreviewUnavailableError,
  PrintPrinterUnavailableError,
  PrintTimeoutError,
} from "./print-error.js";
import { preparePrintFonts } from "./print-font-jobs.js";
import { renderPrintDocumentsHtml, renderPrintHtml } from "./print-template.js";

export type PrintJobRequest = {
  sessionId: string;
  document: CanonicalDocument;
  layout?: PrintLayoutSettings;
  patentBookLayout?: boolean;
  documents?: CanonicalDocument[];
  figureLabels?: Record<string, string>;
};

export type CachedPrintPreview = {
  previewId: string;
  bytes: Uint8Array;
};

export type PrintWebContents = {
  once(event: string, listener: (...args: unknown[]) => void): void;
  on(event: string, listener: (event: { preventDefault(): void }) => void): void;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  executeJavaScript(source: string, userGesture: boolean): Promise<unknown>;
  printToPDF(options: PrintToPdfOptions | HtmlPrintToPdfOptions): Promise<Buffer>;
  print(
    options: PrintOptions | SystemPrintOptions,
    callback: (success: boolean, failureReason: string) => void,
  ): void;
};

export type PrintWindow = {
  webContents: PrintWebContents;
  loadURL(url: string): Promise<unknown>;
  destroy(): void;
};

export type PrintServiceDependencies = {
  createWindow(options: BrowserWindowConstructorOptions): PrintWindow;
  createPrintDocument(html: string): PrintDocumentLease;
  renderHtml(
    document: CanonicalDocument,
    assets: readonly StoredAsset[],
    layout: PrintLayoutSettings,
    options?: { patentBookLayout: boolean },
  ): Promise<string>;
  atomicWrite(path: string, bytes: Uint8Array): Promise<unknown>;
  createPreviewId(): string;
  now(): number;
  scheduleExpiry(callback: () => void, delayMs: number): () => void;
  limits: PrintServiceLimits;
};

export type PrintServiceLimits = {
  maxCachedPreviews: number;
  maxPreviewBytes: number;
  maxTotalPreviewBytes: number;
  maxConcurrentJobs: number;
};

type PreviewCacheEntry = {
  sessionId: string;
  document: CanonicalDocument;
  layout: PrintLayoutSettings;
  bytes: Uint8Array;
  expiresAt: number;
  cancelExpiry: () => void;
  saving: boolean;
  printing: boolean;
  deleteAfterUse: boolean;
};

type PrintSnapshot = {
  sessionId: string;
  document: CanonicalDocument;
  layout: PrintLayoutSettings;
  patentBookLayout?: boolean;
  documents?: CanonicalDocument[];
  figureLabels?: Record<string, string>;
};

type PrintToPdfOptions = {
  landscape: boolean;
  pageSize: PrintLayoutSettings["paperSize"];
  printBackground: true;
  preferCSSPageSize: true;
  scale: number;
};

type HtmlPrintToPdfOptions = {
  printBackground: true;
  preferCSSPageSize: true;
};

type SystemPrintOptions = {
  silent: boolean;
  printBackground: boolean;
};

type PrintOptions = {
  silent: boolean;
  printBackground: boolean;
  deviceName?: string;
  color: boolean;
  margins: { marginType: "none" };
  landscape: boolean;
  scaleFactor: number;
  pagesPerSheet: number;
  collate: boolean;
  copies: number;
  pageRanges?: Array<{ from: number; to: number }>;
  duplexMode: PrintOutputSettings["duplexMode"];
  pageSize: PrintLayoutSettings["paperSize"];
};

const PREVIEW_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_LIMITS: PrintServiceLimits = {
  maxCachedPreviews: 8,
  maxPreviewBytes: 64 * 1024 * 1024,
  maxTotalPreviewBytes: 128 * 1024 * 1024,
  maxConcurrentJobs: 2,
};

const WINDOW_OPTIONS: BrowserWindowConstructorOptions = {
  show: false,
  webPreferences: {
    backgroundThrottling: false,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    devTools: false,
  },
};

async function withPrintTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PrintTimeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const defaultDependencies: Omit<PrintServiceDependencies, "createWindow" | "createPrintDocument"> =
  {
    renderHtml: renderPrintHtml,
    atomicWrite: (path, bytes) => writeExportFile(path, Buffer.from(bytes)),
    createPreviewId: randomUUID,
    now: Date.now,
    scheduleExpiry: (callback, delayMs) => {
      const timeout = setTimeout(callback, delayMs);
      timeout.unref();
      return () => clearTimeout(timeout);
    },
    limits: DEFAULT_LIMITS,
  };

async function loadPrintDocument(window: PrintWindow, url: string): Promise<void> {
  if (!isAllowedPrintNavigationUrl(url)) throw new Error("打印视图地址无效。");
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const loaded = new Promise<void>((resolve, reject) => {
    window.webContents.once("did-finish-load", () => resolve());
    window.webContents.once("did-fail-load", (...args) => {
      const description = typeof args[2] === "string" ? args[2] : "打印视图加载失败。";
      reject(new Error(description));
    });
  });
  await Promise.all([window.loadURL(url), loaded]);
  await window.webContents.executeJavaScript("document.fonts.ready.then(() => true)", true);
}

function handlePrintCallback(
  resolve: () => void,
  reject: (error: Error) => void,
  success: boolean,
  failureReason: string,
): void {
  if (success) {
    resolve();
    return;
  }

  if (failureReason === "Print job canceled") {
    reject(new PrintCancelledError());
    return;
  }

  if (failureReason === "Invalid printer settings") {
    reject(new PrintDriverSettingsError(failureReason));
    return;
  }

  reject(new Error(failureReason || "打印失败。"));
}

function runPrint(window: PrintWindow, options: PrintOptions | SystemPrintOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    window.webContents.print(options, (success, failureReason) => {
      if (settled) return;
      settled = true;
      handlePrintCallback(resolve, reject, success, failureReason);
    });
  });
}

function runSystemPrint(window: PrintWindow): Promise<void> {
  return runPrint(window, { silent: false, printBackground: true });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;

  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }

  return value;
}

function cloneDocument(document: CanonicalDocument): CanonicalDocument {
  return deepFreeze(CanonicalDocumentSchema.parse(structuredClone(document)));
}

function cloneLayout(
  document: CanonicalDocument,
  layout: PrintLayoutSettings | undefined,
): PrintLayoutSettings {
  const fallbackLayout = createDefaultPrintSettings(document.page).layout;
  return deepFreeze(PrintLayoutSettingsSchema.parse(structuredClone(layout ?? fallbackLayout)));
}

function toPreviewPdfOptions(layout: PrintLayoutSettings): PrintToPdfOptions {
  return {
    landscape: layout.orientation === "landscape",
    pageSize: layout.paperSize,
    printBackground: true,
    preferCSSPageSize: true,
    scale: layout.scalePercent / 100,
  };
}

function toPrintOptions(layout: PrintLayoutSettings, output: PrintOutputSettings): PrintOptions {
  return {
    silent: true,
    printBackground: true,
    ...(output.printerDeviceName ? { deviceName: output.printerDeviceName } : {}),
    color: output.color,
    margins: { marginType: "none" },
    landscape: layout.orientation === "landscape",
    scaleFactor: layout.scalePercent,
    pagesPerSheet: output.pagesPerSheet,
    collate: output.collate,
    copies: output.copies,
    ...(output.pageRanges ? { pageRanges: output.pageRanges.map((range) => ({ ...range })) } : {}),
    duplexMode: output.duplexMode,
    pageSize: layout.paperSize,
  };
}

function toPrinterNameSet(
  availablePrinterNames: ReadonlySet<string> | readonly string[],
): Set<string> {
  return availablePrinterNames instanceof Set
    ? new Set(availablePrinterNames)
    : new Set(availablePrinterNames);
}

export class PrintService {
  readonly #dependencies: PrintServiceDependencies;
  readonly #previewCache = new Map<string, PreviewCacheEntry>();
  readonly #sessionPreviewIds = new Map<string, string>();
  readonly #activeSessions = new Set<string>();
  #activeJobCount = 0;
  #cachedPreviewBytes = 0;

  constructor(
    private readonly assetStore: AssetStore,
    dependencies: Pick<PrintServiceDependencies, "createWindow" | "createPrintDocument"> &
      Partial<Omit<PrintServiceDependencies, "createWindow" | "createPrintDocument" | "limits">> & {
        limits?: Partial<PrintServiceLimits>;
      },
  ) {
    this.#dependencies = {
      ...defaultDependencies,
      ...dependencies,
      limits: { ...DEFAULT_LIMITS, ...dependencies.limits },
    };
  }

  #createSnapshot(request: PrintJobRequest): PrintSnapshot {
    const document = cloneDocument(request.document);
    const layout = cloneLayout(document, request.layout);
    return {
      sessionId: request.sessionId,
      document,
      layout,
      ...(request.documents ? { documents: request.documents.map(cloneDocument) } : {}),
      ...(request.figureLabels ? { figureLabels: structuredClone(request.figureLabels) } : {}),
      ...(request.patentBookLayout ? { patentBookLayout: true } : {}),
    };
  }

  async #withWindow<T>(
    snapshot: PrintSnapshot,
    operation: (window: PrintWindow) => Promise<T>,
  ): Promise<T> {
    this.#beginJob(snapshot.sessionId);
    let printDocument: PrintDocumentLease | undefined;
    let window: PrintWindow | undefined;
    try {
      const assets = [];
      for (const assetId of new Set(
        (snapshot.documents ?? [snapshot.document]).flatMap(referencedDocumentAssetIds),
      )) {
        const asset = await this.assetStore.getOrLoad(snapshot.sessionId, assetId);
        if (asset) assets.push(asset);
      }
      const html =
        snapshot.documents || snapshot.figureLabels
          ? await renderPrintDocumentsHtml(
              snapshot.documents ?? [snapshot.document],
              assets,
              snapshot.layout,
              snapshot.figureLabels,
            )
          : snapshot.patentBookLayout
            ? await this.#dependencies.renderHtml(snapshot.document, assets, snapshot.layout, {
                patentBookLayout: true,
              })
            : await this.#dependencies.renderHtml(snapshot.document, assets, snapshot.layout);
      printDocument = this.#dependencies.createPrintDocument(await preparePrintFonts(html));
      window = this.#dependencies.createWindow(WINDOW_OPTIONS);
      await withPrintTimeout(
        loadPrintDocument(window, printDocument.url),
        30_000,
        "打印视图加载超时，请重试。",
      );
      return await operation(window);
    } finally {
      window?.destroy();
      printDocument?.dispose();
      this.#endJob(snapshot.sessionId);
    }
  }

  async #withHtmlWindow<T>(
    sessionId: string,
    html: string,
    operation: (window: PrintWindow) => Promise<T>,
  ): Promise<T> {
    this.#beginJob(sessionId);
    let printDocument: PrintDocumentLease | undefined;
    let window: PrintWindow | undefined;
    try {
      printDocument = this.#dependencies.createPrintDocument(await preparePrintFonts(html));
      window = this.#dependencies.createWindow(WINDOW_OPTIONS);
      await withPrintTimeout(
        loadPrintDocument(window, printDocument.url),
        30_000,
        "打印视图加载超时，请重试。",
      );
      return await operation(window);
    } finally {
      window?.destroy();
      printDocument?.dispose();
      this.#endJob(sessionId);
    }
  }

  async #createPdfFromSnapshot(snapshot: PrintSnapshot): Promise<Uint8Array> {
    return this.#withWindow(snapshot, async (window) => {
      const bytes = await withPrintTimeout(
        window.webContents.printToPDF(toPreviewPdfOptions(snapshot.layout)),
        120_000,
        "PDF 生成超时，请重试或分文档导出。",
      );
      if (Buffer.from(bytes).subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("PDF 输出无效。");
      }
      return bytes;
    });
  }

  async createPdf(request: PrintJobRequest): Promise<Uint8Array> {
    return this.#createPdfFromSnapshot(this.#createSnapshot(request));
  }

  async createHtmlPdf(sessionId: string, html: string): Promise<Uint8Array> {
    return this.#withHtmlWindow(sessionId, html, async (window) => {
      const bytes = await withPrintTimeout(
        window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }),
        120_000,
        "PDF 生成超时，请重试或分文档导出。",
      );
      if (Buffer.from(bytes).subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("PDF 输出无效。");
      }
      return bytes;
    });
  }

  async createPreview(request: PrintJobRequest): Promise<CachedPrintPreview> {
    const currentPreviewId = this.#sessionPreviewIds.get(request.sessionId);
    if (currentPreviewId && this.#previewCache.get(currentPreviewId)?.saving) {
      throw new Error("当前打印预览正在保存，请稍候。");
    }
    const snapshot = this.#createSnapshot(request);
    const bytes = await this.#createPdfFromSnapshot(snapshot);
    if (bytes.byteLength > this.#dependencies.limits.maxPreviewBytes) {
      throw new Error("PDF 文件过大，无法创建打印预览。");
    }
    this.#pruneExpiredPreviews();
    const oldPreviewId = this.#sessionPreviewIds.get(request.sessionId);
    if (oldPreviewId && this.#previewCache.get(oldPreviewId)?.saving) {
      throw new Error("当前打印预览正在保存，请稍候。");
    }
    if (oldPreviewId) this.#deletePreview(oldPreviewId);
    while (
      this.#previewCache.size >= this.#dependencies.limits.maxCachedPreviews ||
      this.#cachedPreviewBytes + bytes.byteLength > this.#dependencies.limits.maxTotalPreviewBytes
    ) {
      const oldestPreviewId = [...this.#previewCache].find(
        ([, preview]) => !this.#isPreviewBusy(preview),
      )?.[0];
      if (!oldestPreviewId) break;
      this.#deletePreview(oldestPreviewId);
    }
    if (this.#previewCache.size >= this.#dependencies.limits.maxCachedPreviews) {
      throw new Error("打印预览缓存已满，请等待当前保存完成后重试。");
    }
    if (
      this.#cachedPreviewBytes + bytes.byteLength >
      this.#dependencies.limits.maxTotalPreviewBytes
    ) {
      throw new Error("PDF 文件过大，无法放入打印预览缓存。");
    }
    const previewId = this.#dependencies.createPreviewId();
    if (this.#previewCache.has(previewId)) throw new Error("打印预览标识冲突。");
    const entry: PreviewCacheEntry = {
      sessionId: snapshot.sessionId,
      document: snapshot.document,
      layout: snapshot.layout,
      bytes,
      expiresAt: this.#dependencies.now() + PREVIEW_TTL_MS,
      cancelExpiry: () => undefined,
      saving: false,
      printing: false,
      deleteAfterUse: false,
    };
    this.#previewCache.set(previewId, entry);
    this.#cachedPreviewBytes += bytes.byteLength;
    this.#sessionPreviewIds.set(request.sessionId, previewId);
    this.#armPreviewExpiry(previewId, entry);
    return { previewId, bytes };
  }

  async savePreviewPdf(outputPath: string, previewId: string): Promise<ExportReport> {
    this.#pruneExpiredPreviews();
    const preview = this.#previewCache.get(previewId);
    if (!preview) throw new Error("打印预览已失效，请重新生成预览。");
    if (preview.saving) throw new Error("打印预览正在保存，请稍候。");
    preview.cancelExpiry();
    preview.cancelExpiry = () => undefined;
    preview.saving = true;
    try {
      await this.#dependencies.atomicWrite(outputPath, preview.bytes);
    } catch (error) {
      if (this.#previewCache.get(previewId) === preview) {
        preview.saving = false;
        if (preview.deleteAfterUse) {
          this.#deletePreview(previewId, true);
        } else {
          preview.expiresAt = this.#dependencies.now() + PREVIEW_TTL_MS;
          this.#armPreviewExpiry(previewId, preview);
        }
      }
      throw error;
    }
    this.#deletePreview(previewId, true);
    return { format: "pdf", outputPath, issues: [] };
  }

  getPreviewSessionId(previewId: string): string | undefined {
    this.#pruneExpiredPreviews();
    return this.#previewCache.get(previewId)?.sessionId;
  }

  discardPreview(previewId: string): void {
    this.#deletePreview(previewId);
  }

  releaseSession(sessionId: string): void {
    const previewId = this.#sessionPreviewIds.get(sessionId);
    if (previewId) this.#deletePreview(previewId);
  }

  async savePdf(outputPath: string, request: PrintJobRequest): Promise<ExportReport> {
    const bytes = await this.createPdf(request);
    await this.#dependencies.atomicWrite(outputPath, bytes);
    return { format: "pdf", outputPath, issues: [] };
  }

  async saveHtmlPdf(
    outputPath: string,
    sessionId: string,
    html: string,
    issues: ExportIssue[] = [],
  ): Promise<ExportReport> {
    const bytes = await this.createHtmlPdf(sessionId, html);
    await this.#dependencies.atomicWrite(outputPath, bytes);
    return { format: "pdf", outputPath, issues: structuredClone(issues) };
  }

  async print(request: PrintJobRequest): Promise<void> {
    await this.#withWindow(this.#createSnapshot(request), runSystemPrint);
  }

  async printHtmlConfigured(
    sessionId: string,
    html: string,
    layoutInput: PrintLayoutSettings,
    outputInput: PrintOutputSettings,
    availablePrinterNames: readonly string[],
    beforeSubmit: () => void,
  ): Promise<void> {
    const layout = PrintLayoutSettingsSchema.parse(layoutInput);
    const output = PrintOutputSettingsSchema.parse(outputInput);
    if (!output.printerDeviceName || !availablePrinterNames.includes(output.printerDeviceName))
      throw new PrintPrinterUnavailableError(output.printerDeviceName ?? "");
    await this.#withHtmlWindow(sessionId, html, async (window) => {
      beforeSubmit();
      await runPrint(window, toPrintOptions(layout, output));
    });
  }

  async printCached(
    request: DirectPrintRequest,
    availablePrinterNames: ReadonlySet<string> | readonly string[],
  ): Promise<void> {
    this.#pruneExpiredPreviews();
    const preview = this.#previewCache.get(request.previewId);
    if (!preview || preview.sessionId !== request.sessionId) {
      throw new PrintPreviewUnavailableError();
    }
    if (preview.printing) throw new Error("当前打印预览正在打印，请稍候。");
    const printerNames = toPrinterNameSet(availablePrinterNames);
    if (request.output.printerDeviceName && !printerNames.has(request.output.printerDeviceName)) {
      throw new PrintPrinterUnavailableError(request.output.printerDeviceName);
    }

    preview.cancelExpiry();
    preview.cancelExpiry = () => undefined;
    preview.printing = true;
    try {
      await this.#withWindow(preview, (window) =>
        runPrint(window, toPrintOptions(preview.layout, request.output)),
      );
    } catch (error) {
      if (this.#previewCache.get(request.previewId) === preview) {
        preview.printing = false;
        if (preview.deleteAfterUse) {
          this.#deletePreview(request.previewId, true);
        } else {
          preview.expiresAt = this.#dependencies.now() + PREVIEW_TTL_MS;
          this.#armPreviewExpiry(request.previewId, preview);
        }
      }
      throw error;
    }

    if (this.#previewCache.get(request.previewId) === preview) {
      preview.printing = false;
      if (preview.deleteAfterUse) {
        this.#deletePreview(request.previewId, true);
      } else {
        preview.expiresAt = this.#dependencies.now() + PREVIEW_TTL_MS;
        this.#armPreviewExpiry(request.previewId, preview);
      }
    }
  }

  #pruneExpiredPreviews(): void {
    const now = this.#dependencies.now();
    for (const [previewId, preview] of this.#previewCache) {
      if (!this.#isPreviewBusy(preview) && preview.expiresAt <= now) {
        this.#deletePreview(previewId);
      }
    }
  }

  #deletePreview(previewId: string, force = false): void {
    const preview = this.#previewCache.get(previewId);
    if (!preview) return;
    if (this.#isPreviewBusy(preview) && !force) {
      preview.deleteAfterUse = true;
      return;
    }
    this.#previewCache.delete(previewId);
    preview.cancelExpiry();
    this.#cachedPreviewBytes -= preview.bytes.byteLength;
    if (this.#sessionPreviewIds.get(preview.sessionId) === previewId) {
      this.#sessionPreviewIds.delete(preview.sessionId);
    }
  }

  #isPreviewBusy(preview: PreviewCacheEntry): boolean {
    return preview.saving || preview.printing;
  }

  #armPreviewExpiry(previewId: string, preview: PreviewCacheEntry): void {
    preview.cancelExpiry = this.#dependencies.scheduleExpiry(() => {
      if (this.#previewCache.get(previewId) !== preview || this.#isPreviewBusy(preview)) return;
      this.#deletePreview(previewId, true);
    }, PREVIEW_TTL_MS);
  }

  #beginJob(sessionId: string): void {
    if (this.#activeSessions.has(sessionId)) {
      throw new Error("此文档已有打印任务正在进行。");
    }
    if (this.#activeJobCount >= this.#dependencies.limits.maxConcurrentJobs) {
      throw new Error("打印任务繁忙，请稍后重试。");
    }
    this.#activeSessions.add(sessionId);
    this.#activeJobCount += 1;
  }

  #endJob(sessionId: string): void {
    this.#activeSessions.delete(sessionId);
    this.#activeJobCount = Math.max(0, this.#activeJobCount - 1);
  }
}
