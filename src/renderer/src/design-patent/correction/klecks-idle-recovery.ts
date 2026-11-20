import type { KlecksPortIdentity } from "./klecks-command-port";

type State = {
  identity: KlecksPortIdentity | null;
  dirty: boolean;
  selectionDirty?: boolean;
  pending: boolean;
  locked: boolean;
  checkpointRevision: number;
};
/** Debounce completed operations, not pointer moves. The case writer owns locking and durability. */
export class KlecksIdleRecovery {
  private state: State | null = null;
  private seen = new Map<string, string>();
  private debt = false;
  private targets = new Map<string, KlecksPortIdentity>();
  private busy = false;
  private failed = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly options: {
      save(targets: KlecksPortIdentity[]): Promise<unknown>;
      error(error: unknown): void;
      saved(): void;
      delayMs?: number;
      shouldTrack?(identity: KlecksPortIdentity): boolean;
    },
  ) {}
  notify(state: State | null) {
    if (this.closed) return;
    this.state = state;
    if (
      state?.identity &&
      (state.dirty || state.selectionDirty) &&
      (this.options.shouldTrack?.(state.identity) ?? true)
    ) {
      const key = state.identity.viewId,
        version = `${state.identity.generation}:${state.checkpointRevision}`;
      if (this.seen.get(key) !== version) {
        this.seen.set(key, version);
        this.debt = true;
        this.targets.set(key, { ...state.identity });
        this.failed = false;
      }
    }
    this.schedule();
  }
  private clear() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  private schedule() {
    this.clear();
    if (
      !this.closed &&
      !this.busy &&
      !this.failed &&
      this.debt &&
      this.state &&
      !this.state.pending &&
      !this.state.locked
    )
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.run();
      }, this.options.delayMs ?? 2000);
  }
  async retry() {
    this.failed = false;
    this.debt = true;
    // A previous checkpoint can still own an unacknowledged unlock token.
    // Its coordinator must be allowed to retry that release before inspecting the lock.
    return this.run(true);
  }
  private async run(retryLocked = false) {
    this.clear();
    if (
      this.closed ||
      this.busy ||
      !this.state ||
      this.state.pending ||
      (this.state.locked && !retryLocked)
    ) {
      this.schedule();
      return;
    }
    this.busy = true;
    this.debt = false;
    const targets = new Map(this.targets);
    this.targets.clear();
    try {
      await this.options.save([...targets.values()]);
      if (!this.closed) this.options.saved();
    } catch (error) {
      this.debt = true;
      for (const [key, target] of targets)
        if (!this.targets.has(key)) this.targets.set(key, target);
      this.failed = true;
      if (!this.closed) this.options.error(error);
    } finally {
      this.busy = false;
      this.schedule();
    }
  }
  dispose() {
    this.closed = true;
    this.clear();
    this.seen.clear();
    this.targets.clear();
  }
}
