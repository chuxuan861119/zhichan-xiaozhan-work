import { IPC_CHANNELS } from "../../shared/ipc/contract.js";
import type { AppResult } from "../../shared/ipc/result.js";
import {
  type FolderFormat,
  folderExportItems,
  type PatentFolderEntry,
  PatentFolderExportRequestSchema,
  patentFolderEntries,
} from "../../shared/patent/folder.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { createFolderExport, folderFileNames } from "../exports/patent-folder-export.js";
import type { RegisterLibraryIpcOptions } from "../library/register-library-ipc.js";
import { writeExportFile } from "../platform/atomic-export-write.js";
import { type OwnedDialogEvent, showOwnedSaveDialog } from "./owned-native-dialog.js";

export function registerPatentFolderIpc(
  register: (
    channel: string,
    handler: (event: unknown, input?: unknown) => Promise<AppResult<string | null>>,
  ) => void,
  options: {
    patents: RegisterLibraryIpcOptions["patents"];
    requireSession(sessionId: string, patentId: string): void;
    render(
      patent: CanonicalPatent,
      sessionId: string,
      entry: PatentFolderEntry,
      format: FolderFormat,
      cad: { projectId: string; bytes: Uint8Array }[],
    ): Promise<Uint8Array>;
  },
) {
  let busy = false;
  register(IPC_CHANNELS.patentsExportFolder, async (event, input) => {
    if (busy)
      return { ok: false, error: { code: "OPERATION_IN_PROGRESS", message: "正在导出，请稍候。" } };
    busy = true;
    try {
      const request = PatentFolderExportRequestSchema.parse(input);
      options.requireSession(request.sessionId, request.patentId);
      const service = options.patents;
      if (!service) throw new Error("专利服务不可用。");
      const patent = await service.loadForExport(request);
      // Validate the selection before showing a save dialog or invoking any renderer.
      const entries = patentFolderEntries(patent);
      const selected = folderExportItems(
        entries,
        request.items.map((i) => i.key),
        request.items.length === 1 ? request.items[0]!.format : undefined,
      );
      if (selected.some((i, n) => i.format !== request.items[n]!.format))
        throw new Error("批量导出格式无效。");
      const item = entries.find((e) => e.key === selected[0]!.key)!;
      const extension = request.items.length > 1 ? "zip" : selected[0]!.format;
      const name = folderFileNames([
        {
          name: request.items.length > 1 ? (patent.name ?? "未命名专利") : item.name,
          format: extension,
        },
      ])[0]!;
      const result = await showOwnedSaveDialog(event as OwnedDialogEvent, {
        title: "导出专利文件",
        defaultPath: name,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      if (result.canceled || !result.filePath) return { ok: true, value: null };
      const output = await createFolderExport(patent, request.items, (entry, format) =>
        options.render(patent, request.sessionId, entry, format, request.cad),
      );
      // Reject if the document changed while a dialog or expensive conversion was running.
      options.requireSession(request.sessionId, request.patentId);
      await service.loadForExport(request);
      const path = result.filePath.toLowerCase().endsWith(`.${extension}`)
        ? result.filePath
        : `${result.filePath}.${extension}`;
      await writeExportFile(path, Buffer.from(output.bytes));
      return { ok: true, value: path };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "EXPORT_FAILED",
          message: error instanceof Error ? error.message : "文件导出失败，请重试。",
        },
      };
    } finally {
      busy = false;
    }
  });
}
