import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createBlankDocument } from "../../../shared/document/defaults";
import type { ExportReport } from "../../../shared/exports/report";
import type { DocumentStructureIssue } from "../../../shared/patent/document-structure-ruler";
import type { PrinterDescriptor } from "../../../shared/printing/model";

const pdfRenderer = vi.hoisted(() => ({
  open: vi.fn(async () => ({ totalPages: 6 })),
  render: vi.fn(async () => ({
    pageNumber: 1,
    totalPages: 6,
    scale: 1,
    width: 420,
    height: 594,
    viewport: { width: 420, height: 594, scale: 1 },
  })),
  close: vi.fn(),
}));

vi.mock("./pdf-page-renderer", () => ({
  createPdfPageRenderer: vi.fn(() => pdfRenderer),
  PdfPreviewError: class PdfPreviewError extends Error {},
}));

import { PrintCenter, type PrintCenterApi, type PrintCenterProps } from "./print-center";

const PREVIEW_ID: string = "11111111-1111-4111-8111-111111111111";
const NEXT_PREVIEW_ID: string = "22222222-2222-4222-8222-222222222222";

const structureIssue: DocumentStructureIssue = {
  id: "missing-claim:2",
  kind: "missing-claim",
  bookKind: "claims",
  summary: "缺少权利要求 2",
  targetBlockIds: [],
  anchorBlockId: "00000000-0000-4000-8000-000000000001",
};

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

function createApi(printers: PrinterDescriptor[] = [printer("office-printer", "办公室打印机")]) {
  return {
    listPrinters: vi.fn(async () => ({ ok: true, value: printers }) as const),
    preview: vi.fn<PrintCenterApi["preview"]>(
      async () =>
        ({
          ok: true,
          value: { previewId: PREVIEW_ID, bytes: Uint8Array.from([37, 80, 68, 70]) },
        }) as const,
    ),
    discardPreview: vi.fn(async () => ({ ok: true, value: undefined }) as const),
    savePreviewPdf: vi.fn(
      async () =>
        ({
          ok: true,
          value: {
            format: "pdf",
            outputPath: "C:\\exports\\print.pdf",
            issues: [],
          } as ExportReport,
        }) as const,
    ),
    print: vi.fn(async () => ({ ok: true, value: undefined }) as const),
    openPrinterSettings: vi.fn(async () => ({ ok: true, value: undefined }) as const),
  } satisfies PrintCenterApi;
}

function renderPrintCenter(
  api = createApi(),
  structureIssues: readonly DocumentStructureIssue[] = [],
) {
  const onClose = vi.fn();
  const onExportReport = vi.fn();
  const onError = vi.fn();
  render(
    <PrintCenter
      sessionId="5d5c49f1-5f4c-4e70-9326-dd7e17d68a41"
      document={createBlankDocument("打印测试文档")}
      suggestedName="打印测试文档"
      preferences={{
        printerDeviceName: "office-printer",
        duplexMode: "simplex",
        color: true,
        orientation: "portrait",
        paperSize: "A4",
      }}
      api={api}
      structureIssues={structureIssues}
      onClose={onClose}
      onExportReport={onExportReport}
      onError={onError}
    />,
  );
  return { api, onClose, onExportReport, onError };
}

beforeEach(() => {
  pdfRenderer.open.mockClear();
  pdfRenderer.render.mockClear();
  pdfRenderer.close.mockClear();
});

test("exposes the shared four-corner resize handles", async () => {
  renderPrintCenter();
  const dialog = await screen.findByRole("dialog", { name: "打印中心" });
  expect(dialog.classList.contains("standard-dialog--resizable")).toBe(true);
  expect(within(dialog).getAllByRole("button", { name: "调整打印中心大小" })).toHaveLength(4);
  for (const corner of ["nw", "ne", "sw", "se"]) {
    expect(dialog.querySelector(`.dialog-resize--${corner}`)).not.toBeNull();
  }
});

