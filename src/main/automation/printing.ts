import type { z } from "zod";
import type { AutomationPrintSchema } from "../../shared/automation/printing.js";
import { AutomationError } from "../../shared/automation/protocol.js";
import { auxiliaryExportDocument } from "../../shared/exports/patent-export-scope.js";
import { collectPatentStructureIssues } from "../../shared/patent/document-structure-ruler.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import type { PrinterDescriptor } from "../../shared/printing/model.js";
import { createPatentPrintSnapshot } from "../../shared/printing/patent-print-snapshot.js";
import type { PrintService } from "../exports/print-service.js";
import { renderPrintDocumentsHtml, renderPrintHtml } from "../exports/print-template.js";
import type { LibraryRuntime } from "../library/library-runtime.js";
import type { AutomationExportContext } from "./export.js";

export type AutomationPrinting = {
  printers(): Promise<PrinterDescriptor[]>;
  submit: PrintService["printHtmlConfigured"];
};

export async function printAutomationPatent(
  runtime: LibraryRuntime,
  patent: CanonicalPatent,
  input: z.infer<typeof AutomationPrintSchema>,
  printing: AutomationPrinting,
  context: AutomationExportContext,
) {
  context.assertAuthorized();
  const printers = await printing.printers();
  if (!printers.some((printer) => printer.deviceName === input.output.printerDeviceName))
    throw new AutomationError("PRINTER_UNAVAILABLE", "指定打印机不可用，请重新读取打印机列表。");
  const release = await runtime.assetStore.leaseSnapshotAssets(patent.assets.map((a) => a.assetId));
  try {
    const assets = await Promise.all(
      patent.assets.map((asset) => runtime.assetStore.readAsset(asset.assetId)),
    );
    const issues: Array<{ code: string; severity: string; message: string }> =
      input.auxiliaryDocumentId
        ? []
        : collectPatentStructureIssues(patent).map((issue) => ({
            code: issue.kind,
            severity: "warning",
            message: issue.summary,
          }));
    const report = (issue: { code: string; severity: string; message: string }) => {
      issues.push(issue);
    };
    let html: string;
    if (input.auxiliaryDocumentId)
      html = await renderPrintHtml(
        auxiliaryExportDocument(patent, input.auxiliaryDocumentId),
        assets,
        input.layout,
        { onIssue: report },
      );
    else {
      const snapshot = createPatentPrintSnapshot(patent, input.bookKind ?? "claims");
      html = await renderPrintDocumentsHtml(
        input.bookKind ? [snapshot.current] : snapshot.documents,
        assets,
        input.layout,
        snapshot.figureLabels,
        report,
      );
    }
    if (issues.some((issue) => issue.severity === "error"))
      throw new AutomationError("PRINT_BLOCKED", "内容存在阻断问题，未提交打印。", { issues });
    const declined = issues.filter((issue) => !input.acceptWarnings.includes(issue.code));
    if (declined.length)
      throw new AutomationError("PRINT_WARNINGS", "请列出接受的打印警告代码后重试。", {
        issues: declined,
      });
    context.assertAuthorized();
    await printing.submit(
      context.record.operationId,
      html,
      input.layout,
      input.output,
      printers.map((printer) => printer.deviceName),
      () => {
        context.assertAuthorized();
        // The OS spooler and SQLite cannot commit atomically. Never auto-repeat an uncertain print.
        context.ledger.update(context.record, "running", null, {
          kind: "print-submission",
          patentId: patent.patentId,
          revision: patent.revision,
          printer: input.output.printerDeviceName,
        });
      },
    );
    const result = {
      patentId: patent.patentId,
      revision: patent.revision,
      submitted: true,
      printer: input.output.printerDeviceName,
      warnings: issues,
    };
    context.ledger.update(context.record, "committed", result);
    return result;
  } finally {
    release();
  }
}
