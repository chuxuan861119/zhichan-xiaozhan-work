import type { KlecksPortIdentity } from "./klecks-command-port";

type State = {
  identity: KlecksPortIdentity | null;
  pending: boolean;
  locked: boolean;
  checkpointRevision: number;
};
type Dependencies = {
  targets(): readonly KlecksPortIdentity[];
  current(target: KlecksPortIdentity): boolean;
  activate(target: KlecksPortIdentity): Promise<boolean>;
  state(): State | null;
  lock(token: string, locked: boolean): Promise<void>;
  /** Resolve only after the chosen checkpoint kind is durable. Recovery callers never mark saved/applied. */
  saveRecovery(target: KlecksPortIdentity): Promise<void>;
  /** Optional active-document filter; skipped documents are not recorded as completed. */
  shouldSave?(target: KlecksPortIdentity): boolean;
};
const key = (target: KlecksPortIdentity) =>
  JSON.stringify([target.sessionId, target.viewId, target.generation]);
const same = (a: KlecksPortIdentity | null, b: KlecksPortIdentity) =>
  a !== null && key(a) === key(b);
/** One connected frame only. Replace this coordinator when replacing or reloading its frame. */
export class KlecksRecoveryCheckpoints {
  private readonly completed = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  private pendingUnlock: string | null = null;
  constructor(private readonly dependencies: Dependencies) {}
  run(): Promise<number> {
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
    if (this.pendingUnlock === token) this.pendingUnlock = null;
  }
  private async perform(): Promise<number> {
    const dependencies = this.dependencies;
    await this.unlock();
    const initial = dependencies.state();
    if (!initial || initial.pending || initial.locked)
      throw new Error("请先完成当前图片操作，再生成检查点。");
    const original = initial.identity ? { ...initial.identity } : null;
    const token = crypto.randomUUID();
    let saved = 0;
    const failures: unknown[] = [];
    this.pendingUnlock = token;
    try {
      await dependencies.lock(token, true);
      if (!dependencies.state()?.locked) throw new Error("图片编辑器尚未确认输入保护。");
      const targets = structuredClone(dependencies.targets());
      const keys = new Set(targets.map(key));
      for (const previous of this.completed.keys())
        if (!keys.has(previous)) this.completed.delete(previous);
      for (const target of targets) {
        if (!dependencies.current(target) || !(await dependencies.activate(target)))
          throw new Error("图片集合已改变，检查点未完成。");
        const state = dependencies.state();
        if (
          !state?.locked ||
          state.pending ||
          !same(state.identity, target) ||
          !Number.isSafeInteger(state.checkpointRevision) ||
          state.checkpointRevision < 1
        )
          throw new Error("图片工程状态尚未稳定。");
        if (dependencies.shouldSave && !dependencies.shouldSave(target)) continue;
        if (this.completed.get(key(target)) === state.checkpointRevision) continue;
        const revision = state.checkpointRevision;
        await dependencies.saveRecovery({ ...target });
        const after = dependencies.state();
        if (
          !dependencies.current(target) ||
          !after?.locked ||
          !same(after.identity, target) ||
          after.checkpointRevision !== revision
        )
          throw new Error("图片在检查点期间发生变化，请重试。");
        this.completed.set(key(target), revision);
        saved++;
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      if (
        original &&
        dependencies.current(original) &&
        !same(dependencies.state()?.identity ?? null, original)
      ) {
        if (!(await dependencies.activate(original))) throw new Error("未能恢复原活动图片。");
      }
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
      throw new AggregateError(failures, "检查点未完成，编辑会话已保留，请重试。");
    return saved;
  }
}