function callbackTestProps(api: PrintCenterApi): PrintCenterProps {
  return {
    sessionId: "5d5c49f1-5f4c-4e70-9326-dd7e17d68a41",
    document: createBlankDocument("打印刷新测试"),
    suggestedName: "打印刷新测试",
    preferences: {
      printerDeviceName: null,
      duplexMode: "simplex",
      color: true,
      orientation: "portrait",
      paperSize: "A4",
    },
    api,
    onClose: vi.fn(),
    onExportReport: vi.fn(),
    onError: vi.fn(),
  };
}

function pendingResult<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("preserves an in-flight preview across parent callback changes", async () => {
  const api = createApi();
  const pending = pendingResult<Awaited<ReturnType<PrintCenterApi["preview"]>>>();
  api.preview.mockReturnValueOnce(pending.promise);
  const props = callbackTestProps(api);
  const ui = render(<PrintCenter {...props} />);
  await waitFor(() => expect(api.preview).toHaveBeenCalledOnce());

  ui.rerender(<PrintCenter {...props} onError={vi.fn()} />);
  await act(async () => {
    pending.resolve({
      ok: true,
      value: { previewId: PREVIEW_ID, bytes: Uint8Array.from([37, 80, 68, 70]) },
    });
  });

  expect(api.preview).toHaveBeenCalledOnce();
  expect(api.listPrinters).toHaveBeenCalledOnce();
  expect(api.discardPreview).not.toHaveBeenCalled();
  await waitFor(() => expect(pdfRenderer.render).toHaveBeenCalled());
  expect(screen.getByText("第 1 / 6 页")).toBeDefined();
});

test("reports a pending printer error to the latest callback without restarting", async () => {
  const api = createApi();
  const pending = pendingResult<Awaited<ReturnType<PrintCenterApi["listPrinters"]>>>();
  const listPrinters = vi.fn(() => pending.promise);
  const props = callbackTestProps({ ...api, listPrinters });
  const latestError = vi.fn();
  const ui = render(<PrintCenter {...props} />);
  ui.rerender(<PrintCenter {...props} onError={latestError} />);
  const error = { code: "INTERNAL" as const, message: "打印机读取失败" };
  await act(async () => pending.resolve({ ok: false, error }));

  expect(listPrinters).toHaveBeenCalledOnce();
  expect(props.onError).not.toHaveBeenCalled();
  expect(latestError).toHaveBeenCalledExactlyOnceWith(error);
  expect(api.preview).not.toHaveBeenCalled();
});

