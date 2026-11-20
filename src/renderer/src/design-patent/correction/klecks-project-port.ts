import type { KlecksPortIdentity } from "./klecks-command-port";
import { isKlecksResourceLimit, KLECKS_RESOURCE_LIMIT_MESSAGE } from "./klecks-resource-budget";

export type KlecksProjectWire = {
  metadata: unknown;
  psd: Uint8Array;
  backings: { id: string; bytes: Uint8Array }[];
};
export type KlecksFrozenProject = {
  pixelDirty?: boolean;
  unapplied?: boolean;
  composite?: Uint8Array;
  ticket: number;
  project: KlecksProjectWire;
  thumbnail: Uint8Array;
};
type Code =
  | "DISCARDED"
  | "FROZEN"
  | "SAVED"
  | "APPLIED"
  | "INVALID_MESSAGE"
  | "STALE_TARGET"
  | "REPLAY"
  | "UNAVAILABLE"
  | "EDITOR_RESOURCE_LIMIT"
  | "FAILED";
const requestType = "klecks:project",
  replyType = "klecks:project:reply";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const same = (a: KlecksPortIdentity, b: KlecksPortIdentity) =>
  a.sessionId === b.sessionId && a.viewId === b.viewId && a.generation === b.generation;
function identity(value: unknown): value is KlecksPortIdentity {
  return (
    record(value) &&
    exact(value, ["sessionId", "viewId", "generation"]) &&
    [value.sessionId, value.viewId].every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= 200,
    ) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) > 0
  );
}
function bytes(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}
/** Transport bounds only; the main-process schema and codec validate complete project metadata. */
function payload(value: unknown): value is Omit<KlecksFrozenProject, "ticket"> {
  return (
    record(value) &&
    exact(value, [
      "project",
      "thumbnail",
      ...(Object.hasOwn(value, "pixelDirty") ? ["pixelDirty"] : []),
      ...(Object.hasOwn(value, "unapplied") ? ["unapplied"] : []),
      ...(Object.hasOwn(value, "composite") ? ["composite"] : []),
    ]) &&
    (value.pixelDirty === undefined || typeof value.pixelDirty === "boolean") &&
    (value.unapplied === undefined || typeof value.unapplied === "boolean") &&
    (value.composite === undefined ||
      (bytes(value.composite) &&
        value.composite.byteLength > 0 &&
        value.composite.byteLength <= 50 * 1024 * 1024)) &&
    bytes(value.thumbnail) &&
    value.thumbnail.byteLength > 0 &&
    value.thumbnail.byteLength <= 4 * 1024 * 1024 &&
    isKlecksProjectWire(value.project)
  );
}
export function isKlecksProjectWire(value: unknown): value is KlecksProjectWire {
  if (
    !record(value) ||
    !exact(value, ["metadata", "psd", "backings"]) ||
    !record(value.metadata) ||
    !bytes(value.psd) ||
    value.psd.byteLength < 26 ||
    !Array.isArray(value.backings) ||
    value.backings.length > 16
  )
    return false;
  let size = value.psd.byteLength;
  const ids = new Set<string>();
  for (const item of value.backings) {
    if (
      !record(item) ||
      !exact(item, ["id", "bytes"]) ||
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > 208 ||
      ids.has(item.id) ||
      !bytes(item.bytes) ||
      !item.bytes.byteLength
    )
      return false;
    ids.add(item.id);
    size += item.bytes.byteLength;
  }
  return size <= 50 * 1024 * 1024;
}

