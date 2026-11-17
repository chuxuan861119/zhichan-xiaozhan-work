import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExportReport } from "../../../shared/exports/report";
import { ExportReportDialog } from "./export-report-dialog";

test("shows the local output path and export issues", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const report: ExportReport = {
    format: "docx",
    outputPath: "C:\\exports\\reference.docx",
    issues: [
      {
        severity: "warning",
        code: "UNSUPPORTED_STYLE",
        nodeId: null,
        message: "某个样式已使用兼容表示。",
      },
    ],
  };

  render(<ExportReportDialog report={report} onClose={onClose} />);

  expect(
    screen.getByRole("dialog", { name: "DOCX 导出报告" }).classList.contains("standard-dialog--m"),
  ).toBe(true);
  expect(screen.getByText(report.outputPath)).toBeDefined();
  expect(screen.getByText("某个样式已使用兼容表示。")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "关闭" }));
  expect(onClose).toHaveBeenCalledOnce();
});

test("shows a green success confirmation when export has no issues", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const report: ExportReport = {
    format: "pdf",
    outputPath: "C:\\exports\\reference.pdf",
    issues: [],
  };

  render(<ExportReportDialog report={report} onClose={onClose} />);

  expect(screen.getByRole("dialog", { name: "PDF 导出成功" })).toBeDefined();
  expect(screen.getByText("导出成功。")).toHaveProperty("className", "export-success-message");
  expect(screen.queryByText("未发现导出问题。")).toBeNull();
  await user.click(screen.getByRole("button", { name: "确认" }));
  expect(onClose).toHaveBeenCalledOnce();
});

test("shows the saved path after a successful PATDOC export", () => {
  const report: ExportReport = {
    format: "patdoc",
    outputPath: "D:\\专利\\测试.patdoc",
    issues: [],
  };

  render(<ExportReportDialog report={report} onClose={vi.fn()} />);

  expect(screen.getByRole("dialog", { name: "PATDOC 导出成功" })).toBeDefined();
  expect(screen.getByText("D:\\专利\\测试.patdoc")).toBeDefined();
});
