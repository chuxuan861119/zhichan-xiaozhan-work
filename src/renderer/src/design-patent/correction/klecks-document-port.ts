import type { KlecksPortIdentity } from "./klecks-command-port";
import { isKlecksProjectWire, type KlecksProjectWire } from "./klecks-project-port";
import { isKlecksResourceLimit, KLECKS_RESOURCE_LIMIT_MESSAGE } from "./klecks-resource-budget";

export type KlecksDocumentIdentity = { viewId: string; generation: number };
export type KlecksRasterWire = {
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  initialLayerKind: "regular" | "background";
};
type Callbacks = {
  activate(identity: KlecksPortIdentity): boolean | Promise<boolean>;
  cancelOpen(): void;
  sessionId: string;
  interactionLock?(token: string, locked: boolean): void;
  sync(documents: KlecksDocumentIdentity[], lockToken?: string): void;
  isCurrent(identity: KlecksPortIdentity): boolean;
  openRaster(
    identity: KlecksPortIdentity,
    name: string,
    source: KlecksRasterWire,
  ): Promise<boolean>;
  openProject(
    identity: KlecksPortIdentity,
    project: KlecksProjectWire,
    isApplied: boolean,
    isSaved: boolean,
  ): Promise<boolean>;
};
const requestType = "klecks:documents",
  replyType = "klecks:documents:reply";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