/** Multiplex on an already authenticated dedicated port. Tokens never leave the frame. */
export function bindKlecksProjectPort<T>(
  port: MessagePort,
  options: {
    isCurrent(identity: KlecksPortIdentity): boolean;
    freeze(identity: KlecksPortIdentity): Promise<{
      project: KlecksProjectWire;
      thumbnail: Uint8Array;
      composite?: Uint8Array;
      unapplied?: boolean;
      pixelDirty?: boolean;
      token: T;
    }>;
    confirmSaved(token: T): boolean;
    confirmApplied?(token: T): boolean;
  },
): () => void {
  let closed = false,
    busy = false,
    sequence = 0;
  const tickets = new Map<number, { identity: KlecksPortIdentity; token: T }>();
  let activeFreeze: { sequence: number; identity: KlecksPortIdentity; cancelled: boolean } | null =
    null;
  const receive = async (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (!record(data) || data.type !== requestType || closed) return;
    const reply = (code: Code, value?: KlecksFrozenProject) => {
      if (!closed)
        port.postMessage({
          type: replyType,
          version: 1,
          sequence: data.sequence,
          code,
          ...(value ? { value } : {}),
        });
    };
    if (
      data.version !== 1 ||
      !Number.isSafeInteger(data.sequence) ||
      (data.sequence as number) < 1 ||
      !identity(data.identity) ||
      !["freeze", "confirmSaved", "confirmApplied", "discard"].includes(data.action as string) ||
      !exact(
        data,
        data.action === "freeze"
          ? ["type", "version", "sequence", "identity", "action"]
          : ["type", "version", "sequence", "identity", "action", "ticket"],
      )
    ) {
      reply("INVALID_MESSAGE");
      return;
    }
    const next = data.sequence as number;
    if (next <= sequence) {
      reply("REPLAY");
      return;
    }
    sequence = next;
    try {
      if (!options.isCurrent(data.identity)) {
        reply("STALE_TARGET");
        return;
      }
      for (const [key, ticket] of tickets)
        if (!options.isCurrent(ticket.identity)) tickets.delete(key);
      if (
        data.action === "confirmSaved" ||
        data.action === "confirmApplied" ||
        data.action === "discard"
      ) {
        if (!Number.isSafeInteger(data.ticket) || (data.ticket as number) < 1) {
          reply("INVALID_MESSAGE");
          return;
        }
        const ticket = tickets.get(data.ticket as number);
        if (
          data.action === "discard" &&
          activeFreeze &&
          activeFreeze.sequence === data.ticket &&
          same(activeFreeze.identity, data.identity)
        ) {
          activeFreeze.cancelled = true;
          reply("DISCARDED");
          return;
        }
        if (!ticket || !same(ticket.identity, data.identity)) {
          reply("STALE_TARGET");
          return;
        }
        tickets.delete(data.ticket as number);
        if (data.action === "discard") {
          reply("DISCARDED");
          return;
        }
        reply(
          data.action === "confirmApplied"
            ? options.confirmApplied?.(ticket.token)
              ? "APPLIED"
              : "STALE_TARGET"
            : options.confirmSaved(ticket.token)
              ? "SAVED"
              : "STALE_TARGET",
        );
        return;
      }
      // Batch apply retains only one small confirmation token per synced image.
      if (busy || tickets.size >= 500) {
        reply("UNAVAILABLE");
        return;
      }
      busy = true;
      const target = { ...data.identity };
      const candidate = { sequence: next, identity: target, cancelled: false };
      activeFreeze = candidate;
      try {
        const result = await options.freeze(target);
        if (closed) return;
        if (candidate.cancelled || !options.isCurrent(target)) {
          reply("STALE_TARGET");
          return;
        }
        const value = {
          project: result.project,
          thumbnail: result.thumbnail,
          ...(result.pixelDirty !== undefined ? { pixelDirty: result.pixelDirty } : {}),
          ...(result.unapplied !== undefined ? { unapplied: result.unapplied } : {}),
          ...(result.composite ? { composite: result.composite } : {}),
        };
        if (!payload(value)) {
          reply("FAILED");
          return;
        }
        tickets.set(next, { identity: target, token: result.token });
        reply("FROZEN", { ticket: next, ...value });
      } finally {
        busy = false;
        activeFreeze = null;
      }
    } catch (error) {
      reply(isKlecksResourceLimit(error) ? "EDITOR_RESOURCE_LIMIT" : "FAILED");
    }
  };
  port.addEventListener("message", receive);
  port.start();
  return () => {
    closed = true;
    tickets.clear();
    port.removeEventListener("message", receive);
  };
}

