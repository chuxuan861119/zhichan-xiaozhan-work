import { ExportIssueSchema } from "./report.js";

test("accepts the chemical graphic-export warning in export reports", () => {
  expect(
    ExportIssueSchema.parse({
      severity: "warning",
      code: "CHEMISTRY_RENDERED_AS_IMAGE",
      nodeId: "00000000-0000-4000-8000-000000000901",
      message: "化学方程式已按设计导出为图形；源数据已保留，可在本应用中编辑，未丢失数据。",
    }),
  ).toMatchObject({ code: "CHEMISTRY_RENDERED_AS_IMAGE" });
});
