import type { AiCorrectionEvent } from "../../shared/ai-correction/contract.js";
import type {
  TextPolishConversationEvent,
  TextPolishEvent,
} from "../../shared/ai-correction/text-polish-contract.js";
import { IPC_CHANNELS } from "../../shared/ipc/contract.js";

export type AiCorrectionEventTarget = {
  isDestroyed(): boolean;
  send(channel: string, value: unknown): void;
};

const TERMINAL_EVENTS = new Set<AiCorrectionEvent["type"]>(["completed", "failed", "cancelled"]);

export class AiCorrectionEventRouter {
  readonly #owners = new Map<string, AiCorrectionEventTarget>();

  bindLifecycle(
    target: AiCorrectionEventTarget & {
      on(
        event: "did-start-navigation",
        listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void,
      ): unknown;
      on(event: "render-process-gone" | "destroyed", listener: () => void): unknown;
    },
    cancel: (jobId: string) => void,
  ): void {
    const release = () => {
      for (const jobId of this.releaseTarget(target)) cancel(jobId);
    };
    target.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) release();
    });
    target.on("render-process-gone", release);
    target.on("destroyed", release);
  }

  bind(jobId: string, target: AiCorrectionEventTarget): void {
    const current = this.#owners.get(jobId);
    if (current && current !== target) throw new Error("AI 纠错任务标识已被占用。");
    this.#owners.set(jobId, target);
  }

  owns(jobId: string, target: AiCorrectionEventTarget): boolean {
    return this.#owners.get(jobId) === target;
  }

  unbind(jobId: string): void {
    this.#owners.delete(jobId);
  }

  releaseTarget(target: AiCorrectionEventTarget): string[] {
    const released: string[] = [];
    for (const [jobId, owner] of this.#owners) {
      if (owner !== target) continue;
      this.#owners.delete(jobId);
      released.push(jobId);
    }
    return released;
  }

  emit(event: AiCorrectionEvent): void {
    const target = this.#owners.get(event.jobId);
    if (!target) return;
    if (target.isDestroyed()) this.#owners.delete(event.jobId);
    else target.send(IPC_CHANNELS.aiCorrectionEvent, event);
    if (TERMINAL_EVENTS.has(event.type)) this.#owners.delete(event.jobId);
  }
}

const TEXT_POLISH_TERMINAL_EVENTS = new Set<TextPolishEvent["type"]>([
  "polish-completed",
  "failed",
  "cancelled",
]);

export class TextPolishEventRouter {
  readonly #owners = new Map<string, AiCorrectionEventTarget>();

  bind(jobId: string, target: AiCorrectionEventTarget): void {
    const current = this.#owners.get(jobId);
    if (current && current !== target) throw new Error("小栈AI助手任务标识已被占用。");
    this.#owners.set(jobId, target);
  }

  owns(jobId: string, target: AiCorrectionEventTarget): boolean {
    return this.#owners.get(jobId) === target;
  }

  unbind(jobId: string): void {
    this.#owners.delete(jobId);
  }

  releaseTarget(target: AiCorrectionEventTarget): string[] {
    const released: string[] = [];
    for (const [jobId, owner] of this.#owners) {
      if (owner !== target) continue;
      this.#owners.delete(jobId);
      released.push(jobId);
    }
    return released;
  }

  emit(event: TextPolishEvent): void {
    const target = this.#owners.get(event.jobId);
    if (!target) return;
    if (target.isDestroyed()) this.#owners.delete(event.jobId);
    else target.send(IPC_CHANNELS.textPolishEvent, event);
    if (TEXT_POLISH_TERMINAL_EVENTS.has(event.type)) this.#owners.delete(event.jobId);
  }
}

export class TextPolishConversationEventRouter {
  readonly #owners = new Map<string, AiCorrectionEventTarget>();

  bindOwner(ownerToken: string, target: AiCorrectionEventTarget): void {
    const current = this.#owners.get(ownerToken);
    if (current && current !== target) throw new Error("连续对话所有者标识已被占用。");
    this.#owners.set(ownerToken, target);
  }

  releaseTarget(target: AiCorrectionEventTarget): string[] {
    const released: string[] = [];
    for (const [ownerToken, owner] of this.#owners) {
      if (owner !== target) continue;
      this.#owners.delete(ownerToken);
      released.push(ownerToken);
    }
    return released;
  }

  emit(event: TextPolishConversationEvent, ownerToken: string): void {
    const target = this.#owners.get(ownerToken);
    if (!target) return;
    if (target.isDestroyed()) {
      this.#owners.delete(ownerToken);
      return;
    }
    target.send(IPC_CHANNELS.textPolishConversationEvent, event);
  }
}
