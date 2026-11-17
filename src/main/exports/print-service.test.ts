import { createChemicalContentPayload } from "../../../tests/fixtures/chemical-content.js";
import { createBlankDocument } from "../../shared/document/defaults.js";
import type { CanonicalDocument, ParagraphNode } from "../../shared/document/model.js";
import type {
  DirectPrintRequest,
  PrintLayoutSettings,
  PrintOutputSettings,
} from "../../shared/printing/model.js";
import { createDefaultPrintSettings } from "../../shared/printing/model.js";
import type { AssetStore } from "../assets/asset-store.js";
import { PrintService, type PrintWindow } from "./print-service.js";

// Font payload/rendering has its own tests; retaining a full font copy per mock
// print job would obscure the queue/lifecycle behavior under test here.
vi.mock("./print-font-jobs.js", () => ({
  preparePrintFonts: async (html: string) => html,
}));

type HarnessOptions = {
  pdfError?: Error;
  loadError?: Error;
  printSuccess?: boolean;
  printFailureReason?: string;
  html?: string;
  limits?: {
    maxCachedPreviews?: number;
    maxPreviewBytes?: number;
    maxTotalPreviewBytes?: number;
    maxConcurrentJobs?: number;
  };
};

test("configured HTML printing uses a hidden explicit printer and checks authorization immediately before submission", async () => {
  const h = harness();
  const output = { ...createDefaultPrintSettings().output, printerDeviceName: "fixture-printer" };
  const beforeSubmit = vi.fn((): void => {
    throw new Error("revoked");
  });
  await expect(
    h.service.printHtmlConfigured(
      "job",
      "<html></html>",
      h.request.layout,
      output,
      ["fixture-printer"],
      beforeSubmit,
    ),
  ).rejects.toThrow("revoked");
  expect(h.window.webContents.print).not.toHaveBeenCalled();
  beforeSubmit.mockImplementation(() => {});
  await h.service.printHtmlConfigured(
    "job",
    "<html></html>",
    h.request.layout,
    output,
    ["fixture-printer"],
    beforeSubmit,
  );
  expect(h.window.webContents.print).toHaveBeenCalledWith(
    expect.objectContaining({ silent: true, deviceName: "fixture-printer", copies: 1 }),
    expect.any(Function),
  );
  expect(h.createWindow).toHaveBeenCalledWith(expect.objectContaining({ show: false }));
  await expect(
    h.service.printHtmlConfigured(
      "job",
      "<html></html>",
      h.request.layout,
      output,
      [],
      beforeSubmit,
    ),
  ).rejects.toThrow();
});

