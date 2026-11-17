import { DEFAULT_SNAPSHOT_SETTINGS, type SnapshotSettings } from "../../shared/snapshot/model.js";
import type { SnapshotService } from "./snapshot-service.js";

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export type SnapshotTimerOptions = {
  snapshots: Pick<SnapshotService, "create" | "pruneAll" | "lastAutomaticSnapshotAt"> &
    Partial<Pick<SnapshotService, "prepareClose">>;
  listOpenPatentIds: () => readonly string[];
  readSettings: () => Promise<{ snapshot: SnapshotSettings }>;
};

export class SnapshotTimer {
  readonly #snapshots: SnapshotTimerOptions["snapshots"];
  readonly #listOpenPatentIds: SnapshotTimerOptions["listOpenPatentIds"];
  readonly #readSettings: SnapshotTimerOptions["readSettings"];

  #automaticTimer: TimerHandle | undefined;
  #maintenanceTimer: TimerHandle | undefined;
  #prepareTimer: TimerHandle | undefined;
  #runsInFlight = new Set<Promise<void>>();
  #stopped = true;
  #suspended = false;
  #resumeWhenReleased = false;
  #automaticGeneration = 0;
  #automaticWorkInFlight: Promise<void> | undefined;
  #maintenanceInFlight = false;
  #lastCheckAt: string | null = null;
  #nextCheckAt: string | null = null;
  #settingsError: string | null = null;
  #automaticError: string | null = null;
  #maintenanceError: string | null = null;
  #settings: SnapshotSettings = DEFAULT_SNAPSHOT_SETTINGS;

  constructor(options: SnapshotTimerOptions) {
    this.#snapshots = options.snapshots;
    this.#listOpenPatentIds = options.listOpenPatentIds;
    this.#readSettings = options.readSettings;
  }

  start(): void {
    if (this.#suspended) {
      this.#resumeWhenReleased = true;
      return;
    }
    this.#startScheduling();
  }