export function createKlecksProjectClient(port: MessagePort, timeoutMs = 30000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000)
    throw new Error("工程传输超时参数无效。");
  let sequence = 0,
    closed = false;
  const pending = new Map<
    number,
    {
      action: string;
      resolve(value: KlecksFrozenProject | boolean): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const request = (
    target: KlecksPortIdentity,
    action: "freeze" | "confirmSaved" | "confirmApplied" | "discard",
    ticket?: number,
  ): Promise<KlecksFrozenProject | boolean> =>
    new Promise((resolve, reject) => {
      if (closed || !identity(target)) {
        reject(new Error("工程传输已关闭或目标无效。"));
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        if (action === "freeze" && !closed) {
          try {
            port.postMessage({
              type: requestType,
              version: 1,
              sequence: ++sequence,
              identity: { ...target },
              action: "discard",
              ticket: id,
            });
          } catch {
            /* A closed transport owns no further acknowledgements. */
          }
        }
        reject(new Error("工程传输等待超时。"));
      }, timeoutMs);
      pending.set(id, { action, resolve, reject, timer });
      try {
        port.postMessage({
          type: requestType,
          version: 1,
          sequence: id,
          identity: { ...target },
          action,
          ...(action !== "freeze" ? { ticket } : {}),
        });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error("工程传输发送失败。"));
      }
    });
  const receive = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (
      !record(data) ||
      data.type !== replyType ||
      data.version !== 1 ||
      !Number.isSafeInteger(data.sequence)
    )
      return;
    const item = pending.get(data.sequence as number);
    if (
      !item ||
      !exact(
        data,
        data.code === "FROZEN"
          ? ["type", "version", "sequence", "code", "value"]
          : ["type", "version", "sequence", "code"],
      )
    )
      return;
    if (
      data.code === "FROZEN" &&
      (item.action !== "freeze" ||
        !record(data.value) ||
        !exact(data.value, [
          "ticket",
          "project",
          "thumbnail",
          ...(Object.hasOwn(data.value, "pixelDirty") ? ["pixelDirty"] : []),
          ...(Object.hasOwn(data.value, "unapplied") ? ["unapplied"] : []),
          ...(Object.hasOwn(data.value, "composite") ? ["composite"] : []),
        ]) ||
        data.value.ticket !== data.sequence ||
        !payload({
          project: data.value.project,
          thumbnail: data.value.thumbnail,
          ...(Object.hasOwn(data.value, "pixelDirty") ? { pixelDirty: data.value.pixelDirty } : {}),
          ...(Object.hasOwn(data.value, "unapplied") ? { unapplied: data.value.unapplied } : {}),
          ...(Object.hasOwn(data.value, "composite") ? { composite: data.value.composite } : {}),
        }))
    )
      return;
    pending.delete(data.sequence as number);
    clearTimeout(item.timer);
    if (data.code === "FROZEN") item.resolve(data.value as KlecksFrozenProject);
    else if (data.code === "SAVED" && item.action === "confirmSaved") item.resolve(true);
    else if (data.code === "APPLIED" && item.action === "confirmApplied") item.resolve(true);
    else if (data.code === "DISCARDED" && item.action === "discard") item.resolve(true);
    else
      item.reject(
        Object.assign(
          new Error(
            data.code === "EDITOR_RESOURCE_LIMIT"
              ? KLECKS_RESOURCE_LIMIT_MESSAGE
              : `工程传输未完成：${String(data.code)}`,
          ),
          { code: data.code },
        ),
      );
  };
  port.addEventListener("message", receive);
  port.start();
  return {
    freeze: (target: KlecksPortIdentity) =>
      request(target, "freeze") as Promise<KlecksFrozenProject>,
    confirmSaved: (target: KlecksPortIdentity, ticket: number) =>
      request(target, "confirmSaved", ticket) as Promise<boolean>,
    confirmApplied: (target: KlecksPortIdentity, ticket: number) =>
      request(target, "confirmApplied", ticket) as Promise<boolean>,
    discard: (target: KlecksPortIdentity, ticket: number) =>
      request(target, "discard", ticket) as Promise<boolean>,
    close: () => {
      closed = true;
      port.removeEventListener("message", receive);
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("工程传输已关闭。"));
      }
      pending.clear();
    },
  };
}
