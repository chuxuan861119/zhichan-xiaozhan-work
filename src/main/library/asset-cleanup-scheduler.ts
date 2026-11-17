import type { AssetOwner } from "../assets/asset-store.js";
import type { AssetStore } from "./asset-store.js";

/** Failed files keep their database rows: this is also the durable retry queue after restart. */
export class AssetCleanupScheduler {
  #tail: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #enabled = false;
  #suspended = false;
  #closed = false;
  #needsRetry = false;
  #backoff = 0;
  readonly #delays: readonly number[];
  readonly #interval: number;

  constructor(
    private readonly assets: Pick<AssetStore, "collectUnreferenced">,
    options: { retryDelaysMs?: readonly number[]; retryIntervalMs?: number } = {},
  ) {
    this.#delays = options.retryDelaysMs ?? [60, 180];
    this.#interval = options.retryIntervalMs ?? 30_000;
  }

  start(): void {
    if (this.#closed) return;
    this.#enabled = true;
    this.#schedule();
  }

  collect(owner?: AssetOwner): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#suspended) {
      this.#needsRetry = true;
      return Promise.resolve();
    }
    this.#clearTimer();
    const operation = this.#tail.then(async () => {
      if (this.#closed || this.#suspended) {
        this.#needsRetry = true;
        return;
      }
      this.#needsRetry = false;
      for (const delay of [0, ...this.#delays]) {
        if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
        if (this.#closed || this.#suspended) {
          this.#needsRetry = true;
          break;
        }
        try {
          // Every attempt rechecks all owners, snapshot references and in-memory leases.
          const report = await this.assets.collectUnreferenced(owner);
          this.#needsRetry = report.failedAssetIds.length > 0;
        } catch {
          this.#needsRetry = true;
        }
        if (!this.#needsRetry) break;
      }
      if (!this.#needsRetry) this.#backoff = 0;
      this.#schedule();
    });
    this.#tail = operation;
    return operation;
  }

  dispose(): void {
    this.#enabled = false;
    this.#clearTimer();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.dispose();
    await this.#tail;
  }

  async suspend(): Promise<() => Promise<void>> {
    this.#suspended = true;
    this.#clearTimer();
    await this.#tail;
    let resumed = false;
    return async () => {
      if (resumed || this.#closed) return;
      resumed = true;
      this.#suspended = false;
      if (this.#needsRetry) await this.collect();
    };
  }

  #schedule(): void {
    if (!this.#enabled || this.#closed || this.#suspended || !this.#needsRetry || this.#timer)
      return;
    const delay = Math.min(this.#interval * 2 ** this.#backoff, 15 * 60_000);
    this.#backoff = Math.min(this.#backoff + 1, 5);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.collect();
    }, delay);
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
