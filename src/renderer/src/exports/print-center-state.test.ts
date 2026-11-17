import { createBlankDocument } from "../../../shared/document/defaults";
import type { PrintPreview, PrintPreviewRequest } from "../../../shared/ipc/contract";
import type { AppResult } from "../../../shared/ipc/result";
import type { PrinterDescriptor, PrintPreferences } from "../../../shared/printing/model";
import { createPrintCenterController } from "./print-center-state";

const PREVIEW_ONE = "11111111-1111-4111-8111-111111111111";
const PREVIEW_TWO = "22222222-2222-4222-8222-222222222222";

function printer(deviceName: string, displayName = deviceName): PrinterDescriptor {
  return {
    deviceName,
    displayName,
    description: null,
    duplex: "unknown",
    color: "unknown",
    paperSize: "unknown",
  };
}

function okPreview(previewId: string, bytes = Uint8Array.from([37, 80, 68, 70])) {
  return { ok: true, value: { previewId, bytes } } satisfies AppResult<PrintPreview>;
}

function deferredPreview(previewId: string) {
  let resolve: (value: ReturnType<typeof okPreview>) => void = () => undefined;
  const promise = new Promise<ReturnType<typeof okPreview>>((finish) => {
    resolve = finish;
  });
  return { promise, resolve: () => resolve(okPreview(previewId)) };
}

function createHarness(
  preferences: Partial<PrintPreferences> = {},
  printers: PrinterDescriptor[] = [printer("office-printer", "办公室打印机")],
) {
  const preview = vi.fn<(request: PrintPreviewRequest) => Promise<AppResult<PrintPreview>>>(
    async () => okPreview(PREVIEW_ONE),
  );
  const discardPreview = vi.fn(async () => ({ ok: true, value: undefined }) as const);
  const controller = createPrintCenterController({
    sessionId: "5d5c49f1-5f4c-4e70-9326-dd7e17d68a41",
    targetId: "00000000-0000-4000-8000-000000000501",
    document: createBlankDocument("打印测试文档"),
    suggestedName: "打印测试文档",
    preferences: {
      printerDeviceName: "office-printer",
      duplexMode: "simplex",
      color: true,
      orientation: "portrait",
      paperSize: "A4",
      ...preferences,
    },
    printers,
    preview,
    discardPreview,
    debounceMs: 250,
  });
  return { controller, preview, discardPreview };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("opens from document page settings and remembered preferences, falling back once when printer is missing", () => {
  const { controller } = createHarness({ printerDeviceName: "missing-printer" }, [printer("p1")]);

  const state = controller.getState();

  expect(state.settings.output.printerDeviceName).toBeNull();
  expect(state.settings.output.copies).toBe(1);
  expect(state.settings.output.pageRanges).toBeUndefined();
  expect(state.settings.layout.paperSize).toBe("A4");
  expect(state.settings.layout.orientation).toBe("portrait");
  expect(state.missingRememberedPrinterName).toBe("missing-printer");
});

test("generates the first preview immediately and enables print only after PDF page count is known", async () => {
  const { controller, preview } = createHarness();

  controller.start();
  await vi.runAllTimersAsync();

  expect(preview).toHaveBeenCalledOnce();
  expect(preview.mock.calls[0]?.[0]).toMatchObject({
    sessionId: "5d5c49f1-5f4c-4e70-9326-dd7e17d68a41",
    targetId: "00000000-0000-4000-8000-000000000501",
    suggestedName: "打印测试文档",
    layout: { paperSize: "A4", orientation: "portrait" },
  });
  expect(controller.getState().canPrint).toBe(false);

  controller.setTotalPages(3);

  expect(controller.getState()).toMatchObject({
    currentPage: 1,
    totalPages: 3,
    canPrint: true,
  });
});

test("starts with the document paper geometry instead of a previous print job", () => {
  const { controller } = createHarness({ paperSize: "Letter", orientation: "landscape" });
  expect(controller.getState().settings.layout).toMatchObject({
    paperSize: "A4",
    orientation: "portrait",
    scalePercent: 100,
    margins: { mode: "document" },
  });
});

test("layout changes debounce into one latest preview while output-only settings do not refresh preview", async () => {
  const { controller, preview } = createHarness();
  controller.start();
  await vi.runAllTimersAsync();
  controller.setTotalPages(2);
  preview.mockClear();

  controller.updateOutput({ copies: 2, color: false, pagesPerSheet: 4 });
  vi.advanceTimersByTime(500);
  await Promise.resolve();

  expect(preview).not.toHaveBeenCalled();
  expect(controller.getState().canPrint).toBe(true);

  const pending = deferredPreview(PREVIEW_TWO);
  preview.mockReturnValueOnce(pending.promise);
  controller.updateLayout({ orientation: "landscape" });
  controller.updateLayout({ paperSize: "Letter" });
  vi.advanceTimersByTime(249);
  await Promise.resolve();
  expect(preview).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);

  expect(preview).toHaveBeenCalledOnce();
  expect(preview.mock.calls[0]?.[0].layout).toMatchObject({
    orientation: "landscape",
    paperSize: "Letter",
  });
  expect(controller.getState().canPrint).toBe(false);
});

