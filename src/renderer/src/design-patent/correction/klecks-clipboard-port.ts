import type { ClipboardImage } from "../../../../shared/ipc/contract";
import { validateEditorBinaryHeader } from "../../../../shared/patent/design-editor-binary";
import type { KlecksPortIdentity } from "./klecks-command-port";
import { KlecksOperationRejected } from "./klecks-operation-error";
import { isKlecksResourceLimit, KLECKS_RESOURCE_LIMIT_MESSAGE } from "./klecks-resource-budget";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const identity = (value: unknown): value is KlecksPortIdentity =>
  record(value) &&
  exact(value, ["sessionId", "viewId", "generation"]) &&
  [value.sessionId, value.viewId].every(
    (x) => typeof x === "string" && x.length > 0 && x.length <= 200,
  ) &&
  Number.isSafeInteger(value.generation) &&
  (value.generation as number) > 0;
function image(value: unknown): value is ClipboardImage {
  if (
    !record(value) ||
    !exact(value, ["bytes", "width", "height"]) ||
    !ArrayBuffer.isView(value.bytes) ||
    Object.prototype.toString.call(value.bytes) !== "[object Uint8Array]" ||
    value.bytes.byteLength < 33 ||
    value.bytes.byteLength > 50 * 1024 * 1024 ||
    ![value.width, value.height].every(
      (x) => typeof x === "number" && Number.isSafeInteger(x) && x > 0 && x <= 10000,
    ) ||
    (value.width as number) * (value.height as number) > 40000000
  )
    return false;
  try {
    validateEditorBinaryHeader(value.bytes as Uint8Array, "png", {
      width: value.width as number,
      height: value.height as number,
    });
    return true;
  } catch {
    return false;
  }
}
type Operation =
  | { operation: "copy"; cut: boolean; merged: boolean }
  | { operation: "paste"; image: ClipboardImage }
  | { operation: "pasteInternal"; inPlace: boolean };
