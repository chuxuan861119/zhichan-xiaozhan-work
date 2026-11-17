import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join, win32 } from "node:path";
import { z } from "zod";
import { RendererFailureLocationSchema } from "../../shared/ipc/renderer-failure-location.js";
import { AppErrorCodeSchema } from "../../shared/ipc/result.js";
import { CorrectionResponseDiagnosticSchema } from "../ai-correction/response-diagnostic.js";

const MAX_LOG_BYTES = 1024 * 1024;
const RETAINED_LOG_FILES = 7;

const LogLevelSchema = z.enum(["info", "warn", "error"]);
const SafeLogEventSchema = z.enum([
  "app.started",
  "ai.correction_response",
  "app.error",
  "app.start_failed",
  "document.opened",
  "document.open_failed",
  "document.saved",
  "document.save_failed",
  "draft.saved",
  "draft.save_failed",
  "export.completed",
  "export.failed",
  "library.edit_saved",
  "library.export_failed",
  "library.imported",
  "library.recovery_read_only",
  "security.outbound_blocked",
  "window.load_failed",
  "window.renderer_gone",
  "window.renderer_failure",
  "window.renderer_recovered",
  "window.renderer_responsive",
  "window.renderer_unresponsive",
]);
const SafeLogInputSchema = z.object({
  event: SafeLogEventSchema,
  aiCorrection: CorrectionResponseDiagnosticSchema.optional(),
  errorCode: AppErrorCodeSchema.optional(),
  path: z.string().max(32_767).optional(),
  libraryDocumentId: z.string().uuid().optional(),
  revision: z.number().int().nonnegative().optional(),
  failureKind: z.enum(["type-error", "reference-error", "render-loop", "other"]).optional(),
  locations: z.array(RendererFailureLocationSchema).max(3).optional(),
});

export type SafeLogInput = z.input<typeof SafeLogInputSchema>;

export function redactWindowsPath(candidate: string): string | undefined {
  if (/^[a-zA-Z]:[\\/]/u.test(candidate)) {
    const name = win32.basename(candidate.replaceAll("/", "\\"));
    return name ? `<drive>:\\…\\${name}` : undefined;
  }
  if (/^\\\\[^\\/]+[\\/][^\\/]+[\\/]/u.test(candidate)) {
    const name = win32.basename(candidate.replaceAll("/", "\\"));
    return name ? `<network>:\\…\\${name}` : undefined;
  }
  return undefined;
}

function shortenLibraryDocumentId(libraryDocumentId: string): string {
  return `${libraryDocumentId.slice(0, 8)}…${libraryDocumentId.slice(-4)}`;
}

export class SafeLogger {
  #pending: Promise<boolean> = Promise.resolve(true);

  constructor(
    private readonly directory: string,
    private readonly appVersion: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  log(levelInput: unknown, input: unknown): Promise<boolean> {
    const level = LogLevelSchema.safeParse(levelInput);
    const parsed = SafeLogInputSchema.safeParse(input);
    if (!level.success || !parsed.success) return Promise.resolve(false);

    const record = {
      timestamp: this.now().toISOString(),
      level: level.data,
      event: parsed.data.event,
      appVersion: this.appVersion,
      ...(parsed.data.event === "ai.correction_response" && parsed.data.aiCorrection
        ? { aiCorrection: parsed.data.aiCorrection }
        : {}),
      ...(parsed.data.errorCode ? { errorCode: parsed.data.errorCode } : {}),
      ...(parsed.data.event === "window.renderer_failure" && parsed.data.failureKind
        ? { failureKind: parsed.data.failureKind }
        : {}),
      ...(parsed.data.event === "window.renderer_failure" && parsed.data.locations?.length
        ? { locations: parsed.data.locations }
        : {}),
      ...(parsed.data.event.startsWith("library.") && parsed.data.libraryDocumentId
        ? { libraryDocumentId: shortenLibraryDocumentId(parsed.data.libraryDocumentId) }
        : {}),
      ...(parsed.data.event.startsWith("library.") && parsed.data.revision !== undefined
        ? { revision: parsed.data.revision }
        : {}),
      ...(parsed.data.path && !parsed.data.event.startsWith("library.")
        ? { redactedPath: redactWindowsPath(parsed.data.path) }
        : {}),
    };
    const safeRecord = Object.fromEntries(
      Object.entries(record).filter((entry) => entry[1] !== undefined),
    );
    const line = `${JSON.stringify(safeRecord)}\n`;
    const operation = this.#pending.then(() => this.#write(line)).catch(() => false);
    this.#pending = operation;
    return operation;
  }

  async #write(line: string): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });
    const currentPath = join(this.directory, "app.log");
    let currentSize = 0;
    try {
      currentSize = (await stat(currentPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentSize > 0 && currentSize + Buffer.byteLength(line, "utf8") > MAX_LOG_BYTES) {
      await this.#rotate();
    }
    await appendFile(currentPath, line, { encoding: "utf8" });
    return true;
  }

  async #rotate(): Promise<void> {
    for (const name of await readdir(this.directory)) {
      const match = /^app\.(\d+)\.log$/u.exec(name);
      if (match && Number(match[1]) >= RETAINED_LOG_FILES - 1) {
        await unlink(join(this.directory, name)).catch(() => undefined);
      }
    }
    for (let index = RETAINED_LOG_FILES - 2; index >= 1; index -= 1) {
      await rename(
        join(this.directory, `app.${index}.log`),
        join(this.directory, `app.${index + 1}.log`),
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rename(join(this.directory, "app.log"), join(this.directory, "app.1.log")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
}

export function createSafeLogger(
  directory: string,
  appVersion: string,
  now?: () => Date,
): SafeLogger {
  return new SafeLogger(directory, appVersion, now);
}
