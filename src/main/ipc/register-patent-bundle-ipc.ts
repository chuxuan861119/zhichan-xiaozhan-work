import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, dialog } from "electron";
import type { ExportIssue } from "../../shared/exports/report.js";
import { IPC_CHANNELS } from "../../shared/ipc/contract.js";
import {
  PatentBundleExportSchema,
  type PatentBundleResult,
} from "../../shared/ipc/patent-bundle.js";
import { collectPatentStructureIssues } from "../../shared/patent/document-structure-ruler.js";
import type { PatentPatdocPayload } from "../documents/patdoc-format.js";
import { patdocRestoreBytes } from "../documents/patdoc-history.js";
import { writePatdoc } from "../documents/patdoc-writer.js";
import { bundleFileName, writePatentBundle } from "../documents/patent-bundle.js";
import { fiveBookPatent, importPatentBundle } from "../documents/patent-bundle-service.js";
import { savePatentDocxToPath } from "../exports/patent-docx-exporter.js";
import type { RegisterLibraryIpcOptions } from "../library/register-library-ipc.js";
import { writeExportFile } from "../platform/atomic-export-write.js";
import {
  type OwnedDialogEvent,
  showOwnedOpenDialog,
  showOwnedSaveDialog,
} from "./owned-native-dialog.js";

