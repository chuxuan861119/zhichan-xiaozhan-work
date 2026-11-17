import { randomUUID } from "node:crypto";
import { AutomationError, type AutomationEvent } from "../../shared/automation/protocol.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";

export type AutomationParticipant = {
  sessionId: string;
  ownerId: number;
  send(event: AutomationEvent): void;
};
type Reply = { ok: boolean; dirty: boolean; revision: number };
type Round = {
  token: string;
  patentId: string;
  phase: "probe" | "drain" | "adopt";
  participants: AutomationParticipant[];
  replies: Map<string, Reply>;
  resolve(value: Reply[]): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

export class AutomationBarrier {
  #rounds = new Map<string, Round>();
  #locks = new Map<
    string,
    { token: string; phase: "draining" | "fenced"; participants: AutomationParticipant[] }
  >();
  constructor(
    private readonly participants: (patentId: string) => AutomationParticipant[],
    private readonly timeoutMs = 8000,
    private readonly isIdle: (patentId: string) => boolean = () => true,
  ) {}

  acknowledge(
    ownerId: number,
    input: { token: string; sessionId: string; phase: string } & Reply,
  ): void {
    const round = this.#rounds.get(input.token);
    if (
      !round ||
      round.phase !== input.phase ||
      !round.participants.some((p) => p.ownerId === ownerId && p.sessionId === input.sessionId)
    ) {
      throw new AutomationError("STALE_BARRIER", "保存屏障已失效。");
    }
    round.replies.set(input.sessionId, {
      ok: input.ok,
      dirty: input.dirty,
      revision: input.revision,
    });
    if (round.replies.size === round.participants.length) {
      this.#rounds.delete(round.token);
      clearTimeout(round.timer);
      round.resolve([...round.replies.values()]);
    }
  }

  sessionChanged(patentId: string): void {
    for (const round of this.#rounds.values()) {
      if (round.patentId === patentId) {
        clearTimeout(round.timer);
        this.#rounds.delete(round.token);
        round.reject(new AutomationError("EDITOR_CHANGED", "编辑窗口已变化，请重新同步。"));
      }
    }
  }

  isLocked(patentId: string): boolean {
    return this.#locks.has(patentId);
  }

  guardWrite(patentId: string | undefined): void {
    if (patentId && this.#locks.get(patentId)?.phase === "fenced") {
      throw new AutomationError("OPERATION_IN_PROGRESS", "专利正在应用外部修改，请稍后重试。");
    }
  }

  async probe(patentId: string): Promise<{ dirty: boolean; unknown: boolean }> {
    try {
      const replies = await this.#exchange(patentId, "probe", this.participants(patentId));
      return { dirty: replies.some((r) => r.dirty || !r.ok), unknown: false };
    } catch {
      return { dirty: true, unknown: true };
    }
  }

  async acquire(patentId: string): Promise<{
    assertValid(): void;
    adopt(patent: CanonicalPatent): Promise<boolean>;
    markCommitted(): void;
    release(): void;
  }> {
    if (this.#locks.has(patentId))
      throw new AutomationError("OPERATION_IN_PROGRESS", "同一专利正在同步。");
    const lock = {
      token: randomUUID(),
      phase: "draining" as "draining" | "fenced",
      participants: [...this.participants(patentId)],
      expiresAt: Date.now() + 30000,
      committed: false,
    };
    this.#locks.set(patentId, lock);
    const release = () => {
      if (this.#locks.get(patentId) !== lock) return;
      this.#locks.delete(patentId);
      for (const p of lock.participants)
        p.send({
          type: "barrier",
          token: lock.token,
          patentId,
          phase: "release",
          committed: lock.committed,
        });
    };
    const assertValid = () => {
      if (
        Date.now() > lock.expiresAt ||
        this.#locks.get(patentId) !== lock ||
        !this.#sameParticipants(patentId, lock.participants)
      )
        throw new AutomationError("EDITOR_CHANGED", "保存屏障已失效。");
      if (!this.isIdle(patentId))
        throw new AutomationError("EDITOR_DIRTY", "界面修改仍在执行，请稍后重试。");
    };
    try {
      const replies = await this.#exchange(
        patentId,
        "drain",
        lock.participants,
        undefined,
        lock.token,
      );
      assertValid();
      if (replies.some((r) => !r.ok || r.dirty))
        throw new AutomationError("EDITOR_DIRTY", "界面内容尚未安全保存。");
      lock.phase = "fenced";
      return {
        assertValid,
        release,
        markCommitted: () => {
          lock.committed = true;
        },
        adopt: async (patent) => {
          try {
            assertValid();
            const replies = await this.#exchange(
              patentId,
              "adopt",
              lock.participants,
              patent,
              lock.token,
            );
            return replies.every((r) => r.ok && !r.dirty && r.revision === patent.revision);
          } catch {
            return false;
          }
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  #sameParticipants(patentId: string, expected: AutomationParticipant[]): boolean {
    const current = this.participants(patentId);
    return (
      current.length === expected.length &&
      expected.every((p) =>
        current.some((c) => c.ownerId === p.ownerId && c.sessionId === p.sessionId),
      )
    );
  }

  #exchange(
    patentId: string,
    phase: Round["phase"],
    participants: AutomationParticipant[],
    patent?: CanonicalPatent,
    token = randomUUID(),
  ): Promise<Reply[]> {
    if (participants.length === 0) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#rounds.delete(token);
        reject(new AutomationError("EDITOR_TIMEOUT", "编辑窗口未及时确认，请检查保存状态后重试。"));
      }, this.timeoutMs);
      this.#rounds.set(token, {
        token,
        patentId,
        phase,
        participants,
        replies: new Map(),
        resolve,
        reject,
        timer,
      });
      try {
        for (const p of participants)
          p.send({ type: "barrier", token, patentId, phase, ...(patent ? { patent } : {}) });
      } catch (error) {
        clearTimeout(timer);
        this.#rounds.delete(token);
        reject(error);
      }
    });
  }
}
