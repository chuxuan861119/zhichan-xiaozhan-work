import { mkdtemp, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { AutomationError } from "../../shared/automation/protocol.js";
import { AutomationTransferExportSchema } from "../../shared/automation/transfer.js";
import type { FullDataExportService } from "../data-transfer/full-data-export-service.js";
import type { AutomationExportContext } from "./export.js";
import { allowedPath, privateDirectory } from "./paths.js";
import { publishAutomationFile } from "./publish.js";

export type AutomationTransferServices = {
  inspect(): Promise<unknown>;
  exportPackage: FullDataExportService["export"];
};

export async function exportAutomationTransfer(
  home: string,
  services: AutomationTransferServices,
  payload: Record<string, unknown>,
  context: AutomationExportContext,
): Promise<unknown> {
  const input = AutomationTransferExportSchema.parse(payload);
  context.assertAuthorized();
  if (extname(input.output).toLowerCase() !== ".zxwbackup")
    throw new AutomationError("INVALID_PATH", "完整数据包扩展名必须是 .zxwbackup。");
  allowedPath(input.output, [context.grant.workspace.exportDirectory], true);
  const root = await privateDirectory(join(home, "transfer-export"));
  const staging = await mkdtemp(join(root, "package-"));
  try {
    context.assertAuthorized();
    const result = await services.exportPackage({
      operationId: context.record.operationId,
      finalPath: join(staging, "data.zxwbackup"),
      password: input.password,
      passwordHint: input.passwordHint,
      passwordRecorded: true,
      signal: context.signal,
      onProgress: (progress) => {
        context.assertAuthorized();
        context.ledger.update(context.record, "running", {
          progress: {
            phase: progress.phase,
            processedBytes: progress.processedBytes,
            totalBytes: progress.totalBytes,
          },
        });
      },
    });
    context.assertAuthorized();
    return await publishAutomationFile(result.finalPath, input.output, "zxwbackup", 0, context, [
      ...result.warnings,
    ]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
