import { IPC_CHANNELS } from "../../shared/ipc/contract.js";
import {
  TemporaryBatchBeginSchema,
  TemporaryBatchPsdSchema,
  TemporaryBatchRasterSchema,
  TemporaryBatchTokenSchema,
  TemporaryPsdDecodeSchema,
  TemporaryPsdExportSchema,
  TemporaryRasterDecodeSchema,
  TemporaryRasterExportSchema,
} from "../../shared/ipc/temporary-images.js";
import type { TemporaryImageBatch } from "./temporary-image-batch.js";
import type { TemporaryImageFiles } from "./temporary-image-files.js";
import type { TemporaryImageJobs } from "./temporary-image-jobs.js";

/** Deliberately accepts neither a case session nor an asset store. */
export function registerTemporaryImageIpc(
  register: (channel: string, handler: (...args: unknown[]) => unknown) => void,
  jobs: Pick<TemporaryImageJobs, "decode"> & Partial<Pick<TemporaryImageJobs, "decodePsd">>,
  files: Pick<TemporaryImageFiles, "exportRaster"> &
    Partial<Pick<TemporaryImageFiles, "exportPsd">>,
  failure: (error: unknown) => unknown,
  batch?: TemporaryImageBatch,
) {
  register(IPC_CHANNELS.imageEditorBeginBatch, async (_event, input) => {
    try {
      if (!batch) throw new Error("当前平台不支持批量导出。");
      return { ok: true, value: await batch.begin(TemporaryBatchBeginSchema.parse(input)) };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.imageEditorWriteBatchRaster, async (_event, input) => {
    try {
      if (!batch) throw new Error("当前平台不支持批量导出。");
      return { ok: true, value: await batch.writeRaster(TemporaryBatchRasterSchema.parse(input)) };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.imageEditorWriteBatchPsd, async (_event, input) => {
    try {
      if (!batch) throw new Error("当前平台不支持批量导出。");
      return { ok: true, value: await batch.writePsd(TemporaryBatchPsdSchema.parse(input)) };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.imageEditorFinishBatch, async (_event, input) => {
    try {
      if (!batch) throw new Error("当前平台不支持批量导出。");
      batch.finish(TemporaryBatchTokenSchema.parse(input).token);
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.imageEditorDecodePsd, async (_event, input) => {
    try {
      if (!jobs.decodePsd) throw new Error("PSD导入尚未提供。");
      return { ok: true, value: await jobs.decodePsd(TemporaryPsdDecodeSchema.parse(input)) };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.imageEditorExportPsd, async (_event, input) => {
    try {
      if (!files.exportPsd) throw new Error("PSD导出尚未提供。");
      return { ok: true, value: await files.exportPsd(TemporaryPsdExportSchema.parse(input)) };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.imageEditorDecodeRaster, async (_event, input) => {
    try {
      const value = await jobs.decode(TemporaryRasterDecodeSchema.parse(input));
      return { ok: true, value };
    } catch (error) {
      return failure(error);
    }
  });
  register(IPC_CHANNELS.imageEditorExportRaster, async (_event, input) => {
    try {
      const value = await files.exportRaster(TemporaryRasterExportSchema.parse(input));
      return { ok: true, value };
    } catch (error) {
      return failure(error);
    }
  });
}
