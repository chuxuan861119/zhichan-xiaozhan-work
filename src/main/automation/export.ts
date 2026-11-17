import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import { AutomationError, type ResolvedAutomationScope } from "../../shared/automation/protocol.js";
import { auxiliaryExportDocument } from "../../shared/exports/patent-export-scope.js";
import { collectPatentStructureIssues } from "../../shared/patent/document-structure-ruler.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { AssetStore as SessionAssetStore } from "../assets/asset-store.js";
import { writePatdoc } from "../documents/patdoc-writer.js";
import { createDocxPackage } from "../exports/docx-exporter.js";
import { createPatentDocxPackage } from "../exports/patent-docx-exporter.js";
import { createPatentPrintPackage } from "../exports/patent-print-template.js";
import { renderPrintHtml } from "../exports/print-template.js";
import type { LibraryRuntime } from "../library/library-runtime.js";
import type { AutomationLedger, OperationRecord } from "./ledger.js";
import { allowedPath, publishNewFile } from "./paths.js";

export type AutomationExportContext = {
  signal: AbortSignal;
  grant: ResolvedAutomationScope;
  record: OperationRecord;
  ledger: AutomationLedger;
  assertAuthorized(): void;
};
export type PublicationEvidence = {
  phase: "publishing";
  target: string;
  temp: string;
  hash: string;
  size: number;
  device: string;
  inode: string;
  revision: number;
  format: string;
  warnings: unknown[];
};
export async function exportAutomationPatent(
  runtime: LibraryRuntime,
  pdf: (html: string, sessionId: string) => Promise<Uint8Array>,
  patent: CanonicalPatent,
  payload: Record<string, unknown>,
  context: AutomationExportContext,
): Promise<unknown> {
  const request = z
    .object({
      patentId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
      format: z.enum(["docx", "pdf", "patdoc"]),
      output: z.string().min(1),
      bookKind: z
        .enum(["claims", "description", "description-drawings", "abstract", "abstract-drawing"])
        .optional(),
      auxiliaryDocumentId: z.string().uuid().optional(),
      acceptWarnings: z.array(z.string()).max(100).default([]),
      persisted: z.boolean().optional(),
    })
    .strict()
    .parse(payload);
  if (extname(request.output).toLowerCase() !== `.${request.format}`)
    throw new AutomationError("INVALID_PATH", "输出文件扩展名必须与格式一致。");
  if (request.auxiliaryDocumentId && request.bookKind)
    throw new AutomationError("INVALID_INPUT", "不能同时选择书册和其他文档。");
  if (request.format === "patdoc" && (request.bookKind || request.auxiliaryDocumentId))
    throw new AutomationError("INVALID_INPUT", "patdoc 保存完整专利，不能选择单书。");
  const target = allowedPath(request.output, [context.grant.workspace.exportDirectory], true);
  const temp = join(dirname(target), `.zxw-${context.record.operationId}-${randomUUID()}.tmp`);
  const release = await runtime.assetStore.leaseSnapshotAssets(patent.assets.map((a) => a.assetId));
  let published = false;
  const sessionAssets = new SessionAssetStore();
  sessionAssets.createSession(context.record.operationId);
  try {
    context.assertAuthorized();
    const flowcharts = patent.flowchartProjects.map((project) => {
      const source = runtime.flowchartSourceStore.loadCurrent(patent.patentId, project.projectId);
      if (source.revision !== project.revision)
        throw new AutomationError("REVISION_CONFLICT", "流程图版本已变化，请重新导出。");
      return { projectId: project.projectId, source: source.source };
    });
    const assets = await Promise.all(
      patent.assets.map((a) => runtime.assetStore.readAsset(a.assetId)),
    );
    for (const asset of assets) sessionAssets.put(context.record.operationId, asset);
    const auxiliary = request.auxiliaryDocumentId
      ? auxiliaryExportDocument(patent, request.auxiliaryDocumentId)
      : null;
    const warnings: Array<{ code: string; message: string; severity: string }> = (
      auxiliary ? [] : collectPatentStructureIssues(patent)
    ).map((issue) => ({
      code: issue.kind,
      message: issue.summary,
      severity: "warning",
    }));
    let buffer: Uint8Array | undefined;
    if (request.format === "docx") {
      const packageResult = auxiliary
        ? await createDocxPackage(
            { sessionId: context.record.operationId, document: auxiliary },
            sessionAssets,
          )
        : await createPatentDocxPackage(
            request.bookKind
              ? { patent, mode: "single", bookKind: request.bookKind }
              : { patent, mode: "combined" },
            assets,
          );
      warnings.push(...packageResult.issues);
      buffer = packageResult.buffer;
    } else if (request.format === "pdf") {
      const packageResult = auxiliary
        ? {
            html: await renderPrintHtml(auxiliary, assets, {
              onIssue: (issue) => warnings.push(issue),
            }),
            issues: [],
          }
        : await createPatentPrintPackage(
            request.bookKind
              ? { patent, assets, mode: "single", bookKind: request.bookKind }
              : { patent, assets, mode: "combined" },
          );
      warnings.push(...packageResult.issues);
      if (warnings.some((w) => w.severity === "error"))
        throw new AutomationError("EXPORT_BLOCKED", "导出存在阻断问题。", { issues: warnings });
      const declined = warnings.filter((w) => !request.acceptWarnings.includes(w.code));
      if (declined.length)
        throw new AutomationError(
          "EXPORT_WARNINGS",
          "可在 acceptWarnings 中列出接受的警告代码后重试。",
          {
            issues: declined,
          },
        );
      context.assertAuthorized();
      buffer = await pdf(packageResult.html, context.record.operationId);
    }
    if (warnings.some((w) => w.severity === "error"))
      throw new AutomationError("EXPORT_BLOCKED", "导出存在阻断问题。", { issues: warnings });
    const declined = warnings.filter((w) => !request.acceptWarnings.includes(w.code));
    if (declined.length)
      throw new AutomationError(
        "EXPORT_WARNINGS",
        "可在 acceptWarnings 中列出接受的警告代码后重试。",
        {
          issues: declined,
        },
      );
    context.assertAuthorized();
    if (request.format === "patdoc") {
      await writePatdoc(temp, { patent, assets, flowcharts });
    } else if (buffer) await writeFile(temp, buffer, { flag: "wx", mode: 0o600 });
    const handle = await open(temp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const bytes = await readFile(temp);
    const info = await stat(temp, { bigint: true });
    const hash = createHash("sha256").update(bytes).digest("hex");
    const evidence: PublicationEvidence = {
      phase: "publishing",
      target,
      temp,
      hash,
      size: bytes.length,
      device: info.dev.toString(),
      inode: info.ino.toString(),
      revision: patent.revision,
      format: request.format,
      warnings,
    };
    // Synchronous authorization + no-clobber publication + receipt ordering, with no renderer wait.
    context.assertAuthorized();
    context.ledger.update(context.record, "running", null, evidence);
    publishNewFile(temp, target, [context.grant.workspace.exportDirectory]);
    published = true;
    const result = {
      path: target,
      revision: patent.revision,
      format: request.format,
      sha256: hash,
      warnings,
    };
    context.ledger.update(context.record, "committed", result, evidence);
    return result;
  } catch (error) {
    // Before publication, absence of final side effect is known; do not leave an ambiguous receipt.
    if (!published) context.ledger.update(context.record, "running", null, null);
    throw error;
  } finally {
    try {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } finally {
      sessionAssets.destroySession(context.record.operationId);
      release();
    }
  }
}
