import type { KlecksPortIdentity } from "./klecks-command-port";

type State = {
  identity: KlecksPortIdentity | null;
  dirty: boolean;
  selectionDirty?: boolean;
  pending: boolean;
  locked: boolean;
};
type Dependencies = {
  targets(): readonly KlecksPortIdentity[];
  current(target: KlecksPortIdentity): boolean;
  activate(target: KlecksPortIdentity): Promise<boolean>;
  state(): State | null;
  lock(token: string, locked: boolean): Promise<void>;
  choose(dirty: readonly KlecksPortIdentity[]): Promise<"save" | "discard" | "cancel">;
  /** Durable explicit save and editor acknowledgement, never implicit application. */
  save(target: KlecksPortIdentity): Promise<void>;
  /** Durable discard plus fresh-generation reload, while retaining the supplied input lock. */
  discard(target: KlecksPortIdentity, token: string): Promise<void>;
  /** True only after the case/frame is released. False must leave the frame available. */
  close(): Promise<boolean>;
};
const same = (a: KlecksPortIdentity | null, b: KlecksPortIdentity) =>
  a?.sessionId === b.sessionId && a.viewId === b.viewId && a.generation === b.generation;

/** Retain per frame. Input remains protected while choosing and until release succeeds. */
export class KlecksCloseCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private pendingUnlock: string | null = null;
  private closed = false;
  constructor(private readonly dependencies: Dependencies) {}
  /** After the close attempt settles, retry only its retained input-release acknowledgement. */
  releaseInput(): Promise<void> {
    return this.unlock();
  }
  run(): Promise<boolean> {
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
  private async activate(target: KlecksPortIdentity): Promise<State> {
    const d = this.dependencies;
    if (!d.current(target) || !(await d.activate(target)))
      throw new Error("关闭期间图片集合已改变。");
    const state = d.state();
    if (!state || !state.locked || state.pending || !same(state.identity, target))
      throw new Error("图片编辑状态尚未稳定，未关闭案件。");
    return state;
  }
  private async perform(): Promise<boolean> {
    if (this.closed) return true;
    await this.unlock();
    const d = this.dependencies,
      initial = d.state();
    if (!initial || initial.pending || initial.locked)
      throw new Error("请先完成当前图片操作，再关闭案件。");
    const original = initial.identity ? { ...initial.identity } : null;
    const token = crypto.randomUUID(),
      failures: unknown[] = [];
    this.pendingUnlock = token;
    try {
      await d.lock(token, true);
      if (!d.state()?.locked) throw new Error("关闭前尚未确认图片输入保护。");
      const targets = structuredClone(d.targets());
      if (new Set(targets.map((target) => JSON.stringify(target))).size !== targets.length)
        throw new Error("图片关闭集合包含重复文档。");
      const dirty: KlecksPortIdentity[] = [];
      for (const target of targets) {
        const state = await this.activate(target);
        if (state.dirty) dirty.push(target);
        else if (state.selectionDirty) {
          await d.save(target);
          if ((await this.activate(target)).selectionDirty)
            throw new Error("选区状态尚未确认保存，未关闭案件。");
        }
      }
      if (original && d.current(original)) await this.activate(original);
      const choice = dirty.length ? await d.choose(dirty) : "save";
      if (!["save", "discard", "cancel"].includes(choice)) throw new Error("关闭选择无效。");
      if (choice !== "cancel") {
        for (const target of dirty) {
          await this.activate(target);
          if (choice === "save") {
            await d.save(target);
            if ((await this.activate(target)).dirty)
              throw new Error("图片尚未确认明确保存，未关闭案件。");
          } else await d.discard(target, token);
        }
        if (!d.state()?.locked) throw new Error("关闭期间图片输入保护意外解除。");
        this.closed = await d.close();
        if (this.closed) this.pendingUnlock = null; // The released frame no longer owns an input surface.
      }
    } catch (error) {
      failures.push(error);
    }
    if (!this.closed) {
      try {
        if (original && d.current(original)) await this.activate(original);
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.unlock();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "关闭未完成，图片编辑会话已保留。");
    return this.closed;
  }
}
