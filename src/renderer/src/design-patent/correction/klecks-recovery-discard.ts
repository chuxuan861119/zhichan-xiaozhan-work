type Dependencies = {
  /** Owner/session validity; must remain valid across the intended generation replacement. */
  current(): boolean;
  state(): { pending: boolean; locked: boolean } | null;
  lock(token: string, locked: boolean): Promise<void>;
  /** Durable, retryable transaction for this captured decision, not a fresh discard of latest state. */
  commit(): Promise<void>;
  /** Retryable reload of the committed version, using this operation's input-lock credential. */
  reload(token: string): Promise<void>;
};

/** One explicit discard decision only. Retain on failure; never reuse for another image/revision. */
export class KlecksRecoveryDiscard {
  private committed = false;
  private reloaded = false;
  private pendingUnlock: string | null = null;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly dependencies: Dependencies) {}
  run(): Promise<void> {
    const work = this.tail.then(() => this.perform());
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  private async unlock(): Promise<void> {
    const token = this.pendingUnlock;
    if (!token) return;
    await this.dependencies.lock(token, false);
    this.pendingUnlock = null;
  }
  private requireCurrent(): void {
    if (!this.dependencies.current()) throw new Error("舍弃操作所属的图片编辑会话已改变。");
  }
  private async perform(): Promise<void> {
    await this.unlock();
    if (this.reloaded) return;
    this.requireCurrent();
    const initial = this.dependencies.state();
    if (initial?.pending || initial?.locked)
      throw new Error("请先完成当前图片操作，再舍弃恢复版本。");
    const token = crypto.randomUUID();
    this.pendingUnlock = token;
    const failures: unknown[] = [];
    try {
      await this.dependencies.lock(token, true);
      this.requireCurrent();
      if (initial && !this.dependencies.state()?.locked)
        throw new Error("图片编辑器尚未确认输入保护。");
      if (!this.committed) {
        await this.dependencies.commit();
        this.committed = true;
      }
      this.requireCurrent();
      await this.dependencies.reload(token);
      this.requireCurrent();
      if (!this.dependencies.state()?.locked) throw new Error("图片重建期间输入保护意外解除。");
      this.reloaded = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.unlock();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "舍弃流程尚未完成，请保留编辑会话并重试。");
  }
}
