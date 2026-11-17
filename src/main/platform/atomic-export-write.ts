import { mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { AppOperationError } from "../app-operation-error.js";
import { installNewFileWithoutClobber } from "../documents/file-service.js";
import { usesHarmonyPublicFileCopy } from "./harmony-public-files.js";

type ExportWriter = (path: string, bytes: Buffer) => Promise<void>;

export function createAtomicExportWriter(
  options: {
    platform?: string;
    isPublicPath?: (path: string) => boolean;
    temporaryRoot?: string;
    writeAtomic?: ExportWriter;
    installNewFile?: (source: string, destination: string) => Promise<void>;
  } = {},
): ExportWriter {
  const platform = options.platform ?? process.platform;
  const isPublicPath =
    options.isPublicPath ?? ((path: string) => usesHarmonyPublicFileCopy(path, platform));
  return async (path, bytes) => {
    if (!["openharmony", "ohos"].includes(platform) || !isPublicPath(path)) {
      await (options.writeAtomic ?? writeFileAtomic)(path, bytes);
      return;
    }
    // The picker selects a fresh destination. Never replace an existing public
    // file: Harmony denies rename, and truncating it would lose its safe copy.
    const directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "zxw-export-"));
    const source = join(directory, "verified-export.bin");
    try {
      const handle = await open(source, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await (options.installNewFile ?? installNewFileWithoutClobber)(source, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new AppOperationError({
            code: "UNSAFE_OVERWRITE",
            message: "无法安全覆盖已有文件，请保留原文件并选择新文件名。",
          });
        throw error;
      }
    } finally {
      await unlink(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rmdir(directory);
    }
  };
}

export const writeExportFile = createAtomicExportWriter();
