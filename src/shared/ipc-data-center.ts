import { z } from "zod";

export const IPC_DATA_ORIGIN = "patent-ipc://center";
export const IpcReportRequestSchema = z
  .object({
    png: z
      .string()
      .max(24 * 1024 * 1024)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u),
    filename: z
      .string()
      .min(1)
      .max(100)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows file names must reject control characters.
      .regex(/^[^<>:"/\\|?*\u0000-\u001f]+\.png$/iu),
  })
  .strict();
export type IpcReportRequest = z.infer<typeof IpcReportRequestSchema>;

export const IpcFrameMessageSchema = z.discriminatedUnion("action", [
  z
    .object({
      source: z.literal("ipc-data-center"),
      action: z.literal("copy"),
      id: z.number().int().nonnegative(),
      text: z.string().max(1_000_000),
    })
    .strict(),
  z
    .object({
      source: z.literal("ipc-data-center"),
      action: z.literal("save-report"),
      id: z.number().int().nonnegative(),
      report: IpcReportRequestSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("ipc-data-center"),
      action: z.enum(["ready", "failed", "interact", "close"]),
    })
    .strict(),
]);

export function isIpcDataPageUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return (
      url.protocol === "patent-ipc:" &&
      url.host === "center" &&
      url.pathname === "/index.html" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