function harness(options: HarnessOptions = {}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const webContents = {
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    executeJavaScript: vi.fn().mockResolvedValue(true),
    printToPDF: options.pdfError
      ? vi.fn().mockRejectedValue(options.pdfError)
      : vi.fn().mockResolvedValue(Buffer.from("%PDF-1.7\nfixture")),
    print: vi.fn(
      (_printOptions: unknown, callback: (success: boolean, failureReason: string) => void) =>
        callback(options.printSuccess ?? true, options.printFailureReason ?? ""),
    ),
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const window = {
    webContents,
    loadURL: vi.fn(async (_url: string) => {
      if (options.loadError) {
        listeners.get("did-fail-load")?.({}, -3, options.loadError.message);
        throw options.loadError;
      }
      listeners.get("did-finish-load")?.();
    }),
    destroy: vi.fn(),
  } satisfies PrintWindow;
  const createWindow = vi.fn(() => window);
  const renderHtml = vi
    .fn()
    .mockResolvedValue(options.html ?? "<!doctype html><html><body>专利</body></html>");
  const atomicWrite = vi.fn().mockResolvedValue(undefined);
  const createPreviewId = vi.fn(() => "preview-token-1");
  const now = vi.fn(() => 1_000);
  const disposePrintDocument = vi.fn();
  const createPrintDocument = vi.fn((_html: string) => ({
    url: "patent-print://job/5d5c49f1-5f4c-4e70-9326-dd7e17d68a41",
    dispose: disposePrintDocument,
  }));
  const scheduledExpiries: Array<{ callback: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
  const scheduleExpiry = vi.fn((callback: () => void) => {
    const cancel = vi.fn();
    scheduledExpiries.push({ callback, cancel });
    return cancel;
  });
  const get = vi.fn();
  const assetStore = {
    list: vi.fn().mockReturnValue([]),
    get,
    getOrLoad: vi.fn(async (sessionId: string, assetId: string) => get(sessionId, assetId)),
  } as unknown as AssetStore;
  const service = new PrintService(assetStore, {
    createWindow,
    renderHtml,
    atomicWrite,
    createPreviewId,
    now,
    createPrintDocument,
    scheduleExpiry,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  const layout: PrintLayoutSettings = {
    ...createDefaultPrintSettings().layout,
    orientation: "landscape",
    paperSize: "Letter",
    scalePercent: 125,
  };
  const request = {
    sessionId: "print-session",
    document: createBlankDocument("打印参考文档") as CanonicalDocument,
    layout,
  };
  return {
    service,
    request,
    createWindow,
    renderHtml,
    atomicWrite,
    createPreviewId,
    now,
    createPrintDocument,
    disposePrintDocument,
    scheduledExpiries,
    assetStore,
    window,
    webContents,
  };
}

describe("print service", () => {
  test.each(["document", "html"])(
    "%s PDF timeout releases the window and session without writing late results",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const h = harness();
        let resolvePdf!: (bytes: Buffer) => void;
        h.webContents.printToPDF.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePdf = resolve;
            }),
        );
        const saving =
          mode === "html"
            ? h.service.saveHtmlPdf("unused.pdf", h.request.sessionId, "<html></html>")
            : h.service.savePdf("unused.pdf", h.request);
        const rejected = expect(saving).rejects.toThrow("PDF 生成超时");
        await vi.advanceTimersByTimeAsync(120_001);
        await rejected;
        expect(h.window.destroy).toHaveBeenCalledOnce();
        expect(h.disposePrintDocument).toHaveBeenCalledOnce();
        expect(h.atomicWrite).not.toHaveBeenCalled();
        await expect(h.service.createPdf(h.request)).resolves.toBeDefined();
        resolvePdf(Buffer.from("%PDF-1.7\nlate"));
        await Promise.resolve();
        expect(h.atomicWrite).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("hidden print views are not background-throttled and stalled font readiness times out", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.webContents.executeJavaScript.mockImplementationOnce(() => new Promise(() => {}));
      const rejected = expect(h.service.createPreview(h.request)).rejects.toThrow(
        "打印视图加载超时",
      );
      await vi.advanceTimersByTimeAsync(30_001);
      await rejected;
      expect(h.createWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          show: false,
          webPreferences: expect.objectContaining({ backgroundThrottling: false }),
        }),
      );
      expect(h.webContents.printToPDF).not.toHaveBeenCalled();
      expect(h.window.destroy).toHaveBeenCalledOnce();
      await expect(h.service.createPreview(h.request)).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(["paragraph", "heading", "bullet-list", "ordered-list", "table"])(
    "loads inline figure assets inside %s for printing",
    async (container) => {
      const { service, request, assetStore } = harness();
      const paragraph = request.document.content[0] as ParagraphNode;
      const assetId = "00000000-0000-4000-8000-000000000901";
      paragraph.content = [
        {
          id: crypto.randomUUID(),
          type: "inline-figure",
          assetId,
          widthMm: 40,
          alignment: "center",
        },
      ];
      if (container === "heading")
        request.document.content = [{ ...paragraph, type: "heading", level: 1 }];
      else if (container === "bullet-list" || container === "ordered-list") {
        const list = {
          id: crypto.randomUUID(),
          items: [{ id: crypto.randomUUID(), content: [paragraph] }],
        };
        request.document.content = [
          container === "bullet-list"
            ? { ...list, type: "bullet-list" }
            : { ...list, type: "ordered-list", start: 1 },
        ];
      } else if (container === "table")
        request.document.content = [
          {
            id: crypto.randomUUID(),
            type: "table",
            columnWidthsMm: [40],
            rows: [
              {
                id: crypto.randomUUID(),
                cells: [
                  {
                    id: crypto.randomUUID(),
                    rowSpan: 1,
                    colSpan: 1,
                    horizontalAlignment: "left",
                    verticalAlignment: "top",
                    borderStyle: "single",
                    content: [paragraph],
                  },
                ],
              },
            ],
          },
        ];
      vi.mocked(assetStore.get).mockReturnValue({} as never);
      await service.createPdf(request);
      expect(assetStore.get).toHaveBeenCalledWith(request.sessionId, assetId);
      expect(assetStore.get).toHaveBeenCalledTimes(1);
    },
  );
  test.each([false, true])(
    "includes chemical previews in combined=%s print jobs",
    async (combined) => {
      const { service, request, assetStore, renderHtml, createPrintDocument } = harness();
      const payload = await createChemicalContentPayload("结构式打印");
      vi.mocked(assetStore.get).mockImplementation((_session, id) =>
        payload.assets.find((asset) => asset.descriptor.assetId === id),
      );
      await service.createPreview({
        ...request,
        document: payload.document,
        ...(combined ? { documents: [request.document, payload.document] } : {}),
      });
      expect(assetStore.get).toHaveBeenCalledWith(
        request.sessionId,
        payload.assets[0]?.descriptor.assetId,
      );
      if (combined) expect(createPrintDocument.mock.calls[0]?.[0]).toContain("化学结构预览");
      else expect(renderHtml.mock.calls[0]?.[1]).toEqual(payload.assets);
    },
  );
  test("caches a combined preview using every book instead of just the active document", async () => {
    const { service, request, createPrintDocument, renderHtml, atomicWrite } = harness();
    const documents = Array.from({ length: 5 }, (_, index) => createBlankDocument(`Book ${index}`));
    const preview = await service.createPreview({ ...request, documents });
    expect(renderHtml).not.toHaveBeenCalled();
    const html = createPrintDocument.mock.calls[0]?.[0] ?? "";
    for (let index = 0; index < 5; index++) expect(html).toContain(`@page print-book-${index}`);
    await service.savePreviewPdf("combined.pdf", preview.previewId);
    expect(atomicWrite).toHaveBeenCalledWith("combined.pdf", preview.bytes);
  });
  test("retains the patent book layout when creating the preview snapshot", async () => {
    const { service, request, renderHtml } = harness();
    await service.createPreview({ ...request, patentBookLayout: true });
    expect(renderHtml).toHaveBeenCalledWith(request.document, [], request.layout, {
      patentBookLayout: true,
    });
  });
  test("creates PDF bytes in a hardened hidden per-job window and destroys it", async () => {
    const { service, request, createWindow, disposePrintDocument, window, webContents } = harness();

    const bytes = await service.createPdf(request);

    expect(Buffer.from(bytes).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(createWindow).toHaveBeenCalledWith({
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        devTools: false,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    expect(window.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^patent-print:\/\/job\//iu));
    expect(window.loadURL.mock.calls[0]?.[0].length).toBeLessThan(100);
    expect(webContents.once).toHaveBeenCalledWith("did-finish-load", expect.any(Function));
    expect(webContents.executeJavaScript).toHaveBeenCalledWith(
      "document.fonts.ready.then(() => true)",
      true,
    );
    expect(webContents.printToPDF).toHaveBeenCalledWith({
      landscape: true,
      pageSize: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      scale: 1.25,
    });
    expect(webContents.printToPDF.mock.calls[0]?.[0]).not.toHaveProperty("pageRanges");
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(disposePrintDocument).toHaveBeenCalledOnce();
  });

  test("passes controlled layout into print HTML and preview PDF options", async () => {
    const { service, request, renderHtml, webContents } = harness();

    await service.createPreview(request);

    expect(renderHtml).toHaveBeenCalledWith(request.document, [], request.layout);
    expect(webContents.printToPDF).toHaveBeenCalledWith({
      landscape: true,
      pageSize: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      scale: 1.25,
    });
    expect(webContents.printToPDF.mock.calls[0]?.[0]).not.toHaveProperty("pageRanges");
  });

  test("transports HTML larger than 2 MiB without putting it in the navigation URL", async () => {
    const html = `<!doctype html><body>${"图".repeat(2 * 1024 * 1024)}</body>`;
    const { service, request, createPrintDocument, window } = harness({ html });

    await service.createPdf(request);

    expect(createPrintDocument.mock.calls[0]?.[0]).toContain(html.slice(html.indexOf("<body")));
    expect(window.loadURL.mock.calls[0]?.[0].length).toBeLessThan(100);
  });

  test("atomically saves the exact cached preview bytes without regenerating the PDF", async () => {
    const { service, request, atomicWrite, webContents } = harness();

    const preview = await service.createPreview(request);
    expect(service.getPreviewSessionId(preview.previewId)).toBe(request.sessionId);
    const report = await service.savePreviewPdf("C:\\exports\\reference.pdf", preview.previewId);

    expect(Buffer.from(preview.bytes).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(preview.previewId).toBe("preview-token-1");
    expect(webContents.printToPDF).toHaveBeenCalledOnce();
    expect(atomicWrite.mock.calls[0]?.[1]).toBe(preview.bytes);
    expect(report).toEqual({
      format: "pdf",
      outputPath: "C:\\exports\\reference.pdf",
      issues: [],
    });
    await expect(
      service.savePreviewPdf("C:\\exports\\second.pdf", preview.previewId),
    ).rejects.toThrow("预览已失效");
    expect(service.getPreviewSessionId(preview.previewId)).toBeUndefined();
  });

  test("saves a provided patent HTML document as PDF without rendering a legacy document", async () => {
    const { service, atomicWrite, renderHtml, createPrintDocument } = harness();

    const report = await service.saveHtmlPdf(
      "C:\\exports\\combined-patent.pdf",
      "patent-session",
      "<!doctype html><html><body>五书合并</body></html>",
      [
        {
          severity: "warning",
          code: "FLOWCHART_RENDERED_AS_IMAGE",
          nodeId: "figure-1",
          message: "流程图 SVG 无法安全导出，已降级为 PNG 图片。",
        },
      ],
    );

    expect(renderHtml).not.toHaveBeenCalled();
    expect(createPrintDocument).toHaveBeenCalledWith(
      expect.stringContaining("<body>五书合并</body></html>"),
    );
    expect(atomicWrite.mock.calls[0]?.[0]).toBe("C:\\exports\\combined-patent.pdf");
    expect(
      Buffer.from(atomicWrite.mock.calls[0]?.[1] as Uint8Array)
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    expect(report).toEqual({
      format: "pdf",
      outputPath: "C:\\exports\\combined-patent.pdf",
      issues: [
        {
          severity: "warning",
          code: "FLOWCHART_RENDERED_AS_IMAGE",
          nodeId: "figure-1",
          message: "流程图 SVG 无法安全导出，已降级为 PNG 图片。",
        },
      ],
    });
  });

  test("retains a cached preview when the atomic write fails so the user can retry", async () => {
    const { service, request, atomicWrite, webContents } = harness();
    atomicWrite.mockRejectedValueOnce(new Error("file locked")).mockResolvedValueOnce(undefined);
    const preview = await service.createPreview(request);

    await expect(
      service.savePreviewPdf("C:\\exports\\locked.pdf", preview.previewId),
    ).rejects.toThrow("file locked");
    await expect(
      service.savePreviewPdf("C:\\exports\\retry.pdf", preview.previewId),
    ).resolves.toMatchObject({ outputPath: "C:\\exports\\retry.pdf" });

    expect(webContents.printToPDF).toHaveBeenCalledOnce();
    expect(atomicWrite).toHaveBeenCalledTimes(2);
  });

  test("pins a preview against expiry while a failing atomic write is in flight", async () => {
    const { service, request, atomicWrite, scheduledExpiries } = harness();
    let rejectWrite: ((error: Error) => void) | undefined;
    atomicWrite.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const preview = await service.createPreview(request);
    const firstSave = service.savePreviewPdf("C:\\exports\\locked.pdf", preview.previewId);
    await Promise.resolve();

    scheduledExpiries[0]?.callback();
    rejectWrite?.(new Error("file locked"));
    await expect(firstSave).rejects.toThrow("file locked");
    atomicWrite.mockResolvedValueOnce(undefined);

    await expect(
      service.savePreviewPdf("C:\\exports\\retry.pdf", preview.previewId),
    ).resolves.toMatchObject({ outputPath: "C:\\exports\\retry.pdf" });
  });

  test("rejects replacing a same-session preview while its cached bytes are being saved", async () => {
    const { service, request, atomicWrite } = harness();
    let rejectWrite: ((error: Error) => void) | undefined;
    atomicWrite.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const preview = await service.createPreview(request);
    const firstSave = service.savePreviewPdf("C:\\exports\\locked.pdf", preview.previewId);
    await Promise.resolve();

    await expect(service.createPreview(request)).rejects.toThrow("预览正在保存");
    rejectWrite?.(new Error("file locked"));
    await expect(firstSave).rejects.toThrow("file locked");
    atomicWrite.mockResolvedValueOnce(undefined);
    await expect(
      service.savePreviewPdf("C:\\exports\\retry.pdf", preview.previewId),
    ).resolves.toBeDefined();
  });

  test("does not exceed the preview entry cap when every cached entry is pinned by a save", async () => {
    const { service, request, atomicWrite, createPreviewId } = harness({
      limits: { maxCachedPreviews: 1 },
    });
    createPreviewId.mockReturnValueOnce("preview-token-1").mockReturnValueOnce("preview-token-2");
    let finishWrite: (() => void) | undefined;
    atomicWrite.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const preview = await service.createPreview(request);
    const save = service.savePreviewPdf("C:\\exports\\pending.pdf", preview.previewId);
    await Promise.resolve();

    await expect(
      service.createPreview({ ...request, sessionId: "print-session-2" }),
    ).rejects.toThrow("预览缓存已满");
    finishWrite?.();
    await save;
  });

  test("invalidates a session's old preview and supports explicit close cleanup", async () => {
    const { service, request, createPreviewId } = harness();
    createPreviewId.mockReturnValueOnce("preview-token-1").mockReturnValueOnce("preview-token-2");

    const first = await service.createPreview(request);
    const second = await service.createPreview(request);

    await expect(service.savePreviewPdf("C:\\exports\\old.pdf", first.previewId)).rejects.toThrow(
      "预览已失效",
    );
    service.discardPreview(second.previewId);
    await expect(
      service.savePreviewPdf("C:\\exports\\closed.pdf", second.previewId),
    ).rejects.toThrow("预览已失效");
  });

  test("expires cached preview bytes after the bounded lifetime", async () => {
    const { service, request, scheduledExpiries } = harness();
    const preview = await service.createPreview(request);

    expect(scheduledExpiries).toHaveLength(1);
    scheduledExpiries[0]?.callback();

    await expect(
      service.savePreviewPdf("C:\\exports\\expired.pdf", preview.previewId),
    ).rejects.toThrow("预览已失效");
  });

  test("evicts oldest previews by total bytes and rejects a PDF over the per-preview bound", async () => {
    const { service, request, webContents, createPreviewId } = harness({
      limits: { maxPreviewBytes: 20, maxTotalPreviewBytes: 24 },
    });
    createPreviewId.mockReturnValueOnce("preview-token-1").mockReturnValueOnce("preview-token-2");
    webContents.printToPDF
      .mockResolvedValueOnce(Buffer.from("%PDF-123456789"))
      .mockResolvedValueOnce(Buffer.from("%PDF-987654321"))
      .mockResolvedValueOnce(Buffer.from(`%PDF-${"x".repeat(20)}`));
    const first = await service.createPreview(request);
    const second = await service.createPreview({ ...request, sessionId: "print-session-2" });

    await expect(service.savePreviewPdf("C:\\exports\\first.pdf", first.previewId)).rejects.toThrow(
      "预览已失效",
    );
    await expect(
      service.savePreviewPdf("C:\\exports\\second.pdf", second.previewId),
    ).resolves.toBeDefined();
    await expect(
      service.createPreview({ ...request, sessionId: "print-session-3" }),
    ).rejects.toThrow("PDF 文件过大");
  });

  test("loads only assets referenced by canonical figure nodes", async () => {
    const { service, request, assetStore } = harness();
    const referencedId = "00000000-0000-4000-8000-000000000901";
    request.document.content.push({
      id: "00000000-0000-4000-8000-000000000902",
      type: "figure",
      assetId: referencedId,
      widthMm: 80,
      alignment: "center",
    });
    vi.mocked(assetStore.get).mockReturnValue({} as never);

    await service.createPdf(request);

    expect(assetStore.get).toHaveBeenCalledTimes(1);
    expect(assetStore.get).toHaveBeenCalledWith(request.sessionId, referencedId);
    expect(assetStore.list).not.toHaveBeenCalled();
  });

  test("rejects duplicate session jobs and caps concurrent hidden windows, then releases capacity", async () => {
    const { service, request, webContents } = harness({ limits: { maxConcurrentJobs: 1 } });
    let releasePdf: ((bytes: Buffer) => void) | undefined;
    webContents.printToPDF.mockImplementationOnce(
      () =>
        new Promise<Buffer>((resolve) => {
          releasePdf = resolve;
        }),
    );
    const first = service.createPdf(request);
    await vi.waitFor(() => expect(webContents.printToPDF).toHaveBeenCalledOnce());

    await expect(service.createPdf(request)).rejects.toThrow("已有打印任务");
    await expect(service.createPdf({ ...request, sessionId: "print-session-2" })).rejects.toThrow(
      "打印任务繁忙",
    );
    releasePdf?.(Buffer.from("%PDF-1.7\nfixture"));
    await first;
    await expect(
      service.createPdf({ ...request, sessionId: "print-session-2" }),
    ).resolves.toBeDefined();
  });

  test("opens the non-silent system print dialog with backgrounds", async () => {
    const { service, request, webContents, window } = harness();

    await service.print(request);

    expect(webContents.print).toHaveBeenCalledWith(
      { silent: false, printBackground: true },
      expect.any(Function),
    );
    expect(window.destroy).toHaveBeenCalledOnce();
  });

  test("prints silently from the immutable cached preview snapshot with output settings", async () => {
    const { service, request, renderHtml, webContents, window } = harness();
    const preview = await service.createPreview(request);
    const originalDocument = request.document;
    request.document.title = "用户后来继续编辑的标题";
    request.layout.paperSize = "A5";
    const output: PrintOutputSettings = {
      ...createDefaultPrintSettings(originalDocument.page).output,
      printerDeviceName: "office-printer",
      copies: 3,
      pageRanges: [
        { from: 0, to: 2 },
        { from: 4, to: 4 },
      ],
      duplexMode: "longEdge",
      color: false,
      pagesPerSheet: 2,
      collate: false,
    };
    const directRequest: DirectPrintRequest = {
      sessionId: request.sessionId,
      previewId: preview.previewId,
      output,
    };

    await service.printCached(directRequest, ["office-printer", "other-printer"]);

    expect(renderHtml).toHaveBeenCalledTimes(2);
    expect(renderHtml.mock.calls[1]?.[0]).toMatchObject({ title: "打印参考文档" });
    expect(renderHtml.mock.calls[1]?.[0]).not.toBe(originalDocument);
    expect(renderHtml.mock.calls[1]?.[2]).toMatchObject({
      orientation: "landscape",
      paperSize: "Letter",
      scalePercent: 125,
    });
    expect(webContents.print).toHaveBeenLastCalledWith(
      {
        silent: true,
        printBackground: true,
        deviceName: "office-printer",
        color: false,
        landscape: true,
        scaleFactor: 125,
        pagesPerSheet: 2,
        collate: false,
        copies: 3,
        pageRanges: [
          { from: 0, to: 2 },
          { from: 4, to: 4 },
        ],
        duplexMode: "longEdge",
        pageSize: "Letter",
        margins: { marginType: "none" },
      },
      expect.any(Function),
    );
    expect(window.destroy).toHaveBeenCalledTimes(2);
  });

  test("omits deviceName for the system default printer during silent printing", async () => {
    const { service, request, webContents } = harness();
    const preview = await service.createPreview(request);
    const output: PrintOutputSettings = {
      ...createDefaultPrintSettings(request.document.page).output,
      printerDeviceName: null,
    };

    await service.printCached(
      {
        sessionId: request.sessionId,
        previewId: preview.previewId,
        output,
      },
      [],
    );

    expect(webContents.print.mock.calls.at(-1)?.[0]).not.toHaveProperty("deviceName");
  });

  test("rejects stale previews, mismatched sessions, and removed printers before printing", async () => {
    const { service, request, webContents } = harness();
    const preview = await service.createPreview(request);
    const output: PrintOutputSettings = {
      ...createDefaultPrintSettings(request.document.page).output,
      printerDeviceName: "removed-printer",
    };

    await expect(
      service.printCached({ sessionId: request.sessionId, previewId: "missing-preview", output }, [
        "removed-printer",
      ]),
    ).rejects.toMatchObject({ name: "PrintPreviewUnavailableError" });
    await expect(
      service.printCached({ sessionId: "other-session", previewId: preview.previewId, output }, [
        "removed-printer",
      ]),
    ).rejects.toMatchObject({ name: "PrintPreviewUnavailableError" });
    await expect(
      service.printCached({ sessionId: request.sessionId, previewId: preview.previewId, output }, [
        "available-printer",
      ]),
    ).rejects.toMatchObject({ name: "PrintPrinterUnavailableError" });

    expect(webContents.print).not.toHaveBeenCalled();
  });

  test("keeps a cached preview pinned while silent printing is in flight", async () => {
    const { service, request, webContents } = harness();
    let finishPrint: ((success: boolean, failureReason: string) => void) | undefined;
    webContents.print.mockImplementationOnce(
      (_printOptions: unknown, callback: (success: boolean, failureReason: string) => void) => {
        finishPrint = callback;
      },
    );
    const preview = await service.createPreview(request);
    const output: PrintOutputSettings = {
      ...createDefaultPrintSettings(request.document.page).output,
      printerDeviceName: null,
    };

    const print = service.printCached(
      { sessionId: request.sessionId, previewId: preview.previewId, output },
      [],
    );
    for (let attempt = 0; attempt < 10 && !finishPrint; attempt += 1) {
      await Promise.resolve();
    }
    expect(finishPrint).toBeTypeOf("function");
    service.discardPreview(preview.previewId);
    finishPrint?.(true, "");
    await print;

    await expect(
      service.savePreviewPdf("C:\\exports\\after-print.pdf", preview.previewId),
    ).rejects.toThrow("预览已失效");
  });

  test("distinguishes Electron's user cancellation from real print failures", async () => {
    const cancelled = harness({ printSuccess: false, printFailureReason: "Print job canceled" });
    const failed = harness({ printSuccess: false, printFailureReason: "printer unavailable" });

    await expect(cancelled.service.print(cancelled.request)).rejects.toMatchObject({
      name: "PrintCancelledError",
    });
    await expect(failed.service.print(failed.request)).rejects.toThrow("printer unavailable");
  });

  test.each([
    ["load", { loadError: new Error("load failed") }],
    ["PDF", { pdfError: new Error("PDF failed") }],
    ["print", { printSuccess: false, printFailureReason: "printer unavailable" }],
  ] as const)("destroys the hidden window when %s fails", async (_name, options) => {
    const { service, request, window } = harness(options);

    const operation = _name === "print" ? service.print(request) : service.createPdf(request);
    await expect(operation).rejects.toThrow();

    expect(window.destroy).toHaveBeenCalledOnce();
  });
});
