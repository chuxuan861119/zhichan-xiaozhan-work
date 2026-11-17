import sharp from "sharp";
import { IpcReportRequestSchema } from "../../shared/ipc-data-center.js";
import { writeExportFile } from "../platform/atomic-export-write.js";

export async function saveIpcReport(
  input: unknown,
  choosePath: (filename: string) => Promise<string | null>,
): Promise<string | null> {
  const request = IpcReportRequestSchema.parse(input);
  const bytes = Buffer.from(request.png.slice("data:image/png;base64,".length), "base64");
  const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  if (metadata.format !== "png") throw new Error("报告图片格式无效。");
  const path = await choosePath(request.filename);
  if (!path) return null;
  await writeExportFile(path, bytes);
  return path;
}