test("serializes preview refreshes and prevents stale results from overwriting the newest layout", async () => {
  const first = deferredPreview(PREVIEW_ONE);
  const second = deferredPreview(PREVIEW_TWO);
  const { controller, preview, discardPreview } = createHarness();
  preview.mockReset();
  preview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

  controller.start();
  await Promise.resolve();
  controller.updateLayout({ orientation: "landscape" });
  controller.updateLayout({ paperSize: "Letter" });
  await vi.runAllTimersAsync();

  expect(preview).toHaveBeenCalledTimes(1);

  first.resolve();
  await Promise.resolve();

  expect(controller.getState().preview.previewId).toBeNull();
  expect(discardPreview).toHaveBeenCalledWith(PREVIEW_ONE);
  expect(preview).toHaveBeenCalledTimes(2);
  expect(preview.mock.calls[1]?.[0].layout).toMatchObject({
    orientation: "landscape",
    paperSize: "Letter",
  });

  second.resolve();
  await Promise.resolve();

  expect(controller.getState().preview.previewId).toBe(PREVIEW_TWO);
});

test("clamps current page after a new preview reports fewer pages", async () => {
  const { controller } = createHarness();
  controller.start();
  await vi.runAllTimersAsync();
  controller.setTotalPages(10);
  controller.goToPage(8);

  controller.setTotalPages(3);

  expect(controller.getState().currentPage).toBe(3);
});

test("validates page ranges against total pages and includes current page ranges in output", async () => {
  const { controller } = createHarness();
  controller.start();
  await vi.runAllTimersAsync();
  controller.setTotalPages(5);
  controller.goToPage(3);

  controller.setPageSelection({ mode: "current" });
  expect(controller.getState().settings.output.pageRanges).toEqual([{ from: 2, to: 2 }]);

  controller.setPageSelection({ mode: "custom", source: "2-4, 4" });
  expect(controller.getState().settings.output.pageRanges).toEqual([{ from: 1, to: 3 }]);
  expect(controller.getState().canPrint).toBe(true);

  controller.setPageSelection({ mode: "custom", source: "2-9" });

  expect(controller.getState().pageRangeError).toContain("总页数 5");
  expect(controller.getState().canPrint).toBe(false);
});

test("closes by cancelling timers and discarding the current preview", async () => {
  const { controller, discardPreview, preview } = createHarness();
  controller.start();
  await vi.runAllTimersAsync();
  controller.setTotalPages(1);
  preview.mockClear();

  controller.updateLayout({ paperSize: "Letter" });
  controller.close();
  await vi.advanceTimersByTimeAsync(300);

  expect(preview).not.toHaveBeenCalled();
  expect(discardPreview).toHaveBeenCalledWith(PREVIEW_ONE);
  expect(controller.getState().closed).toBe(true);
});
