import { randomUUID } from "node:crypto";
import { AppOperationError } from "../app-operation-error.js";

export type OperationContext = {
  operationId: string;
  signal: AbortSignal;
};

type ActiveOperation = {
  controller: AbortController;
  promise: Promise<unknown>;
};

export class OperationCoordinator {
  readonly #active = new Map<string, ActiveOperation>();
  readonly #closing = new Map<string, number>();

  constructor(private readonly createOperationId: () => string = randomUUID) {}

  run<T>(
    scopeId: string,
    operationType: string,
    work: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    if (this.#closing.has(scopeId)) {
      return Promise.reject(
        new AppOperationError({
          code: "OPERATION_IN_PROGRESS",
          message: "normalized",
        }),
      );
    }
    const key = `${scopeId}\0${operationType}`;
    const existing = this.#active.get(key);
    if (existing) {
      return Promise.reject(
        new AppOperationError({
          code: "OPERATION_IN_PROGRESS",
          message: "normalized",
        }),
      );
    }

    const controller = new AbortController();
    const context = { operationId: this.createOperationId(), signal: controller.signal };
    let workPromise: Promise<T>;
    try {
      workPromise = Promise.resolve(work(context));
    } catch (error) {
      workPromise = Promise.reject(error);
    }
    const promise = workPromise.finally(() => {
      if (this.#active.get(key)?.promise === promise) this.#active.delete(key);
    });
    this.#active.set(key, { controller, promise });
    return promise;
  }

  cancelScope(scopeId: string): number {
    const prefix = `${scopeId}\0`;
    let cancelled = 0;
    for (const [key, operation] of this.#active) {
      if (!key.startsWith(prefix) || operation.controller.signal.aborted) continue;
      operation.controller.abort();
      cancelled += 1;
    }
    return cancelled;
  }

  async cancelAndWaitScope(scopeId: string): Promise<void> {
    this.#closing.set(scopeId, (this.#closing.get(scopeId) ?? 0) + 1);
    const prefix = `${scopeId}\0`;
    const pending: Promise<unknown>[] = [];
    for (const [key, operation] of this.#active) {
      if (!key.startsWith(prefix)) continue;
      operation.controller.abort();
      pending.push(operation.promise);
    }
    await Promise.allSettled(pending);
  }

  finishScopeClose(scopeId: string): void {
    const count = this.#closing.get(scopeId);
    if (count === undefined) return;
    if (count === 1) this.#closing.delete(scopeId);
    else this.#closing.set(scopeId, count - 1);
  }
}
