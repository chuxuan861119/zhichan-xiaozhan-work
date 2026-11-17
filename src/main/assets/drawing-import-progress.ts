import { readFile, stat } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  DRAWING_IMPORT_PHASES,
  type DrawingImportProgressValue,
  type DrawingImportStage,
  DrawingImportStageSchema,
} from "../../shared/drawing-markup/import-progress.js";

// Initial ranges are deliberately broad. Calibration contains only aggregate timings,
// never document names, paths, identifiers or geometry.
const FALLBACK_MS_PER_MIB = [20, 450, 220, 520, 50, 400, 330, 80, 80, 20];
const HistorySchema = z
  .object({
    version: z.literal(1),
    stages: z.partialRecord(
      z.enum(DRAWING_IMPORT_PHASES),
      z
        .object({
          perMiB: z.number().min(1).max(600_000),
          samples: z.number().int().min(1).max(100),
        })
        .strict(),
    ),
  })
  .strict();
export class DrawingTimingHistory {
  private stages: z.infer<typeof HistorySchema>["stages"] = {};
  readonly ready: Promise<void>;
  private writes = Promise.resolve();
  constructor(private readonly path?: string) {
    this.ready = path
      ? stat(path)
          .then((entry) => {
            if (entry.size > 16384) throw new Error("Invalid timing history");
            return readFile(path, "utf8");
          })
          .then((text) => {
            const parsed = HistorySchema.safeParse(JSON.parse(text));
            if (parsed.success) this.stages = parsed.data.stages;
          })
          .catch(() => {})
      : Promise.resolve();
  }
  expected(phase: DrawingImportStage["phase"], bytes: number) {
    const rate =
      this.stages[phase]?.perMiB ?? FALLBACK_MS_PER_MIB[DRAWING_IMPORT_PHASES.indexOf(phase)]!;
    return Math.max(150, rate * Math.max(0.25, bytes / 1024 / 1024));
  }
  record(phase: DrawingImportStage["phase"], bytes: number, milliseconds: number) {
    if (bytes <= 0 || milliseconds < 20 || !Number.isFinite(milliseconds)) return;
    const rate = Math.min(600_000, Math.max(1, milliseconds / Math.max(0.25, bytes / 1024 / 1024)));
    const old = this.stages[phase];
    this.stages[phase] = {
      perMiB: old ? old.perMiB * 0.75 + rate * 0.25 : rate,
      samples: Math.min(100, (old?.samples ?? 0) + 1),
    };
  }
  save() {
    const path = this.path;
    if (!path) return Promise.resolve();
    const text = JSON.stringify({ version: 1, stages: this.stages });
    this.writes = this.writes
      .then(async () => {
        await writeFileAtomic(path, text, { mode: 0o600 });
      })
      .catch(() => {});
    return this.writes;
  }
}

export class DrawingImportProgress {
  private stage: DrawingImportStage = { phase: "prepare", completed: null, total: null };
  private readonly started: number;
  private lastObservation: number;
  private inactiveMs = 0;
  private stageStarted: number;
  private lastEmission = -Infinity;
  private percent = 0;
  private stopped = false;
  private observedCounters = false;
  private longestPhase = 0;
  constructor(
    private readonly bytes: number,
    private readonly publish: (value: DrawingImportProgressValue) => void,
    private readonly history: DrawingTimingHistory,
    private readonly now = () => performance.now(),
  ) {
    this.started = this.stageStarted = now();
    this.lastObservation = this.started;
  }
  update(value: DrawingImportStage) {
    if (this.stopped) return;
    const index = DRAWING_IMPORT_PHASES.indexOf(value.phase);
    if (index < this.longestPhase) return; // Ignore late packets from an earlier phase.
    if (value.phase !== this.stage.phase) {
      this.inactiveMs = 0;
      this.lastObservation = this.now();
      this.history.record(this.stage.phase, this.bytes, this.now() - this.stageStarted);
      this.stageStarted = this.now();
      this.observedCounters = false;
      this.longestPhase = index;
    } else if (
      this.stage.completed !== null &&
      value.completed !== null &&
      value.completed < this.stage.completed
    )
      return;
    if (
      value.completed !== null &&
      (this.stage.completed === null || value.completed > this.stage.completed)
    ) {
      this.inactiveMs = 0;
      this.lastObservation = this.now();
    }
    this.stage = value;
    this.observedCounters ||= value.completed !== null && value.total !== null;
    this.emit(true);
  }
  tick() {
    this.emit(false);
  }
  stop(completed = false) {
    if (completed && !this.stopped)
      this.history.record(this.stage.phase, this.bytes, this.now() - this.stageStarted);
    this.stopped = true;
  }
  private emit(force: boolean) {
    if (this.stopped) return;
    const now = this.now();
    this.inactiveMs += Math.max(0, Math.min(now - this.lastObservation, 2000));
    this.lastObservation = now;
    if (!force && now - this.lastEmission < 900) return;
    this.lastEmission = now;
    const index = DRAWING_IMPORT_PHASES.indexOf(this.stage.phase);
    const elapsed = now - this.stageStarted;
    const weights = FALLBACK_MS_PER_MIB;
    const sum = weights.reduce((a, b) => a + b, 0);
    const fraction =
      this.stage.total && this.stage.completed !== null
        ? this.stage.completed / this.stage.total
        : 0;
    this.percent = Math.min(
      99,
      Math.max(
        this.percent,
        Math.floor(
          (100 *
            (weights.slice(0, index).reduce((a, b) => a + b, 0) + weights[index]! * fraction)) /
            sum,
        ),
      ),
    );
    const expected = this.history.expected(this.stage.phase, this.bytes);
    const takingLonger = elapsed > expected * 1.8;
    const currentRemaining =
      this.observedCounters && fraction > 0 && elapsed > 1500
        ? (elapsed * (1 - fraction)) / fraction
        : Math.max(0, expected - elapsed);
    const later = DRAWING_IMPORT_PHASES.slice(index + 1).reduce(
      (total, phase) => total + this.history.expected(phase, this.bytes),
      0,
    );
    const estimate = currentRemaining + later;
    // Never count down to zero while conversion or storage is still running.
    const range: [number, number] | null =
      takingLonger && !this.observedCounters
        ? null
        : [
            Math.min(86_400_000, Math.max(5000, estimate * 0.65)),
            Math.min(86_400_000, Math.max(10000, estimate * 1.65)),
          ];
    try {
      this.publish({
        stage: this.stage,
        overallPercent: this.percent,
        elapsedMs: Math.min(86_400_000, Math.max(0, now - this.started)),
        estimatedRemainingMs: range,
        takingLonger,
        waitingForActivity: this.inactiveMs >= 180_000,
      });
    } catch {
      /* Closing a progress surface must not fail conversion. */
    }
  }
}

export class ProgressLineDecoder {
  private tail = "";
  private discarding = false;
  constructor(private readonly accept: (value: DrawingImportStage) => void) {}
  push(chunk: string | Buffer) {
    for (const part of chunk.toString().split(/(?<=\n)/u)) {
      if (!this.discarding) this.tail += part;
      if (this.tail.length > 4096) {
        this.tail = "";
        this.discarding = true;
      }
      if (!part.endsWith("\n")) continue;
      const line = this.tail.trim();
      this.tail = "";
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      if (!line.startsWith("ZXW_CAD_PROGRESS ")) continue;
      try {
        const value = DrawingImportStageSchema.safeParse(JSON.parse(line.slice(17)));
        if (value.success) this.accept(value.data);
      } catch {
        /* Diagnostics cannot fail an import. */
      }
    }
  }
}
