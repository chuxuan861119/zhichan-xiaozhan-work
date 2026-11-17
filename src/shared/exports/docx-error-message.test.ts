import { publicDocxExportIssue } from "./docx-error-message.js";

test("preserves actionable safe table errors without exposing raw filesystem errors", () => {
  const issue = {
    severity: "error" as const,
    code: "EXPORT_FAILED" as const,
    nodeId: "table-id",
    message: "表格行未覆盖完整的持久化网格。",
  };
  expect(publicDocxExportIssue(issue).message).toContain("表格");
  expect(
    publicDocxExportIssue({ ...issue, message: "EPERM: rename C:/private/file" }).message,
  ).toBe("DOCX 导出失败。");
});
