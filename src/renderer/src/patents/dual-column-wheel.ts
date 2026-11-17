/** Pixel streams already carry device momentum; keep easing for isolated wheel steps. */
export function columnWheelDuration(mode: number, delta: number, elapsedMs: number): number {
  return mode === 0 && (Math.abs(delta) < 50 || elapsedMs < 50) ? 0 : 180;
}

/** A short, bounded transition for wheel steps; coordinates stay in screen pixels. */
export class ColumnWheelMotion {
  private from = 0;
  private target = 0;
  private startedAt = 0;
  private direction = 0;
  private duration = 180;
  running = false;

  add(current: number, delta: number, max: number, now: number, duration = 180): void {
    const direction = Math.sign(delta);
    const continuing = this.running && direction === this.direction;
    this.from = current;
    // On reversal, respond from the visible position instead of finishing old input.
    this.target = Math.max(0, Math.min(max, (continuing ? this.target : current) + delta));
    this.startedAt = now;
    this.duration = duration;
    this.direction = direction;
    this.running = this.target !== current;
  }

  sample(now: number): number {
    const progress =
      this.duration === 0 ? 1 : Math.max(0, Math.min(1, (now - this.startedAt) / this.duration));
    if (progress === 1) this.running = false;
    return this.from + (this.target - this.from) * (1 - (1 - progress) ** 3);
  }

  cancel(): void {
    this.running = false;
  }
}
