import type { IpcChannel } from "../../shared/ipc/contract.js";
import type { DataTransferOperationKind } from "../../shared/ipc/result.js";

type GateFailureCode = "CANCELLED" | "OPERATION_IN_PROGRESS";

export class DataTransferOperationError extends Error {
  override readonly name = "DataTransferOperationError";
  readonly channel: IpcChannel | undefined;

  constructor(
    readonly code: GateFailureCode,
    readonly operationKind: DataTransferOperationKind,
    channel?: IpcChannel,
  ) {
    super(
      code === "CANCELLED"
        ? `Operation ${operationKind} was cancelled.`
        : channel
          ? `Operation ${operationKind} blocks mutation ${channel}.`
          : `Operation ${operationKind} is already in progress.`,
    );
    this.channel = channel;
  }
}

type ExclusiveReservation = Readonly<{ operationKind: DataTransferOperationKind }>;

export class DataTransferOperationGate {
  #activeMutations = 0;
  #exclusiveReservation: ExclusiveReservation | undefined;
  #resolveDrain: (() => void) | undefined;

  async runMutation<T>(channel: IpcChannel, task: () => T | PromiseLike<T>): Promise<T> {
    const reservation = this.#exclusiveReservation;
    if (reservation) {
      throw new DataTransferOperationError(
        "OPERATION_IN_PROGRESS",
        reservation.operationKind,
        channel,
      );
    }

    this.#activeMutations += 1;
    let released = false;
    try {
      return await task();
    } finally {
      if (!released) {
        released = true;
        this.#activeMutations -= 1;
        if (this.#activeMutations === 0) {
          const resolveDrain = this.#resolveDrain;
          this.#resolveDrain = undefined;
          resolveDrain?.();
        }
      }
    }
  }

  async runExclusive<T>(
    operationKind: DataTransferOperationKind,
    task: (signal?: AbortSignal) => T | PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new DataTransferOperationError("CANCELLED", operationKind);

    const currentReservation = this.#exclusiveReservation;
    if (currentReservation) {
      throw new DataTransferOperationError(
        "OPERATION_IN_PROGRESS",
        currentReservation.operationKind,
      );
    }

    const reservation = { operationKind } as const;
    this.#exclusiveReservation = reservation;
    try {
      await this.#waitForActiveMutations(signal, operationKind);
      if (signal?.aborted) throw new DataTransferOperationError("CANCELLED", operationKind);
      try {
        const value = await task(signal);
        if (signal?.aborted) throw new DataTransferOperationError("CANCELLED", operationKind);
        return value;
      } catch (error) {
        if (signal?.aborted) throw new DataTransferOperationError("CANCELLED", operationKind);
        throw error;
      }
    } finally {
      if (this.#exclusiveReservation === reservation) this.#exclusiveReservation = undefined;
    }
  }

  #waitForActiveMutations(
    signal: AbortSignal | undefined,
    operationKind: DataTransferOperationKind,
  ): Promise<void> {
    if (this.#activeMutations === 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (result: "drained" | "cancelled") => {
        if (settled) return;
        settled = true;
        if (this.#resolveDrain === onDrained) this.#resolveDrain = undefined;
        signal?.removeEventListener("abort", onAbort);
        if (result === "cancelled") {
          reject(new DataTransferOperationError("CANCELLED", operationKind));
        } else {
          resolve();
        }
      };
      const onDrained = () => finish("drained");
      const onAbort = () => finish("cancelled");

      this.#resolveDrain = onDrained;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else if (this.#activeMutations === 0) onDrained();
    });
  }
}

const globalDataTransferOperationGate = new DataTransferOperationGate();

export function getDataTransferOperationGate(): DataTransferOperationGate {
  return globalDataTransferOperationGate;
}
