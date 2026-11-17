import { AppOperationError } from "../app-operation-error.js";

export type SuspendableService = {
  suspend(): Promise<() => Promise<void>>;
};

export type AssetDrain = {
  waitForIdle(): Promise<{ stagedSessionIds: string[] }>;
};

export type DraftDrain = {
  waitForIdle(): Promise<void>;
};

export type DataTransferQuiescenceLease = {
  release(): Promise<void>;
};

export type QuiescenceServiceName = "snapshot" | "backup" | "trash" | "assets" | "drafts";

export type QuiescencePhase = "suspend" | "drain" | "resume" | "release";

export type QuiescenceFailure = Readonly<{
  service: QuiescenceServiceName;
  phase: QuiescencePhase;
  code: "SOURCE_SAVE_FAILED";
}>;

type ResumeOperation = {
  service: Extract<QuiescenceServiceName, "snapshot" | "backup" | "trash">;
  resume: () => Promise<void>;
};

export class DataTransferQuiescenceError extends Error {
  override readonly name = "DataTransferQuiescenceError";
  readonly code = "SOURCE_SAVE_FAILED" as const;
  readonly firstFailure: QuiescenceFailure;
  readonly failures: ReadonlyArray<QuiescenceFailure>;

  constructor(firstFailure: QuiescenceFailure, failures: ReadonlyArray<QuiescenceFailure>) {
    super("Background library services could not be quiesced safely.");
    delete this.stack;
    this.firstFailure = safeFailure(firstFailure);
    this.failures = Object.freeze(failures.map(safeFailure));
  }
}

export type DataTransferQuiescenceOptions = {
  snapshot: SuspendableService;
  backup: SuspendableService;
  trash: SuspendableService;
  assets: AssetDrain;
  drafts: DraftDrain;
};

function operationError(code: "OPERATION_IN_PROGRESS" | "SOURCE_SAVE_FAILED"): AppOperationError {
  return new AppOperationError({ code, message: "normalized" });
}

function safeFailure(failure: QuiescenceFailure): QuiescenceFailure {
  return Object.freeze({
    service: failure.service,
    phase: failure.phase,
    code: "SOURCE_SAVE_FAILED",
  });
}

function sourceFailure(service: QuiescenceServiceName, phase: QuiescencePhase): QuiescenceFailure {
  return { service, phase, code: "SOURCE_SAVE_FAILED" };
}

export class DataTransferQuiescence {
  readonly #snapshot: SuspendableService;
  readonly #backup: SuspendableService;
  readonly #trash: SuspendableService;
  readonly #assets: AssetDrain;
  readonly #drafts: DraftDrain;
  #active = false;

  constructor(options: DataTransferQuiescenceOptions) {
    this.#snapshot = options.snapshot;
    this.#backup = options.backup;
    this.#trash = options.trash;
    this.#assets = options.assets;
    this.#drafts = options.drafts;
  }

  async acquire(): Promise<DataTransferQuiescenceLease> {
    if (this.#active) throw operationError("OPERATION_IN_PROGRESS");
    this.#active = true;
    const resumes: ResumeOperation[] = [];
    let currentFailure = sourceFailure("snapshot", "suspend");

    try {
      currentFailure = sourceFailure("snapshot", "suspend");
      resumes.push({ service: "snapshot", resume: await this.#snapshot.suspend() });
      currentFailure = sourceFailure("backup", "suspend");
      resumes.push({ service: "backup", resume: await this.#backup.suspend() });
      currentFailure = sourceFailure("trash", "suspend");
      resumes.push({ service: "trash", resume: await this.#trash.suspend() });
      currentFailure = sourceFailure("assets", "drain");
      const assetReport = await this.#assets.waitForIdle();
      currentFailure = sourceFailure("drafts", "drain");
      await this.#drafts.waitForIdle();
      currentFailure = sourceFailure("assets", "drain");
      if (assetReport.stagedSessionIds.length !== 0) {
        throw Symbol("staged-assets-block-data-transfer");
      }

      let releasePromise: Promise<void> | undefined;
      return {
        release: () => {
          releasePromise ??= this.#release(resumes);
          return releasePromise;
        },
      };
    } catch {
      const failures = await this.#resumeAll(resumes);
      this.#active = false;
      throw new DataTransferQuiescenceError(currentFailure, [currentFailure, ...failures]);
    }
  }

  async #release(resumes: ResumeOperation[]): Promise<void> {
    try {
      const failures = await this.#resumeAll(resumes);
      const firstFailure = failures[0];
      if (firstFailure) throw new DataTransferQuiescenceError(firstFailure, failures);
    } finally {
      this.#active = false;
    }
  }

  async #resumeAll(resumes: ResumeOperation[]): Promise<QuiescenceFailure[]> {
    const failures: QuiescenceFailure[] = [];
    for (const operation of [...resumes].reverse()) {
      try {
        await operation.resume();
      } catch {
        failures.push(sourceFailure(operation.service, "resume"));
      }
    }
    return failures;
  }
}
