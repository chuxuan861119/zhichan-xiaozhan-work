import { settleShutdownTasks } from "../application-lifecycle.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type ResourceMaintenance = {
  start(): void;
  dispose(): void;
  close(): Promise<void>;
  suspend(): Promise<() => Promise<void>>;
};

type PurgeService = {
  purgeExpired(): Promise<unknown>;
};

type TimerApi<TimerId> = {
  setInterval(callback: () => void, milliseconds: number): TimerId;
  clearInterval(timerId: TimerId): void;
};

const defaultTimerApi: TimerApi<ReturnType<typeof setInterval>> = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timerId) => clearInterval(timerId),
};

export class TrashPurgeScheduler<TimerId = ReturnType<typeof setInterval>> {
  readonly #library: PurgeService;
  readonly #timerApi: TimerApi<TimerId>;
  #timerId: TimerId | null = null;
  #runInFlight: Promise<void> | undefined;
  #rerunRequested = false;
  #suspended = false;
  #resumeScheduled = false;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(
    library: PurgeService,
    timerApi: TimerApi<TimerId> = defaultTimerApi as TimerApi<TimerId>,
    private readonly maintenance?: ResourceMaintenance,
  ) {
    this.#library = library;
    this.#timerApi = timerApi;
  }

  start(): void {
    if (this.#closed) return;
    if (this.#suspended) {
      this.#resumeScheduled = true;
      return;
    }
    if (this.#timerId !== null) return;
    this.maintenance?.start();
    void this.#run().catch(() => undefined);
    this.#schedule();
  }

  #schedule(): void {
    if (this.#closed || this.#suspended || this.#timerId !== null) return;
    this.#timerId = this.#timerApi.setInterval(() => {
      void this.#run().catch(() => undefined);
    }, ONE_DAY_MS);
  }

  dispose(): void {
    this.maintenance?.dispose();
    if (this.#suspended) this.#resumeScheduled = false;
    if (this.#timerId === null) return;
    this.#timerApi.clearInterval(this.#timerId);
    this.#timerId = null;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#suspended = true;
    this.#resumeScheduled = false;
    this.#rerunRequested = false;
    if (this.#timerId !== null) {
      this.#timerApi.clearInterval(this.#timerId);
      this.#timerId = null;
    }
    const purge = this.#runInFlight;
    this.#closing = settleShutdownTasks([
      () => purge,
      async () => {
        // An active purge may still enqueue cleanup; drain it before closing the collector.
        await purge?.catch(() => undefined);
        await this.maintenance?.close();
      },
    ]);
    return this.#closing;
  }

  async suspend(): Promise<() => Promise<void>> {
    this.#suspended = true;
    this.#resumeScheduled = this.#timerId !== null;
    if (this.#timerId !== null) {
      this.#timerApi.clearInterval(this.#timerId);
      this.#timerId = null;
    }
    this.#rerunRequested = false;

    let resumeMaintenance: (() => Promise<void>) | undefined;
    let resumed = false;
    const resume = async () => {
      if (resumed) return;
      resumed = true;
      const shouldSchedule = this.#resumeScheduled;
      this.#resumeScheduled = false;
      this.#suspended = false;
      await resumeMaintenance?.();
      if (shouldSchedule && this.#timerId === null) this.#schedule();
    };
    try {
      resumeMaintenance = await this.maintenance?.suspend();
      await this.#runInFlight;
    } catch (error) {
      await resume();
      throw error;
    }
    return resume;
  }

  #run(): Promise<void> {
    if (this.#suspended) return Promise.resolve();
    if (this.#runInFlight) {
      this.#rerunRequested = true;
      return this.#runInFlight;
    }
    const run = this.#library.purgeExpired().then(() => undefined);
    const inFlight = run.finally(() => {
      if (this.#runInFlight === inFlight) this.#runInFlight = undefined;
      if (this.#rerunRequested && !this.#suspended) {
        this.#rerunRequested = false;
        void this.#run().catch(() => undefined);
      }
    });
    this.#runInFlight = inFlight;
    return inFlight;
  }
}
