import { createKlecksClipboardClient } from "./klecks-clipboard-port";
import type { KlecksPortIdentity, PortCode } from "./klecks-command-port";
import { createKlecksDocumentClient } from "./klecks-document-port";
import { isKlecksDroppedImages, type KlecksDroppedImage } from "./klecks-file-drop-port";
import type { KlecksKeyboardCommand } from "./klecks-keyboard";
import type { KlecksClipboardAction } from "./klecks-native-clipboard";
import { createKlecksProjectClient } from "./klecks-project-port";
import { createKlecksStateClient } from "./klecks-state-port";
import { createKlecksToolClient } from "./klecks-tool-port";

type Action = Exclude<KlecksKeyboardCommand["action"], "tool" | "nudge" | "strokeValue">;
export type KlecksFrameClient = {
  isActive?(): boolean;
  canvasOverlayHost?: HTMLElement;
  onFilesDropped?(
    listener: (files: KlecksDroppedImage[]) => void,
    error: (message: string) => void,
  ): () => void;
  onClipboardRequested?(
    sessionId: string,
    listener: (action: KlecksClipboardAction, identity: KlecksPortIdentity) => void,
  ): () => void;
  clipboard?: ReturnType<typeof createKlecksClipboardClient>;
  onSaveRequested?(listener: (identity: KlecksPortIdentity) => void): () => void;
  state: ReturnType<typeof createKlecksStateClient> & {
    forDocument?(
      viewId: string,
    ): ReturnType<ReturnType<typeof createKlecksStateClient>["snapshot"]>;
  };
  tools: ReturnType<typeof createKlecksToolClient>;
  projects: Omit<ReturnType<typeof createKlecksProjectClient>, "confirmApplied"> &
    Partial<Pick<ReturnType<typeof createKlecksProjectClient>, "confirmApplied">>;
  documents: ReturnType<typeof createKlecksDocumentClient>;
  send(identity: KlecksPortIdentity, action: Action): Promise<PortCode>;
  close(): void;
};
const codes = new Set([
  "ACCEPTED",
  "INVALID_MESSAGE",
  "STALE_TARGET",
  "REPLAY",
  "UNAVAILABLE",
  "EDITOR_RESOURCE_LIMIT",
  "COMMAND_FAILED",
]);
export function createKlecksFrameNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Invoke only after the expected frame has loaded the local editor URL with this nonce. */
export async function connectKlecksFrame(
  target: Window,
  origin: string,
  nonce: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<KlecksFrameClient> {
  if (!origin || origin === "*" || origin === "null" || !/^[a-f0-9]{64}$/u.test(nonce))
    throw new Error("图片编辑器连接参数无效。");
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000)
    throw new Error("图片编辑器连接超时设置无效。");
  if (options.signal?.aborted) throw new Error("图片编辑器连接已取消。");
  const channel = new MessageChannel();
  const port = channel.port1;
  const projects = createKlecksProjectClient(port);
  const documents = createKlecksDocumentClient(port);
  const tools = createKlecksToolClient(port, timeoutMs);
  const state = createKlecksStateClient(port);
  const clipboard = createKlecksClipboardClient(port, timeoutMs);
  const saveListeners = new Set<(identity: KlecksPortIdentity) => void>();
  const dropListeners = new Set<{
    files(files: KlecksDroppedImage[]): void;
    error(message: string): void;
  }>();
  let dropSequence = 0;
  let saveSequence = 0;
  const clipboardListeners = new Set<
    (action: KlecksClipboardAction, identity: KlecksPortIdentity) => void
  >();
  let clipboardSequence = 0;
  return new Promise((resolve, reject) => {
    let closed = false,
      ready = false,
      sequence = 0;
    const pending = new Map<
      number,
      {
        resolve(value: PortCode): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const close = (error = new Error("图片编辑器连接已关闭。")) => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      options.signal?.removeEventListener("abort", abort);
      port.removeEventListener("message", receive);
      port.removeEventListener("messageerror", failed);
      port.close();
      channel.port2.close();
      if (!ready) reject(error);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
      projects.close();
      documents.close();
      tools.close();
      state.close();
      clipboard.close();
      saveListeners.clear();
      dropListeners.clear();
      clipboardListeners.clear();
    };
    const abort = () => close(new Error("图片编辑器连接已取消。"));
    const failed = () => close(new Error("图片编辑器消息无法读取。"));
    const client: KlecksFrameClient = {
      onFilesDropped(files, error) {
        const listener = { files, error };
        if (!closed) dropListeners.add(listener);
        return () => {
          dropListeners.delete(listener);
        };
      },
      clipboard,
      onClipboardRequested(sessionId, listener) {
        if (closed) return () => {};
        clipboardListeners.add(listener);
        port.postMessage({ type: "klecks:clipboard:mode", version: 1, sessionId, enabled: true });
        return () => {
          clipboardListeners.delete(listener);
          if (!closed && !clipboardListeners.size)
            port.postMessage({
              type: "klecks:clipboard:mode",
              version: 1,
              sessionId,
              enabled: false,
            });
        };
      },
      onSaveRequested(listener) {
        if (closed) return () => {};
        saveListeners.add(listener);
        return () => {
          saveListeners.delete(listener);
        };
      },
      state,
      tools,
      projects,
      documents,
      close: () => close(),
      send: (identity, action) =>
        new Promise((done, fail) => {
          if (closed || !ready) {
            fail(new Error("图片编辑器未连接。"));
            return;
          }
          const request = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(request);
            fail(new Error("图片编辑器命令等待超时。"));
          }, timeoutMs);
          pending.set(request, { resolve: done, reject: fail, timer });
          try {
            port.postMessage({ version: 1, sequence: request, identity: { ...identity }, action });
          } catch {
            clearTimeout(timer);
            pending.delete(request);
            fail(new Error("图片编辑器命令发送失败。"));
          }
        }),
    };
    const receive = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (typeof data !== "object" || data === null) return;
      if (
        ready &&
        "type" in data &&
        ["klecks:files-dropped", "klecks:files-dropped-error"].includes(String(data.type))
      ) {
        const payload = data as Record<string, unknown>;
        if (
          Object.keys(payload).length !== 4 ||
          payload.version !== 1 ||
          !Number.isSafeInteger(payload.sequence) ||
          (payload.sequence as number) <= dropSequence
        )
          return;
        if (payload.type === "klecks:files-dropped" && isKlecksDroppedImages(payload.files)) {
          dropSequence = payload.sequence as number;
          for (const listener of dropListeners) listener.files(payload.files);
        } else if (
          payload.type === "klecks:files-dropped-error" &&
          typeof payload.message === "string" &&
          payload.message.length > 0 &&
          payload.message.length <= 500
        ) {
          dropSequence = payload.sequence as number;
          for (const listener of dropListeners) listener.error(payload.message);
        }
        return;
      }
      if (!ready) {
        if (
          Object.keys(data).length !== 3 ||
          !("type" in data) ||
          data.type !== "klecks:ready" ||
          !("version" in data) ||
          data.version !== 1 ||
          !("nonce" in data) ||
          data.nonce !== nonce
        )
          return;
        ready = true;
        clearTimeout(handshakeTimer);
        resolve(client);
        return;
      }
      if (
        "type" in data &&
        (data.type === "klecks:save-request" || data.type === "klecks:clipboard-request")
      ) {
        const message = data as Record<string, unknown>,
          id = message.identity as Record<string, unknown> | null;
        const clipboardRequest = message.type === "klecks:clipboard-request";
        if (
          Object.keys(message).length !== (clipboardRequest ? 5 : 4) ||
          (clipboardRequest &&
            !["copy", "copyMerged", "cut", "paste", "pasteInPlace"].includes(
              message.action as string,
            )) ||
          message.version !== 1 ||
          !Number.isSafeInteger(message.sequence) ||
          (message.sequence as number) <= (clipboardRequest ? clipboardSequence : saveSequence) ||
          !id ||
          typeof id !== "object" ||
          Array.isArray(id) ||
          Object.keys(id).length !== 3 ||
          ![id.sessionId, id.viewId].every(
            (value) => typeof value === "string" && value.length > 0 && value.length <= 200,
          ) ||
          !Number.isSafeInteger(id.generation) ||
          (id.generation as number) < 1
        )
          return;
        if (clipboardRequest) {
          clipboardSequence = message.sequence as number;
          for (const listener of clipboardListeners) {
            try {
              listener(message.action as KlecksClipboardAction, { ...id } as KlecksPortIdentity);
            } catch {}
          }
          return;
        }
        saveSequence = message.sequence as number;
        for (const listener of saveListeners) {
          try {
            listener({ ...id } as KlecksPortIdentity);
          } catch {
            /* The case owner reports its own save failure. */
          }
        }
        return;
      }
      if (
        Object.keys(data).length !== 3 ||
        !("version" in data) ||
        data.version !== 1 ||
        !("sequence" in data) ||
        typeof data.sequence !== "number" ||
        !("code" in data) ||
        typeof data.code !== "string" ||
        !codes.has(data.code)
      )
        return;
      const request = pending.get(data.sequence);
      if (!request) return;
      pending.delete(data.sequence);
      clearTimeout(request.timer);
      request.resolve(data.code as PortCode);
    };
    const handshakeTimer = setTimeout(
      () => close(new Error("图片编辑器连接等待超时。")),
      timeoutMs,
    );
    port.addEventListener("message", receive);
    port.addEventListener("messageerror", failed);
    port.start();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      target.postMessage({ type: "klecks:connect", version: 1, nonce }, origin, [channel.port2]);
    } catch {
      close(new Error("图片编辑器连接发送失败。"));
    }
  });
}