export function registerPatentBundleIpc(
  register: (
    channel: string,
    handler: (event: unknown, input?: unknown) => Promise<PatentBundleResult>,
  ) => void,
  options: Pick<
    RegisterLibraryIpcOptions,
    "patents" | "assetStore" | "flowcharts" | "readOnly" | "snapshots"
  >,
  renderPdf: (
    payload: PatentPatdocPayload,
    sessionId: string,
    reportIssues: (issues: ExportIssue[]) => void,
  ) => Promise<Uint8Array>,
) {
  let busy = false;
  const route = (
    channel: string,
    operation: (event: OwnedDialogEvent, input: unknown) => Promise<PatentBundleResult>,
  ) => {
    register(channel, async (event, input) => {
      if (options.readOnly && channel === IPC_CHANNELS.patentsImportBundle)
        return {
          ok: false,
          error: { code: "READ_ONLY_RECOVERY", message: "当前文档库为只读状态。" },
        };
      if (busy)
        return {
          ok: false,
          error: { code: "OPERATION_IN_PROGRESS", message: "正在处理文档包，请稍候。" },
        };
      busy = true;
      try {
        return await operation(event as OwnedDialogEvent, input);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: error instanceof Error ? error.message : "文档包处理失败。",
          },
        };
      } finally {
        busy = false;
      }
    });
  };
  route(IPC_CHANNELS.patentsExportBundle, async (event, input) => {
    const request = PatentBundleExportSchema.parse(input);
    const service = options.patents;
    if (!service) throw new Error("专利库不可用。");
    const warnings: string[] = [];
    let singleName = "未命名专利";
    for (const item of request.patents) {
      await service.flush(item.patentId, item.expectedRevision);
      const opened = await service.open(item.patentId);
      try {
        const patent = await service.loadForExport({ ...item, sessionId: opened.sessionId });
        singleName = bundleFileName(patent.name ?? singleName);
        if (request.format !== "patdoc") {
          const issues = collectPatentStructureIssues(patent);
          if (issues.length)
            warnings.push(`${patent.name ?? "未命名专利"}：${issues.length} 个结构问题`);
        }
      } finally {
        await service.release(opened.sessionId);
      }
    }
    if (warnings.length) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner) throw new Error("导出窗口不可用。");
      const confirmation = await dialog.showMessageBox(owner, {
        type: "warning",
        title: "文档结构提示",
        message: "所选专利存在文档结构问题，仍然继续导出吗？",
        detail: warnings.join("\n"),
        buttons: ["取消", "仍然导出"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return { ok: true, value: null };
    }
    const extension = request.patents.length === 1 ? request.format : "zip";
    const selection = await showOwnedSaveDialog(event, {
      title: extension === "zip" ? "导出专利压缩包" : "导出专利",
      defaultPath:
        extension === "zip"
          ? `专利文档-${request.patents.length}项.zip`
          : `${singleName}.${extension}`,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (selection.canceled || !selection.filePath) return { ok: true, value: null };
    const path = selection.filePath.toLowerCase().endsWith(`.${extension}`)
      ? selection.filePath
      : `${selection.filePath}.${extension}`;
    const root = await mkdtemp(join(tmpdir(), "patent-bundle-export-"));
    const files: { name: string; file: string; native: string }[] = [];
    const issues: ExportIssue[] = [];
    let restoreBytes = 0;
    try {
      for (const [index, item] of request.patents.entries()) {
        await service.flush(item.patentId, item.expectedRevision);
        const opened = await service.open(item.patentId);
        try {
          const snapshot = await service.loadForExport({ ...item, sessionId: opened.sessionId });
          const patent = fiveBookPatent(snapshot);
          const assets = await Promise.all(
            patent.assets.map((asset) => options.assetStore.readAsset(asset.assetId)),
          );
          const flowcharts = [];
          for (const project of patent.flowchartProjects) {
            if (!options.flowcharts) throw new Error("流程图源文件服务不可用。");
            flowcharts.push({
              projectId: project.projectId,
              source: await options.flowcharts.exportBackup(patent.patentId, project.projectId),
            });
          }
          await service.loadForExport({ ...item, sessionId: opened.sessionId });
          const payload = { patent, assets, flowcharts };
          await service.loadForExport({ ...item, sessionId: opened.sessionId });
          restoreBytes += patdocRestoreBytes(payload);
          if (extension === "zip" && request.format !== "pdf" && restoreBytes > 256 * 1024 * 1024)
            throw new Error("还原数据超过 256 MiB，请减少选择的专利数量。");
          const native = join(root, `${index}.patdoc`);
          await writePatdoc(native, payload);
          const file =
            request.format === "patdoc" ? native : join(root, `${index}.${request.format}`);
          const reportIssues = (reported: ExportIssue[]) =>
            issues.push(
              ...reported.map((issue) => ({
                ...issue,
                message: `${patent.name ?? "未命名专利"}：${issue.message}`,
              })),
            );
          if (request.format === "docx")
            reportIssues(
              (await savePatentDocxToPath(file, { patent, mode: "combined" }, assets)).issues,
            );
          if (request.format === "pdf")
            await writeFile(file, await renderPdf(payload, randomUUID(), reportIssues), {
              flag: "wx",
            });
          files.push({ name: patent.name ?? "未命名专利", file, native });
        } finally {
          await service.release(opened.sessionId);
        }
      }
      if (extension === "zip") await writePatentBundle(path, request.format, files);
      else await writeExportFile(path, await readFile(files[0]!.file));
      return {
        ok: true,
        value: { count: files.length, path, ...(issues.length ? { issues } : {}) },
      };
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  route(IPC_CHANNELS.patentsImportBundle, async (event, input) => {
    if (input !== undefined) throw new Error("导入参数无效。");
    const service = options.patents;
    if (!service?.hasImportedBundle || !service.importBundle)
      throw new Error("批量导入服务不可用。");
    const selection = await showOwnedOpenDialog(event, {
      title: "导入专利压缩包",
      properties: ["openFile"],
      filters: [{ name: "本软件导出的 PATDOC / DOCX 压缩包", extensions: ["zip"] }],
    });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return { ok: true, value: null };
    const count = await importPatentBundle(
      path,
      {
        hasImportedBundle: service.hasImportedBundle.bind(service),
        importBundle: service.importBundle.bind(service),
      },
      options.assetStore,
      async () => {
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner) return false;
        const result = await dialog.showMessageBox(owner, {
          type: "question",
          title: "重复导入",
          message: "这个压缩包已经导入过。是否再创建一份独立副本？",
          buttons: ["取消", "再次导入"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return result.response === 1;
      },
    );
    return { ok: true, value: count === null ? null : { count } };
  });
}
