import {
  mapPrintError,
  PrintCancelledError,
  PrintDriverSettingsError,
  PrintPreviewUnavailableError,
  PrintPrinterUnavailableError,
  PrintTimeoutError,
} from "./print-error.js";

test("maps known print failures without hiding unrelated failures", () => {
  expect(mapPrintError(new PrintTimeoutError("PDF 生成超时，请重试或分文档导出。"))).toEqual({
    ok: false,
    error: { code: "INTERNAL", message: "PDF 生成超时，请重试或分文档导出。" },
  });
  expect(mapPrintError(new PrintCancelledError())).toEqual({
    ok: false,
    error: { code: "CANCELLED", message: "打印已取消。" },
  });
  expect(mapPrintError(new PrintPreviewUnavailableError())).toEqual({
    ok: false,
    error: { code: "NOT_FOUND", message: "打印预览已失效，请重新生成预览。" },
  });
  expect(mapPrintError(new PrintPrinterUnavailableError("office-printer"))).toEqual({
    ok: false,
    error: { code: "NOT_FOUND", message: "打印机不可用：office-printer" },
  });
  expect(mapPrintError(new PrintDriverSettingsError("Invalid printer settings"))).toEqual({
    ok: false,
    error: { code: "INVALID_INPUT", message: "打印机拒绝了当前设置：Invalid printer settings" },
  });
  expect(mapPrintError(new Error("printer unavailable"))).toBeNull();
});
