import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { z } from "zod";
import type { AutomationBundleExportSchema } from "../../shared/automation/bundles.js";
import { AutomationError } from "../../shared/automation/protocol.js";
import type { ExportIssue } from "../../shared/exports/report.js";
import { collectPatentStructureIssues } from "../../shared/patent/document-structure-ruler.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { patdocRestoreBytes } from "../documents/patdoc-history.js";
import { writePatdoc } from "../documents/patdoc-writer.js";
import { writePatentBundle } from "../documents/patent-bundle.js";
import { fiveBookPatent } from "../documents/patent-bundle-service.js";
import { createPatentDocxPackage } from "../exports/patent-docx-exporter.js";
import { createPatentPrintPackage } from "../exports/patent-print-template.js";
import type { LibraryRuntime } from "../library/library-runtime.js";
import type { AutomationExportContext } from "./export.js";
import { allowedPath, privateDirectory } from "./paths.js";
import { publishAutomationBytes } from "./publish.js";

export async function exportAutomationBundle(
  runtime: LibraryRuntime,
  home: string,
  patents: CanonicalPatent[],
  input: z.infer<typeof AutomationBundleExportSchema>,
  context: AutomationExportContext,
  pdf?: (html: string, sessionId: string) => Promise<Uint8Array>,
) {
  if (extname(input.output).toLowerCase() !== ".zip")
    throw new AutomationError("INVALID_PATH", "专利包输出扩展名必须是 .zip。");
  allowedPath(input.output, [context.grant.workspace.exportDirectory], true);
  const parent = await privateDirectory(join(home, "bundle-temp"));
  const root = await mkdtemp(join(parent, "export-"));
  const warnings: Array<{ code: string; message: string; severity: string }> = [];
  const files: Array<{ name: string; file: string; native: string }> = [];
  let restoreBytes = 0;
  const checkWarnings = () => {
    if (warnings.some((w) => w.severity === "error"))
      throw new AutomationError("EXPORT_BLOCKED", "专利包存在阻断问题。", { issues: warnings });
    const declined = warnings.filter((w) => !input.acceptWarnings.includes(w.code));
    if (declined.length)
      throw new AutomationError("EXPORT_WARNINGS", "请在 acceptWarnings 中列出接受的警告代码。", {
        issues: declined,
      });
  };
  try {
    for (const [index, source] of patents.entries()) {
      context.assertAuthorized();
      const patent = fiveBookPatent(source);
      const release = await runtime.assetStore.leaseSnapshotAssets(
        patent.assets.map((a) => a.assetId),
      );
      try {
        const assets = await Promise.all(
          patent.assets.map((a) => runtime.assetStore.readAsset(a.assetId)),
        );
        const flowcharts = patent.flowchartProjects.map((project) => {
          const saved = runtime.flowchartSourceStore.loadCurrent(
            patent.patentId,
            project.projectId,
          );
          if (saved.revision !== project.revision)
            throw new AutomationError("REVISION_CONFLICT", "流程图版本已变化。");
          return { projectId: project.projectId, source: saved.source };
        });
        const payload = { patent, assets, flowcharts };
        restoreBytes += patdocRestoreBytes(payload);
        if (restoreBytes > 256 * 1024 * 1024)
          throw new AutomationError("TOO_LARGE", "专利包还原数据超过 256 MiB，请分批输出。");
        const native = join(root, `${index}.patdoc`);
        await writePatdoc(native, payload);
        const file = input.format === "patdoc" ? native : join(root, `${index}.${input.format}`);
        const report = (issues: ExportIssue[]) =>
          warnings.push(
            ...issues.map((issue) => ({
              ...issue,
              message: `${patent.name ?? "未命名专利"}：${issue.message}`,
            })),
          );
        if (input.format !== "patdoc") {
          warnings.push(
            ...collectPatentStructureIssues(patent).map((issue) => ({
              code: issue.kind,
              severity: "warning",
              message: `${patent.name ?? "未命名专利"}：${issue.summary}`,
            })),
          );
          checkWarnings();
        }
        if (input.format === "docx") {
          const result = await createPatentDocxPackage({ patent, mode: "combined" }, assets);
          report(result.issues);
          checkWarnings();
          await writeFile(file, result.buffer, { flag: "wx", mode: 0o600 });
        } else if (input.format === "pdf") {
          if (!pdf) throw new AutomationError("UNAVAILABLE", "PDF 渲染服务不可用。");
          const result = await createPatentPrintPackage({ patent, assets, mode: "combined" });
          report(result.issues);
          checkWarnings();
          context.assertAuthorized();
          await writeFile(file, await pdf(result.html, context.record.operationId), {
            flag: "wx",
            mode: 0o600,
          });
        }
        files.push({ name: patent.name ?? "未命名专利", file, native });
      } finally {
        release();
      }
    }
    context.assertAuthorized();
    const archive = join(root, "bundle.zip");
    await writePatentBundle(archive, input.format, files);
    return await publishAutomationBytes(
      await readFile(archive),
      input.output,
      "zip",
      0,
      context,
      warnings,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