type Options = {
  current(): { identity: KlecksPortIdentity; revision: number } | null;
  copy(cut: boolean, merged: boolean): Promise<ClipboardImage | null>;
  paste(
    image: ClipboardImage | null,
    inPlace: boolean,
    revision: number,
    signal: AbortSignal,
  ): Promise<boolean>;
};
export function bindKlecksClipboardPort(port: MessagePort, options: Options): () => void {
  let sequence = 0,
    closed = false;
  const active = new Map<number, AbortController>();
  const receive = async (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (!record(data) || closed) return;
    if (
      data.type === "klecks:clipboard:cancel" &&
      exact(data, ["type", "sequence"]) &&
      Number.isSafeInteger(data.sequence)
    ) {
      active.get(data.sequence as number)?.abort();
      return;
    }
    if (data.type !== "klecks:clipboard") return;
    const reply = (code: string, value?: ClipboardImage | null | boolean, message?: string) => {
      if (!closed)
        port.postMessage({
          type: "klecks:clipboard:reply",
          version: 1,
          sequence: data.sequence,
          code,
          ...(value !== undefined ? { value } : {}),
          ...(message ? { message } : {}),
        });
    };
    if (
      data.version !== 1 ||
      !Number.isSafeInteger(data.sequence) ||
      (data.sequence as number) < 1 ||
      !identity(data.identity) ||
      !Number.isSafeInteger(data.revision) ||
      (data.revision as number) < 0 ||
      !exact(data, [
        "type",
        "version",
        "sequence",
        "identity",
        "revision",
        "operation",
        ...(data.operation === "copy"
          ? ["cut", "merged"]
          : data.operation === "paste"
            ? ["image"]
            : ["inPlace"]),
      ]) ||
      !(data.operation === "copy"
        ? typeof data.cut === "boolean" &&
          typeof data.merged === "boolean" &&
          !(data.cut && data.merged)
        : data.operation === "paste"
          ? image(data.image)
          : data.operation === "pasteInternal" && typeof data.inPlace === "boolean")
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
    const current = options.current();
    if (
      !current ||
      current.revision !== data.revision ||
      current.identity.sessionId !== data.identity.sessionId ||
      current.identity.viewId !== data.identity.viewId ||
      current.identity.generation !== data.identity.generation
    ) {
      reply("STALE_TARGET");
      return;
    }
    if (active.size) {
      reply("BUSY");
      return;
    }
    const controller = new AbortController();
    active.set(next, controller);
    try {
      const result =
        data.operation === "copy"
          ? await options.copy(data.cut as boolean, data.merged as boolean)
          : await options.paste(
              data.operation === "paste" ? (data.image as ClipboardImage) : null,
              data.inPlace === true,
              data.revision as number,
              controller.signal,
            );
      if (!controller.signal.aborted) reply("ACCEPTED", result);
    } catch (error) {
      if (!controller.signal.aborted)
        reply(
          isKlecksResourceLimit(error) ? "EDITOR_RESOURCE_LIMIT" : "FAILED",
          undefined,
          error instanceof KlecksOperationRejected ? error.message.slice(0, 500) : undefined,
        );
    } finally {
      active.delete(next);
    }
  };
  port.addEventListener("message", receive);
  port.start();
  return () => {
    closed = true;
    for (const controller of active.values()) controller.abort();
    active.clear();
    port.removeEventListener("message", receive);
  };
}
export function createKlecksClipboardClient(port: MessagePort, timeoutMs = 30000) {
  let sequence = 0,
    closed = false;
  const pending = new Map<
    number,
    {
      operation: string;
      resolve(value: ClipboardImage | null | boolean): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const request = (
    target: KlecksPortIdentity,
    revision: number,
    operation: Operation,
  ): Promise<ClipboardImage | null | boolean> =>
    new Promise((resolve, reject) => {
      if (
        closed ||
        !identity(target) ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        (operation.operation === "paste" && !image(operation.image))
      ) {
        reject(new Error("图片剪贴板连接已关闭或参数无效。"));
        return;
      }
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          try {
            port.postMessage({ type: "klecks:clipboard:cancel", sequence: id });
          } catch {}
          reject(new Error("图片剪贴板操作等待超时。"));
        }, timeoutMs);
      pending.set(id, { operation: operation.operation, resolve, reject, timer });
      try {
        port.postMessage({
          type: "klecks:clipboard",
          version: 1,
          sequence: id,
          identity: { ...target },
          revision,
          ...operation,
        });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error("图片剪贴板操作发送失败。"));
      }
    });
  const receive = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (
      !record(data) ||
      data.type !== "klecks:clipboard:reply" ||
      data.version !== 1 ||
      !Number.isSafeInteger(data.sequence) ||
      !exact(data, [
        "type",
        "version",
        "sequence",
        "code",
        ...(Object.hasOwn(data, "value") ? ["value"] : []),
        ...(Object.hasOwn(data, "message") ? ["message"] : []),
      ])
    )
      return;
    if (
      Object.hasOwn(data, "message") &&
      (data.code !== "FAILED" ||
        typeof data.message !== "string" ||
        !data.message.length ||
        data.message.length > 500)
    )
      return;
    const item = pending.get(data.sequence as number);
    if (!item) return;
    if (
      data.code === "ACCEPTED" &&
      !(item.operation === "copy"
        ? data.value === null || image(data.value)
        : typeof data.value === "boolean")
    )
      return;
    pending.delete(data.sequence as number);
    clearTimeout(item.timer);
    if (data.code === "ACCEPTED") item.resolve(data.value as ClipboardImage | null | boolean);
    else
      item.reject(
        new Error(
          data.code === "EDITOR_RESOURCE_LIMIT"
            ? KLECKS_RESOURCE_LIMIT_MESSAGE
            : typeof data.message === "string"
              ? data.message
              : "图片剪贴板操作未完成，目标可能已经改变。",
        ),
      );
  };
  port.addEventListener("message", receive);
  port.start();
  return {
    copy: (target: KlecksPortIdentity, revision: number, cut = false, merged = false) =>
      request(target, revision, {
        operation: "copy",
        cut,
        merged,
      }) as Promise<ClipboardImage | null>,
    paste: (target: KlecksPortIdentity, revision: number, value: ClipboardImage) =>
      request(target, revision, { operation: "paste", image: value }) as Promise<boolean>,
    pasteInternal: (target: KlecksPortIdentity, revision: number, inPlace = false) =>
      request(target, revision, { operation: "pasteInternal", inPlace }) as Promise<boolean>,
    close() {
      if (closed) return;
      closed = true;
      port.removeEventListener("message", receive);
      for (const [id, item] of pending) {
        clearTimeout(item.timer);
        try {
          port.postMessage({ type: "klecks:clipboard:cancel", sequence: id });
        } catch {}
        item.reject(new Error("图片剪贴板连接已关闭。"));
      }
      pending.clear();
    },
  };
}