test("loads printers and preview, then shows grouped homepage settings plus paginated canvas controls", async () => {
  const { api } = renderPrintCenter();

  const dialog = await screen.findByRole("dialog", { name: "打印中心" });
  expect(dialog.classList.contains("standard-dialog--xl")).toBe(true);
  expect(dialog.parentElement?.classList.contains("standard-dialog-overlay")).toBe(true);
  expect(
    within(dialog)
      .getByRole("button", { name: "打印" })
      .closest("footer")
      ?.classList.contains("standard-dialog__footer"),
  ).toBe(true);

  expect(api.listPrinters).toHaveBeenCalledOnce();
  expect(api.preview).toHaveBeenCalledOnce();
  expect(await within(dialog).findByLabelText("打印机")).toBeDefined();
  expect(within(dialog).getByLabelText("份数")).toBeDefined();
  expect(within(dialog).getByLabelText("页码范围")).toBeDefined();
  expect(within(dialog).getByLabelText("双面打印")).toBeDefined();
  expect(within(dialog).getByLabelText("颜色")).toBeDefined();
  expect(within(dialog).getByLabelText("方向")).toBeDefined();
  expect(within(dialog).getByLabelText("纸张")).toBeDefined();

  await waitFor(() => expect(screen.getByText("第 1 / 6 页")).toBeDefined());
  expect((screen.getByLabelText("预览缩放") as HTMLSelectElement).value).toBe("fit-width");
  expect(screen.queryByRole("button", { name: "适合页面" })).toBeNull();
  expect((screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(
    false,
  );

  await userEvent.click(screen.getByRole("button", { name: "更多设置" }));

  expect(screen.getByLabelText("缩放")).toBeDefined();
  expect(screen.getByLabelText("每张纸页数")).toBeDefined();
  expect(screen.getByLabelText("逐份打印")).toBeDefined();
  expect(screen.getByLabelText("页边距")).toBeDefined();
  expect(screen.getByRole("button", { name: "打开系统打印机设置" })).toBeDefined();
});

test("shows continuous pages and scrolls without reopening the PDF", async () => {
  renderPrintCenter();
  const user = userEvent.setup();

  await screen.findByText("第 1 / 6 页");
  await waitFor(() => expect(screen.queryByText("正在打开 PDF 预览……")).toBeNull());

  expect(pdfRenderer.open).toHaveBeenCalledTimes(1);
  expect(screen.getAllByLabelText(/打印预览(?:画布|第 \d+ 页)/)).toHaveLength(6);
  expect(screen.queryByText("让应用记住打印机、单双面、颜色、方向和纸张。")).toBeNull();
  const container = screen.getByLabelText("打印预览画布").parentElement as HTMLDivElement;

  await user.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("第 2 / 6 页");
  expect(container.scrollTop).toBe(616);
  expect(pdfRenderer.open).toHaveBeenCalledTimes(1);
  fireEvent.scroll(container, { target: { scrollTop: 616 * 4 } });
  await screen.findByText("第 5 / 6 页");
  await waitFor(() =>
    expect(pdfRenderer.render).toHaveBeenCalledWith(
      screen.getByLabelText("打印预览第 6 页"),
      expect.objectContaining({ pageNumber: 6 }),
    ),
  );

  await user.selectOptions(screen.getByLabelText("预览缩放"), "150");
  await waitFor(() =>
    expect(pdfRenderer.render).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ zoom: { mode: "percent", value: 150 } }),
    ),
  );
  expect(pdfRenderer.open).toHaveBeenCalledTimes(1);
  await user.selectOptions(screen.getByLabelText("预览缩放"), "fit-width");
  await waitFor(() =>
    expect(pdfRenderer.render).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ zoom: { mode: "fit-width" } }),
    ),
  );
  expect(pdfRenderer.open).toHaveBeenCalledTimes(1);
});

test("keeps distant pages as lightweight slots and renders them after scrolling", async () => {
  pdfRenderer.open.mockResolvedValueOnce({ totalPages: 100 });
  renderPrintCenter();
  await screen.findByText("第 1 / 100 页");
  await waitFor(() => expect(screen.queryByText("正在打开 PDF 预览……")).toBeNull());
  const container = screen.getByLabelText("打印预览画布").parentElement as HTMLDivElement;
  expect(container.querySelectorAll("canvas")).toHaveLength(100);
  expect(
    pdfRenderer.render.mock.calls.every(
      (call) => (call as unknown as [unknown, { pageNumber: number }])[1].pageNumber < 10,
    ),
  ).toBe(true);
  fireEvent.scroll(container, { target: { scrollTop: 616 * 49 } });
  await screen.findByText("第 50 / 100 页");
  await waitFor(() =>
    expect(pdfRenderer.render).toHaveBeenCalledWith(
      screen.getByLabelText("打印预览第 50 页"),
      expect.objectContaining({ pageNumber: 50 }),
    ),
  );
});

test("opens a regenerated preview once when layout settings create a new preview id", async () => {
  const api = createApi();
  api.preview
    .mockResolvedValueOnce({
      ok: true,
      value: { previewId: PREVIEW_ID, bytes: Uint8Array.from([37, 80, 68, 70]) },
    })
    .mockResolvedValueOnce({
      ok: true,
      value: { previewId: NEXT_PREVIEW_ID, bytes: Uint8Array.from([37, 80, 68, 70, 45]) },
    });
  renderPrintCenter(api);
  const user = userEvent.setup();

  await screen.findByText("第 1 / 6 页");
  await waitFor(() => expect(screen.queryByText("正在打开 PDF 预览……")).toBeNull());
  expect(pdfRenderer.open).toHaveBeenCalledTimes(1);

  await user.selectOptions(screen.getByLabelText("方向"), "landscape");

  await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(pdfRenderer.open).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText("正在打开 PDF 预览……")).toBeNull());
  expect(api.discardPreview).toHaveBeenCalledWith(PREVIEW_ID);
});

