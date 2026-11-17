import type { ExportIssue } from "./report.js";

const SAFE_TABLE_ERRORS = new Set([
  "表格合并范围超出持久化网格。",
  "表格行未覆盖完整的持久化网格。",
]);

export function publicDocxExportIssue(issue: ExportIssue): ExportIssue {
  if (issue.code !== "EXPORT_FAILED") return issue;
  return {
    ...issue,
    message: SAFE_TABLE_ERRORS.has(issue.message)
      ? `${issue.message}请检查表格的列数及合并单元格。`
      : "DOCX 导出失败。",
  };
}
