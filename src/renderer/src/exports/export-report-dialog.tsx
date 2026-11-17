import type { ExportReport } from "../../../shared/exports/report";
import { StandardDialog } from "../shared/standard-dialog";

type ExportReportDialogProps = {
  report: ExportReport;
  onClose(): void;
};

export function ExportReportDialog({ report, onClose }: ExportReportDialogProps) {
  const failed = report.issues.some((issue) => issue.severity === "error");
  const successful = !failed && report.issues.length === 0;
  const formatLabel = { docx: "DOCX", pdf: "PDF", patdoc: "PATDOC" }[report.format];
  const title = failed
    ? `${formatLabel} 导出失败`
    : successful
      ? `${formatLabel} 导出成功`
      : `${formatLabel} 导出报告`;
  return (
    <StandardDialog
      open
      title={title}
      size="m"
      onCancel={onClose}
      movable
      bodyClassName="export-report-dialog__body"
      footer={
        <button type="button" className="primary-button" onClick={onClose}>
          {successful ? "确认" : "关闭"}
        </button>
      }
    >
      <p>{failed ? "未写入目标文件：" : "文件已导出到："}</p>
      <output className="export-output-path">{report.outputPath}</output>
      {report.issues.length > 0 ? (
        <ul className="export-issue-list">
          {report.issues.map((issue) => (
            <li key={`${issue.code}-${issue.nodeId ?? "document"}-${issue.message}`}>
              <strong>{issue.severity === "error" ? "错误" : "提示"}</strong>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="export-success-message" role="status">
          导出成功。
        </p>
      )}
    </StandardDialog>
  );
}
