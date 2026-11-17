import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import type { PreviousShutdownStatus } from "../../shared/recovery/startup-recovery.js";

const MAX_RUN_STATE_BYTES = 32 * 1024;

const PersistedRunStateSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().uuid(),
    appVersion: z.string().trim().min(1).max(100),
    startedAt: z.string().datetime(),
    cleanShutdown: z.boolean(),
    finishedAt: z.string().datetime().nullable(),
  })
  .strict();

type PersistedRunState = z.infer<typeof PersistedRunStateSchema>;

export type BeginRunResult = {
  previousShutdown: PreviousShutdownStatus;
  runId: string;
};

type RunStateFileOptions = {
  now?: () => Date;
  randomId?: () => string;
};

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class RunStateFile {
  readonly #now: () => Date;
  readonly #randomId: () => string;
  #current: PersistedRunState | undefined;

  constructor(
    private readonly path: string,
    options: RunStateFileOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
  }

  async begin(appVersion: string): Promise<BeginRunResult> {
    const previousShutdown = await this.#readPreviousStatus();
    const startedAt = this.#now().toISOString();
    const current = PersistedRunStateSchema.parse({
      version: 1,
      runId: this.#randomId(),
      appVersion,
      startedAt,
      cleanShutdown: false,
      finishedAt: null,
    });
    await this.#write(current);
    this.#current = current;
    return { previousShutdown, runId: current.runId };
  }

  async markClean(): Promise<void> {
    if (!this.#current) throw new Error("运行尚未开始，无法记录正常退出。");
    const clean = PersistedRunStateSchema.parse({
      ...this.#current,
      cleanShutdown: true,
      finishedAt: this.#now().toISOString(),
    });
    await this.#write(clean);
    this.#current = clean;
  }

  async #readPreviousStatus(): Promise<PreviousShutdownStatus> {
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_RUN_STATE_BYTES) {
        return "unknown";
      }
      const parsed = PersistedRunStateSchema.safeParse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
      if (!parsed.success) return "unknown";
      return parsed.data.cleanShutdown ? "clean" : "unclean";
    } catch (error) {
      return isNodeError(error, "ENOENT") ? "first-run" : "unknown";
    }
  }

  async #write(state: PersistedRunState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFileAtomic(this.path, `${JSON.stringify(state)}\n`, { encoding: "utf8" });
  }
}