const generation = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
function identity(value: unknown): value is KlecksPortIdentity {
  return (
    record(value) &&
    exact(value, ["sessionId", "viewId", "generation"]) &&
    text(value.sessionId) &&
    text(value.viewId) &&
    generation(value.generation)
  );
}
function documents(value: unknown): value is KlecksDocumentIdentity[] {
  if (!Array.isArray(value) || value.length > 100000) return false;
  const ids = new Set<string>();
  for (const doc of value) {
    if (
      !record(doc) ||
      !exact(doc, ["viewId", "generation"]) ||
      !text(doc.viewId) ||
      !generation(doc.generation) ||
      ids.has(doc.viewId)
    )
      return false;
    ids.add(doc.viewId);
  }
  return true;
}
function raster(value: unknown): value is KlecksRasterWire {
  return (
    record(value) &&
    exact(value, ["bytes", "widthPx", "heightPx", "initialLayerKind"]) &&
    ArrayBuffer.isView(value.bytes) &&
    Object.prototype.toString.call(value.bytes) === "[object Uint8Array]" &&
    value.bytes.byteLength >= 33 &&
    value.bytes.byteLength <= 50 * 1024 * 1024 &&
    Number.isSafeInteger(value.widthPx) &&
    Number.isSafeInteger(value.heightPx) &&
    (value.widthPx as number) > 0 &&
    (value.heightPx as number) > 0 &&
    (value.widthPx as number) <= 10000 &&
    (value.heightPx as number) <= 10000 &&
    (value.widthPx as number) * (value.heightPx as number) <= 40000000 &&
    ["regular", "background"].includes(value.initialLayerKind as string)
  );
}
export function bindKlecksDocumentPort(port: MessagePort, callbacks: Callbacks): () => void {
  let closed = false,
    sequence = 0;
  let activeOpen: { sequence: number; identity: KlecksPortIdentity; cancelled: boolean } | null =
    null;
  const receive = async (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (!record(data) || data.type !== requestType || closed) return;
    const reply = (code: string) => {
      if (!closed) port.postMessage({ type: replyType, version: 1, sequence: data.sequence, code });
    };
    if (
      data.version !== 1 ||
      !Number.isSafeInteger(data.sequence) ||
      (data.sequence as number) < 1
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
      if (data.action === "interactionLock") {
        if (
          !exact(data, ["type", "version", "sequence", "action", "sessionId", "token", "locked"]) ||
          !text(data.sessionId) ||
          !text(data.token) ||
          typeof data.locked !== "boolean"
        ) {
          reply("INVALID_MESSAGE");
          return;
        }
        if (data.sessionId !== callbacks.sessionId) {
          reply("STALE_TARGET");
          return;
        }
        if (!callbacks.interactionLock) {
          reply("UNAVAILABLE");
          return;
        }
        callbacks.interactionLock(data.token, data.locked);
        reply(data.locked ? "LOCKED" : "UNLOCKED");
        return;
      }
      if (data.action === "sync") {
        if (
          !exact(data, [
            "type",
            "version",
            "sequence",
            "action",
            "sessionId",
            "documents",
            ...(Object.hasOwn(data, "lockToken") ? ["lockToken"] : []),
          ]) ||
          (Object.hasOwn(data, "lockToken") && !text(data.lockToken)) ||
          !text(data.sessionId) ||
          !documents(data.documents)
        ) {
          reply("INVALID_MESSAGE");
          return;
        }
        if (data.sessionId !== callbacks.sessionId) {
          reply("STALE_TARGET");
          return;
        }
        const nextDocuments = data.documents.map((doc) => ({ ...doc }));
        if (typeof data.lockToken === "string") callbacks.sync(nextDocuments, data.lockToken);
        else callbacks.sync(nextDocuments);
        reply("SYNCED");
        return;
      }
      if (!identity(data.identity)) {
        reply("INVALID_MESSAGE");
        return;
      }
      if (data.action === "cancel") {
        if (
          !exact(data, ["type", "version", "sequence", "action", "identity", "requestSequence"]) ||
          !generation(data.requestSequence)
        ) {
          reply("INVALID_MESSAGE");
          return;
        }
        if (data.identity.sessionId !== callbacks.sessionId) {
          reply("STALE_TARGET");
          return;
        }
        if (
          activeOpen &&
          activeOpen.sequence === data.requestSequence &&
          activeOpen.identity.viewId === data.identity.viewId &&
          activeOpen.identity.generation === data.identity.generation
        ) {
          activeOpen.cancelled = true;
          activeOpen = null;
          callbacks.cancelOpen();
        }
        reply("CANCELLED");
        return;
      }
      if (!callbacks.isCurrent(data.identity)) {
        reply("STALE_TARGET");
        return;
      }
      let opened: boolean;
      const candidate = { sequence: next, identity: { ...data.identity }, cancelled: false };
      if (data.action === "activate") {
        if (!exact(data, ["type", "version", "sequence", "action", "identity"])) {
          reply("INVALID_MESSAGE");
          return;
        }
        activeOpen = candidate;
        opened = await callbacks.activate({ ...data.identity });
      } else if (data.action === "openRaster") {
        if (
          !exact(data, ["type", "version", "sequence", "action", "identity", "name", "source"]) ||
          typeof data.name !== "string" ||
          !data.name ||
          data.name.length > 255 ||
          !raster(data.source)
        ) {
          reply("INVALID_MESSAGE");
          return;
        }
        activeOpen = candidate;
        opened = await callbacks.openRaster({ ...data.identity }, data.name, data.source);
      } else if (data.action === "openProject") {
        if (
          !exact(data, [
            "type",
            "version",
            "sequence",
            "action",
            "identity",
            "project",
            "isApplied",
            "isSaved",
          ]) ||
          typeof data.isApplied !== "boolean" ||
          typeof data.isSaved !== "boolean" ||
          !isKlecksProjectWire(data.project)
        ) {
          reply("INVALID_MESSAGE");
          return;
        }
        activeOpen = candidate;
        opened = await callbacks.openProject(
          { ...data.identity },
          data.project,
          data.isApplied,
          data.isSaved,
        );
      } else {
        reply("INVALID_MESSAGE");
        return;
      }
      if (activeOpen === candidate) activeOpen = null;
      reply(
        opened && !candidate.cancelled && callbacks.isCurrent(data.identity)
          ? "OPENED"
          : "STALE_TARGET",
      );
    } catch (error) {
      if (activeOpen?.sequence === next) activeOpen = null;
      reply(isKlecksResourceLimit(error) ? "EDITOR_RESOURCE_LIMIT" : "FAILED");
    }
  };
  port.addEventListener("message", receive);
  port.start();
  return () => {
    closed = true;
    if (activeOpen) {
      activeOpen.cancelled = true;
      activeOpen = null;
      try {
        callbacks.cancelOpen();
      } catch {
        /* Frame teardown still removes its listener. */
      }
    }
    port.removeEventListener("message", receive);
  };
}
export function createKlecksDocumentClient(port: MessagePort, timeoutMs = 30000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000)
    throw new Error("图片加载超时参数无效。");
  let closed = false,
    sequence = 0;
  const pending = new Map<
    number,
    {
      expected: string;
      resolve(value: boolean): void;
      reject(error: Error): void;
      cleanup(): void;
      cancel(): void;
    }
  >();
  const request = (
    body: Record<string, unknown>,
    expected: string,
    signal?: AbortSignal,
  ): Promise<boolean> =>
    new Promise((resolve, reject) => {
      if (closed || signal?.aborted) {
        reject(
          Object.assign(new Error(signal?.aborted ? "图片加载已取消。" : "图片数据通道已关闭。"), {
            code: "CANCELLED",
          }),
        );
        return;
      }
      const id = ++sequence;
      const cancel = () => {
        if (!body.identity) return;
        try {
          port.postMessage({
            type: requestType,
            version: 1,
            sequence: ++sequence,
            action: "cancel",
            identity: body.identity,
            requestSequence: id,
          });
        } catch {
          /* Closed peers cannot acknowledge a late load. */
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        pending.delete(id);
        cleanup();
        cancel();
        reject(Object.assign(new Error("图片加载已取消。"), { code: "CANCELLED" }));
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        cleanup();
        cancel();
        reject(new Error("图片加载等待超时。"));
      }, timeoutMs);
      pending.set(id, { expected, resolve, reject, cleanup, cancel });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        port.postMessage({ type: requestType, version: 1, sequence: id, ...body });
      } catch {
        cleanup();
        pending.delete(id);
        reject(new Error("图片数据发送失败。"));
      }
    });
  const receive = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (
      !record(data) ||
      data.type !== replyType ||
      data.version !== 1 ||
      !Number.isSafeInteger(data.sequence) ||
      !exact(data, ["type", "version", "sequence", "code"])
    )
      return;
    const item = pending.get(data.sequence as number);
    if (!item) return;
    pending.delete(data.sequence as number);
    item.cleanup();
    if (data.code === item.expected) item.resolve(true);
    else
      item.reject(
        Object.assign(
          new Error(
            data.code === "EDITOR_RESOURCE_LIMIT"
              ? KLECKS_RESOURCE_LIMIT_MESSAGE
              : `图片数据操作未完成：${String(data.code)}`,
          ),
          { code: data.code },
        ),
      );
  };
  port.addEventListener("message", receive);
  port.start();
  return {
    interactionLock: (sessionId: string, token: string, locked: boolean) =>
      request(
        { action: "interactionLock", sessionId, token, locked },
        locked ? "LOCKED" : "UNLOCKED",
      ),
    activate: (target: KlecksPortIdentity, options: { signal?: AbortSignal } = {}) =>
      request({ action: "activate", identity: { ...target } }, "OPENED", options.signal),
    sync: (sessionId: string, docs: readonly KlecksDocumentIdentity[], lockToken?: string) =>
      request(
        {
          action: "sync",
          sessionId,
          documents: docs.map(({ viewId, generation }) => ({ viewId, generation })),
          ...(lockToken !== undefined ? { lockToken } : {}),
        },
        "SYNCED",
      ),
    openRaster: (
      target: KlecksPortIdentity,
      name: string,
      source: KlecksRasterWire,
      options: { signal?: AbortSignal } = {},
    ) =>
      request(
        {
          action: "openRaster",
          identity: { ...target },
          name,
          source: {
            bytes: source.bytes,
            widthPx: source.widthPx,
            heightPx: source.heightPx,
            initialLayerKind: source.initialLayerKind,
          },
        },
        "OPENED",
        options.signal,
      ),
    openProject: (
      target: KlecksPortIdentity,
      project: KlecksProjectWire,
      isApplied = false,
      options: { signal?: AbortSignal; isSaved?: boolean } = {},
    ) =>
      request(
        {
          action: "openProject",
          identity: { ...target },
          project,
          isApplied,
          isSaved: options.isSaved ?? true,
        },
        "OPENED",
        options.signal,
      ),
    close: () => {
      closed = true;
      port.removeEventListener("message", receive);
      for (const item of pending.values()) {
        item.cleanup();
        item.cancel();
        item.reject(new Error("图片数据通道已关闭。"));
      }
      pending.clear();
    },
  };
}