  #startScheduling(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedulePreparation();
    this.#scheduleMaintenanceClock();
    this.#trackRun(this.#runMaintenance());
    void this.#restartAutomaticClock();
  }

  stop(): void {
    if (this.#suspended) this.#resumeWhenReleased = false;
    this.#stopScheduling();
  }

  #stopScheduling(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    ++this.#automaticGeneration;
    this.#cancelAutomaticTimer();
    if (this.#prepareTimer !== undefined) clearTimeout(this.#prepareTimer);
    this.#prepareTimer = undefined;
    if (this.#maintenanceTimer !== undefined) {
      clearTimeout(this.#maintenanceTimer);
      this.#maintenanceTimer = undefined;
    }
  }

  async shutdown(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.#runsInFlight]);
  }

  #schedulePreparation(): void {
    if (this.#stopped || !this.#snapshots.prepareClose) return;
    this.#prepareTimer = setTimeout(() => {
      this.#prepareTimer = undefined;
      const run = (async () => {
        for (const patentId of this.#uniqueOpenPatentIds()) {
          if (this.#stopped) break;
          // Optional work cannot block normal saving; create() retries from live data.
          try {
            await this.#snapshots.prepareClose?.(patentId);
          } catch {
            /* retry next idle pass */
          }
        }
      })().finally(() => this.#schedulePreparation());
      this.#trackRun(run);
    }, 20_000);
  }

  async restartAutomaticClock(): Promise<void> {
    if (this.#stopped) return;
    await this.#restartAutomaticClock();
  }

  async suspend(): Promise<() => Promise<void>> {
    this.#suspended = true;
    this.#resumeWhenReleased = !this.#stopped;
    this.#stopScheduling();
    await Promise.all([...this.#runsInFlight]);

    let resumed = false;
    return async () => {
      if (resumed) return;
      resumed = true;
      const shouldResume = this.#resumeWhenReleased;
      this.#resumeWhenReleased = false;
      this.#suspended = false;
      if (shouldResume) this.#startScheduling();
    };
  }

  async openPatentSessionsChanged(): Promise<void> {
    if (this.#stopped) return;
    if (this.#uniqueOpenPatentIds().length === 0) {
      ++this.#automaticGeneration;
      this.#cancelAutomaticTimer();
      return;
    }
    if (this.#automaticTimer === undefined) await this.#restartAutomaticClock();
  }

  status(): {
    lastCheckAt: string | null;
    nextCheckAt: string | null;
    lastAutomaticSnapshotAt: string | null;
    lastError: string | null;
  } {
    const error = this.#settingsError ?? this.#automaticError ?? this.#maintenanceError;
    return {
      lastCheckAt: this.#lastCheckAt,
      nextCheckAt: this.#nextCheckAt,
      lastAutomaticSnapshotAt: this.#snapshots.lastAutomaticSnapshotAt(),
      lastError: error ? (error.length > 2000 ? `${error.slice(0, 1999)}…` : error) : null,
    };
  }

  #restartAutomaticClock(): Promise<void> {
    const generation = ++this.#automaticGeneration;
    this.#cancelAutomaticTimer();
    const run = this.#refreshSettingsAndSchedule(generation);
    this.#trackRun(run);
    return run;
  }

  async #refreshSettingsAndSchedule(generation: number): Promise<void> {
    try {
      const settings = (await this.#readSettings()).snapshot;
      if (this.#stopped || generation !== this.#automaticGeneration) return;
      this.#settings = settings;
      this.#settingsError = null;
    } catch (error) {
      if (this.#stopped || generation !== this.#automaticGeneration) return;
      this.#settingsError = errorMessage(error, "快照设置读取失败");
    }
    if (this.#stopped || generation !== this.#automaticGeneration) return;
    this.#scheduleAutomaticTick(generation);
  }

  #scheduleAutomaticTick(generation: number): void {
    if (!this.#settings.enabled || this.#uniqueOpenPatentIds().length === 0) {
      this.#nextCheckAt = null;
      return;
    }
    const delayMs = this.#settings.intervalMinutes * 60_000;
    this.#nextCheckAt = new Date(Date.now() + delayMs).toISOString();
    this.#automaticTimer = setTimeout(() => {
      this.#automaticTimer = undefined;
      if (this.#stopped || generation !== this.#automaticGeneration) return;
      this.#trackRun(this.#runAutomaticTick(generation));
    }, delayMs);
  }

  async #runAutomaticTick(generation: number): Promise<void> {
    this.#lastCheckAt = new Date().toISOString();
    this.#nextCheckAt = null;
    if (!this.#maintenanceInFlight && !this.#automaticWorkInFlight) {
      const work = this.#createAutomaticSnapshots();
      this.#automaticWorkInFlight = work;
      try {
        await work;
      } finally {
        if (this.#automaticWorkInFlight === work) this.#automaticWorkInFlight = undefined;
      }
    }
    if (!this.#stopped && generation === this.#automaticGeneration) {
      await this.#refreshSettingsAndSchedule(generation);
    }
  }

  #scheduleMaintenanceClock(): void {
    this.#maintenanceTimer = setTimeout(() => {
      this.#maintenanceTimer = undefined;
      if (this.#stopped) return;
      this.#scheduleMaintenanceClock();
      this.#trackRun(this.#runMaintenance());
    }, MAINTENANCE_INTERVAL_MS);
  }

  async #runMaintenance(): Promise<void> {
    if (this.#maintenanceInFlight) return;
    this.#maintenanceInFlight = true;
    try {
      await this.#automaticWorkInFlight;
      const result = await this.#snapshots.pruneAll();
      this.#maintenanceError = result.cleanupError;
    } catch (error) {
      this.#maintenanceError = errorMessage(error, "快照维护失败");
    } finally {
      this.#maintenanceInFlight = false;
    }
  }

  #cancelAutomaticTimer(): void {
    if (this.#automaticTimer !== undefined) {
      clearTimeout(this.#automaticTimer);
      this.#automaticTimer = undefined;
    }
    this.#nextCheckAt = null;
  }

  #uniqueOpenPatentIds(): string[] {
    return [...new Set(this.#listOpenPatentIds())];
  }

  async #createAutomaticSnapshots(): Promise<void> {
    this.#automaticError = null;
    for (const patentId of this.#uniqueOpenPatentIds()) {
      try {
        await this.#snapshots.create(patentId, "automatic");
      } catch (error) {
        this.#automaticError ??= errorMessage(error, "自动快照创建失败");
      }
    }
  }

  #trackRun(run: Promise<void>): void {
    this.#runsInFlight.add(run);
    void run.finally(() => this.#runsInFlight.delete(run));
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
