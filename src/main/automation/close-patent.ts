import { randomUUID } from "node:crypto";
import { AutomationError } from "../../shared/automation/protocol.js";
import type { AutomationParticipant } from "./barrier.js";

type Round = {
  patentId: string;
  participants: AutomationParticipant[];
  replies: Set<string>;
  finish(error?: Error): void;
};
/** Requests the renderer's normal save-and-close path; never releases a session forcibly. */
export class AutomationPatentCloser {
  #rounds = new Map<string, Round>();
  constructor(
    private readonly participants: (patentId: string) => AutomationParticipant[],
    private readonly timeoutMs = 30000,
  ) {}
  get pending() {
    return this.#rounds.size > 0;
  }
  isBusy(patentId: string) {
    return [...this.#rounds.values()].some((round) => round.patentId === patentId);
  }
  acknowledge(ownerId: number, input: { token: string; sessionId: string; ok: boolean }) {
    const round = this.#rounds.get(input.token);
    if (
      !round ||
      !round.participants.some(
        (entry) => entry.ownerId === ownerId && entry.sessionId === input.sessionId,
      )
    )
      throw new AutomationError("STALE_CLOSE", "关闭请求已失效。");
    if (!input.ok) {
      round.finish(
        new AutomationError(
          "EDITOR_BUSY",
          "编辑器未能安全保存并关闭，请完成正在进行的编辑后重试。",
        ),
      );
      return;
    }
    round.replies.add(input.sessionId);
    if (round.replies.size === round.participants.length) {
      round.finish(
        this.participants(round.patentId).length
          ? new AutomationError("EDITOR_CHANGED", "关闭期间编辑会话发生变化，请重试。")
          : undefined,
      );
    }
  }
  async close(patentId: string, signal: AbortSignal): Promise<void> {
    if (this.isBusy(patentId)) throw new AutomationError("OPERATION_IN_PROGRESS", "专利正在关闭。");
    if (signal.aborted) throw new AutomationError("CANCELLED", "关闭已取消。");
    const participants = this.participants(patentId);
    if (!participants.length) return;
    const token = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const abort = () =>
        finish(new AutomationError("CANCELLED", "关闭已取消；已保存关闭的会话不会重新打开。"));
      const timer = setTimeout(
        () => finish(new AutomationError("EDITOR_TIMEOUT", "编辑器未确认关闭，未继续删除专利。")),
        this.timeoutMs,
      );
      const finish = (error?: Error) => {
        if (!this.#rounds.delete(token)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      this.#rounds.set(token, { patentId, participants, replies: new Set(), finish });
      signal.addEventListener("abort", abort, { once: true });
      try {
        for (const participant of participants)
          participant.send({ type: "close", token, patentId, sessionId: participant.sessionId });
      } catch {
        finish(new AutomationError("EDITOR_CHANGED", "编辑窗口不可用，未继续删除专利。"));
      }
    });
  }
}