test("switches print scope and blocks exporting the previous preview while the five books load", async () => {
  const api = createApi();
  const props = callbackTestProps(api);
  const documents = Array.from({ length: 5 }, (_, index) => createBlankDocument(`书册${index}`));
  render(<PrintCenter {...props} documents={documents} combinedSuggestedName="专利-全部五书" />);
  const user = userEvent.setup();
  await screen.findByText("第 1 / 6 页");
  expect((screen.getByLabelText("打印内容") as HTMLSelectElement).value).toBe("current");
  const pending = pendingResult<Awaited<ReturnType<PrintCenterApi["preview"]>>>();
  api.preview.mockReturnValueOnce(pending.promise);
  await user.selectOptions(screen.getByLabelText("打印内容"), "all");
  expect((screen.getByRole("button", { name: "导出 PDF" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await waitFor(() =>
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ documents, suggestedName: "专利-全部五书" }),
    ),
  );
  await act(async () =>
    pending.resolve({
      ok: true,
      value: { previewId: NEXT_PREVIEW_ID, bytes: Uint8Array.from([37, 80, 68, 70]) },
    }),
  );
  await screen.findByText("第 1 / 6 页");
  await user.click(screen.getByRole("button", { name: "导出 PDF" }));
  expect(api.savePreviewPdf).toHaveBeenCalledWith(
    expect.objectContaining({ previewId: NEXT_PREVIEW_ID, suggestedName: "专利-全部五书" }),
  );
});

test("validates custom page ranges and disables print without hiding the preview", async () => {
  renderPrintCenter();
  await screen.findByText("第 1 / 6 页");
  const user = userEvent.setup();

  await user.selectOptions(screen.getByLabelText("页码范围"), "custom");
  await user.type(screen.getByLabelText("自定义页码"), "2-9");

  expect(screen.getByRole("alert").textContent).toContain("总页数 6");
  expect((screen.getByRole("button", { name: "打印" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText("打印预览画布")).toBeDefined();
});

test("prints the current preview with output-only settings and closes on success", async () => {
  const { api, onClose } = renderPrintCenter();
  const user = userEvent.setup();
  await screen.findByText("第 1 / 6 页");
  await user.selectOptions(screen.getByLabelText("颜色"), "false");
  await user.click(screen.getByRole("button", { name: "更多设置" }));
  await user.selectOptions(screen.getByLabelText("每张纸页数"), "4");

  await user.click(screen.getByRole("button", { name: "打印" }));

  expect(api.print).toHaveBeenCalledWith({
    sessionId: "5d5c49f1-5f4c-4e70-9326-dd7e17d68a41",
    previewId: PREVIEW_ID,
    output: expect.objectContaining({
      color: false,
      pagesPerSheet: 4,
      printerDeviceName: "office-printer",
    }),
  });
  expect(onClose).toHaveBeenCalledOnce();
});

test("requires explicit confirmation before printing a document with structure errors", async () => {
  const { api } = renderPrintCenter(createApi(), [structureIssue]);
  const user = userEvent.setup();
  await screen.findByText("第 1 / 6 页");

  await user.click(screen.getByRole("button", { name: "打印" }));
  expect(api.print).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("alertdialog", { name: "文档结构错误" });
  expect(confirmation.classList.contains("standard-dialog--s")).toBe(true);
  expect(within(confirmation).getByText("缺少权利要求 2")).toBeDefined();

  await user.click(within(confirmation).getByRole("button", { name: "仍然继续" }));
  expect(api.print).toHaveBeenCalledOnce();
});

test("requires explicit confirmation before exporting a PDF with structure errors", async () => {
  const { api, onExportReport } = renderPrintCenter(createApi(), [structureIssue]);
  const user = userEvent.setup();
  await screen.findByText("第 1 / 6 页");

  await user.click(screen.getByRole("button", { name: "导出 PDF" }));
  expect(api.savePreviewPdf).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("alertdialog", { name: "文档结构错误" });

  await user.click(within(confirmation).getByRole("button", { name: "仍然继续" }));
  expect(api.savePreviewPdf).toHaveBeenCalledWith({
    previewId: PREVIEW_ID,
    suggestedName: "打印测试文档",
  });
  expect(onExportReport).toHaveBeenCalledOnce();
});

test("keeps preview and PDF export available when no printers exist, but disables printing", async () => {
  const api = createApi([]);
  const { onExportReport } = renderPrintCenter(api);
  const user = userEvent.setup();
  await screen.findByText("第 1 / 6 页");

  expect((screen.getByRole("button", { name: "打印" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "导出 PDF" }));

  expect(api.savePreviewPdf).toHaveBeenCalledWith({
    previewId: PREVIEW_ID,
    suggestedName: "打印测试文档",
  });
  expect(onExportReport).toHaveBeenCalledWith({
    format: "pdf",
    outputPath: "C:\\exports\\print.pdf",
    issues: [],
  });
});

test("shows the preview failure instead of leaving the stale printer loading message", async () => {
  const api = createApi();
  api.preview.mockResolvedValueOnce({
    ok: false,
    error: { code: "EXPORT_FAILED", message: "打印预览生成失败。" },
  });

  renderPrintCenter(api);

  expect(await screen.findByText("打印预览生成失败。")).toBeDefined();
  expect(screen.queryByText("正在加载打印机……")).toBeNull();
});

test("opens fixed system printer settings and discards the preview on cancel", async () => {
  const { api, onClose } = renderPrintCenter();
  const user = userEvent.setup();
  await screen.findByText("第 1 / 6 页");

  await user.click(screen.getByRole("button", { name: "更多设置" }));
  await user.click(screen.getByRole("button", { name: "打开系统打印机设置" }));
  await user.click(screen.getByRole("button", { name: "取消" }));

  expect(api.openPrinterSettings).toHaveBeenCalledOnce();
  expect(api.discardPreview).toHaveBeenCalledWith(PREVIEW_ID);
  expect(onClose).toHaveBeenCalledOnce();
});

test("protects the print center close controls while printing", async () => {
  const api = createApi();
  api.print.mockImplementation(() => new Promise(() => undefined));
  renderPrintCenter(api);
  const user = userEvent.setup();
  await screen.findByText("第 1 / 6 页");

  await user.click(screen.getByRole("button", { name: "打印" }));
  await screen.findByRole("button", { name: "正在打印……" });

  expect((screen.getByRole("button", { name: "关闭打印中心" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
});

test("keeps generating the preview when the default preload API is exposed through fresh proxy objects", async () => {
  const api = createApi();
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, "patentApi");
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    get: () => ({ exports: { ...api } }),
  });

  try {
    render(
      <PrintCenter
        sessionId="5d5c49f1-5f4c-4e70-9326-dd7e17d68a41"
        document={createBlankDocument("默认接口打印测试")}
        suggestedName="默认接口打印测试"
        preferences={{
          printerDeviceName: null,
          duplexMode: "simplex",
          color: true,
          orientation: "portrait",
          paperSize: "A4",
        }}
        onClose={vi.fn()}
        onExportReport={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(pdfRenderer.render).toHaveBeenCalledOnce());
    expect(api.listPrinters).toHaveBeenCalledOnce();
    expect(api.preview).toHaveBeenCalledOnce();
  } finally {
    if (originalDescriptor) Object.defineProperty(window, "patentApi", originalDescriptor);
    else Reflect.deleteProperty(window, "patentApi");
  }
});
